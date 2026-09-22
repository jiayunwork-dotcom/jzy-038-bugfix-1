/**
 * PostgreSQL 仓储：batches / records 两张表，JSONB 存输入、输出与错误。
 * 批次内记录序号在插入事务中生成；先锁住对应批次行，再读取 MAX(idx)，
 * 从而把同一批次的并发追加串行化，避免重复序号触发 UNIQUE 冲突或丢件。
 * 不同批次锁不同行，仍可并发写入。
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';
import type { Batch, StoredRecord } from '../types.js';
import type { BatchRepository } from './repository.js';

type StoredRecordData = Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>;

function mapBatch(row: { id: string; created_at: Date | string; note: string | null }): Batch {
  return {
    id: row.id,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    note: row.note,
  };
}

function mapRecord(row: {
  id: string;
  batch_id: string;
  idx: number;
  created_at: Date | string;
  status: string;
  input: unknown;
  result: unknown;
  errors: unknown;
}): StoredRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    index: row.idx,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    status: row.status as StoredRecord['status'],
    input: row.input as StoredRecord['input'],
    result: row.result as StoredRecord['result'],
    errors: row.errors as StoredRecord['errors'],
  };
}

export class PostgresBatchRepository implements BatchRepository {
  private readonly pool: Pool;

  constructor(connectionStringOrPool: string | Pool) {
    this.pool =
      typeof connectionStringOrPool === 'string'
        ? new pg.Pool({ connectionString: connectionStringOrPool, max: 10 })
        : connectionStringOrPool;
  }

  async createBatch(note: string | null): Promise<Batch> {
    const id = randomUUID();
    const res = await this.pool.query<{ id: string; created_at: Date; note: string | null }>(
      'INSERT INTO batches (id, note) VALUES ($1, $2) RETURNING id, created_at, note',
      [id, note],
    );
    return mapBatch(res.rows[0]!);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const res = await this.pool.query('SELECT id, created_at, note FROM batches WHERE id = $1', [id]);
    return res.rows[0] ? mapBatch(res.rows[0]) : null;
  }

  async appendRecord(batchId: string, record: StoredRecordData): Promise<StoredRecord> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE 持有到 COMMIT：同批次的后续插入会在此等待，保证 MAX(idx) 与 INSERT 是临界区。
      const lockRes = await client.query<{ id: string }>(
        'SELECT id FROM batches WHERE id = $1 FOR UPDATE',
        [batchId],
      );
      if (lockRes.rowCount === 0) {
        throw new Error(`batch ${batchId} not found`);
      }
      const idxRes = await client.query<{ next_idx: number }>(
        'SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM records WHERE batch_id = $1',
        [batchId],
      );
      const nextIdx = idxRes.rows[0]!.next_idx;
      const res = await client.query(
        `INSERT INTO records (id, batch_id, idx, status, input, result, errors)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, batch_id, idx, created_at, status, input, result, errors`,
        [
          randomUUID(),
          batchId,
          nextIdx,
          record.status,
          JSON.stringify(record.input),
          record.result === null ? null : JSON.stringify(record.result),
          JSON.stringify(record.errors),
        ],
      );
      await client.query('COMMIT');
      return mapRecord(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRecords(batchId: string): Promise<StoredRecord[]> {
    const res = await this.pool.query(
      'SELECT id, batch_id, idx, created_at, status, input, result, errors FROM records WHERE batch_id = $1 ORDER BY idx ASC',
      [batchId],
    );
    return res.rows.map(mapRecord);
  }

  async getRecord(batchId: string, recordId: string): Promise<StoredRecord | null> {
    const res = await this.pool.query(
      'SELECT id, batch_id, idx, created_at, status, input, result, errors FROM records WHERE batch_id = $1 AND id = $2',
      [batchId, recordId],
    );
    return res.rows[0] ? mapRecord(res.rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
