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
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'nocobase/plugins/service-ticket/src/client');
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

  // 两个模块都是零依赖的纯 TS，直接 re-export 成一个入口
  fs.writeFileSync(
    entry,
    [
      "export * from '" + path.join(CLIENT_DIR, 'timeliness').replace(/\\/g, '/') + "';",
      "export * from '" + path.join(CLIENT_DIR, 'action-matrix').replace(/\\/g, '/') + "';",
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

for (const file of ['timeliness.ts', 'action-matrix.ts', 'ticket-drawer.tsx', 'ticket-actions.tsx']) {
  if (!fs.existsSync(path.join(CLIENT_DIR, file))) {
    console.log(`  ❌ 环境未就绪：缺少 ${file}`);
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
