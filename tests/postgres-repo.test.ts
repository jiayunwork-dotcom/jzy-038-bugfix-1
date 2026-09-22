import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresBatchRepository } from '../src/persistence/postgres.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { balancedPositive, phasor } from './helpers.js';
import type { StoredRecord } from '../src/types.js';

/** 内存假库：实现 pg.Pool 用到的 connect()/query()/end() 接口 */
function makeFakePool() {
  const batches = new Map<string, { id: string; created_at: Date; note: string | null }>();
  const records = new Map<string, Array<Record<string, unknown>>>();

  const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    let rows: QueryResultRow[] = [];
    if (text.startsWith('INSERT INTO batches')) {
      rows = [{ id: params[0], created_at: new Date('2026-09-19T00:00:00Z'), note: params[1] as string | null }];
      batches.set(params[0] as string, rows[0]);
      records.set(params[0] as string, []);
    } else if (text.startsWith('SELECT id, created_at, note FROM batches')) {
      const b = batches.get(params[0] as string);
      rows = b ? [b] : [];
    } else if (text.includes('FOR UPDATE')) {
      rows = batches.has(params[0] as string) ? [{ id: params[0] }] : [];
    } else if (text.includes('MAX(idx) + 1')) {
      rows = [{ next_idx: (records.get(params[0] as string) ?? []).length }];
    } else if (text.startsWith('INSERT INTO records')) {
      const row = {
        id: params[0],
        batch_id: params[1],
        idx: params[2],
        status: params[3],
        input: JSON.parse(params[4] as string),
        result: params[5] ? JSON.parse(params[5] as string) : null,
        errors: JSON.parse(params[6] as string),
        created_at: new Date('2026-09-19T00:00:00Z'),
      };
      records.get(params[1] as string)!.push(row);
      rows = [row];
    } else if (text.includes('ORDER BY idx')) {
      rows = [...(records.get(params[0] as string) ?? [])].sort((a, b) => (a.idx as number) - (b.idx as number));
    } else if (text.includes('batch_id = $1 AND id = $2')) {
      rows = (records.get(params[0] as string) ?? []).filter((r) => r.id === params[1]);
    }
    return { rows, command: '', oid: 0, fields: [], rowCount: rows.length };
  });

  const connect = vi.fn(async (): Promise<PoolClient> => ({ query, release: vi.fn() }) as unknown as PoolClient);
  const pool = { connect, query, end: vi.fn(async () => undefined) } as unknown as Pool;
  return { pool, connect };
}

function makeLockingFakePool() {
  interface BatchRow {
    id: string;
    created_at: Date;
    note: string | null;
  }
  interface RecordRow {
    id: string;
    batch_id: string;
    idx: number;
    status: string;
    input: unknown;
    result: unknown;
    errors: unknown;
    created_at: Date;
  }
  interface Transaction {
    id: number;
    active: boolean;
    lockedBatchId?: string;
    pendingRecord?: RecordRow;
  }

  const batches = new Map<string, BatchRow>();
  const records = new Map<string, RecordRow[]>();
  const batchLocks = new Map<string, Transaction>();
  const pendingRecords = new Map<string, Set<RecordRow>>();
  const lockWaiters = new Map<string, Array<() => void>>();
  const connect = vi.fn();
  let nextTransactionId = 0;

  function result(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
    return { rows, command: '', oid: 0, fields: [], rowCount: rows.length };
  }

  async function acquireBatchLock(tx: Transaction, batchId: string): Promise<QueryResultRow[]> {
    if (!batches.has(batchId)) return [];
    const holder = batchLocks.get(batchId);
    if (holder && holder !== tx) {
      await new Promise<void>((resolve) => {
        const waiters = lockWaiters.get(batchId) ?? [];
        waiters.push(() => {
          if (batches.has(batchId)) {
            tx.lockedBatchId = batchId;
            batchLocks.set(batchId, tx);
          }
          resolve();
        });
        lockWaiters.set(batchId, waiters);
      });
      return batches.has(batchId) && tx.lockedBatchId === batchId ? [{ id: batchId }] : [];
    }
    tx.lockedBatchId = batchId;
    batchLocks.set(batchId, tx);
    return [{ id: batchId }];
  }

  function releaseBatchLock(tx: Transaction): void {
    if (!tx.lockedBatchId) return;
    const batchId = tx.lockedBatchId;
    if (batchLocks.get(batchId) === tx) batchLocks.delete(batchId);
    tx.lockedBatchId = undefined;
    lockWaiters.get(batchId)?.shift()?.();
  }

  async function executeQuery(
    tx: Transaction | null,
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<QueryResultRow>> {
    if (text === 'BEGIN') {
      tx!.active = true;
      return result([]);
    }
    if (text === 'COMMIT') {
      if (tx?.pendingRecord) {
        records.get(tx.pendingRecord.batch_id)!.push(tx.pendingRecord);
        pendingRecords.get(tx.pendingRecord.batch_id)?.delete(tx.pendingRecord);
        tx.pendingRecord = undefined;
      }
      tx!.active = false;
      releaseBatchLock(tx!);
      return result([]);
    }
    if (text === 'ROLLBACK') {
      if (tx?.pendingRecord) pendingRecords.get(tx.pendingRecord.batch_id)?.delete(tx.pendingRecord);
      tx!.active = false;
      tx!.pendingRecord = undefined;
      releaseBatchLock(tx!);
      return result([]);
    }

    if (text.startsWith('INSERT INTO batches')) {
      const row: BatchRow = {
        id: params[0] as string,
        created_at: new Date('2026-09-19T00:00:00Z'),
        note: params[1] as string | null,
      };
      batches.set(row.id, row);
      records.set(row.id, []);
      pendingRecords.set(row.id, new Set());
      return result([row]);
    }

    if (text.includes('FOR UPDATE')) {
      return result(await acquireBatchLock(tx!, params[0] as string));
    }

    if (text.includes('MAX(idx) + 1')) {
      const nextIdx = (records.get(params[0] as string) ?? []).length;
      return result([{ next_idx: nextIdx }]);
    }

    if (text.startsWith('INSERT INTO records')) {
      const row: RecordRow = {
        id: params[0] as string,
        batch_id: params[1] as string,
        idx: params[2] as number,
        status: params[3] as string,
        input: JSON.parse(params[4] as string),
        result: params[5] ? JSON.parse(params[5] as string) : null,
        errors: JSON.parse(params[6] as string),
        created_at: new Date('2026-09-19T00:00:00Z'),
      };
      if (!batches.has(row.batch_id)) {
        throw Object.assign(new Error('foreign key violation'), { code: '23503' });
      }
      const duplicateCommitted = (records.get(row.batch_id) ?? []).some((record) => record.idx === row.idx);
      const duplicatePending = [...(pendingRecords.get(row.batch_id) ?? [])].some((record) => record.idx === row.idx);
      if (duplicateCommitted || duplicatePending) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      tx!.pendingRecord = row;
      pendingRecords.get(row.batch_id)?.add(row);
      return result([row]);
    }

    if (text.includes('ORDER BY idx')) {
      return result([...(records.get(params[0] as string) ?? [])]);
    }

    if (text.includes('batch_id = $1 AND id = $2')) {
      return result((records.get(params[0] as string) ?? []).filter((record) => record.id === params[1]));
    }

    if (text.startsWith('SELECT id, created_at, note FROM batches')) {
      const batch = batches.get(params[0] as string);
      return result(batch ? [batch] : []);
    }

    return result([]);
  }

  const pool = {
    connect: connect.mockImplementation(async () => {
      const tx: Transaction = { id: nextTransactionId++, active: false };
      return {
        query: (text: string, params?: unknown[]) => executeQuery(tx, text, params),
        release: vi.fn(),
      } as unknown as PoolClient;
    }),
    query: (text: string, params?: unknown[]) => executeQuery(null, text, params),
    end: vi.fn(async () => undefined),
  } as unknown as Pool;

  return { pool, connect };
}

describe('PostgresBatchRepository（连接桩）', () => {
  it('追加记录在事务中锁定批次行并按 MAX(idx)+1 编号，批次间隔离，行正确映射', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);

    const b1 = await repo.createBatch('one');
    const b2 = await repo.createBatch('two');
    expect(b1.note).toBe('one');

    const r1 = await repo.appendRecord(b1.id, { status: 'ok', input: { k: 1 }, result: { kind: 'transform' }, errors: [] });
    const r2 = await repo.appendRecord(b1.id, {
      status: 'rejected',
      input: { k: 2 },
      result: null,
      errors: [{ code: 'X', field: 'f', message: 'm' }],
    });
    const r3 = await repo.appendRecord(b2.id, { status: 'ok', input: { k: 3 }, result: { kind: 'fault' }, errors: [] });

    expect([r1.index, r2.index, r3.index]).toEqual([0, 1, 0]);
    expect(r1.batchId).toBe(b1.id);
    expect(r2.batchId).toBe(b1.id);
    expect(r3.batchId).toBe(b2.id);
    expect(r2.status).toBe('rejected');
    expect(r2.errors[0]!.code).toBe('X');

    const list1 = await repo.listRecords(b1.id);
    expect(list1).toHaveLength(2);
    expect(list1.map((r) => r.index)).toEqual([0, 1]);

    const list2 = await repo.listRecords(b2.id);
    expect(list2).toHaveLength(1);

    const got = await repo.getRecord(b1.id, r2.id);
    expect(got!.id).toBe(r2.id);
    expect(await repo.getRecord(b1.id, 'nonexistent')).toBeNull();
    expect(await repo.getRecord(b2.id, r1.id)).toBeNull();
    expect(await repo.getBatch('nope')).toBeNull();

    // 追加走独立连接（事务）
    expect(fake.connect).toHaveBeenCalledTimes(3);
    await repo.close();
  });

  it('HTTP 并发追加同一批次时按批次行锁串行化：成功数与取回数一致，不抛错', async () => {
    const fake = makeLockingFakePool();
    const repo = new PostgresBatchRepository(fake.pool);
    const app = await buildApp(repo);
    const createRes = await app.inject({ method: 'POST', url: '/batches', payload: { note: 'http concurrency' } });
    const batch = createRes.json<{ id: string }>();
    const requestCount = 12;

    const payloads = Array.from({ length: requestCount }, (_, i) => {
      const marker = `pg-record-${i}`;
      return i % 3 === 2
        ? {
            kind: 'fault' as const,
            clientRequestId: marker,
            z1: phasor(1, 80),
            z2: phasor(1, 80),
            z0: phasor(2, 75),
            vf: phasor(1, i),
            rf: 0.1,
          }
        : {
            kind: 'transform' as const,
            clientRequestId: marker,
            quantity: i % 2 === 0 ? 'voltage' : 'current',
            direction: 'phase->sequence' as const,
            phases: balancedPositive(10 + i, i * 3),
          };
    });

    const responses = await Promise.all(
      payloads.map((payload) => app.inject({ method: 'POST', url: `/batches/${batch.id}/records`, payload })),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(
      Array.from({ length: requestCount }, () => 201),
    );
    const accepted = responses.map((response) => response.json<StoredRecord>());
    expect(new Set(accepted.map((record) => record.id)).size).toBe(requestCount);

    const listRes = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records` });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json<{ count: number; records: StoredRecord[] }>();
    expect(listed.count).toBe(requestCount);
    expect(listed.records).toHaveLength(requestCount);
    expect(listed.records.map((record) => record.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: requestCount }, (_, i) => i),
    );
    expect(listed.records.map((record) => (record.input as { clientRequestId: string }).clientRequestId).sort()).toEqual(
      payloads.map((payload) => payload.clientRequestId).sort(),
    );

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it('不同批次并发追加互不阻塞，仍保持各自批次内序号连续', async () => {
    const fake = makeLockingFakePool();
    const repo = new PostgresBatchRepository(fake.pool);
    const [batchA, batchB] = await Promise.all([repo.createBatch('A'), repo.createBatch('B')]);

    const makeRecord = (request: number) => ({
      status: 'ok' as const,
      input: { request },
      result: { kind: 'transform', request },
      errors: [],
    });
    const [recordsA, recordsB] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, (_, i) => repo.appendRecord(batchA.id, makeRecord(i)))),
      Promise.all(Array.from({ length: 8 }, (_, i) => repo.appendRecord(batchB.id, makeRecord(100 + i)))),
    ]);

    expect(recordsA.map((record) => record.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(recordsB.map((record) => record.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await repo.close();
  });
});
