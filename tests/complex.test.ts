import { describe, expect, it } from 'vitest';
import { A, A_SQUARED, Complex } from '../src/complex.js';

describe('旋转算子 a = e^{j120°}', () => {
  it('a 的实部为 -1/2、虚部为 √3/2，幅值为 1', () => {
    expect(A.re).toBeCloseTo(-0.5, 12);
    expect(A.im).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(A.magnitude).toBeCloseTo(1, 12);
    expect(A.angleDeg).toBeCloseTo(120, 12);
  });

  it('a² 相位 240°（等价 -120°），且 a³ = 1', () => {
    expect(A_SQUARED.angleDeg).toBeCloseTo(-120, 12);
    const aCubed = A.mul(A_SQUARED);
    expect(aCubed.re).toBeCloseTo(1, 12);
    expect(aCubed.im).toBeCloseTo(0, 12);
  });

  it('1 + a + a² = 0（三相对称相量之和为零的依据）', () => {
    const sum = Complex.ONE.add(A).add(A_SQUARED);
    expect(sum.magnitude).toBeLessThan(1e-12);
  });

  it('极坐标与直角坐标往返一致', () => {
    const z = Complex.polar(5, 37);
    expect(z.re).toBeCloseTo(5 * Math.cos((37 * Math.PI) / 180), 10);
    expect(z.im).toBeCloseTo(5 * Math.sin((37 * Math.PI) / 180), 10);
    const back = z.toPolar();
    expect(back.magnitude).toBeCloseTo(5, 10);
    expect(back.angleDeg).toBeCloseTo(37, 10);
  });

  it('复数乘除互逆', () => {
    const x = Complex.polar(3, 50);
    const y = Complex.polar(2, -170);
    const round = x.mul(y).div(y);
    expect(round.re).toBeCloseTo(x.re, 10);
    expect(round.im).toBeCloseTo(x.im, 10);
  });
});
