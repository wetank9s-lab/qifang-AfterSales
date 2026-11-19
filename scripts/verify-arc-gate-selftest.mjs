#!/usr/bin/env node
/**
 * verify-arc-gate-selftest.mjs —— 「publicArchive 双层闸门」判据的**自证**
 * =============================================================================
 * 存在的理由（铁律⑤：验证器自己也会错，且错得比产品更隐蔽）
 * -----------------------------------------------------------------------------
 * 本轮（ARC-V1 / FINAL-LAUNCH · D2）把闸门从**资源级**收紧成**资源级 + Action 级**。
 * 这件事如果只靠"跑一遍 HTTP 看 403"，会出现三类假绿，本脚本逐条封住：
 *
 *   ① **判据太宽**：只要状态码是 403 就判通过。
 *      nginx 的 403（`location ^~ /api/publicArchive:` 的 return 403，返回 HTML）、
 *      ACL 的 403、甚至被限流的 429 都长得不一样，但只要有人写成 `status===403`，
 *      "服务端闸门"与"nginx 挡住"就再也分不开 —— 而本轮要证明的恰恰是
 *      服务端自己也会拦（直连 :13000 绕过 nginx 时仍然 403）。
 *      ⇒ 判据必须落到**我方错误码** `PUBLIC_ARCHIVE_DISABLED` /
 *        `PUBLIC_ARCHIVE_ACTION_CLOSED` 上。
 *
 *   ② **只测一个方向**：只测"关着时被拦"，不测"开着时能通"。
 *      那么一段把 6 条动作全挡死的代码也会全绿。
 *      ⇒ 每组都要有正向对照。
 *
 *   ③ **'true' 与 'false' 混着测**：只测 `'true'` 会让
 *      `raw ? true : false`（字符串 'false' 是 truthy）这种最经典的写反通过。
 *
 * ⇒ 本脚本用**桌面级纯函数 fixture**（双向）+ **与 .ts 源码的结构比对**
 *    + **变异测试**（放宽判据后必须真的变红）三段组成。
 *
 * 与 `verify-public-archive-gate.mjs` 的分工（**不重复**）：
 *   · 那个脚本打 HTTP，验的是**部署后行为**（含重启、含 nginx 之外的直连）；
 *   · 本脚本**不起任何服务**，验的是**判据本身**是否写对、是否能变红。
 *     它可以在 CI/提交前跑，几毫秒出结果。
 *
 * 用法：
 *   node scripts/verify-arc-gate-selftest.mjs            # 正常自证
 *   node scripts/verify-arc-gate-selftest.mjs --json     # 机器可读输出
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = **工具自身故障**（fixture 读不到 / 源码读不到）
 *   ⚠️ 2 与 1 必须分开：脚本坏了不能报成"产品坏了"（本项目铁律⑤明确要求）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as R from './lib/public-archive-gate.rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TS_SRC = path.join(
  ROOT, 'nocobase/plugins/service-ticket/src/server/middleware/public-archive-gate.ts');
const TS_PLUGIN_SRC = path.join(
  ROOT, 'nocobase/plugins/service-ticket/src/server/plugin.ts');
const JSON_OUT = process.argv.includes('--json');

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: Boolean(pass), detail: String(detail ?? '') });
  if (!JSON_OUT) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}`);
    if (detail) console.log(`        ${detail}`);
  }
}
function section(title) {
  if (!JSON_OUT) console.log(`\n${'-'.repeat(76)}\n${title}\n${'-'.repeat(76)}`);
}

// ===========================================================================
section('0. 前置：.ts 源码必须可读（读不到 ⇒ 工具故障，退出码 2，不给产品结论）');
// ===========================================================================
let tsSrc = '';
try {
  tsSrc = fs.readFileSync(TS_SRC, 'utf8');
} catch (e) {
  console.error(`[selftest] 读不到 ${TS_SRC}：${e?.message}`);
  console.error('[selftest] 这是**工具故障**，不是产品缺陷 ⇒ 退出码 2，不产出 PASS/FAIL 结论');
  process.exit(2);
}
check('P0', '.ts 源码可读', tsSrc.length > 1000, `${tsSrc.length} 字符`);

// 服务端是 CRLF（本项目铁律：用 \n 拼的多行锚点永远匹配不上）
const NL = tsSrc.includes('\r\n') ? '\r\n' : '\n';
check('P0b', '已识别源码行尾（CRLF/LF），后续锚点按它对齐',
  NL === '\r\n' || NL === '\n', `lineEnding=${NL === '\r\n' ? 'CRLF' : 'LF'}`);

// ===========================================================================
section('1. 开关求值：五档判据（关/开/宽松真值/大小写/缺失）');
// ===========================================================================
// ⚠️ 'false' 是 truthy 字符串 —— `Boolean(process.env.X)` 会把它读成 true。
//    这是本项目踩过、门禁必须钉死的那一条。
const envCases = [
  [undefined, false, '未设置'],
  ['', false, '空串'],
  ['false', false, "'false'（★ truthy 字符串陷阱）"],
  ['0', false, "'0'"],
  ['no', false, "'no'"],
  ['off', false, "'off'"],
  ['yes', false, "'yes'（宽松真值不得放行）"],
  ['on', false, "'on'"],
  ['1', false, "'1'"],
  ['TRUE ', true, "'TRUE '（大小写+空白 = 同一个值）"],
  ['  true  ', true, '两侧空白'],
  ['true', true, "'true'"],
];
const badEnv = [];
for (const [v, want, label] of envCases) {
  const got = R.booleanEnv({ X: v }, 'X');
  if (got !== want) badEnv.push(`${label}: 期望 ${want} 实得 ${got}`);
}
check('S1', '资源级/动作级开关共用同一套"规范化后严格等于 true"判据（12 档）',
  badEnv.length === 0,
  badEnv.length ? badEnv.join(' | ') : `已验 ${envCases.length} 档；'false'/'1'/'yes' 均不放行`);

// 两个开关是**独立**的：一个开不代表另一个开
check('S2', '两个开关互相独立（只设资源级 ⇒ 动作级仍为 false，反之亦然）',
  R.isPublicArchiveEnabled({ PUBLIC_ARCHIVE_ENABLED: 'true' }) === true &&
  R.isPublicArchiveQueryEnabled({ PUBLIC_ARCHIVE_ENABLED: 'true' }) === false &&
  R.isPublicArchiveQueryEnabled({ PUBLIC_ARCHIVE_QUERY_ENABLED: 'true' }) === true &&
  R.isPublicArchiveEnabled({ PUBLIC_ARCHIVE_QUERY_ENABLED: 'true' }) === false,
  'cross-set 四种组合均已核');

// ===========================================================================
section('2. 判定矩阵：2 层开关 × 6 条动作 —— 只有"两层全开 + queryByMobile"放行');
// ===========================================================================
// 期望表（本轮的**产品契约**，逐条写死，不接受"跑出来什么样就算什么样"）
const expectBlocked = (enabled, queryEnabled, action) => {
  if (!enabled) return R.PUBLIC_ARCHIVE_DISABLED_CODE;
  if (!queryEnabled) return R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE;
  return action === 'queryByMobile' ? null : R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE;
};

const matrix = [];
for (const enabled of [false, true]) {
  for (const queryEnabled of [false, true]) {
    for (const action of R.ALL_PUBLIC_ARCHIVE_ACTIONS) {
      const want = expectBlocked(enabled, queryEnabled, action);
      const got = R.publicArchiveBlockCode('publicArchive', action, enabled, queryEnabled);
      matrix.push({ enabled, queryEnabled, action, want, got, ok: want === got });
    }
  }
}
const matrixBad = matrix.filter((m) => !m.ok);
check('M1', '★ 矩阵 24 格（2×2×6）逐格符合契约（含错误码，不只"拦/不拦"）',
  matrixBad.length === 0,
  matrixBad.length
    ? matrixBad.map((m) => `en=${m.enabled} q=${m.queryEnabled} ${m.action}: 期望 ${m.want ?? 'PASS'} 实得 ${m.got ?? 'PASS'}`).join(' | ')
    : '24/24 全中');

// 逐条点名本轮最关心的四类格子（防止 M1 被"整体对但细节错"掩盖）
const cell = (en, q, a) => R.publicArchiveBlockCode('publicArchive', a, en, q);
check('M2', '只开资源级总闸 ⇒ **6 条全部 403**（比旧行为更严，不是更松）',
  R.ALL_PUBLIC_ARCHIVE_ACTIONS.every((a) => cell(true, false, a) === R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE),
  '6/6 均为 PUBLIC_ARCHIVE_ACTION_CLOSED');

check('M3', '两层全开 ⇒ 只有 queryByMobile 放行，其余 5 条仍 403',
  cell(true, true, 'queryByMobile') === null &&
  ['sendCode', 'verify', 'list', 'detail', 'photo'].every(
    (a) => cell(true, true, a) === R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE),
  'queryByMobile=放行 / 其余 5 条=PUBLIC_ARCHIVE_ACTION_CLOSED');

check('M4', '资源级关闭时即使是 queryByMobile 也 403，且码是 PUBLIC_ARCHIVE_DISABLED（不是 ACTION_CLOSED）',
  cell(false, true, 'queryByMobile') === R.PUBLIC_ARCHIVE_DISABLED_CODE,
  `实得 ${cell(false, true, 'queryByMobile')}`);

check('M5', '两层都关 ⇒ 6 条全 403，码统一为 PUBLIC_ARCHIVE_DISABLED（资源级先判）',
  R.ALL_PUBLIC_ARCHIVE_ACTIONS.every((a) => cell(false, false, a) === R.PUBLIC_ARCHIVE_DISABLED_CODE),
  '6/6 均为 PUBLIC_ARCHIVE_DISABLED');

// ===========================================================================
section('3. 白名单是**精确相等**，不是前缀匹配（防"同族新动作被顺手放行"）');
// ===========================================================================
const nearMiss = [
  'queryByMobileV2',
  'queryByMobile2',
  'queryByMobile ',
  ' queryByMobile',
  'QueryByMobile',
  'QUERYBYMOBILE',
  'queryByMobil',
  'queryByMobiles',
  'query',
  '_queryByMobile',
];
const leaked = nearMiss.filter((n) => R.isActionExplicitlyAllowed(n));
check('W1', '★ 10 个"近似名"全部不放行（前缀/大小写/尾空格/复数都不得命中）',
  leaked.length === 0,
  leaked.length ? `被误放行：${leaked.join(', ')}` : `已验 ${nearMiss.length} 个近似名，0 命中`);

check('W2', '正名 queryByMobile 精确放行（正向对照 —— 否则 W1 可以是"全拒"的恒真断言）',
  R.isActionExplicitlyAllowed('queryByMobile') === true &&
  cell(true, true, 'queryByMobile') === null,
  'isActionExplicitlyAllowed=true 且 blockCode=null');

check('W3', '缺失/空动作名 ⇒ 一律不放行（fail-closed，不看"没拿到名字就放行"）',
  R.isActionExplicitlyAllowed(undefined) === false &&
  R.isActionExplicitlyAllowed(null) === false &&
  R.isActionExplicitlyAllowed('') === false &&
  cell(true, true, undefined) === R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE,
  'undefined/null/空串 均不放行；blockCode=PUBLIC_ARCHIVE_ACTION_CLOSED');

// ===========================================================================
section('4. 边界：本闸门**只管** publicArchive，不得影响其它匿名/员工端资源');
// ===========================================================================
const otherResources = [
  'publicStore', 'publicTicket', 'publicMedia', 'publicProgress',
  'publicReview', 'publicUiTheme', 'publicVisit', 'svc', 'stores', 'tickets',
];
const collateral = otherResources.filter(
  (r) => R.shouldBlockPublicArchive(r, 'list', false, false) !== false);
check('B1', '★ 非 publicArchive 资源在"两层全关"下**仍然放行**（默认放行不是默认拒绝）',
  collateral.length === 0,
  collateral.length
    ? `误拦：${collateral.join(', ')}`
    : `已验 ${otherResources.length} 个资源；全站其余接口不受影响`);

check('B2', '资源名大小写/前后缀的近似写法不被当成 publicArchive（`PublicArchive`/`publicArchiveV2` 不受管）',
  R.shouldBlockPublicArchive('PublicArchive', 'queryByMobile', false, false) === false &&
  R.shouldBlockPublicArchive('publicArchiveV2', 'queryByMobile', false, false) === false,
  '两例均放行（它们不是被管资源）');

// ===========================================================================
section('5. 与 .ts 源码的**结构比对**（防"规则库与服务端实现各写一份 ⇒ 漂移"）');
// ===========================================================================
// 思路：服务端 .ts 是判据的**真实实现**，本规则库是它的**可执行规格**。
// 两者不可能共用一份代码（一个 .ts 一个 .mjs、打包目标不同）⇒ 只能比对**结构**：
//   · 常量名与取值必须一致（资源名、两个环境变量名、两个错误码、动作名）；
//   · 白名单必须只含那一条；
//   · 判定顺序必须是"资源 → 资源级开关 → 动作级开关 → 白名单"。
// 任何一边改了，这里都会红 —— 那时必须**同时**改两边并跑这份脚本。
const structural = [];
const need = (label, ok, detail) => structural.push({ label, ok, detail });

need('GATED_RESOURCE = publicArchive',
  new RegExp(`export const GATED_RESOURCE = '${R.GATED_RESOURCE}'`).test(tsSrc));
need('PUBLIC_ARCHIVE_ENABLED_ENV = PUBLIC_ARCHIVE_ENABLED',
  new RegExp(`export const PUBLIC_ARCHIVE_ENABLED_ENV = '${R.PUBLIC_ARCHIVE_ENABLED_ENV}'`).test(tsSrc));
need('PUBLIC_ARCHIVE_QUERY_ENABLED_ENV = PUBLIC_ARCHIVE_QUERY_ENABLED',
  new RegExp(`export const PUBLIC_ARCHIVE_QUERY_ENABLED_ENV = '${R.PUBLIC_ARCHIVE_QUERY_ENABLED_ENV}'`).test(tsSrc));
need('PUBLIC_ARCHIVE_DISABLED_CODE = PUBLIC_ARCHIVE_DISABLED',
  new RegExp(`export const PUBLIC_ARCHIVE_DISABLED_CODE = '${R.PUBLIC_ARCHIVE_DISABLED_CODE}'`).test(tsSrc));
need('PUBLIC_ARCHIVE_ACTION_CLOSED_CODE = PUBLIC_ARCHIVE_ACTION_CLOSED',
  new RegExp(`export const PUBLIC_ARCHIVE_ACTION_CLOSED_CODE = '${R.PUBLIC_ARCHIVE_ACTION_CLOSED_CODE}'`).test(tsSrc));
need('PUBLIC_ARCHIVE_QUERY_ACTION = queryByMobile',
  new RegExp(`export const PUBLIC_ARCHIVE_QUERY_ACTION = '${R.PUBLIC_ARCHIVE_QUERY_ACTION}'`).test(tsSrc));
need('QUERY_ACTION_ALLOWLIST 只含那一条（不得偷偷扩容）',
  /export const QUERY_ACTION_ALLOWLIST: readonly string\[\] = \[PUBLIC_ARCHIVE_QUERY_ACTION\];/.test(tsSrc));

// 判定顺序：必须能在源码里按序找到这四个判据（顺序影响返回的错误码）
const orderAnchors = [
  "if (String(resourceName ?? '') !== GATED_RESOURCE) return false;",
  'if (!enabled) return true;',
  'if (!queryEnabled) return true;',
  'return !isActionExplicitlyAllowed(actionName);',
];
const idx = orderAnchors.map((a) => tsSrc.indexOf(a));
need('判定顺序 = 资源 → 资源级 → 动作级 → 白名单（四处锚点按序命中）',
  idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
  `indexOf = [${idx.join(', ')}]`);

// 判定**不得**把 actionName 当作"不匹配就放行"的兜底（那等于白名单失效）
need('白名单判定不得写成 startsWith/正则前缀匹配',
  !/QUERY_ACTION_ALLOWLIST\.(some|filter)\([^)]*startsWith/.test(tsSrc) &&
  !/isActionExplicitlyAllowed[\s\S]{0,200}\.startsWith\(/.test(tsSrc));

// 启动日志必须把"三态"分别写清（否则运维会把"只放行一条"读成"6 条都开"）
// 启动日志必须把"三态"分别写清（否则运维会把"只放行一条"读成"6 条都开"）
//
// ⚠️ 这两段文案在 **plugin.ts**（挂载点），不在中间件文件里 ——
//    第一版只读了 public-archive-gate.ts，于是 T1 恒红（读错文件，不是产品问题）。
//    ⇒ 结构断言要覆盖**全部相关源文件**，否则"文件找错了"会被误报成"实现错了"。
let pluginSrc = '';
try {
  pluginSrc = fs.readFileSync(TS_PLUGIN_SRC, 'utf8');
} catch (e) {
  console.error(`[selftest] 读不到 ${TS_PLUGIN_SRC}：${e?.message}`);
  console.error('[selftest] 工具故障 ⇒ 退出码 2');
  process.exit(2);
}
need('启动日志区分三态（总闸关 / 总闸开但动作级关 / 两层全开）',
  pluginSrc.includes('Action 级未开启') && /6 条匿名 action 仍全部 403/.test(pluginSrc));

// T1b：本脚本此前**漏了一项**（2026-11-12 实际踩到）——见 V7 的注释。
// 只查"三态日志"而没查"只开总闸时白名单也不得不被求值"，导致
// `if (!queryEnabled) return true;` 被停用后，`只开总闸` 那一格**仍然**被白名单挡住，
// 于是 V7 的断言恒假。补齐这一条：判定函数在"资源级开、动作级关"时**必须**、
// 在"资源级关"时**不得先求值动作级开关（实现层由中间件短路保证，这里只验纯函数顺序）。
need('资源级关闭时**不得**进入白名单判定（顺序契约：先资源级、后白名单）',
  tsSrc.indexOf('if (!enabled) return true;') < tsSrc.indexOf('return !isActionExplicitlyAllowed(actionName);'));

const structBad = structural.filter((s) => !s.ok);
check('T1', `与 .ts 源码结构一致（${structural.length} 条锚点）`,
  structBad.length === 0,
  structBad.length ? structBad.map((s) => `未命中：${s.label}`).join(' | ') : `${structural.length}/${structural.length} 命中`);

// ===========================================================================
section('6. ★ 变异测试：放宽判据后，上面第 2/3/4 节必须**真的变红**');
// ===========================================================================
// 做法与 `verify-arc-uid-ownership-selftest.mjs` 同范式：
//   读规则库源码 → 改坏某一处 → 写临时 .mjs → 动态 import → 用**同一批 fixture** 重判。
// 预期：变异版在对应的断言上给出**相反**结论 ⇒ 证明那些断言不是恒真。
const RULES_PATH = path.join(ROOT, 'scripts/lib/public-archive-gate.rules.mjs');
let rulesSrc = '';
try {
  rulesSrc = fs.readFileSync(RULES_PATH, 'utf8');
} catch (e) {
  console.error(`[selftest] 读不到规则库源码：${e?.message}`);
  process.exit(2);
}

async function withMutant(name, replacement, fn) {
  const tmp = path.join(os.tmpdir(), `pag-mut-${process.pid}-${name}.mjs`);
  try {
    fs.writeFileSync(tmp, replacement, 'utf8');
    const mod = await import(pathToFileURL(tmp).href);
    return fn(mod);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// 变异①：把"精确白名单"放宽成"前缀匹配"（最可能被后来人"顺手优化"的写法）
const mutA = rulesSrc.replace(
  'return QUERY_ACTION_ALLOWLIST.includes(name);',
  'return QUERY_ACTION_ALLOWLIST.some((a) => name.startsWith(a)); // MUTATED');
check('V1', '（变异①）前缀匹配的注入点存在', mutA !== rulesSrc);
if (mutA !== rulesSrc) {
  const r = await withMutant('a', mutA, (m) => ({
    v2: m.isActionExplicitlyAllowed('queryByMobileV2'),
    ok: m.isActionExplicitlyAllowed('queryByMobile'),
    cell: m.publicArchiveBlockCode('publicArchive', 'queryByMobileV2', true, true),
  }));
  check('V2', '★（变异①）把白名单改成前缀匹配后，`queryByMobileV2` 会被**误放行** ⇒ W1 有区分力',
    r.v2 === true && r.ok === true && r.cell === null,
    `变异版对 queryByMobileV2 ⇒ allowed=${r.v2} blockCode=${r.cell ?? 'null(放行)'}（原版 true/false 相反）`);
  check('V3', '（变异①）正名仍被放行 ⇒ 红的是"判据强度"，不是函数坏掉（独立性对照）',
    r.ok === true, `变异版对 queryByMobile ⇒ ${r.ok}`);
}

// 变异②：删掉"资源级开关"这一层（等价于退回到"只看动作级"）
const mutB = rulesSrc.replace(
  'if (!enabled) return true;',
  'if (false) return true; // MUTATED: 资源级判据已停用');
check('V4', '（变异②）资源级判据的注入点存在', mutB !== rulesSrc);
if (mutB !== rulesSrc) {
  const r = await withMutant('b', mutB, (m) => ({
    blocked: m.shouldBlockPublicArchive('publicArchive', 'queryByMobile', false, true),
    code: m.publicArchiveBlockCode('publicArchive', 'queryByMobile', false, true),
  }));
  check('V5', '★（变异②）停用资源级后，`资源级关 + 动作级开` 会**误放行** ⇒ M4 有区分力',
    r.blocked === false && r.code === null,
    `变异版 ⇒ blocked=${r.blocked} code=${r.code ?? 'null(放行)'}（原版 true/PUBLIC_ARCHIVE_DISABLED）`);
}

// 变异③：删掉"动作级开关"这一层（等价于退回到"只开总闸就 6 条全开"，即本轮要消除的缺陷）
const mutC = rulesSrc.replace(
  'if (!queryEnabled) return true;',
  'if (false) return true; // MUTATED: 动作级开关已停用');
check('V6', '（变异③）动作级判据的注入点存在', mutC !== rulesSrc);
if (mutC !== rulesSrc) {
// ⚠️ V7 的**设计教训**（2026-11-12 第一版踩到，必须留在代码里）：
//   第一版写的是「停用动作级后，只开总闸 ⇒ sendCode 也应被放行」。
//   这条**是真红的**，但红的原因不是实现错，而是我的断言把"两层白名单叠加"
//   当成了"只剩一层"。停用动作级开关后，白名单这一层**仍然在**，
//   所以 `sendCode` 依旧被拦 —— 也就是说这条断言**恒假**，它测不出任何东西。
//   正确写法：停用动作级开关后，受影响的只有"**已经在白名单里**的那条动作"
//   （它从"被动作级开关拦"变成"放行"）；非白名单动作由另一层负责，不在本变异的影响范围内。
//   —— 这正是"断言必须能变红"的反面：一条恒假的断言会让变异测试**看起来**跑过了。
const r = await withMutant('c', mutC, (m) => ({
  q: m.shouldBlockPublicArchive('publicArchive', 'queryByMobile', true, false),
  qCode: m.publicArchiveBlockCode('publicArchive', 'queryByMobile', true, false),
  send: m.shouldBlockPublicArchive('publicArchive', 'sendCode', true, false),
}));
check('V7', '★（变异③）停用动作级开关后，`只开总闸` 会让白名单内动作**误放行** ⇒ M2 有区分力',
  r.q === false && r.qCode === null,
  `变异版 ⇒ queryByMobile blocked=${r.q} code=${r.qCode ?? 'null(放行)'}（原版 true/PUBLIC_ARCHIVE_ACTION_CLOSED）`);
check('V7b', '（变异③）非白名单动作仍被白名单层拦住 ⇒ 两层是**独立**的，不是同一件事（独立性对照）',
  r.send === true,
  `变异版 ⇒ sendCode blocked=${r.send}（两版均为 true，说明它由白名单层负责，与动作级开关无关）`);
}

// 变异④：把资源判据从"精确相等"放宽成"包含"（会误伤 publicArchiveXxx 之类）
const mutD = rulesSrc.replace(
  "if (String(resourceName ?? '') !== GATED_RESOURCE) return false;",
  'if (!String(resourceName ?? "").includes(GATED_RESOURCE)) return false; // MUTATED');
check('V8', '（变异④）资源名判据的注入点存在', mutD !== rulesSrc);
if (mutD !== rulesSrc) {
  const r = await withMutant('d', mutD, (m) => ({
    v2: m.shouldBlockPublicArchive('publicArchiveV2', 'list', false, false),
    ok: m.shouldBlockPublicArchive('publicArchive', 'list', false, false),
  }));
  check('V9', '★（变异④）把资源名判据放宽成 includes 后，`publicArchiveV2` 会被**误拦** ⇒ B2 有区分力',
    r.v2 === true && r.ok === true,
    `变异版 ⇒ publicArchiveV2 blocked=${r.v2}（原版 false）`);
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = results.filter((r) => !r.pass);
if (JSON_OUT) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    tool: 'verify-arc-gate-selftest',
    total: results.length,
    failed: failed.map((f) => f.id),
    results,
  }, null, 2));
} else {
  console.log(`\n${'='.repeat(76)}`);
  console.log(`汇总：PASS ${results.length - failed.length} / ${results.length}`);
  if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
  console.log('='.repeat(76));
}

fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/arc-gate'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, '.tmp-verify/evidence/arc-gate/selftest.json'),
  JSON.stringify({ at: new Date().toISOString(), total: results.length, failed, results }, null, 2));

process.exit(failed.length ? 1 : 0);
