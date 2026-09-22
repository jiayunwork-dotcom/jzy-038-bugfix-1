import { describe, expect, it } from 'vitest';
import { Complex } from '../src/complex.js';
import { calculateSlgFault } from '../src/kernel/fault.js';
import { processRecord } from '../src/records.js';
import { expectMagnitudeClose, phasor } from './helpers.js';

function runFault(overrides: { z1?: Complex; z2?: Complex; z0?: Complex; vf?: Complex; rf?: number } = {}) {
  return calculateSlgFault({
    z1: overrides.z1 ?? Complex.polar(1, 80),
    z2: overrides.z2 ?? Complex.polar(1, 80),
    z0: overrides.z0 ?? Complex.polar(2, 75),
    vf: overrides.vf ?? Complex.polar(1, 0),
    rf: overrides.rf ?? 0.1,
  });
}

describe('单相接地：三序串联', () => {
  it('I1=I2=I0=Vf/(Z1+Z2+Z0+3Rf)，故障相电流 = 3I0', () => {
    const out = runFault();
    const denom = Complex.polar(1, 80)
      .add(Complex.polar(1, 80))
      .add(Complex.polar(2, 75))
      .add(Complex.ONE.scale(0.3));
    const iExpected = Complex.polar(1, 0).div(denom);
    expect(out.iSequence.re).toBeCloseTo(iExpected.re, 10);
    expect(out.iSequence.im).toBeCloseTo(iExpected.im, 10);
    // Ia = 3 I0
    expect(out.faultCurrent.re).toBeCloseTo(3 * iExpected.re, 10);
    expect(out.faultCurrent.im).toBeCloseTo(3 * iExpected.im, 10);
  });

  it('金属性接地（Rf=0）故障相电压为零、跌落等于 |Vf|', () => {
    const out = runFault({ rf: 0 });
    expect(out.faultedPhaseVoltage.magnitude).toBeLessThan(1e-10);
    expect(out.voltageSag).toBeCloseTo(1, 10);
  });

  it('金属性接地满足 V0+V1+V2=0（边界条件 Va=0）', () => {
    const out = runFault({ rf: 0 });
    const va = out.v0.add(out.v1).add(out.v2);
    expect(va.magnitude).toBeLessThan(1e-10);
  });

  it('经 Rf 接地满足 Va = 3 Rf I1', () => {
    const rf = 0.25;
    const out = runFault({ rf });
    const expected = out.iSequence.scale(3 * rf);
    expect(out.faultedPhaseVoltage.re).toBeCloseTo(expected.re, 10);
    expect(out.faultedPhaseVoltage.im).toBeCloseTo(expected.im, 10);
    // V1 + V2 + V0 也等于 Va
    const sum = out.v1.add(out.v2).add(out.v0);
    expect(sum.magnitude).toBeCloseTo(out.faultedPhaseVoltage.magnitude, 9);
  });

  it('序电流单调随故障电阻增大而减小，电压跌落同方向减小（同趋势）', () => {
    const sags: number[] = [];
    const currents: number[] = [];
    for (const rf of [0, 0.05, 0.2, 0.6, 1.5]) {
      const out = runFault({ rf });
      currents.push(out.iSequence.magnitude);
      sags.push(out.voltageSag);
    }
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]!).toBeLessThan(currents[i - 1]!);
      expect(sags[i]!).toBeLessThan(sags[i - 1]!);
    }
  });

  it('零序阻抗增大时：序电流减小，电压跌落增大（同向变化）', () => {
    const sags: number[] = [];
    const currents: number[] = [];
    for (const z0mag of [0.5, 1, 2, 4, 8]) {
      const out = runFault({ z0: Complex.polar(z0mag, 75) });
      currents.push(out.iSequence.magnitude);
      sags.push(out.voltageSag);
    }
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]!).toBeLessThan(currents[i - 1]!);
      expect(sags[i]!).toBeGreaterThan(sags[i - 1]!);
    }
  });

  it('故障前电压越高，故障电流与跌落同向增大', () => {
    const prev = runFault({ vf: Complex.polar(0.5, 0) });
    const high = runFault({ vf: Complex.polar(1.5, 0) });
    expect(high.iSequence.magnitude).toBeGreaterThan(prev.iSequence.magnitude);
    expect(high.voltageSag).toBeGreaterThan(prev.voltageSag);
  });
});

describe('故障核算的非法输入（记录级结构化拒绝）', () => {
  const base = {
    kind: 'fault',
    z1: phasor(1, 80),
    z2: phasor(1, 80),
    z0: phasor(2, 75),
    vf: phasor(1, 0),
  };

  it('阻抗实部非正被拒绝，错误类型为 IMPEDANCE_NON_POSITIVE', () => {
    // 纯电抗（90°，实部浮点约 6e-17）与容性大角度（实部为负）
    for (const bad of [phasor(1, 90), phasor(1, 120), phasor(2, 95)]) {
      const rec = processRecord({ ...base, z0: bad });
      expect(rec.status).toBe('rejected');
      expect(rec.errors.some((e) => e.code === 'IMPEDANCE_NON_POSITIVE'), `角度 ${bad.angleDeg} 应被实部校验拒绝`).toBe(true);
      expect(rec.result).toBeNull();
    }
  });

  it('阻抗幅值为负被拒绝，错误类型为 MAGNITUDE_NON_POSITIVE', () => {
    const rec = processRecord({ ...base, z0: { magnitude: -1, angleDeg: 0 } });
    expect(rec.status).toBe('rejected');
    expect(rec.errors.some((e) => e.code === 'MAGNITUDE_NON_POSITIVE')).toBe(true);
  });

  it('故障电阻为负被拒绝：FAULT_IMPEDANCE_NON_POSITIVE', () => {
    const rec = processRecord({ ...base, rf: -0.01 });
    expect(rec.status).toBe('rejected');
    expect(rec.errors[0]!.code).toBe('FAULT_IMPEDANCE_NON_POSITIVE');
  });

  it('缺阻抗、相角为 NaN/Infinity 被拒绝，服务不崩溃', () => {
    const missing = processRecord({ kind: 'fault', z1: phasor(1, 80), z2: phasor(1, 80), vf: phasor(1, 0) });
    expect(missing.status).toBe('rejected');
    expect(missing.errors.some((e) => e.code === 'IMPEDANCE_NON_POSITIVE')).toBe(true);

    const nanAngle = processRecord({ ...base, vf: { magnitude: 1, angleDeg: Number.NaN } });
    expect(nanAngle.status).toBe('rejected');
    expect(nanAngle.errors.some((e) => e.code === 'ANGLE_NOT_FINITE')).toBe(true);
  });

  it('合法故障记录返回完整结果', () => {
    const rec = processRecord(base);
    expect(rec.status).toBe('ok');
    expect(rec.result!.kind).toBe('fault');
  });
});

describe('跌落方向定义', () => {
  it('电压跌落以幅值差表示且非负', () => {
    const out = runFault();
    expect(out.voltageSag).toBeGreaterThan(0);
    expectMagnitudeClose(out.voltageSag, 1 - out.faultedPhaseVoltage.magnitude, 1e-12);
  });
});
