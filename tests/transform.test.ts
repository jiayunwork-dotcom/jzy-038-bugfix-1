import { describe, expect, it } from 'vitest';
import { A, Complex } from '../src/complex.js';
import {
  ANALYSIS_MATRIX,
  phasesToSequence,
  sequenceToPhases,
  SYNTHESIS_MATRIX,
} from '../src/kernel/transform.js';
import { balancedNegative, balancedPositive, c, expectComplexClose, expectMagnitudeClose, phasor } from './helpers.js';

const TOL = 1e-9;

function randomPhases(seed: number) {
  // 确定性伪随机三相，幅值为正
  const r = (n: number) => {
    const x = Math.sin(seed * 91.7 + n * 47.3) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    a: Complex.polar(1 + 4 * r(1), -180 + 360 * r(2)),
    b: Complex.polar(1 + 4 * r(3), -180 + 360 * r(4)),
    c: Complex.polar(1 + 4 * r(5), -180 + 360 * r(6)),
  };
}

describe('正反变换严格配对（同一套系数）', () => {
  it('分析矩阵是合成矩阵的逆：A·S = I', () => {
    const m = ANALYSIS_MATRIX;
    const s = SYNTHESIS_MATRIX;
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) {
        let v = Complex.ZERO;
        for (let k = 0; k < 3; k++) v = v.add(m[r * 3 + k]!.mul(s[k * 3 + col]!));
        const expected = r === col ? 1 : 0;
        expect(v.magnitude).toBeCloseTo(expected, 9);
      }
    }
  });

  it('分析矩阵恒等于 (1/3)·[1 1 1; 1 a a²; 1 a² a]', () => {
    const third = (z: Complex) => z.scale(1 / 3);
    const expected = [
      [Complex.ONE, Complex.ONE, Complex.ONE],
      [Complex.ONE, A, A.mul(A)],
      [Complex.ONE, A.mul(A), A],
    ].flat() as Complex[];
    ANALYSIS_MATRIX.forEach((entry, i) => {
      expectComplexClose(entry, third(expected[i]!), TOL);
    });
  });

  it('随机三相：phase->sequence->phase 闭合，回到原值', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const original = randomPhases(seed);
      const seq = phasesToSequence(original);
      const back = sequenceToPhases(seq);
      expectComplexClose(back.a, original.a, TOL);
      expectComplexClose(back.b, original.b, TOL);
      expectComplexClose(back.c, original.c, TOL);
    }
  });

  it('随机序量：sequence->phase->sequence 反方向也闭合', () => {
    for (let seed = 100; seed <= 120; seed++) {
      const original = randomPhases(seed);
      const seq0 = {
        zero: original.a.scale(0.3),
        positive: original.b,
        negative: original.c,
      };
      const phases = sequenceToPhases(seq0);
      const back = phasesToSequence(phases);
      expectComplexClose(back.zero, seq0.zero, TOL);
      expectComplexClose(back.positive, seq0.positive, TOL);
      expectComplexClose(back.negative, seq0.negative, TOL);
    }
  });
});

describe('平衡正序退化', () => {
  it('平衡正序输入：零序、负序为零，正序幅值等于相电压幅值', () => {
    const V = 10;
    const seq = phasesToSequence({
      a: c(balancedPositive(V, 15).a),
      b: c(balancedPositive(V, 15).b),
      c: c(balancedPositive(V, 15).c),
    });
    expect(seq.zero.magnitude).toBeLessThan(1e-9 * V);
    expect(seq.negative.magnitude).toBeLessThan(1e-9 * V);
    expectMagnitudeClose(seq.positive.magnitude, V);
    expect(seq.positive.angleDeg).toBeCloseTo(15, 9);
  });

  it('纯正序反变换：三相幅值相等、相位互差 120°（A-B 为 -120°，A-C 为 +120°）', () => {
    const phases = sequenceToPhases({
      zero: Complex.ZERO,
      positive: Complex.polar(7, 40),
      negative: Complex.ZERO,
    });
    expectMagnitudeClose(phases.a.magnitude, 7);
    expectMagnitudeClose(phases.b.magnitude, 7);
    expectMagnitudeClose(phases.c.magnitude, 7);
    expect(((phases.b.angleDeg - phases.a.angleDeg + 540) % 360) - 180).toBeCloseTo(-120, 9);
    expect(((phases.c.angleDeg - phases.a.angleDeg + 540) % 360) - 180).toBeCloseTo(120, 9);
  });

  it('纯零序反变换：三相同幅同相', () => {
    const phases = sequenceToPhases({
      zero: Complex.polar(3, -25),
      positive: Complex.ZERO,
      negative: Complex.ZERO,
    });
    for (const p of [phases.a, phases.b, phases.c]) {
      expectMagnitudeClose(p.magnitude, 3);
      expect(p.angleDeg).toBeCloseTo(-25, 9);
    }
  });
});

describe('三相之和 = 3 × 零序', () => {
  it('多组随机三相均满足 Va+Vb+Vc = 3V0', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = randomPhases(seed + 500);
      const seq = phasesToSequence(p);
      const sum = p.a.add(p.b).add(p.c);
      expectComplexClose(sum, seq.zero.scale(3), 1e-9);
    }
  });
});

describe('相序反转的能量转移（B、C 对调）', () => {
  it('平衡正序对调 B/C 后：能量全部从正序转移到负序', () => {
    const pos = balancedPositive(10);
    const seqBefore = phasesToSequence({ a: c(pos.a), b: c(pos.b), c: c(pos.c) });
    expectMagnitudeClose(seqBefore.positive.magnitude, 10);
    expect(seqBefore.negative.magnitude).toBeLessThan(1e-8);

    const swapped = { a: c(pos.a), b: c(pos.c), c: c(pos.b) };
    const seqAfter = phasesToSequence(swapped);
    expect(seqAfter.zero.magnitude).toBeLessThan(1e-8);
    expect(seqAfter.positive.magnitude).toBeLessThan(1e-8);
    expectMagnitudeClose(seqAfter.negative.magnitude, 10);
  });

  it('一般不对称三相：对调 B/C 后 |V1| 与 |V2| 互换，零序不变', () => {
    const p = randomPhases(7);
    const before = phasesToSequence(p);
    const after = phasesToSequence({ a: p.a, b: p.c, c: p.b });
    expectMagnitudeClose(after.positive.magnitude, before.negative.magnitude);
    expectMagnitudeClose(after.negative.magnitude, before.positive.magnitude);
    expectComplexClose(after.zero, before.zero, 1e-10);
  });

  it('序能量守恒视角：|V0|²+|V1|²+|V2|² = (|Va|²+|Vb|²+|Vc|²)/3，对调前后不变', () => {
    const p = randomPhases(11);
    const seqEnergy = (s: ReturnType<typeof phasesToSequence>) =>
      s.zero.magnitude ** 2 + s.positive.magnitude ** 2 + s.negative.magnitude ** 2;
    const phaseEnergy = (x: typeof p) => (x.a.magnitude ** 2 + x.b.magnitude ** 2 + x.c.magnitude ** 2) / 3;
    const before = phasesToSequence(p);
    const after = phasesToSequence({ a: p.a, b: p.c, c: p.b });
    expect(seqEnergy(before)).toBeCloseTo(phaseEnergy(p), 8);
    expect(seqEnergy(after)).toBeCloseTo(seqEnergy(before), 8);
  });
});

describe('线电压不含零序', () => {
  it('平衡正序的三个线电压 Vab/Vbc/Vca 正变换后零序为零', () => {
    // 线电压 = 相电压之差；平衡时幅值 √3 倍、相位超前 30°
    const Va = Complex.polar(10, 0);
    const Vb = Complex.polar(10, -120);
    const Vc = Complex.polar(10, 120);
    const line = { a: Va.sub(Vb), b: Vb.sub(Vc), c: Vc.sub(Va) };
    const seq = phasesToSequence(line);
    expect(seq.zero.magnitude).toBeLessThan(1e-8);
    expectMagnitudeClose(seq.positive.magnitude, 10 * Math.sqrt(3), 1e-8);
    expect(seq.positive.angleDeg).toBeCloseTo(30, 8);
  });
});

describe('电流与电压共用同一套变换（同一算子，无共轭分支）', () => {
  it('内核不区分 quantity：电流数值（如 100A）与电压走同一个函数、同一套矩阵', () => {
    const p = randomPhases(3);
    // 同一输入调用两次得到逐位相同结果（内核无任何按 quantity 分叉的逻辑）
    const s1 = phasesToSequence(p);
    const s2 = phasesToSequence(p);
    expect(s1.zero.re).toBe(s2.zero.re);
    expect(s1.positive.im).toBe(s2.positive.im);
    expect(s1.negative.re).toBe(s2.negative.re);
    // 平衡三相电流：正序幅值等于相电流，负/零序为零
    const i = { a: phasor(100, 0), b: phasor(100, -120), c: phasor(100, 120) };
    const iseq = phasesToSequence({ a: c(i.a), b: c(i.b), c: c(i.c) });
    expectMagnitudeClose(iseq.positive.magnitude, 100);
    expect(iseq.negative.magnitude).toBeLessThan(1e-7);
    expect(iseq.zero.magnitude).toBeLessThan(1e-7);
  });
});
