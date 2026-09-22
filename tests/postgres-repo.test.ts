import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresBatchRepository } from '../src/persistence/postgres.js';

interface FakeTransaction {
  inTransaction: boolean;
  lockedBatchId: string | null;
}

interface FakeRecordRow {
  id: unknown;
  batch_id: unknown;
  idx: number;
  status: unknown;
  input: unknown;
  result: unknown;
  errors: unknown;
  created_at: Date;
}

function makeQueryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return { rows, command: '', oid: 0, fields: [], rowCount: rows.length };
}

/**
 * 内存假库：模拟 PostgreSQL 事务、FOR UPDATE 行锁和 UNIQUE(batch_id, idx) 约束。
 * 若 appendRecord 没有先锁批次父行，并发事务会同时读到相同 MAX(idx)，随后像真库一样
 * 只有一个 INSERT 成功，其余请求收到 23505。
 */
function makeFakePool() {
  const batches = new Map<string, { id: string; created_at: Date; note: string | null }>();
  const records = new Map<string, FakeRecordRow[]>();
  let lockedBatchId: string | null = null;
  let lockWaiters: Array<() => void> = [];
  let transactionSeq = 0;

  function releaseLock(txn: FakeTransaction): void {
    if (txn.lockedBatchId === null || txn.lockedBatchId !== lockedBatchId) {
      txn.lockedBatchId = null;
      return;
    }
    lockedBatchId = null;
    txn.lockedBatchId = null;
    lockWaiters.shift()?.();
  }

  function acquireLock(batchId: string, txn: FakeTransaction): Promise<void> {
    if (!txn.inTransaction) {
      throw new Error('FOR UPDATE must run inside a transaction');
    }
    if (lockedBatchId === null) {
      lockedBatchId = batchId;
      txn.lockedBatchId = batchId;
      return Promise.resolve();
    }
    if (txn.lockedBatchId === batchId) return Promise.resolve();
    return new Promise((resolve) => {
      lockWaiters.push(() => {
        lockedBatchId = batchId;
        txn.lockedBatchId = batchId;
        resolve();
      });
    });
  }

  async function executeQuery(text: string, params: unknown[] = [], txn?: FakeTransaction): Promise<QueryResult<QueryResultRow>> {
    let rows: QueryResultRow[] = [];

    if (text === 'BEGIN') {
      if (txn) {
        txn.inTransaction = true;
        txn.lockedBatchId = null;
      }
      return makeQueryResult(rows);
    }

    if (text === 'COMMIT') {
      if (txn) {
        releaseLock(txn);
        txn.inTransaction = false;
      }
      return makeQueryResult(rows);
    }

    if (text === 'ROLLBACK') {
      if (txn) {
        releaseLock(txn);
        txn.inTransaction = false;
      }
      return makeQueryResult(rows);
    }

    if (text.startsWith('SELECT id FROM batches WHERE id = $1 FOR UPDATE')) {
      const batchId = params[0] as string;
      if (!batches.has(batchId)) return makeQueryResult(rows);
      await acquireLock(batchId, txn!);
      return makeQueryResult([{ id: batchId }]);
    }

    if (text.startsWith('INSERT INTO batches')) {
      rows = [{ id: params[0], created_at: new Date('2026-09-19T00:00:00Z'), note: params[1] as string | null }];
      batches.set(params[0] as string, rows[0]);
      records.set(params[0] as string, []);
      return makeQueryResult(rows);
    }

    if (text.startsWith('SELECT id, created_at, note FROM batches')) {
      const b = batches.get(params[0] as string);
      rows = b ? [b] : [];
      return makeQueryResult(rows);
    }

    if (text.includes('MAX(idx) + 1')) {
      rows = [{ next_idx: (records.get(params[0] as string) ?? []).length }];
      return makeQueryResult(rows);
    }

    if (text.startsWith('INSERT INTO records')) {
      const batchId = params[1] as string;
      const idx = params[2] as number;
      const batchRecords = records.get(batchId);
      if (!batchRecords) throw Object.assign(new Error('batch row is not visible'), { code: '23503' });
      if (batchRecords.some((r) => r.idx === idx)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "records_batch_id_idx_key"'), {
          code: '23505',
          constraint: 'records_batch_id_idx_key',
        });
      }

      const row: FakeRecordRow = {
        id: params[0],
        batch_id: batchId,
        idx,
        status: params[3],
        input: JSON.parse(params[4] as string),
        result: params[5] ? JSON.parse(params[5] as string) : null,
        errors: JSON.parse(params[6] as string),
        created_at: new Date('2026-09-19T00:00:00Z'),
      };
      batchRecords.push(row);
      return makeQueryResult([row]);
    }

    if (text.includes('ORDER BY idx')) {
      rows = [...(records.get(params[0] as string) ?? [])].sort((a, b) => a.idx - b.idx);
      return makeQueryResult(rows);
    }

    if (text.includes('batch_id = $1 AND id = $2')) {
      rows = (records.get(params[0] as string) ?? []).filter((r) => r.id === params[1]);
      return makeQueryResult(rows);
    }

    return makeQueryResult(rows);
  }

  const connect = vi.fn(async (): Promise<PoolClient> => {
    const txn: FakeTransaction = { inTransaction: false, lockedBatchId: null };
    const client = {
      id: ++transactionSeq,
      query: vi.fn((text: string, params?: unknown[]) => executeQuery(text, params, txn)),
      release: vi.fn(() => {
        releaseLock(txn);
      }),
    };
    return client as unknown as PoolClient;
  });

  const pool = {
    connect,
    query: vi.fn((text: string, params?: unknown[]) => executeQuery(text, params)),
    end: vi.fn(async () => undefined),
  } as unknown as Pool;

  return { pool, connect };
}

describe('PostgresBatchRepository（连接桩）', () => {
  it('追加记录在事务中按 MAX(idx)+1 编号，批次间隔离，行正确映射', async () => {
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

  it('同一批次并发追加：锁批次父行后分配序号，12 个成功请求全部入库且索引唯一连续', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);
    const batch = await repo.createBatch('concurrent same batch');

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repo.appendRecord(batch.id, {
          status: 'ok',
          input: { sequence: i } as never,
          result: { kind: 'transform', sequence: i } as never,
          errors: [],
        }),
      ),
    );

    expect(results).toHaveLength(12);
    expect(new Set(results.map((r) => r.id)).size).toBe(12);
    expect(results.map((r) => r.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));

    const stored = await repo.listRecords(batch.id);
    expect(stored).toHaveLength(12);
    expect(stored.map((r) => r.index)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(stored.every((r) => r.status === 'ok')).toBe(true);

    await repo.close();
  });
});
