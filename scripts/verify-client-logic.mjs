/**
 * verify-client-logic.mjs —— 客户端**纯逻辑**的离线验收（Phase 4-H3 / H6）
 *
 * 为什么必须有这个脚本：
 *
 *   H3 的时效文案与 H6 的按钮矩阵，是 Phase 4 里**最容易写错、又最没法自动验证**
 *   的两块 —— 它们跑在浏览器里，而浏览器里的东西没有断言就是没有验证。
 *   复核方明确要求"不要等真人 I 走查才第一次发现"按钮与菜单的问题，
 *   所以这两块逻辑被刻意写成**零依赖纯模块**（timeliness.ts / action-matrix.ts），
 *   由本脚本用 esbuild 编译后在 Node 里逐条断言。
 *
 * 断言范围（不含任何渲染/DOM）：
 *   · H6 按钮矩阵：每个工单状态下该出现哪些按钮（复核方给定的表）
 *   · H3 时效文案：已等待 / 距预约 / 已超过预约 / 总耗时 / 尚未响应 / 今天明天
 *
 * 退出码遵循项目约定：0 全绿 / 1 失败 / 2 环境未就绪。
 *
 * ---------------------------------------------------------------------------
 * 2026-09-21 扩充（复核方在两个静态契约缺陷上要求"必须有断言盯着"）：
 *   · 派工 UI 的 service_mode 选项必须与服务端枚举**完全相等**（不能多、不能少、
 *     不能改名、不能把 manufacturer 与 third_party 合并成一个选项）；
 *   · provider_name 的条件必填规则必须与服务端 `assertDispatchInput` 一致；
 *   · 四个写请求必须显式带合法的 UUID v4 的 X-Request-Id，
 *     且**网络重试复用同一个号**（每次重试换号 = 自己拆掉幂等防线）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import * as EXPECTED from './expected-h6-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_SRC = path.join(ROOT, 'nocobase/plugins/service-ticket/src');
const CLIENT_DIR = path.join(PLUGIN_SRC, 'client');
const SHARED_DIR = path.join(PLUGIN_SRC, 'shared');
const TMP = path.join(ROOT, '.tmp-verify');
// 与 scripts/build-plugin.mjs 完全一致的路径口径，别各写一份
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

// ---------------------------------------------------------------------------
// 断言框架（与 verify-config / verify-plugin-load 同风格）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  ❌ ${name} — ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 异步版 check。
 *
 * 为什么不把 check 直接改成 async：现有 15 条同步断言都是 `check(...)` 不 await 的写法，
 * 全改一遍会把"同步立即打印顺序"这件事也改掉。这里单独开一个 await 版本，
 * 只为那些必须等待真实 Promise 的用例（网络重试）服务。
 */
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  ❌ ${name} — ${error.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}：实际 ${a}，期望 ${e}`);
}

// ---------------------------------------------------------------------------
// 加载 esbuild（与 build-plugin.mjs 同一套兜底顺序）
// ---------------------------------------------------------------------------
function loadEsbuild() {
  // ⚠️ 本脚本是 .mjs（ESM），**没有全局 require** ——
  //    直接写 require() 会抛 ReferenceError，被 catch 吞掉后表现为
  //    "找不到 esbuild"，极其误导。必须用 createRequire。
  const nodeRequire = createRequire(import.meta.url);
  const candidates = [
    () => nodeRequire('esbuild'),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ];
  const errors = [];
  for (const load of candidates) {
    try {
      return load();
    } catch (error) {
      errors.push(error.message.split('\n')[0]);
    }
  }
  console.log(`  （esbuild 查找失败原因：${errors.join(' | ')}）`);
  return null;
}

// ---------------------------------------------------------------------------
// 编译两个纯模块
// ---------------------------------------------------------------------------
async function compileModules(esbuild) {
  fs.mkdirSync(TMP, { recursive: true });
  const outfile = path.join(TMP, 'client-logic.cjs');
  const entry = path.join(TMP, 'client-logic-entry.ts');

  const reexport = (dir, mod) =>
    `export * from '${path.join(dir, mod).replace(/\\/g, '/')}';`;

  // 全部是零依赖纯 TS，直接 re-export 成一个入口
  fs.writeFileSync(
    entry,
    [
      reexport(CLIENT_DIR, 'timeliness'),
      reexport(CLIENT_DIR, 'action-matrix'),
      // 前后端共享契约：service_mode / provider / X-Request-Id
      reexport(SHARED_DIR, 'service-mode'),
      reexport(SHARED_DIR, 'svc-request'),
    ].join('\n'),
    'utf8',
  );

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'warning',
  });

  return outfile;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
console.log('═══ Phase 4-H 客户端纯逻辑离线验收 ═══\n');

const files = [
  'timeliness.ts',
  'action-matrix.ts',
  'ticket-drawer.tsx',
  'ticket-actions.tsx',
];
for (const file of files) {
  if (!fs.existsSync(path.join(CLIENT_DIR, file))) {
    console.log(`  ❌ 环境未就绪：缺少 ${file}`);
    process.exit(2);
  }
}
for (const file of ['service-mode.ts', 'svc-request.ts']) {
  if (!fs.existsSync(path.join(SHARED_DIR, file))) {
    console.log(`  ❌ 环境未就绪：缺少前后端共享契约 src/shared/${file}`);
    process.exit(2);
  }
}

const esbuild = loadEsbuild();
if (!esbuild) {
  console.log('  ❌ 环境未就绪：找不到 esbuild（无法编译 TS 模块）');
  process.exit(2);
}

const outfile = await compileModules(esbuild);
const logic = await import(`file://${outfile}`);
const { computeTimeliness, availableActionsOf, TICKET_ACTION, TICKET_ACTION_LABEL } = logic;
const {
  SERVICE_MODE,
  SERVICE_MODE_LABEL,
  DISPATCHABLE_SERVICE_MODES,
  DISPATCH_FORM_FIELDS,
  dispatchServiceModeOptions,
  requiresProviderName,
  missingDispatchFields,
  missingRescheduleFields,
  buildDispatchPayload,
  buildReschedulePayload,
  REQUEST_ID_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
  isUuidV4,
  newRequestId,
  buildSvcRequest,
  sendSvcRequest,
  isNetworkFailure,
} = logic;

console.log('── H6 按钮矩阵（复核方给定的状态表）──');

check('NEW → 受理 + 派工', () => {
  eq(availableActionsOf({ status: 'NEW' }), ['accept', 'dispatch'], 'NEW 的按钮');
  return TICKET_ACTION_LABEL.accept + ' + ' + TICKET_ACTION_LABEL.dispatch;
});

check('PROCESSING 且尚未派工 → 只有派工', () => {
  eq(availableActionsOf({ status: 'PROCESSING', dispatched: false }), ['dispatch'], '未派工');
  return '派工';
});

check('PROCESSING 且已派工 → 改派 + 改约', () => {
  eq(
    availableActionsOf({ status: 'PROCESSING', dispatched: true }),
    ['reassign', 'reschedule'],
    '已派工',
  );
  return '改派 + 改约';
});

for (const status of ['WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CLOSED', 'CANCELLED']) {
  check(`${status} → 不显示任何业务按钮`, () => {
    eq(availableActionsOf({ status }), [], status);
    return '（无按钮）';
  });
}

check('未知/缺失状态一律不给按钮（不认识就别摆一个必然失败的按钮）', () => {
  eq(availableActionsOf({ status: 'SOMETHING_NEW' }), [], '未知状态');
  eq(availableActionsOf({ status: null }), [], 'null');
  eq(availableActionsOf({}), [], '空对象');
  return '3 种边界均返回空';
});

check('按钮标识与 /api/svc:<name> 一一对应（前端动作名必须真有后端接口）', () => {
  eq(Object.values(TICKET_ACTION), ['accept', 'dispatch', 'reassign', 'reschedule'], '动作名');
  for (const [name, label] of Object.entries(TICKET_ACTION_LABEL)) {
    assert(label && typeof label === 'string', `${name} 缺中文文案`);
  }
  return '4 个动作均有中文文案';
});

console.log('\n── H6 写请求契约：X-Request-Id（服务端写接口的硬门槛）──');

check('写请求必须显式带上 X-Request-Id（不依赖框架隐式注入）', () => {
  const requestId = newRequestId();
  assert(isUuidV4(requestId), `生成的不是合法 UUID v4：${requestId}`);
  const config = buildSvcRequest({ action: 'dispatch', ticketId: 42, body: { a: 1 }, requestId });
  eq(config.method, 'post', 'method');
  eq(config.url, 'svc:dispatch?filterByTk=42', 'url（多段 action 名在 NocoBase 里不可达，见 DEV-18）');
  eq(Object.keys(config.headers), [REQUEST_ID_HEADER], '请求头集合');
  eq(config.headers[REQUEST_ID_HEADER], requestId, `${REQUEST_ID_HEADER} 的值`);
  eq(REQUEST_ID_HEADER, 'X-Request-Id', '请求头名');
  return `${REQUEST_ID_HEADER}: ${requestId}`;
});

check('两次 newRequestId() 不重复（撞号会让后一个操作被误判成重放）', () => {
  const a = newRequestId();
  const b = newRequestId();
  assert(a !== b, `两次生成了同一个号：${a}`);
  return `${a.slice(0, 8)}… / ${b.slice(0, 8)}…`;
});

check('伪造的幂等号会被拒（服务端用的是同一条正则）', () => {
  const bad = ['', 'not-a-uuid', '550e8400-e29b-11d4-a716-446655440000', '550e8400e29b41d4a716446655440000'];
  for (const value of bad) {
    assert(!isUuidV4(value), `非法值被判为合法：${JSON.stringify(value)}`);
  }
  return `${bad.length} 个非法值全部被拒`;
});

check('无 ticketId 的动作（tokenCheck / smsOutbox）不拼 filterByTk', () => {
  const config = buildSvcRequest({ action: 'tokenCheck', requestId: newRequestId() });
  eq(config.url, 'svc:tokenCheck', 'url');
  eq(config.data, {}, 'data（无 body 时必须是空对象，不是 undefined）');
  return 'svc:tokenCheck';
});

await checkAsync('网络层失败重试时**复用同一个 request id**（每次换号 = 拆掉幂等）', async () => {
  const seen = [];
  let attempts = 0;
  const stub = async (url, method, body, options) => {
    attempts += 1;
    seen.push(options?.headers?.[REQUEST_ID_HEADER]);
    // 网络层失败：没有 response，也没有 status（axios 请求未发出时的形态）
    if (attempts === 1) throw new Error('Network Error');
    return { data: { ok: true } };
  };
  const requestId = newRequestId();
  await logic.sendSvcRequest(stub, { action: 'reschedule', ticketId: 7, requestId });
  eq(attempts, 2, '调用次数（首次网络失败 → 重试 1 次）');
  eq(seen, [requestId, requestId], '两次请求带出的 request id');
  return `retry 同号：${requestId.slice(0, 8)}…`;
});

await checkAsync('服务端给了明确状态码时不重试（500/409 由人来决定，不悄悄再来一次）', async () => {
  let attempts = 0;
  const httpError = Object.assign(new Error('Request failed with status code 409'), {
    response: { status: 409, data: { errors: [{ code: 'VISIT_STATE_CHANGED' }] } },
  });
  const stub = async () => {
    attempts += 1;
    throw httpError;
  };
  let caught = null;
  try {
    await sendSvcRequest(stub, { action: 'dispatch', ticketId: 7, requestId: newRequestId() });
  } catch (error) {
    caught = error;
  }
  eq(attempts, 1, '调用次数（HTTP 有响应 ⇒ 不重试）');
  eq(caught?.response?.status, 409, '错误原样抛出（前端要据此展示服务端错误码）');
  assert(!isNetworkFailure(httpError), '带 response 的错误不应被判为网络故障');
  return '409 不重试，错误码透传';
});

check('isNetworkFailure 只在"拿不到任何响应"时为真', () => {
  assert(isNetworkFailure(new Error('socket hang up')), '无 response/status 应为网络故障');
  assert(!isNetworkFailure({ response: { status: 500 } }), '有 response 不算');
  assert(!isNetworkFailure({ status: 422 }), '有 status 不算');
  return '3 种形态判定正确';
});

check('幂等回放只在响应头标注（body 必须与首次逐字相同）', () => {
  // body 一致性由 smoke §4f 在真机上验证；这里锁的是"头名的单一事实来源"
  eq(IDEMPOTENCY_REPLAY_HEADER, 'X-Idempotent-Replay', '回放响应头名');
  return IDEMPOTENCY_REPLAY_HEADER;
});

console.log('\n── H6 派工参数契约：service_mode + provider_name ──');

check('UI 的 service_mode 选项集合必须等于服务端的可派工枚举', () => {
  const values = dispatchServiceModeOptions().map((o) => o.value);
  eq(values, DISPATCHABLE_SERVICE_MODES, '派工选项');
  // 顺序也一并锁住：顺序变了不影响功能，但会让"第几个是厂家"这种口头约定失真
  eq(values, ['inhouse', 'manufacturer', 'third_party'], '顺序');
  return values.join(' / ');
});

check('remote 不得出现在 Phase 4 派工 UI（走 M11，Phase 6）', () => {
  const values = dispatchServiceModeOptions().map((o) => o.value);
  assert(!values.includes(SERVICE_MODE.REMOTE), 'UI 里出现了 remote');
  assert(!values.includes('self'), 'UI 里还残留历史取值 self（已不存在的服务端枚举）');
  assert(SERVICE_MODE.REMOTE === 'remote', '共享常量缺 remote');
  return `remote 不在 ${values.length} 个选项中`;
});

check('每个选项都有中文文案（下拉里不能出现裸枚举值）', () => {
  for (const opt of dispatchServiceModeOptions()) {
    const label = SERVICE_MODE_LABEL[opt.value];
    assert(label && label !== opt.value, `${opt.value} 缺中文文案`);
    eq(opt.label, label, `${opt.value} 的文案与共享表不一致`);
  }
  return dispatchServiceModeOptions().map((o) => `${o.value}=${o.label}`).join('，');
});

check('provider_name 条件必填规则与服务端 assertDispatchInput 一致', () => {
  eq(requiresProviderName('manufacturer'), true, '厂家');
  eq(requiresProviderName('third_party'), true, '第三方');
  eq(requiresProviderName('inhouse'), false, '门店自修');
  eq(requiresProviderName('remote'), false, '远程');
  return '厂家/第三方 必填，门店自修 不必填';
});

check('厂家/第三方未填 provider_name 时前端拦住（服务端仍保留 MISSING_PROVIDER 兜底）', () => {
  const base = {
    technician_name: '李师傅',
    technician_mobile: '13900010002',
    expected_visit_at: '2026-10-01T10:00',
  };
  eq(missingDispatchFields({ ...base, service_mode: 'manufacturer' }), ['provider_name'], '厂家缺名称');
  eq(missingDispatchFields({ ...base, service_mode: 'third_party' }), ['provider_name'], '第三方缺名称');
  eq(missingDispatchFields({ ...base, service_mode: 'inhouse' }), [], '门店自修不应要求填名称');
  // ⚠️ 前端拦住不等于服务端可以放松：绕过 UI 是常态（curl / 自动化测试 /
  //    旧版本的前端产物），服务端必须仍有 MISSING_PROVIDER —— 由 smoke §4f 断言。
  return '条件必填命中 2 类、放行 1 类';
});

check('其余必填字段同样被共享契约拦住（前端提示要有依据）', () => {
  const missing = missingDispatchFields({});
  eq(
    missing,
    ['technician_name', 'technician_mobile', 'expected_visit_at', 'service_mode'],
    '全空表单的缺失项',
  );
  return missing.join('、');
});

check('改约只要时间 + 原因（没有 service_mode / provider_name 的位置）', () => {
  eq(missingRescheduleFields({}), ['expected_visit_at', 'reason'], '全空');
  eq(missingRescheduleFields({ expected_visit_at: '2026-10-01T10:00' }), ['reason'], '缺原因');
  eq(
    missingRescheduleFields({ expected_visit_at: '2026-10-01T10:00', reason: '客户推迟' }),
    [],
    '齐全',
  );
  return 'expected_visit_at + reason';
});

check('提交载荷只含契约字段，且空值的 provider_name 必须先消失', () => {
  eq(buildDispatchPayload({ service_mode: 'manufacturer', provider_name: '海尔' }), {
    service_mode: 'manufacturer',
    provider_name: '海尔',
  }, '厂家');
  // 空串必须被丢弃：服务端会把 "" 当成"填了名字"，而不是"没填"
  eq(buildDispatchPayload({ service_mode: 'inhouse', provider_name: '   ' }), {
    service_mode: 'inhouse',
  }, '门店自修 + 空白名称');
  // 注意字段顺序：payload 按 DISPATCH_FORM_FIELDS 的顺序装配（师傅在前、服务方式在后）
  eq(buildDispatchPayload({ service_mode: 'third_party', technician_name: ' 王师傅 ' }), {
    technician_name: '王师傅',
    service_mode: 'third_party',
  }, '文本两侧空白必须 trim（" 王师傅 " 走到服务端会变成另一个人）');
  return '空值已剔除 / 文本已 trim';
});

check('载荷字段名必须全部落在共享契约的清单里（防止 UI 自行发明字段）', () => {
  const values = Object.fromEntries(DISPATCH_FORM_FIELDS.map((f) => [f, `v-${f}`]));
  const payload = buildDispatchPayload(values);
  for (const key of Object.keys(payload)) {
    assert(DISPATCH_FORM_FIELDS.includes(key), `载荷里出现了清单外的字段 ${key}`);
  }
  eq(Object.keys(payload).sort(), [...DISPATCH_FORM_FIELDS].sort(), '字段集合');
  eq(buildReschedulePayload({ expected_visit_at: '2026-10-01T10:00', reason: '客户推迟', note: 'x' }), {
    expected_visit_at: '2026-10-01T10:00',
    reason: '客户推迟',
  }, '改约载荷（多余字段被丢弃）');
  return DISPATCH_FORM_FIELDS.join('、');
});

check('expected-h6-contract.mjs 这份镜像必须与 TS 侧实现一致（否则 smoke 用的就不是 UI 的契约）', () => {
  // ① 选项集合与顺序
  eq(
    dispatchServiceModeOptions().map((o) => o.value),
    EXPECTED.DISPATCH_SERVICE_MODES,
    'service_mode 选项',
  );
  // ② 文案
  for (const [value, label] of Object.entries(EXPECTED.DISPATCH_SERVICE_MODE_LABELS)) {
    eq(SERVICE_MODE_LABEL[value], label, `${value} 的中文文案`);
  }
  // ③ 条件必填范围（镜像里列的两个，必须与 requiresProviderName 完全重合）
  for (const mode of EXPECTED.PROVIDER_REQUIRED_MODES) {
    eq(requiresProviderName(mode), true, `${mode} 应要求 provider_name`);
  }
  for (const mode of EXPECTED.DISPATCH_SERVICE_MODES) {
    eq(
      requiresProviderName(mode),
      EXPECTED.PROVIDER_REQUIRED_MODES.includes(mode),
      `${mode} 的必填判定与镜像不一致`,
    );
  }
  // ④ 表单字段清单（决定了 UI payload 的键集合）
  eq([...DISPATCH_FORM_FIELDS], EXPECTED.DISPATCH_FORM_FIELDS, '派工字段清单');
  // ⑤ 头名 —— smoke 用它给真机请求加头，必须与服务端的期望同名
  eq(REQUEST_ID_HEADER, EXPECTED.REQUEST_ID_HEADER, 'X-Request-Id 头名');
  eq(IDEMPOTENCY_REPLAY_HEADER, EXPECTED.IDEMPOTENCY_REPLAY_HEADER, '幂等回放头名');
  return '选项 / 文案 / 必填 / 字段清单 / 两个头名 全部一致';
});

check('镜像里的 payload 构造器与 TS 侧行为一致（smoke 发的 body = UI 发的 body）', () => {
  const cases = [
    { technician_name: '李师傅', service_mode: 'manufacturer', provider_name: '海尔' },
    { technician_name: ' 李师傅 ', service_mode: 'inhouse', provider_name: '   ' },
    { service_mode: 'third_party', technician_mobile: '13900010002', bogus: 'x' },
  ];
  for (const values of cases) {
    eq(
      buildDispatchPayload(values),
      EXPECTED.uiDispatchPayload(values),
      `派工载荷 ${JSON.stringify(values)}`,
    );
  }
  eq(
    buildReschedulePayload({ expected_visit_at: '2026-10-01T10:00', reason: '客户推迟', x: 1 }),
    EXPECTED.uiReschedulePayload({ expected_visit_at: '2026-10-01T10:00', reason: '客户推迟', x: 1 }),
    '改约载荷',
  );
  return `${cases.length + 1} 组载荷逐字节一致`;
});

console.log('\n── H3 时效文案 ──');

const NOW = new Date('2026-09-21T12:00:00+08:00').getTime();
const at = (iso) => new Date(iso).getTime();

check('已等待 36 分钟', () => {
  const r = computeTimeliness({
    createdAt: new Date(NOW - 36 * 60000).toISOString(),
    now: NOW,
  });
  eq(r.elapsedText, '已等待 36 分钟', '耗时文案');
  return r.elapsedText;
});

check('距预约还有 2 小时', () => {
  const r = computeTimeliness({
    createdAt: new Date(NOW - 60000).toISOString(),
    expectedVisitAt: new Date(NOW + 2 * 3600000).toISOString(),
    now: NOW,
  });
  eq(r.relativeText, '距预约还有 2 小时', '相对文案');
  eq(r.overdue, false, '不应标记超期');
  assert(r.appointmentText?.includes('今天'), `应含"今天"，实际 ${r.appointmentText}`);
  return `${r.appointmentText} · ${r.relativeText}`;
});

check('已超过预约 47 分钟（overdue=true，但**不做** SLA 判定）', () => {
  const r = computeTimeliness({
    createdAt: new Date(NOW - 3 * 3600000).toISOString(),
    expectedVisitAt: new Date(NOW - 47 * 60000).toISOString(),
    now: NOW,
  });
  eq(r.relativeText, '已超过预约 47 分钟', '超期文案');
  eq(r.overdue, true, '应标记超期');
  return r.relativeText;
});

check('已闭环的工单说"总耗时"，不再说"已等待"', () => {
  const r = computeTimeliness({
    createdAt: new Date(NOW - 5 * 3600000).toISOString(),
    closedAt: new Date(NOW - 4 * 3600000).toISOString(),
    now: NOW,
  });
  assert(r.elapsedText.startsWith('总耗时'), `实际 ${r.elapsedText}`);
  eq(r.elapsedText, '总耗时 1 小时', '总耗时');
  return r.elapsedText;
});

check('尚未响应时明确说"尚未响应"（不显示 0 分钟误导人）', () => {
  const r = computeTimeliness({ createdAt: new Date(NOW - 60000).toISOString(), now: NOW });
  eq(r.firstResponseText, '尚未响应', '首响');
  return r.firstResponseText;
});

check('取不到报修时间时显示占位符，而不是"已等待 0 分钟"', () => {
  const r = computeTimeliness({ createdAt: null, now: NOW });
  eq(r.elapsedText, '—', '缺失时的耗时');
  return r.elapsedText;
});

check('预约跨天时区分今天/明天/昨天', () => {
  const today = computeTimeliness({
    createdAt: new Date(NOW).toISOString(),
    expectedVisitAt: new Date(NOW + 3600000).toISOString(),
    now: NOW,
  });
  const tomorrow = computeTimeliness({
    createdAt: new Date(NOW).toISOString(),
    expectedVisitAt: new Date(NOW + 26 * 3600000).toISOString(),
    now: NOW,
  });
  const yesterday = computeTimeliness({
    createdAt: new Date(NOW).toISOString(),
    expectedVisitAt: new Date(NOW - 26 * 3600000).toISOString(),
    now: NOW,
  });
  assert(today.appointmentText?.includes('今天'), `今天：${today.appointmentText}`);
  assert(tomorrow.appointmentText?.includes('明天'), `明天：${tomorrow.appointmentText}`);
  assert(yesterday.appointmentText?.includes('昨天'), `昨天：${yesterday.appointmentText}`);
  return [today, tomorrow, yesterday].map((r) => r.appointmentText).join(' / ');
});

check('不足 1 分钟说"不到 1 分钟"，不显示 0 分钟', () => {
  const r = computeTimeliness({
    createdAt: new Date(NOW - 5000).toISOString(),
    now: NOW,
  });
  eq(r.elapsedText, '已等待 不到 1 分钟', '极短时长');
  return r.elapsedText;
});

// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✅ 客户端纯逻辑验收全部通过：${passed} 项`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(0);
}
console.log(`  ❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log(`     • ${f.name}：${f.message}`);
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(1);
