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
      // H3 详情抽屉的展示语义层（状态中文 / 当前 Visit / 时间线）——
      // Phase 4-I 第二轮新增：抽屉从"字段陈列"改成"四区块叙事"时，
      // 这些翻译规则必须能被离线断言，否则只能靠打开浏览器肉眼看
      reexport(CLIENT_DIR, 'ticket-display'),
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
  'ticket-display.ts',
  'ticket-drawer.tsx',
  'ticket-actions.tsx',
  // P6-0：门店回执**只读**区块（内联在 H3 详情抽屉里，见 docs/PHASE-6.md §6.3）。
  // 它是新的一处"手写 URL + 直接渲染服务端字段"的地方，必须同样纳入源码口径断言。
  'ticket-store-review.tsx',
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
const {
  statusTimelinessLine,
  formatAppointmentDate,
  activeVisitOf,
  submittedVisitOf,
  buildTimeline,
  visitStatusText,
  eventActionText,
  serviceModeText,
  DETAIL_HIDDEN_FIELDS,
  TERMINAL_VISIT_STATUSES,
} = logic;
const { availableActionsOf, TICKET_ACTION, TICKET_ACTION_LABEL } = logic;
const {
  SERVICE_MODE,
  SERVICE_MODE_LABEL,
  DISPATCHABLE_SERVICE_MODES,
  DISPATCH_FORM_FIELDS,
  REASSIGN_FORM_FIELDS,
  APPOINTMENT_CANONICAL_TIME,
  APPOINTMENT_TIMEZONE_OFFSET,
  dispatchServiceModeOptions,
  requiresProviderName,
  missingDispatchFields,
  missingRescheduleFields,
  missingReassignFields,
  buildDispatchPayload,
  buildReassignPayload,
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

check('改派原因必填（UI 与载荷两侧同时成立，不能只靠 antd 拦）', () => {
  // ⚠️ Phase 4-I 第二轮 P0：真人**填了**原因却被服务端判 MISSING_REASON。
  //    根因是"表单挂了 reason，但载荷白名单里没有它"。
  //    修法不是放宽服务端，而是让**表单清单 / 必填判定 / 载荷构造器三者同源**。
  //    端到端版本见 scripts/verify-reassign-contract.mjs（真打接口）。
  const base = {
    technician_name: '李师傅',
    technician_mobile: '13900010002',
    expected_visit_at: '2026-10-01T10:00',
    service_mode: 'inhouse',
  };
  eq(missingReassignFields({ ...base, reason: '临时有其他急单' }), [], '填了原因应放行');
  eq(missingReassignFields({ ...base, reason: '   ' }), ['reason'], '空白原因必须被点名');
  eq(missingReassignFields(base), ['reason'], '完全没填原因必须被点名');
  // 载荷侧：有原因就必须带上，空原因就必须不出现（不能把空串发给服务端）
  eq(buildReassignPayload({ ...base, reason: '临时有其他急单' }).reason, '临时有其他急单', '载荷里的原因');
  assert(!('reason' in buildReassignPayload({ ...base, reason: ' ' })), '空原因不该进载荷');
  return '填了必带 / 空必拦 / 两侧同源';
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
  // ⚠️ expected_visit_at 会在**出口**被规范化成"当日 12:00 +08:00"：
  //    项目不采集签到/到达/GPS/排班时段，因此界面上不该出现精确到分钟的承诺，
  //    而存储层必须给 datetime 字段一个值 —— 统一取正午（抗时区误读）。
  eq(
    buildReschedulePayload({ expected_visit_at: '2026-10-01T10:00', reason: '客户推迟', note: 'x' }),
    {
      expected_visit_at: '2026-10-01T12:00:00+08:00',
      reason: '客户推迟',
    },
    '改约载荷（多余字段被丢弃 + 日期已规范化）',
  );
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
  // ④b 改派字段清单（= 派工 + reason）—— P0 缺陷的**结构**判据
  eq([...REASSIGN_FORM_FIELDS], EXPECTED.REASSIGN_FORM_FIELDS, '改派字段清单');
  assert(
    REASSIGN_FORM_FIELDS.includes('reason'),
    '改派字段清单里没有 reason —— 用户填的原因又会被静默丢掉',
  );
  // ④c 日期规范化的两个常量必须同值（否则两端会算出不同的"同一天"）
  eq(APPOINTMENT_CANONICAL_TIME, EXPECTED.APPOINTMENT_CANONICAL_TIME, '规范化的固定时刻');
  eq(APPOINTMENT_TIMEZONE_OFFSET, EXPECTED.APPOINTMENT_TIMEZONE_OFFSET, '业务时区偏移');
  // ⑤ 头名 —— smoke 用它给真机请求加头，必须与服务端的期望同名
  eq(REQUEST_ID_HEADER, EXPECTED.REQUEST_ID_HEADER, 'X-Request-Id 头名');
  eq(IDEMPOTENCY_REPLAY_HEADER, EXPECTED.IDEMPOTENCY_REPLAY_HEADER, '幂等回放头名');
  return '选项 / 文案 / 必填 / 三个字段清单 / 两个日期常量 / 两个头名 全部一致';
});

check('镜像里的 payload 构造器与 TS 侧行为一致（smoke 发的 body = UI 发的 body）', () => {
  const cases = [
    { technician_name: '李师傅', service_mode: 'manufacturer', provider_name: '海尔' },
    { technician_name: ' 李师傅 ', service_mode: 'inhouse', provider_name: '   ' },
    { service_mode: 'third_party', technician_mobile: '13900010002', bogus: 'x' },
    // 带日期的一例：验规范化后的键值两侧也逐字节一致
    {
      technician_name: '王师傅',
      technician_mobile: '13900010001',
      expected_visit_at: '2026-10-01T09:37:00+08:00',
      service_mode: 'manufacturer',
      provider_name: '海尔',
    },
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
  // 改派载荷：**两侧都必须带 reason**（P0 缺陷的镜像侧判据）
  const reassignValues = {
    technician_name: '李师傅',
    technician_mobile: '13900010002',
    expected_visit_at: '2026-10-02',
    service_mode: 'manufacturer',
    provider_name: '海尔',
    reason: '临时有其他急单',
  };
  eq(buildReassignPayload(reassignValues), EXPECTED.uiReassignPayload(reassignValues), '改派载荷');
  assert('reason' in EXPECTED.uiReassignPayload(reassignValues), '镜像侧把 reason 丢了');
  return `${cases.length + 2} 组载荷逐字节一致`;
});

console.log('\n── H3 时效文案（每个状态只说一句话）──');
// ⚠️ 2026-09-23 收紧：原实现一次产出四行（耗时/首响/预约/倒计时），
//    第二轮真人走查反馈"信息层级混乱"。现改为 `statusTimelinessLine()` 单行。
//    断言也随之重写 —— 断言跟着**契约**走，不跟着实现走。

const NOW = new Date('2026-09-23T12:00:00+08:00').getTime();

check('待受理 ⇒ 等待受理 X（计时起点 = 报修时间）', () => {
  const line = statusTimelinessLine({
    status: 'NEW',
    createdAt: new Date(NOW - 36 * 60000).toISOString(),
    now: NOW,
  });
  eq(line, '等待受理 36 分钟', '待受理文案');
  return line;
});

check('处理中 ⇒ "预计 X 上门"（只到天，**不含时分**）', () => {
  const line = statusTimelinessLine({
    status: 'PROCESSING',
    createdAt: new Date(NOW - 3600000).toISOString(),
    expectedVisitAt: new Date(NOW + 86400000).toISOString(),
    now: NOW,
  });
  eq(line, '预计 明天 上门', '处理中文案');
  assert(!/\d{1,2}:\d{2}/.test(line), `文案里出现了时分：${line}`);
  return line;
});

check('处理中但没约定日期 ⇒ 说"已受理，尚未派工"，不编日期', () => {
  const line = statusTimelinessLine({ status: 'PROCESSING', createdAt: new Date(NOW).toISOString(), now: NOW });
  eq(line, '已受理，尚未派工', '无预约时的文案');
  return line;
});

check('待门店确认 ⇒ 计时起点取"进入该状态的事件"，不是 updated_at', () => {
  const entered = new Date(NOW - 3 * 3600000).toISOString();
  const line = statusTimelinessLine({
    status: 'WAIT_STORE_CONFIRM',
    // 工单创建在 2 天前，但"进入待确认"只有 3 小时 —— 必须说 3 小时
    createdAt: new Date(NOW - 2 * 86400000).toISOString(),
    events: [
      { event_type: 'created', to_status: 'NEW', created_at: new Date(NOW - 2 * 86400000).toISOString() },
      { event_type: 'technician_submitted', to_status: 'WAIT_STORE_CONFIRM', created_at: entered },
    ],
    now: NOW,
  });
  eq(line, '等待门店确认 3 小时', '待门店确认文案');
  return line;
});

check('待客户评价 ⇒ 等待客户评价 X', () => {
  const line = statusTimelinessLine({
    status: 'WAIT_FEEDBACK',
    createdAt: new Date(NOW - 3 * 86400000).toISOString(),
    events: [
      { event_type: 'store_confirmed', to_status: 'WAIT_FEEDBACK', created_at: new Date(NOW - 86400000).toISOString() },
    ],
    now: NOW,
  });
  eq(line, '等待客户评价 1 天', '待评价文案');
  return line;
});

check('已闭环 ⇒ 完成于 X · 总耗时 Y（不说"已等待"）', () => {
  const line = statusTimelinessLine({
    status: 'CLOSED',
    createdAt: new Date(NOW - 5 * 3600000).toISOString(),
    closedAt: new Date(NOW - 4 * 3600000).toISOString(),
    now: NOW,
  });
  assert(line.includes('完成于'), `应含"完成于"：${line}`);
  assert(line.includes('总耗时 1 小时'), `总耗时不对：${line}`);
  return line;
});

check('已取消 ⇒ 只说明已取消（不给无意义的等待时长）', () => {
  const line = statusTimelinessLine({ status: 'CANCELLED', createdAt: new Date(NOW - 3600000).toISOString(), now: NOW });
  eq(line, '工单已取消', '已取消文案');
  return line;
});

check('状态取不到 ⇒ 空串（宁可这一行不显示，也不显示假文案）', () => {
  eq(statusTimelinessLine({ status: null, now: NOW }), '', '无状态');
  eq(statusTimelinessLine({ now: NOW }), '', '未传状态');
  return '返回空串，由抽屉决定整行不渲染';
});

check('不足 1 分钟说"不到 1 分钟"，不显示 0 分钟', () => {
  const line = statusTimelinessLine({
    status: 'NEW',
    createdAt: new Date(NOW - 5000).toISOString(),
    now: NOW,
  });
  eq(line, '等待受理 不到 1 分钟', '极短时长');
  return line;
});

check('预计上门日期跨天区分 今天 / 明天 / 昨天', () => {
  const today = formatAppointmentDate(new Date(NOW + 3600000).toISOString(), NOW);
  const tomorrow = formatAppointmentDate(new Date(NOW + 26 * 3600000).toISOString(), NOW);
  const yesterday = formatAppointmentDate(new Date(NOW - 26 * 3600000).toISOString(), NOW);
  const later = formatAppointmentDate(new Date(NOW + 10 * 86400000).toISOString(), NOW);
  eq(today, '今天', '今天');
  eq(tomorrow, '明天', '明天');
  eq(yesterday, '昨天', '昨天');
  assert(/^\d+月\d+日$/.test(later), `更远的日子应只给月日，实际 ${later}`);
  return [today, tomorrow, yesterday, later].join(' / ');
});

check('⚠️ 预计上门日期**绝不输出时分**（规范化出来的 12:00 不得出现在界面）', () => {
  // 存储层把日期规范化成当日 12:00（APPOINTMENT_CANONICAL_TIME）。
  // 那个 12:00 是**产物**、不是承诺 —— 一旦显示出来就会被读成"师傅中午到"。
  const canonical = `2026-09-24T12:00:00+08:00`;
  for (const text of [
    formatAppointmentDate(canonical, NOW),
    statusTimelinessLine({ status: 'PROCESSING', expectedVisitAt: canonical, now: NOW }),
    statusTimelinessLine({
      status: 'CLOSED',
      createdAt: canonical,
      closedAt: canonical,
      now: NOW,
    }),
  ]) {
    assert(!/\d{1,2}:\d{2}/.test(text), `出现了时分：${text}`);
    assert(!text.includes('12:00'), `出现了固定时刻：${text}`);
  }
  return '三条时效文案均只到天';
});

console.log('\n── H3 详情：当前服务 / 时间线（第二轮整改）──');

check('activeVisitOf：改派后"当前服务"必须是 Visit #2（不是被取代的那条）', () => {
  const visits = [
    { visit_no: 1, visit_status: 'SUPERSEDED', technician_name: '王师傅' },
    { visit_no: 2, visit_status: 'ASSIGNED', technician_name: '李师傅' },
  ];
  const active = activeVisitOf(visits);
  eq(active?.visit_no, 2, '当前 Visit');
  eq(active?.technician_name, '李师傅', '当前技师');
  return 'Visit #2 / 李师傅';
});

check('activeVisitOf：全部是终态 ⇒ null（历史不构成"当前服务"）', () => {
  eq(activeVisitOf([{ visit_no: 1, visit_status: 'SUPERSEDED' }]), null, '全被取代');
  eq(activeVisitOf([]), null, '空数组');
  eq(activeVisitOf(null), null, 'null');
  eq(activeVisitOf([{ visit_no: 1, visit_status: 'CANCELLED' }]), null, '已取消');
  return `${TERMINAL_VISIT_STATUSES.join(' / ')} 都不算当前服务`;
});

console.log('\n── P6-0 门店回执：审核对象由**状态**决定（不是顺序）──');

check('submittedVisitOf：改派后审核对象是 SUBMITTED 那条，**不是** visit_no 最大的历史行', () => {
  // 这是 P6-0 唯一会"看错对象"的地方：改派让旧 Visit 转 SUPERSEDED 并新建一条，
  // 两条并存。若按顺序（visit_no 最大 / 时间最新）取，就会把**已被取代**的回执
  // 当成待门店确认对象展示（`docs/PHASE-6.md` §4.1 明令钉死由状态决定）。
  const visits = [
    { visit_no: 1, visit_status: 'SUBMITTED', technician_name: '王师傅' },
    { visit_no: 2, visit_status: 'ASSIGNED', technician_name: '李师傅' },
  ];
  const target = submittedVisitOf(visits);
  eq(target?.visit_no, 1, '审核对象');
  eq(target?.technician_name, '王师傅', '回执归属技师');
  // 反向锚点：同一份数据下 activeVisitOf 给出的是**另一条** ——
  // 证明两者判据确实不同，而不是"恰好相等所以看不出问题"。
  eq(activeVisitOf(visits)?.visit_no, 2, '当前服务（与审核对象不同，正是重点）');
  return 'SUBMITTED=Visit#1 / 当前服务=Visit#2';
});

check('submittedVisitOf：无待确认回执 ⇒ null（已确认/已驳回/全历史都不算）', () => {
  eq(submittedVisitOf([{ visit_no: 1, visit_status: 'CONFIRMED' }]), null, '已确认');
  eq(submittedVisitOf([{ visit_no: 1, visit_status: 'REJECTED' }]), null, '已驳回');
  eq(submittedVisitOf([{ visit_no: 1, visit_status: 'SUPERSEDED' }]), null, '历史');
  eq(submittedVisitOf([]), null, '空数组');
  eq(submittedVisitOf(null), null, 'null');
  return '只有 SUBMITTED 才算审核对象';
});

check('submittedVisitOf 与服务端同源：用的是 VISIT_STATUS.SUBMITTED 而不是裸字符串', () => {
  const src = readClientSource('ticket-display.ts');
  assert(
    src.includes('VISIT_STATUS.SUBMITTED'),
    'ticket-display.ts 没有引用 VISIT_STATUS.SUBMITTED —— 枚举漂移时不会一起改',
  );
  return 'VISIT_STATUS.SUBMITTED（与服务端 constants 同一份）';
});

check('Visit 状态中文化：ASSIGNED=已派工 / SUBMITTED=待门店确认（一线口径）', () => {
  eq(visitStatusText('ASSIGNED'), '已派工', 'ASSIGNED');
  // ⚠️ 原文案是"师傅已提交"（过去时）。门店同事要判断的是"现在轮到我了吗"，
  //    所以改成"待门店确认"（Phase 4-I 第二轮整改）。
  eq(visitStatusText('SUBMITTED'), '待门店确认', 'SUBMITTED');
  eq(visitStatusText('CONFIRMED'), '门店已确认', 'CONFIRMED');
  // 未知状态给中性词，**绝不回落成英文枚举**
  eq(visitStatusText('WEIRD'), '状态未知', '未知状态');
  return '已派工 / 待门店确认 / 门店已确认 / 状态未知';
});

check('服务方式中文化：remote 带"（不派工）"提示，未知值给"其他方式"', () => {
  eq(serviceModeText('inhouse'), '门店自修', 'inhouse');
  eq(serviceModeText('manufacturer'), '厂家', 'manufacturer');
  eq(serviceModeText('remote'), '远程指导（不派工）', 'remote');
  eq(serviceModeText('mystery'), '其他方式', '未知值');
  eq(serviceModeText(null), '', '空值 → 空串（由界面决定不渲染这一行）');
  return 'inhouse / manufacturer / third_party / remote（+不派工）';
});

check('buildTimeline：按时间升序、每项含 谁·何时·做了什么', () => {
  const entries = buildTimeline([
    {
      id: 3,
      event_type: 'reassigned',
      operator_kind: 'store',
      summary: '改派：王师傅 → 李师傅；原因：临时有其他急单',
      created_at: new Date(NOW - 60000).toISOString(),
    },
    {
      id: 1,
      event_type: 'created',
      operator_kind: 'customer',
      summary: '客户提交报修（S01）',
      created_at: new Date(NOW - 7200000).toISOString(),
    },
    {
      id: 2,
      event_type: 'dispatched',
      operator_kind: 'store',
      summary: '派工：王师傅 · 厂家（UAT测试厂家）· 预计 9月24日',
      created_at: new Date(NOW - 3600000).toISOString(),
    },
  ]);
  eq(entries.length, 3, '条数');
  // 升序：最早的在最前，读起来是"这张单是怎么走到今天的"
  eq(entries.map((e) => e.action), ['客户已报修', '门店已派工', '门店已改派'], '动作顺序');
  eq(entries.map((e) => e.actor), ['客户', '门店', '门店'], '操作方身份');
  assert(entries[0].at.includes('月') && entries[0].at.includes(':'), `时间格式：${entries[0].at}`);
  eq(entries[2].detail, '改派：王师傅 → 李师傅；原因：临时有其他急单', '详情保留服务端业务文案');
  return `${entries[0].at} → ${entries[2].at}`;
});

check('buildTimeline：未知事件类型给中性词，**绝不把 event_type 原样打到界面上**', () => {
  const [entry] = buildTimeline([
    { id: 9, event_type: 'future_unknown_event', operator_kind: 'hq', summary: '', created_at: new Date(NOW).toISOString() },
  ]);
  eq(entry.action, '工单记录', '未知类型');
  eq(entry.actor, '总部', '身份');
  // 英文枚举（含下划线）绝不能出现在渲染文本里
  for (const text of [entry.action, entry.actor]) {
    assert(!/[a-z]+_[a-z]+/.test(text), `出现了英文枚举：${text}`);
  }
  return '工单记录（而不是 future_unknown_event）';
});

check('buildTimeline：短信事件降级为"通知"，不抢业务动作的位置', () => {
  const entries = buildTimeline([
    { id: 1, event_type: 'dispatched', operator_kind: 'store', summary: '派工：王师傅', created_at: new Date(NOW).toISOString() },
    { id: 2, event_type: 'sms_sent', operator_kind: 'system', summary: '短信已发送', created_at: new Date(NOW).toISOString() },
  ]);
  eq(entries[0].notice, false, '业务动作不是通知');
  eq(entries[1].notice, true, '短信是通知');
  eq(entries[1].action, '已通知客户（短信）', '短信动作名');
  return '业务动作 normal / 短信 notice';
});

/** 读客户端源码并**去掉注释** —— 源码扫描类断言的共用入口 */
function readClientSource(file) {
  const raw = fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8');
  // ⚠️ 必须先剥注释：本文件里大量注释在**解释缺陷本身**（例如
  //    "这里曾经写成 `/api/svc:timeline`"），直接扫原文会把解释当成违规，
  //    报出一堆假红 —— 而"会误报的检查比没检查更糟"（铁律 2）。
  //    剥注释后剩下的才是**真的会被执行/被渲染**的代码。
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

check('详情抽屉/回执区块默认不展示内部字段与凭据（源码口径）', () => {
  // ⚠️ 复核方 2026-09-23 明确列出的"默认隐藏"清单。
  //    判据用**属性访问形态**（`.字段名`），而不是裸子串 ——
  //    否则抽屉注释里写一句"按 ticket_id 在服务端查"就会假红。
  // P6-0：新增的「技师回执」区块同样直接渲染服务端字段（含照片元数据），
  //       因此必须**一起**纳入扫描 —— 只盯 ticket-drawer.tsx 会留一个新口子。
  const drawer = ['ticket-drawer.tsx', 'ticket-store-review.tsx']
    .map(readClientSource)
    .join('\n');
  assert(DETAIL_HIDDEN_FIELDS.length >= 8, `隐藏清单过短（${DETAIL_HIDDEN_FIELDS.length} 项）`);
  const pattern = new RegExp(
    `\\.(${DETAIL_HIDDEN_FIELDS.join('|')})\\b`,
  );
  const hit = drawer.match(pattern);
  assert(!hit, `详情抽屉/回执区块里出现了默认隐藏的字段：${hit?.[0]}`);
  // 反向：清单本身必须真的在"展示语义层"里定义（不是只在我这个脚本里写死）
  const display = fs.readFileSync(path.join(CLIENT_DIR, 'ticket-display.ts'), 'utf8');
  for (const field of DETAIL_HIDDEN_FIELDS) {
    assert(display.includes(`'${field}'`), `ticket-display.ts 的隐藏清单缺 ${field}`);
  }
  return `${DETAIL_HIDDEN_FIELDS.length} 个字段：两个渲染文件都不引用、清单有定义`;
});

check('详情抽屉/回执区块的请求路径**不带 `/api` 前缀**（否则真实请求会变成 /api/api/… → 404）', () => {
  // ⚠️ 这条是补一个**真实发生过的缺陷**（2026-09-23，由 preflight §3.7 的无头浏览器
  //    点开抽屉时暴露）：抽屉写的是 `/api/svc:timeline`，而注入的 request 最终走
  //    `app.apiClient.request()`，它会自己补 `/api` → 真实请求
  //    `GET /api/api/svc:timeline` → 404 → 抽屉永远"加载失败"。
  //
  //    为什么之前全绿：写动作走 `svc-request.ts`（那里本来就无前缀），
  //    只有抽屉手写 URL —— 于是**唯一手写的地方就是唯一会错的地方**，
  //    而没有任何断言看过"浏览器发出的那个 URL"。
  // P6-0：回执区块又添了**两处**手写 URL（`svc/visits/:id`、`svc/photos/:id`），
  //       所以这条断言的覆盖面必须跟着扩大，否则同一类缺陷会原样复发。
  const drawer = readClientSource('ticket-drawer.tsx');
  const review = readClientSource('ticket-store-review.tsx');
  for (const [name, src] of [['ticket-drawer.tsx', drawer], ['ticket-store-review.tsx', review]]) {
    const bad = src.match(/['"`]\/api\//g) ?? [];
    assert(bad.length === 0, `${name} 里出现了带 /api 前缀的路径 ${bad.length} 处（会变成 /api/api/…）`);
  }
  // 正向：必须真的在用 `svc:<action>` / `svc/...` 形态
  for (const path of ['svc:timeline?', 'svc:visits?']) {
    assert(drawer.includes(path), `抽屉没有使用 ${path} 路径`);
  }
  for (const path of ['svc/visits/', 'svc/photos/']) {
    assert(review.includes(path), `回执区块没有使用 ${path} 路径`);
  }
  return 'svc:timeline / svc:visits / svc/visits/:id / svc/photos/:id（同一约定）';
});

check('详情抽屉不自己翻译事件枚举（必须走 ticket-display 的中文映射）', () => {
  const drawer = readClientSource('ticket-drawer.tsx');
  assert(!drawer.includes('e.event_type'), '抽屉里直接渲染了 event_type —— 会显示英文枚举');
  assert(!drawer.includes('event_type ??'), '抽屉里在兜底显示 event_type');
  // 必须真的用了这三个：当前 Visit / 时间线 / 单行时效
  for (const fn of ['activeVisitOf(', 'buildTimeline(', 'statusTimelinessLine(']) {
    assert(drawer.includes(fn), `抽屉没有使用 ${fn} —— 四区块叙事被改回字段陈列了？`);
  }
  // P6-0：抽屉必须**真的按状态**挑出审核对象并把它交给只读区块 ——
  // 少了这一步，`<StoreReviewSection>` 永远不渲染，"能看到照片"就成了空话。
  assert(drawer.includes('submittedVisitOf('), '抽屉没有用 submittedVisitOf 选审核对象');
  assert(drawer.includes('<StoreReviewSection'), '抽屉没有渲染 StoreReviewSection 只读区块');
  return 'activeVisitOf + buildTimeline + statusTimelinessLine + submittedVisitOf→StoreReviewSection';
});

// ---------------------------------------------------------------------------
// P6-2：确认 / 驳回的**客户端接线**源码断言。
//
// 用户明确"机器侧只验证按钮显隐 + 请求 payload/request-id + 成功后刷新 + 409 刷新"，
// 所以这里只钉这四件事的**接线**，不建一整套 UI mutation 门（那是给状态机留的，
// 写路径的语义已由 verify-store-review-write.mjs 全覆盖）。四条断言都是纯源码口径。
// ---------------------------------------------------------------------------

check('P6-2 按钮显隐：确认/驳回只在「待门店确认」回执区块内出现（不渲染在非审核状态）', () => {
  const review = readClientSource('ticket-store-review.tsx');
  const drawer = readClientSource('ticket-drawer.tsx');
  // 两个按钮必须真实存在于回执区块（不是"以后会加"的占位）——
  // 文案是独立一行 JSX（`>\n  确认服务\n<`），用 `>\s*文案` 锚定 Button 开标签。
  assert(/>\s*确认服务\s*</.test(review), '回执区块没有「确认服务」按钮');
  assert(/>\s*驳回\s*</.test(review), '回执区块没有「驳回」按钮');
  // 区块只在 submittedVisit 存在时才渲染（这条 P6-0 已钉，这里再确认按钮不逃出这个条件）
  assert(drawer.includes('submittedVisit?.id != null'), '抽屉没有按 submittedVisit 条件渲染回执区块');
  return '确认服务 / 驳回按钮在回执区块内，且区块仍受 submittedVisit 条件门控';
});

check('P6-2 金额口径：is_charged=false 不渲染金额输入框（避免 0.00 误导）', () => {
  const review = readClientSource('ticket-store-review.tsx');
  // 金额输入框必须被 isCharged 门控：不收费时不出现，收费时才出现
  assert(review.includes('isCharged'), '回执区块没有读取 is_charged 服务事实');
  // 确认模态框里金额 Form.Item 必须在 isCharged 分支内
  assert(
    /\{isCharged \? \([^)]*Form\.Item[\s\S]*?amount[\s\S]*?\) : null\}/.test(review),
    '金额输入框没有被 isCharged 条件门控',
  );
  return '金额输入框仅 is_charged=true 时出现（不收费无输入框，落 NULL 而非 0.00）';
});

check('P6-2 请求 payload/request-id：写请求带 X-Request-Id 且走斜杠式 confirm/reject 路径', () => {
  const review = readClientSource('ticket-store-review.tsx');
  // 幂等号由 newRequestId 生成 + REQUEST_ID_HEADER 头（与 ticket-actions 同一套纪律）
  assert(review.includes('newRequestId('), '没有用 newRequestId 生成幂等号');
  assert(review.includes('REQUEST_ID_HEADER'), '没有引用 REQUEST_ID_HEADER 头名');
  // 斜杠式路径（与 nginx 两段式 rewrite、门禁脚本同源）
  assert(
    review.includes('`svc/visits/${visitId}/${action}`'),
    '写请求不是 svc/visits/:id/confirm|reject 斜杠式路径',
  );
  // reject 只带 reason（不碰金额/Token）
  assert(review.includes("reason: String(values.reason"), 'reject payload 没有只收 reason');
  return 'newRequestId + X-Request-Id + svc/visits/:id/{confirm|reject}（斜杠式）';
});

check('P6-2 成功后刷新：确认/驳回成功或 409 冲突都回调 onChanged 触发整页重拉', () => {
  const review = readClientSource('ticket-store-review.tsx');
  const drawer = readClientSource('ticket-drawer.tsx');
  // 成功分支必须调用 onChanged（整页交给父组件重拉）
  assert(review.includes('onChanged?.()'), '成功/冲突分支没有回调 onChanged');
  // 父组件把 onChanged 接到 load()：确认/驳回后工单状态、时间线、按钮一起刷新
  assert(drawer.includes('onChanged={() => void load()}'), '抽屉没有把 onChanged 接到 load()');
  return 'onChanged → load()：成功后按钮消失 + 状态标签 + 时间线一起刷新';
});

check('P6-2 409 刷新：冲突码识别 + "已被处理"话术 + 刷新（不是泛泛"操作失败"）', () => {
  const review = readClientSource('ticket-store-review.tsx');
  // 409 冲突码集合必须含 visitId 冲突 / 并发冲突 / 状态机拒绝三类
  for (const code of ['VISIT_NOT_REVIEWABLE', 'IDEMPOTENT_VISIT_MISMATCH', 'CONFLICT_STATE_CHANGED']) {
    assert(review.includes(`'${code}'`), `冲突码集合缺 ${code}`);
  }
  // 冲突时给"已被处理"话术，而非泛泛"操作失败"
  assert(
    review.includes('已被其他人员处理'),
    '409 冲突没有「已被其他人员处理」的中文话术',
  );
  // 冲突时 refresh=true → 走 onChanged 重拉
  assert(review.includes('refresh: true'), '冲突分支没有标记 refresh');
  return '409 → 已被处理话术 + 重拉最新状态（不把状态机拒绝显示成"系统坏了"）';
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
