/**
 * 对称分量正反变换内核。
 *
 * 本服务钉死 Fortescue 对称分量定义（电压、电流通用，均不带共轭）：
 *
 *   正变换（三相 -> 序，含 1/3 系数）：
 *     V0 = (Va + Vb      + Vc ) / 3
 *     V1 = (Va + a·Vb    + a²·Vc) / 3
 *     V2 = (Va + a²·Vb   + a·Vc ) / 3
 *
 *   反变换（序 -> 三相）：
 *     Va = V0 + V1 + V2
 *     Vb = V0 + a²·V1 + a·V2
 *     Vc = V0 + a·V1 + a²·V2
 *
 * 其中 a = e^{j·120°}（见 complex.ts，全服务唯一的旋转算子）。
 *
 * 为保证正反两侧严格配对，正变换矩阵直接由反变换（合成）矩阵求逆得到，
 * 而非另行手抄一份系数 —— 两者在数值上互为逆矩阵，闭合误差只来自浮点舍入。
 */

import {
  A,
  A_SQUARED,
  Complex,
  type CMatrix,
  matInverse3,
  matMulVec,
} from '../complex.js';

/** 反变换（合成）矩阵 S：[Va,Vb,Vc]ᵀ = S · [V0,V1,V2]ᵀ */
export const SYNTHESIS_MATRIX: CMatrix = [
  Complex.ONE, Complex.ONE, Complex.ONE,
  Complex.ONE, A_SQUARED, A,
  Complex.ONE, A, A_SQUARED,
];

/** 正变换（分析）矩阵 = S⁻¹，恒等于 (1/3)·[1 1 1; 1 a a²; 1 a² a] */
export const ANALYSIS_MATRIX: CMatrix = matInverse3(SYNTHESIS_MATRIX);

export interface SequenceTriplet {
  zero: Complex;
  positive: Complex;
  negative: Complex;
}

export interface PhaseTriplet {
  a: Complex;
  b: Complex;
  c: Complex;
}

/** 正变换：三相相量 -> 零序/正序/负序 */
export function phasesToSequence(p: PhaseTriplet): SequenceTriplet {
  const [zero, positive, negative] = matMulVec(ANALYSIS_MATRIX, [p.a, p.b, p.c]);
  return { zero, positive, negative };
}

/** 反变换：零序/正序/负序 -> 三相相量 */
export function sequenceToPhases(s: SequenceTriplet): PhaseTriplet {
  const [a, b, c] = matMulVec(SYNTHESIS_MATRIX, [s.zero, s.positive, s.negative]);
  return { a, b, c };
}
