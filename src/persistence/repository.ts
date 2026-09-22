/**
 * 批次与记录的持久化仓储接口。
 * 内存实现（测试/默认）与 PostgreSQL 实现（容器部署）实现同一接口，
 * 不同批次、同一批次不同记录各自独立存储，按 id/index 精确定位。
 */

import type { Batch, StoredRecord } from '../types.js';

export interface BatchRepository {
  createBatch(note: string | null): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  appendRecord(batchId: string, record: Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>): Promise<StoredRecord>;
  listRecords(batchId: string): Promise<StoredRecord[]>;
  getRecord(batchId: string, recordId: string): Promise<StoredRecord | null>;
  close(): Promise<void>;
}
