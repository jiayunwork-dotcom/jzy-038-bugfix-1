/**
 * 输入校验：把所有非法输入挡在内核之前，错误带类型（code）与字段路径。
 * 校验只做"拒绝/放行"，绝不修正数据、不糊近似结果。
 */

import { Complex } from './complex.js';
import type {
  FaultRecordInput,
  FieldError,
  ForwardRecordInput,
  InverseRecordInput,
  PhasorDTO,
  RecordInput,
} from './types.js';
import { phasesToSequence } from './kernel/transform.js';

/** 线量零序允许的最大幅值（相对值，相对该组最大幅值） */
const LINE_ZERO_SEQUENCE_TOLERANCE = 1e-9;
/** 反变换时线量零序幅值的绝对上限 */
const LINE_ZERO_SEQUENCE_ABS_TOLERANCE = 1e-9;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验一个相量（有效值 + 角度）。path 形如 "phases.b"。
 * allowZero=false（三相相量输入）：幅值必须严格为正；
 * allowZero=true（序分量输入）：幅值允许为 0 —— 序分量为零是正常情形
 *   （如纯正序反变换时 zero/negative 传 {magnitude:0, angleDeg:0}）。
 */
export function validatePhasor(value: unknown, path: string, allowZero = false): FieldError[] {
  if (!isRecord(value) || typeof value.magnitude !== 'number' || typeof value.angleDeg !== 'number') {
    return [{ code: 'MALFORMED_PHASOR', field: path, message: `${path} 必须是 { magnitude: number, angleDeg: number }` }];
  }
  const errors: FieldError[] = [];
  if (!Number.isFinite(value.magnitude)) {
    errors.push({ code: 'MAGNITUDE_NON_POSITIVE', field: `${path}.magnitude`, message: `${path}.magnitude 必须是有限数` });
  } else if (allowZero ? value.magnitude < 0 : value.magnitude <= 0) {
    errors.push({ code: 'MAGNITUDE_NON_POSITIVE', field: `${path}.magnitude`, message: `${path}.magnitude 必须${allowZero ? '非负' : '为正'}，收到 ${value.magnitude}` });
  }
  if (!Number.isFinite(value.angleDeg)) {
    errors.push({ code: 'ANGLE_NOT_FINITE', field: `${path}.angleDeg`, message: `${path}.angleDeg 必须是有限数，收到 ${String(value.angleDeg)}` });
  }
  return errors;
}

const PHASE_KEYS = ['a', 'b', 'c'] as const;
const SEQ_KEYS = ['zero', 'positive', 'negative'] as const;

/** 校验正变换输入（三相相量须三相齐全） */
export function validateForward(input: ForwardRecordInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!isRecord(input.phases)) {
    return [{ code: 'MISSING_PHASE', field: 'phases', message: '缺少三相相量输入 phases' }];
  }
  for (const k of PHASE_KEYS) {
    if (input.phases[k] === undefined || input.phases[k] === null) {
      errors.push({ code: 'MISSING_PHASE', field: `phases.${k}`, message: `缺少 ${k.toUpperCase()} 相相量` });
    } else {
      errors.push(...validatePhasor(input.phases[k], `phases.${k}`));
    }
  }
  if (input.quantity === 'current' && input.phaseMode === 'line') {
    errors.push({
      code: 'LINE_MODE_NOT_APPLICABLE_TO_CURRENT',
      field: 'phaseMode',
      message: '本服务只处理相电流，电流不支持 line 线量模式（线电流概念仅适用于三相三线制电压分析）',
    });
  }
  return errors;
}

/** 校验反变换输入（序分量须三个齐全；线量模式零序必须为零） */
export function validateInverse(input: InverseRecordInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!isRecord(input.sequence)) {
    return [{ code: 'VALIDATION_FAILED', field: 'sequence', message: '缺少序分量输入 sequence' }];
  }
  for (const k of SEQ_KEYS) {
    if (input.sequence[k] === undefined || input.sequence[k] === null) {
      errors.push({ code: 'VALIDATION_FAILED', field: `sequence.${k}`, message: `缺少 ${k} 序分量` });
    } else {
      errors.push(...validatePhasor(input.sequence[k], `sequence.${k}`, true));
    }
  }
  if (input.quantity === 'current' && input.phaseMode === 'line') {
    errors.push({
      code: 'LINE_MODE_NOT_APPLICABLE_TO_CURRENT',
      field: 'phaseMode',
      message: '本服务只处理相电流，电流不支持 line 线量模式',
    });
  }
  if (input.phaseMode === 'line' && isRecord(input.sequence) && errors.length === 0) {
    const zero = input.sequence.zero as PhasorDTO;
    if (zero.magnitude > LINE_ZERO_SEQUENCE_ABS_TOLERANCE) {
      errors.push({
        code: 'LINE_ZERO_SEQUENCE_NOT_ZERO',
        field: 'sequence.zero',
        message: `线电压不含零序，反变换为线量时 sequence.zero 必须为 0，收到幅值 ${zero.magnitude}`,
      });
    }
  }
  return errors;
}

function validateImpedance(value: unknown, path: string): FieldError[] {
  const errs = validatePhasor(value, path);
  if (errs.length > 0) return errs;
  const z = value as PhasorDTO;
  // 阻抗实部（电阻分量）必须严格为正；电抗分量允许为负。
  // 90° 纯电抗浮点算出的实部约为 6e-17，用 1e-9·|Z| 的容差视为非正。
  const re = z.magnitude * Math.cos((z.angleDeg * Math.PI) / 180);
  if (re <= 1e-9 * z.magnitude) {
    return [{ code: 'IMPEDANCE_NON_POSITIVE', field: path, message: `${path} 的实部（电阻）必须为正，收到 ${re}` }];
  }
  return [];
}

/** 校验单相接地故障核算输入 */
export function validateFault(input: FaultRecordInput): FieldError[] {
  const errors: FieldError[] = [];
  for (const k of ['z1', 'z2', 'z0'] as const) {
    if (input[k] === undefined || input[k] === null) {
      errors.push({ code: 'IMPEDANCE_NON_POSITIVE', field: k, message: `缺少阻抗 ${k}` });
    } else {
      errors.push(...validateImpedance(input[k], k));
    }
  }
  if (input.vf === undefined || input.vf === null) {
    errors.push({ code: 'MALFORMED_PHASOR', field: 'vf', message: '缺少故障前正序电压 vf' });
  } else {
    errors.push(...validatePhasor(input.vf, 'vf'));
  }
  if (input.rf !== undefined) {
    if (typeof input.rf !== 'number' || !Number.isFinite(input.rf) || input.rf < 0) {
      errors.push({ code: 'FAULT_IMPEDANCE_NON_POSITIVE', field: 'rf', message: `故障电阻 rf 必须是非负有限数，收到 ${String(input.rf)}` });
    }
  }
  return errors;
}

/** 最外层结构校验：kind / quantity / direction 等 */
export function validateRecordShape(raw: unknown): { ok: true; input: RecordInput } | { ok: false; errors: FieldError[] } {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ code: 'VALIDATION_FAILED', field: '$', message: '请求体必须是对象' }] };
  }
  const kind = raw.kind;
  if (kind !== 'transform' && kind !== 'fault') {
    return { ok: false, errors: [{ code: 'UNSUPPORTED_RECORD', field: 'kind', message: `不支持的记录类型 ${String(kind)}，只支持 transform / fault` }] };
  }
  if (kind === 'fault') {
    return { ok: true, input: raw as unknown as FaultRecordInput };
  }
  const quantity = raw.quantity;
  const direction = raw.direction;
  if (quantity !== 'voltage' && quantity !== 'current') {
    return { ok: false, errors: [{ code: 'VALIDATION_FAILED', field: 'quantity', message: 'quantity 必须是 voltage 或 current' }] };
  }
  if (direction !== 'phase->sequence' && direction !== 'sequence->phase') {
    return { ok: false, errors: [{ code: 'VALIDATION_FAILED', field: 'direction', message: 'direction 必须是 phase->sequence 或 sequence->phase' }] };
  }
  if (raw.phaseMode !== undefined && raw.phaseMode !== 'phase' && raw.phaseMode !== 'line') {
    return { ok: false, errors: [{ code: 'VALIDATION_FAILED', field: 'phaseMode', message: 'phaseMode 必须是 phase 或 line' }] };
  }
  return { ok: true, input: raw as unknown as RecordInput };
}

/** 完整字段校验（结构校验通过后调用） */
export function validateRecord(input: RecordInput): FieldError[] {
  if (input.kind === 'fault') return validateFault(input);
  if (input.direction === 'phase->sequence') {
    const errors = validateForward(input);
    // 线电压正变换：变换结果中的零序必须为零（浮点容差）
    if (input.phaseMode === 'line' && errors.length === 0) {
      const c = toComplex(input.phases.a);
      const maxMag = Math.max(c.magnitude, toComplex(input.phases.b).magnitude, toComplex(input.phases.c).magnitude);
      const zero = phasesToSequence({
        a: c,
        b: toComplex(input.phases.b),
        c: toComplex(input.phases.c),
      }).zero;
      if (zero.magnitude > LINE_ZERO_SEQUENCE_TOLERANCE * Math.max(maxMag, 1)) {
        errors.push({
          code: 'LINE_ZERO_SEQUENCE_NOT_ZERO',
          field: 'phases',
          message: `线电压不含零序，这组三相相量算出零序幅值 ${zero.magnitude}，超过线量容差`,
        });
      }
    }
    return errors;
  }
  return validateInverse(input);
}

function toComplex(p: PhasorDTO): Complex {
  return Complex.polar(p.magnitude, p.angleDeg);
}
