import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { InMemoryBatchRepository } from '../src/persistence/memory.js';
import type { StoredRecord, TransformResultPayload } from '../src/types.js';
import { balancedPositive, phasor } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(new InMemoryBatchRepository());
});

afterAll(async () => {
  await app.close();
});

async function createBatch(note?: string) {
  const res = await app.inject({ method: 'POST', url: '/batches', payload: note ? { note } : {} });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; createdAt: string; note: string | null }>();
}

describe('批次生命周期', () => {
  it('开立批次 -> 投记录 -> 整批取回 -> 单条取回', async () => {
    const batch = await createBatch('roundtrip over http');

    const addRes = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: {
        kind: 'transform',
        quantity: 'voltage',
        direction: 'phase->sequence',
        phases: balancedPositive(10),
      },
    });
    expect(addRes.statusCode).toBe(201);
    const rec = addRes.json<StoredRecord>();
    expect(rec.status).toBe('ok');
    expect(rec.index).toBe(0);
    expect(rec.result!.kind).toBe('transform');

    const getBatch = await app.inject({ method: 'GET', url: `/batches/${batch.id}` });
    expect(getBatch.statusCode).toBe(200);
    const body = getBatch.json<{ id: string; records: StoredRecord[] }>();
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.id).toBe(rec.id);

    const getOne = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records/${rec.id}` });
    expect(getOne.statusCode).toBe(200);
    expect(getOne.json<StoredRecord>().id).toBe(rec.id);
  });

  it('正反变换通过 HTTP 绕一圈回到原始三相（闭合）', async () => {
    const batch = await createBatch();
    const original = {
      a: phasor(12.5, 20),
      b: phasor(8.1, -95),
      c: phasor(15.3, 140),
    };

    const fwd = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: original },
    });
    const fwdRec = fwd.json<StoredRecord>();
    const sequence = (fwdRec.result as TransformResultPayload).sequence;

    const inv = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', sequence },
    });
    const invRec = inv.json<StoredRecord>();
    const back = (invRec.result as TransformResultPayload).phases;

    for (const k of ['a', 'b', 'c'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(original[k]!.magnitude, 8);
      expect(back[k]!.angleDeg).toBeCloseTo(original[k]!.angleDeg, 8);
    }

    const all = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records` });
    const listed = all.json<{ records: StoredRecord[] }>();
    expect(listed.records).toHaveLength(2);
    expect(listed.records[0]!.result).not.toBeNull();
    expect(listed.records[1]!.result).not.toBeNull();
  });

  it('批量投入：同一请求里多条记录各自独立留存，索引递增', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: [
        { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: balancedPositive(100) },
        { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: { a: phasor(0, 0) } },
        {
          kind: 'fault',
          z1: phasor(1, 80),
          z2: phasor(1, 80),
          z0: phasor(2, 75),
          vf: phasor(1, 0),
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ count: number; records: StoredRecord[] }>();
    expect(body.count).toBe(3);
    expect(body.records.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(body.records[0]!.status).toBe('ok');
    expect(body.records[1]!.status).toBe('rejected');
    expect(body.records[2]!.status).toBe('ok');
    // 被拒绝的记录同样留存
    const listed = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records` });
    expect(listed.json<{ records: StoredRecord[] }>().records).toHaveLength(3);
  });

  it('故障记录经 HTTP 核算并留存', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: {
        kind: 'fault',
        z1: phasor(1, 80),
        z2: phasor(1, 80),
        z0: phasor(3, 70),
        vf: phasor(1, 0),
        rf: 0.1,
      },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<StoredRecord>();
    expect(rec.status).toBe('ok');
    expect(rec.result!.kind).toBe('fault');
  });

  it('非法记录单条投递返回 422 + 结构化错误，且已留存', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: balancedPositive(-3) },
    });
    expect(res.statusCode).toBe(422);
    const rec = res.json<StoredRecord>();
    expect(rec.status).toBe('rejected');
    expect(rec.errors.length).toBeGreaterThan(0);
    expect(rec.errors[0]!.code).toBe('MAGNITUDE_NON_POSITIVE');
  });

  it('批次不存在：404 类型化错误', async () => {
    const res = await app.inject({ method: 'GET', url: '/batches/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BATCH_NOT_FOUND');
  });

  it('损坏的 JSON 体：结构化 400，服务不崩', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    // 服务仍可用
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });
});

describe('并发批次隔离', () => {
  it('并发开立多个批次并交错投递，结果不串号、不覆盖', async () => {
    const batches = await Promise.all([createBatch('c1'), createBatch('c2'), createBatch('c3'), createBatch('c4')]);

    // 每个批次并发投 12 条
    await Promise.all(
      batches.flatMap((b, bi) =>
        Array.from({ length: 12 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: `/batches/${b.id}/records`,
            payload: {
              kind: 'transform',
              quantity: 'voltage',
              direction: 'phase->sequence',
              phases: balancedPositive(10 + bi, i * 3),
            },
          }),
        ),
      ),
    );

    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi]!;
      const res = await app.inject({ method: 'GET', url: `/batches/${b.id}/records` });
      const body = res.json<{ records: StoredRecord[] }>();
      expect(body.records).toHaveLength(12);
      // 索引唯一且连续
      expect(body.records.map((r) => r.index).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      // 每条记录都属于本批次，正序幅值 = 投入的相电压幅值
      for (const r of body.records) {
        expect(r.batchId).toBe(b.id);
        const result = r.result as TransformResultPayload;
        expect(result.sequence.positive.magnitude).toBeCloseTo(10 + bi, 8);
      }
    }
  });
});
