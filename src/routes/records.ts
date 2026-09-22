/**
 * HTTP 路由：以「换算批次」为中心。
 *
 *   POST   /batches                     开立批次
 *   POST   /batches/:id/records         向批次投入一条或多条记录（支持单对象或数组）
 *   GET    /batches/:id                 查批次（含全部记录）
 *   GET    /batches/:id/records         取批次内全部记录
 *   GET    /batches/:id/records/:rid    只取一条记录
 *   GET    /health                      健康检查
 *
 * 非法输入返回 4xx + 结构化错误体（error.code / error.fields[]），服务不崩溃。
 * 被校验拒绝的记录仍入库（status=rejected），单条投递交 422，批量投递交 200（逐条标状态）。
 */

import type { FastifyInstance } from 'fastify';
import { processRecord } from '../records.js';
import type { BatchRepository } from '../persistence/repository.js';
import type { StoredRecord } from '../types.js';

interface BatchParams {
  id: string;
}

interface RecordParams extends BatchParams {
  rid: string;
}

export async function registerRoutes(app: FastifyInstance, repo: BatchRepository): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  // 开立批次
  app.post('/batches', async (request, reply) => {
    const body = (request.body ?? {}) as { note?: unknown };
    const note = typeof body.note === 'string' ? body.note : body.note === undefined ? null : String(body.note);
    const batch = await repo.createBatch(note);
    return reply.code(201).send(batch);
  });

  // 投入记录（单条或批量）
  app.post<{ Params: BatchParams }>('/batches/:id/records', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const rawList = Array.isArray(request.body) ? request.body : [request.body];
    if (rawList.length === 0) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: '记录数组不能为空' } });
    }

    const stored: StoredRecord[] = [];
    for (const raw of rawList) {
      const processed = processRecord(raw);
      stored.push(await repo.appendRecord(id, processed));
    }

    const allOk = stored.every((r) => r.status === 'ok');
    if (!Array.isArray(request.body)) {
      return reply.code(allOk ? 201 : 422).send(stored[0]);
    }
    return reply.code(allOk ? 201 : 200).send({ batchId: id, count: stored.length, records: stored });
  });

  // 查批次（含全部记录）
  app.get<{ Params: BatchParams }>('/batches/:id', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const records = await repo.listRecords(id);
    return { ...batch, records };
  });

  // 取全部记录
  app.get<{ Params: BatchParams }>('/batches/:id/records', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const records = await repo.listRecords(id);
    return { batchId: id, count: records.length, records };
  });

  // 取单条记录
  app.get<{ Params: RecordParams }>('/batches/:id/records/:rid', async (request, reply) => {
    const { id, rid } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const record = await repo.getRecord(id, rid);
    if (!record) {
      return reply.code(404).send({ error: { code: 'RECORD_NOT_FOUND', message: `批次 ${id} 下记录 ${rid} 不存在` } });
    }
    return record;
  });
}
