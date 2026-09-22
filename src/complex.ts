/**
 * 复数运算与对称分量旋转算子（唯一一份，电压、电流共用）。
 *
 * 旋转因子 a 定义为相位超前 120° 的单位复数：
 *
 *   a = e^{j·120°} = -1/2 + j·√3/2
 *
 * 约定：正序三相为 A∠0°、B∠-120°、C∠+120°，
 *       负序三相为 A∠0°、B∠+120°、C∠-120°。
 */

export class Complex {
  constructor(
    readonly re: number,
    readonly im: number,
  ) {}

  static readonly ZERO = new Complex(0, 0);
  static readonly ONE = new Complex(1, 0);

  /** 由极坐标构造：有效值幅值 + 相角（度） */
  static polar(magnitude: number, angleDeg: number): Complex {
    const rad = (angleDeg * Math.PI) / 180;
    return new Complex(magnitude * Math.cos(rad), magnitude * Math.sin(rad));
  }

  get magnitude(): number {
    return Math.hypot(this.re, this.im);
  }

  /** 相角（度），范围 (-180, 180]；零相量约定为 0° */
  get angleDeg(): number {
    if (this.re === 0 && this.im === 0) return 0;
    return (Math.atan2(this.im, this.re) * 180) / Math.PI;
  }

  add(other: Complex): Complex {
    return new Complex(this.re + other.re, this.im + other.im);
  }

  sub(other: Complex): Complex {
    return new Complex(this.re - other.re, this.im - other.im);
  }

  mul(other: Complex): Complex {
    return new Complex(
      this.re * other.re - this.im * other.im,
      this.re * other.im + this.im * other.re,
    );
  }

  /** 标量倍乘 */
  scale(k: number): Complex {
    return new Complex(this.re * k, this.im * k);
  }

  div(other: Complex): Complex {
    const d = other.re * other.re + other.im * other.im;
    return new Complex(
      (this.re * other.re + this.im * other.im) / d,
      (this.im * other.re - this.re * other.im) / d,
    );
  }

  isFinite(): boolean {
    return Number.isFinite(this.re) && Number.isFinite(this.im);
  }

  toPolar(): { magnitude: number; angleDeg: number } {
    return { magnitude: this.magnitude, angleDeg: this.angleDeg };
  }
}

/** 旋转因子 a = e^{j·120°} */
export const A = Complex.polar(1, 120);

/** a² = e^{j·240°} = e^{-j·120°} */
export const A_SQUARED = A.mul(A);

/** 3×3 复矩阵（行优先，9 个元素） */
export type CMatrix = [Complex, Complex, Complex, Complex, Complex, Complex, Complex, Complex, Complex];

export function matMulVec(m: CMatrix, v: [Complex, Complex, Complex]): [Complex, Complex, Complex] {
  const out: Complex[] = [];
  for (let r = 0; r < 3; r++) {
    out.push(
      m[r * 3]!
        .mul(v[0]!)
        .add(m[r * 3 + 1]!.mul(v[1]!))
        .add(m[r * 3 + 2]!.mul(v[2]!)),
    );
  }
  return [out[0]!, out[1]!, out[2]!];
}

/** 求 3×3 复矩阵的逆（伴随矩阵法），奇异时抛错 */
export function matInverse3(m: CMatrix): CMatrix {
  const [a, b, c, d, e, f, g, h, i] = m;

  const c00 = e.mul(i).sub(f.mul(h));
  const c01 = f.mul(g).sub(d.mul(i));
  const c02 = d.mul(h).sub(e.mul(g));
  const c10 = c.mul(h).sub(b.mul(i));
  const c11 = a.mul(i).sub(c.mul(g));
  const c12 = b.mul(g).sub(a.mul(h));
  const c20 = b.mul(f).sub(c.mul(e));
  const c21 = c.mul(d).sub(a.mul(f));
  const c22 = a.mul(e).sub(b.mul(d));

  // 余子式矩阵转置即伴随矩阵
  const adj: CMatrix = [c00, c10, c20, c01, c11, c21, c02, c12, c22];
  const det = a.mul(c00).add(b.mul(c01)).add(c.mul(c02));
  if (det.magnitude < 1e-18) {
    throw new Error('matrix is singular');
  }
  return adj.map((x) => x.div(det)) as CMatrix;
}
