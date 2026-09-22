/**
 * 单相接地（SLG，故障假定落在 A 相）序网核算内核。
 *
 * A 相金属性（或经 Rf）接地时的边界条件：
 *
 *   Ia = I1 + I2 + I0， 且 I1 = I2 = I0（三序串联）
 *   Va = Vf - I1·Z1 + (-I2·Z2) + (-I0·Z0) = I1·3Rf
 *
 * 序网连接：正序、负序、零序三网络串联，故障点的序电流为
 *
 *   I1 = I2 = I0 = Vf / (Z1 + Z2 + Z0 + 3Rf)
 *
 * 故障相电流：Ia = 3·I0；故障相电压：Va = 3·Rf·I1。
 */

import { Complex } from '../complex.js';

export interface FaultInputs {
  z1: Complex;
  z2: Complex;
  z0: Complex;
  vf: Complex;
  rf: number;
}

export interface FaultOutputs {
  /** 序电流 I1=I2=I0 */
  iSequence: Complex;
  /** 故障相电流 = 3 I0 */
  faultCurrent: Complex;
  /** 故障点处正序电压 V1 = Vf - I1·Z1 */
  v1: Complex;
  /** 故障点处负序电压 V2 = -I2·Z2 */
  v2: Complex;
  /** 故障点处零序电压 V0 = -I0·Z0 */
  v0: Complex;
  /** 故障相（A 相）电压 Va = V0+V1+V2 = 3 Rf I1 */
  faultedPhaseVoltage: Complex;
  /** 故障相电压跌落（幅值）：|Vf| - |Va| */
  voltageSag: number;
}

export function calculateSlgFault(input: FaultInputs): FaultOutputs {
  const { z1, z2, z0, vf, rf } = input;
  const totalImpedance = z1.add(z2).add(z0).add(Complex.ONE.scale(3 * rf));
  const iSequence = vf.div(totalImpedance);

  const v1 = vf.sub(iSequence.mul(z1));
  const v2 = iSequence.mul(z2).scale(-1);
  const v0 = iSequence.mul(z0).scale(-1);

  const faultedPhaseVoltage = iSequence.scale(3 * rf);
  const voltageSag = vf.magnitude - faultedPhaseVoltage.magnitude;
  const faultCurrent = iSequence.scale(3);

  return {
    iSequence,
    faultCurrent,
    v1,
    v2,
    v0,
    faultedPhaseVoltage,
    voltageSag,
  };
}
