import { describe, expect, it } from 'vitest';
import { processRecord } from '../src/records.js';
import { balancedPositive, phasor } from './helpers.js';

function forwardPhases(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'transform',
    quantity: 'voltage',
    direction: 'phase->sequence',
    phases: balancedPositive(10),
    ...overrides,
  };
}

describe('变换记录的非法输入', () => {
  it('幅值非正：MAGNITUDE_NON_POSITIVE，不给近似结果', () => {
    for (const bad of [0, -5, -0.001]) {
      const rec = processRecord(forwardPhases({ phases: { ...balancedPositive(10), b: phasor(bad, -120) } }));
      expect(rec.status).toBe('rejected');
      expect(rec.errors.some((e) => e.code === 'MAGNITUDE_NON_POSITIVE')).toBe(true);
      expect(rec.result).toBeNull();
    }
  });

  it('相角不是有限数：ANGLE_NOT_FINITE（NaN / Infinity / 字符串）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'abc', null]) {
      const rec = processRecord(forwardPhases({ phases: { ...balancedPositive(10), c: { magnitude: 10, angleDeg: bad } } }));
      expect(rec.status).toBe('rejected');
      expect(rec.errors.some((e) => e.code === 'ANGLE_NOT_FINITE' || e.code === 'MALFORMED_PHASOR')).toBe(true);
    }
  });

  it('缺了某一相：MISSING_PHASE', () => {
    const rec = processRecord(forwardPhases({ phases: { a: phasor(10, 0), b: phasor(10, -120) } }));
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'MISSING_PHASE' && e.field === 'phases.c')).toBe(true);
  });

  it('相量结构损坏：MALFORMED_PHASOR', () => {
    const rec = processRecord(forwardPhases({ phases: { a: [10, 0], b: phasor(10, -120), c: phasor(10, 120) } }));
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'MALFORMED_PHASOR')).toBe(true);
  });

  it('quantity / direction 非法：结构化 VALIDATION_FAILED', () => {
    const rec1 = processRecord({ kind: 'transform', quantity: 'power', direction: 'phase->sequence', phases: balancedPositive() });
    expect(rec1.status).toBe('rejected');
    expect(rec1.errors[0]!.field).toBe('quantity');

    const rec2 = processRecord({ kind: 'transform', quantity: 'voltage', direction: 'sideways', phases: balancedPositive() });
    expect(rec2.status).toBe('rejected');
    expect(rec2.errors[0]!.field).toBe('direction');
  });

  it('未知记录类型：UNSUPPORTED_RECORD', () => {
    const rec = processRecord({ kind: 'power-flow' });
    expect(rec.status).toBe('rejected');
    expect(rec.errors[0]!.code).toBe('UNSUPPORTED_RECORD');
  });
});

describe('线量（线电压）零序约束', () => {
  it('正变换：线量三相算出非零零序被拒绝', () => {
    // 三个幅值不等且同相的相量，零序明显非零
    const rec = processRecord({
      kind: 'transform',
      quantity: 'voltage',
      direction: 'phase->sequence',
      phaseMode: 'line',
      phases: { a: phasor(10, 0), b: phasor(9, 0), c: phasor(8, 0) },
    });
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'LINE_ZERO_SEQUENCE_NOT_ZERO')).toBe(true);
  });

  it('正变换：真正的线电压（零序为零）放行', () => {
    // Vab, Vbc, Vca
    const rec = processRecord({
      kind: 'transform',
      quantity: 'voltage',
      direction: 'phase->sequence',
      phaseMode: 'line',
      phases: {
        a: { magnitude: 17.320508075688, angleDeg: 30 },
        b: { magnitude: 17.320508075688, angleDeg: -90 },
        c: { magnitude: 17.320508075688, angleDeg: 150 },
      },
    });
    expect(rec.status).toBe('ok');
  });

  it('反变换：给线量传非零零序被拒绝', () => {
    const rec = processRecord({
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      phaseMode: 'line',
      sequence: {
        zero: phasor(1, 0),
        positive: phasor(10, 0),
        negative: phasor(0, 0.001),
      },
    });
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'LINE_ZERO_SEQUENCE_NOT_ZERO')).toBe(true);
  });

  it('反变换：线量零序为零放行', () => {
    const rec = processRecord({
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      phaseMode: 'line',
      sequence: {
        zero: phasor(1e-12, 0),
        positive: phasor(10, 30),
        negative: phasor(0, 0),
      },
    });
    expect(rec.status).toBe('ok');
  });

  it('电流不允许 line 模式', () => {
    const rec = processRecord({
      kind: 'transform',
      quantity: 'current',
      direction: 'phase->sequence',
      phaseMode: 'line',
      phases: balancedPositive(100),
    });
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'LINE_MODE_NOT_APPLICABLE_TO_CURRENT')).toBe(true);
  });
});

describe('记录留存输入输出', () => {
  it('被拒绝的记录保留原始输入与字段路径', () => {
    const raw = forwardPhases({ phases: { a: phasor(10, 0) } });
    const rec = processRecord(raw);
    expect(rec.status).toBe('rejected');
    expect((rec.input as { phases: unknown }).phases).toEqual(raw.phases);
    expect(rec.errors.every((e) => typeof e.field === 'string')).toBe(true);
  });
});
