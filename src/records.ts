/**
 * 记录处理引擎：校验 -> 调用变换/故障内核 -> 组装可留存的记录。
 * 校验不过的记录也原样留存（status=rejected + 结构化错误），不抛异常给调用方。
 */

import { Complex } from './complex.js';
import { phasesToSequence, sequenceToPhases } from './kernel/transform.js';
import { calculateSlgFault } from './kernel/fault.js';
import { validateRecord, validateRecordShape } from './validation.js';
import type {
  FaultRecordInput,
  FaultResultPayload,
  ForwardRecordInput,
  InverseRecordInput,
  PhasorDTO,
  RecordInput,
  RecordResultPayload,
  SequenceDTO,
  StoredRecord,
  ThreePhaseDTO,
  TransformResultPayload,
} from './types.js';

export function polarDTO(c: Complex): PhasorDTO {
  return { magnitude: c.magnitude, angleDeg: c.angleDeg };
}

function phasesDTO(p: { a: Complex; b: Complex; c: Complex }): ThreePhaseDTO {
  return { a: polarDTO(p.a), b: polarDTO(p.b), c: polarDTO(p.c) };
}

function sequenceDTO(s: { zero: Complex; positive: Complex; negative: Complex }): SequenceDTO {
  return { zero: polarDTO(s.zero), positive: polarDTO(s.positive), negative: polarDTO(s.negative) };
}

function computeTransform(input: ForwardRecordInput | InverseRecordInput): TransformResultPayload {
  const phaseMode = input.phaseMode ?? 'phase';
  if (input.direction === 'phase->sequence') {
    const phasesC = {
      a: Complex.polar(input.phases.a.magnitude, input.phases.a.angleDeg),
      b: Complex.polar(input.phases.b.magnitude, input.phases.b.angleDeg),
      c: Complex.polar(input.phases.c.magnitude, input.phases.c.angleDeg),
    };
    const seqC = phasesToSequence(phasesC);
    return {
      kind: 'transform',
      quantity: input.quantity,
      direction: 'phase->sequence',
      phaseMode,
      phases: phasesDTO(phasesC),
      sequence: sequenceDTO(seqC),
    };
  }
  const seqC = {
    zero: Complex.polar(input.sequence.zero.magnitude, input.sequence.zero.angleDeg),
    positive: Complex.polar(input.sequence.positive.magnitude, input.sequence.positive.angleDeg),
    negative: Complex.polar(input.sequence.negative.magnitude, input.sequence.negative.angleDeg),
  };
  const phasesC = sequenceToPhases(seqC);
  return {
    kind: 'transform',
    quantity: input.quantity,
    direction: 'sequence->phase',
    phaseMode,
    phases: phasesDTO(phasesC),
    sequence: sequenceDTO(seqC),
  };
}

function computeFault(input: FaultRecordInput): FaultResultPayload {
  const out = calculateSlgFault({
    z1: Complex.polar(input.z1.magnitude, input.z1.angleDeg),
    z2: Complex.polar(input.z2.magnitude, input.z2.angleDeg),
    z0: Complex.polar(input.z0.magnitude, input.z0.angleDeg),
    vf: Complex.polar(input.vf.magnitude, input.vf.angleDeg),
    rf: input.rf ?? 0,
  });
  return {
    kind: 'fault',
    z1: input.z1,
    z2: input.z2,
    z0: input.z0,
    vf: input.vf,
    rf: input.rf ?? 0,
    iSequence: polarDTO(out.iSequence),
    faultCurrent: polarDTO(out.faultCurrent),
    sequenceVoltages: {
      zero: polarDTO(out.v0),
      positive: polarDTO(out.v1),
      negative: polarDTO(out.v2),
    },
    faultedPhaseVoltage: polarDTO(out.faultedPhaseVoltage),
    voltageSag: out.voltageSag,
  };
}

/**
 * 处理一条原始记录：结构/字段校验 + 内核计算。
 * 返回可直接留存的 StoredRecord（不含 id/批次号，由持久化层补齐）。
 */
export function processRecord(raw: unknown): Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'> {
  const shape = validateRecordShape(raw);
  if (!shape.ok) {
    return { status: 'rejected', input: raw as RecordInput, result: null, errors: shape.errors };
  }
  const input = shape.input;
  const errors = validateRecord(input);
  if (errors.length > 0) {
    return { status: 'rejected', input, result: null, errors };
  }
  try {
    const result: RecordResultPayload = input.kind === 'fault' ? computeFault(input) : computeTransform(input);
    return { status: 'ok', input, result, errors: [] };
  } catch (err) {
    return {
      status: 'rejected',
      input,
      result: null,
      errors: [{ code: 'VALIDATION_FAILED', field: '$', message: `计算失败: ${(err as Error).message}` }],
    };
  }
}
