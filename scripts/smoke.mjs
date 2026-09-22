#!/usr/bin/env node
/** 真实 HTTP 端到端冒烟：批次 -> 正变换 -> 反变换闭合、故障核算、非法输入、线电压、反转能量转移。 */

const BASE = process.env.BASE ?? 'http://localhost:8080';

async function call(method, url, body) {
  return callRaw(method, url, body === undefined ? undefined : JSON.stringify(body));
}

async function callRaw(method, url, rawBody) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  return { status: res.status, json: await res.json() };
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
};

const close = (a, b, tol = 1e-7) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const batch = (await call('POST', '/batches', { note: 'smoke' })).json;

// 1) 正变换：不平衡三相
const original = {
  a: { magnitude: 12.5, angleDeg: 20 },
  b: { magnitude: 8.1, angleDeg: -95 },
  c: { magnitude: 15.3, angleDeg: 140 },
};
const fwd = await call('POST', `/batches/${batch.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: original,
});
assert(fwd.status === 201 && fwd.json.status === 'ok', '正变换记录入库成功');
const seq = fwd.json.result.sequence;

// 2) 反变换闭合
const inv = await call('POST', `/batches/${batch.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', sequence: seq,
});
const back = inv.json.result.phases;
let roundtrip = true;
for (const k of ['a', 'b', 'c']) {
  roundtrip &&= close(back[k].magnitude, original[k].magnitude, 1e-8);
  roundtrip &&= close(back[k].angleDeg, original[k].angleDeg, 1e-7);
}
assert(roundtrip, '正反变换绕一圈回到原始三相（1e-7 容差）');

// 3) 三倍零序：Va+Vb+Vc = 3V0（复数和）
const toC = (p) => [p.magnitude * Math.cos((p.angleDeg * Math.PI) / 180), p.magnitude * Math.sin((p.angleDeg * Math.PI) / 180)];
const sum = ['a', 'b', 'c'].reduce(([x, y], k) => {
  const [rx, ry] = toC(original[k]);
  return [x + rx, y + ry];
}, [0, 0]);
const [z0x, z0y] = toC(seq.zero).map((v) => v * 3);
assert(close(sum[0], z0x, 1e-6) && close(sum[1], z0y, 1e-6), 'Va+Vb+Vc = 3V0');

// 4) 平衡正序退化 + B/C 对调能量转移
const b2 = (await call('POST', '/batches', {})).json;
const balanced = { a: { magnitude: 10, angleDeg: 0 }, b: { magnitude: 10, angleDeg: -120 }, c: { magnitude: 10, angleDeg: 120 } };
const rPos = (await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: balanced,
})).json.result.sequence;
assert(rPos.negative.magnitude < 1e-7 && rPos.zero.magnitude < 1e-7 && close(rPos.positive.magnitude, 10, 1e-7),
  '平衡正序：负序零序≈0，正序幅值=相电压幅值');
const swapped = { a: balanced.a, b: balanced.c, c: balanced.b };
const rNeg = (await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: swapped,
})).json.result.sequence;
assert(rNeg.positive.magnitude < 1e-7 && close(rNeg.negative.magnitude, 10, 1e-7),
  'B/C 对调：能量从正序全部转移到负序');

// 5) 故障核算
const fault = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'fault',
  z1: { magnitude: 1, angleDeg: 80 }, z2: { magnitude: 1, angleDeg: 80 },
  z0: { magnitude: 3, angleDeg: 70 }, vf: { magnitude: 1, angleDeg: 0 }, rf: 0.1,
});
assert(fault.status === 201 && fault.json.result.kind === 'fault', '故障核算成功入库');
// 趋势：增大 Rf -> 序电流减小、跌落减小
const f2 = (await call('POST', `/batches/${b2.id}/records`, {
  kind: 'fault',
  z1: { magnitude: 1, angleDeg: 80 }, z2: { magnitude: 1, angleDeg: 80 },
  z0: { magnitude: 3, angleDeg: 70 }, vf: { magnitude: 1, angleDeg: 0 }, rf: 0.6,
})).json.result;
assert(f2.iSequence.magnitude < fault.json.result.iSequence.magnitude
  && f2.voltageSag < fault.json.result.voltageSag,
  '故障趋势：Rf 增大，序电流与电压跌落同向减小');

// 6) 非法输入：幅值非正 / 缺相 / 角度非有限 / 阻抗非正
const badMag = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence',
  phases: { a: { magnitude: -1, angleDeg: 0 }, b: balanced.b, c: balanced.c },
});
assert(badMag.status === 422 && badMag.json.errors[0].code === 'MAGNITUDE_NON_POSITIVE', '幅值非正结构化拒绝(422)');

const missing = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence',
  phases: { a: balanced.a, b: balanced.b },
});
assert(missing.json.errors.some((e) => e.code === 'MISSING_PHASE' && e.field === 'phases.c'), '缺 C 相：MISSING_PHASE');

// 非有限相角经 HTTP 只能以 null（JSON.stringify(NaN)）到达：服务结构化拒绝且不崩
const nanAngle = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'phase->sequence',
  phases: { a: balanced.a, b: { magnitude: 10, angleDeg: NaN }, c: balanced.c },
});
assert(nanAngle.status === 422 && nanAngle.json.errors.length > 0, '相角 NaN(序列化为null)：结构化 422，服务不崩');

// 损坏的 JSON 体：结构化 400
const broken = await callRaw('POST', `/batches/${b2.id}/records`, '{ broken');
assert(broken.status === 400 && broken.json.error.code === 'VALIDATION_FAILED', '损坏 JSON：结构化 400');

const badZ = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'fault', z1: { magnitude: 1, angleDeg: 90 }, z2: { magnitude: 1, angleDeg: 80 },
  z0: { magnitude: 1, angleDeg: 80 }, vf: { magnitude: 1, angleDeg: 0 },
});
assert(badZ.json.errors.some((e) => e.code === 'IMPEDANCE_NON_POSITIVE'), '阻抗实部非正：IMPEDANCE_NON_POSITIVE');

// 7) 线电压反变换带非零零序 -> 报错
const lineBad = await call('POST', `/batches/${b2.id}/records`, {
  kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', phaseMode: 'line',
  sequence: { zero: { magnitude: 1, angleDeg: 0 }, positive: { magnitude: 10, angleDeg: 0 }, negative: { magnitude: 0, angleDeg: 0 } },
});
assert(lineBad.json.errors.some((e) => e.code === 'LINE_ZERO_SEQUENCE_NOT_ZERO'), '线量带零序：LINE_ZERO_SEQUENCE_NOT_ZERO');

// 8) 批次查询：整批 / 单条 / 不存在
const all = await call('GET', `/batches/${b2.id}`);
assert(all.status === 200 && Array.isArray(all.json.records) && all.json.records.length >= 8, '整批记录可取回');
const one = await call('GET', `/batches/${b2.id}/records/${fault.json.id}`);
assert(one.status === 200 && one.json.id === fault.json.id, '按记录号取回单条');
const notFound = await call('GET', '/batches/nope');
assert(notFound.status === 404 && notFound.json.error.code === 'BATCH_NOT_FOUND', '批次不存在 404 类型化');

// 9) 批量提交，逐条留状态
const bulk = await call('POST', `/batches/${b2.id}/records`, [
  { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: balanced },
  { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: { a: { magnitude: 0, angleDeg: 0 } } },
]);
assert(bulk.status === 200 && bulk.json.count === 2
  && bulk.json.records[0].status === 'ok' && bulk.json.records[1].status === 'rejected',
  '批量提交：合法与非法记录各自独立留存');

console.log(process.exitCode ? '\nSMOKE FAILED' : '\nALL SMOKE CHECKS PASSED');
