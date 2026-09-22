import { expect } from 'vitest';
import { Complex } from '../src/complex.js';
import type { PhasorDTO } from '../src/types.js';

/** 相对+绝对混合容差的复数近似相等断言 */
export function expectComplexClose(actual: Complex, expected: Complex, tol = 1e-9): void {
  const scale = Math.max(1, expected.magnitude);
  expect(actual.re, `实部不符：actual=${actual.re}, expected=${expected.re}`).toBeCloseTo(expected.re, -Math.log10(tol * scale));
  expect(actual.im, `虚部不符：actual=${actual.im}, expected=${expected.im}`).toBeCloseTo(expected.im, -Math.log10(tol * scale));
}

export function expectMagnitudeClose(actual: number, expected: number, tol = 1e-9): void {
  const scale = Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * scale);
}

export function phasor(magnitude: number, angleDeg: number): PhasorDTO {
  return { magnitude, angleDeg };
}

/** 平衡正序三相（默认 A∠0、B∠-120、C∠120），幅值相等 */
export function balancedPositive(magnitude = 1, aAngle = 0) {
  return {
    a: phasor(magnitude, aAngle),
    b: phasor(magnitude, aAngle - 120),
    c: phasor(magnitude, aAngle + 120),
  };
}

/** 平衡负序三相（B、C 对调）：A∠0、B∠+120、C∠-120 */
export function balancedNegative(magnitude = 1, aAngle = 0) {
  return {
    a: phasor(magnitude, aAngle),
    b: phasor(magnitude, aAngle + 120),
    c: phasor(magnitude, aAngle - 120),
  };
}

export function c(p: PhasorDTO): Complex {
  return Complex.polar(p.magnitude, p.angleDeg);
}
