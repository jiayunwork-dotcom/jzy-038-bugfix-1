import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresBatchRepository } from '../src/persistence/postgres.js';

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
});
