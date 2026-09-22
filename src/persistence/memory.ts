/**
 * 内存仓储：Map 按批次 id 隔离，记录在批次内按追加顺序编号。
 * 进程内并发安全（Node 单线程事件循环，await 期间不产生交错写）。
 */

import { randomUUID } from 'node:crypto';
import type { Batch, StoredRecord } from '../types.js';
import type { BatchRepository } from './repository.js';

interface BatchRow {
  batch: Batch;
  records: StoredRecord[];
}

export class InMemoryBatchRepository implements BatchRepository {
  private readonly batches = new Map<string, BatchRow>();

  async createBatch(note: string | null): Promise<Batch> {
    const batch: Batch = { id: randomUUID(), createdAt: new Date().toISOString(), note };
    this.batches.set(batch.id, { batch, records: [] });
    return batch;
  }

  async getBatch(id: string): Promise<Batch | null> {
    return this.batches.get(id)?.batch ?? null;
  }

  async appendRecord(batchId: string, record: Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>): Promise<StoredRecord> {
    const row = this.batches.get(batchId);
    if (!row) throw new Error(`batch ${batchId} not found`);
    const stored: StoredRecord = {
      ...record,
      id: randomUUID(),
      batchId,
      index: row.records.length,
      createdAt: new Date().toISOString(),
    };
    row.records.push(stored);
    return stored;
  }

  async listRecords(batchId: string): Promise<StoredRecord[]> {
    const row = this.batches.get(batchId);
    return row ? [...row.records] : [];
  }

  async getRecord(batchId: string, recordId: string): Promise<StoredRecord | null> {
    const row = this.batches.get(batchId);
    if (!row) return null;
    return row.records.find((r) => r.id === recordId) ?? null;
  }

  async close(): Promise<void> {
    this.batches.clear();
  }
}
