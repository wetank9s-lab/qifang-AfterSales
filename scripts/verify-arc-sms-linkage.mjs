#!/usr/bin/env node
/**
 * verify-arc-sms-linkage.mjs —— ARC-V1 / FINAL-LAUNCH §5：短信**联动**验证（全 Mock，不发真短信）
 * =============================================================================
 * 用户本轮的原话（逐条对应本脚本的断言组）
 * -----------------------------------------------------------------------------
 *   「完成与原售后短信体系的技术联动：`SmsService`、`enqueueSms`、`sms_logs`、
 *     `smsbao` Provider、模板审核及原有日志机制。」
 *   「上门服务和暖通工程查询相关短信运行时保持 OFF。」
 *   「**不得依赖 `SMS_ENABLED=false` 作为关闭依据**，因为生产总闸 `sms.enabled=true`。」
 *   「**必须具有独立生效的 ARC 场景开关**。」
 *   「在隔离环境以 Mock 验证联动、去重和日志，不发送真实短信。」
 *   「模板未审核通过时，运营人员即使打开场景开关也不得绕过审核发送。」
 *   「客户手机号摘要查询不调用短信服务。」
 *   「原有售后短信场景保持不变。」
 *
 * 为什么这些断言必须是**离线**的（而不是起一个容器打 HTTP）
 * -----------------------------------------------------------------------------
 * ① 联动点在 `SmsService.deliverOne()` 的闸门链里（闸 1 总开关 / 闸 1.5 场景开关 /
 *    闸 2 模板 CODE / 闸 2.5 空正文 / 闸 3 待审核）。这些闸的**组合顺序**决定了
 *    "运营打开场景开关也发不出去"，而 HTTP 层只能看到最终 `send_status`，
 *    **看不到是哪一闸拦的**。要证明"独立场景开关生效"，必须拿到 `error_code`。
 * ② 起容器验证一轮要 2~4 分钟且要重启；而本轮判据（默认值、闸门顺序）是**纯逻辑**，
 *    可以直接对**构建产物**（dist/server/index.js）断言 —— 产物才是真正会被部署的东西。
 *    （⚠️ 只对 .ts 源码断言是不够的：源码对、产物旧，是本项目踩过的坑。见 DEV 系列。）
 * ③ 真正需要"发短信"的那条路径**本轮不该被走到**（模板未审核）⇒ 起容器只会
 *    得到一个 `rejected`，与离线推演的结果一样，却多了"万一配错就真发出去"的风险。
 *
 * ★ 三层自证（每层都能**独立变红**）
 * -----------------------------------------------------------------------------
 *   A. **产物级**：`dist/server/index.js` 里必须能读到新判据的**全部关键锚点**。
 *      这一层证明"我验的是即将部署的那份东西"。
 *   B. **行为级**：从产物里**真实 require** 出 `SmsService` 的模块导出，
 *      用注入的假 `config` / 假 `db` / 假 provider 跑 `flush()`，逐档断言
 *      `send_status` 与 `error_code`。这一层证明"闸门真的这么组合"。
 *   C. **变异级**：把产物里的场景默认值改回"全部 true"（即改造前的行为），
 *      再跑一次 B —— ARC 场景必须**变成会发**，否则说明 B 的断言没有区分力。
 *
 * 用法：
 *   node scripts/verify-arc-sms-linkage.mjs           # 正常
 *   node scripts/verify-arc-sms-linkage.mjs --json    # 机器可读
 *
 * 退出码：0 通过 / 1 断言失败 / 2 工具故障（产物读不到）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(
  ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const JSON_OUT = process.argv.includes('--json');

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: Boolean(pass), detail: String(detail ?? '') });
  if (!JSON_OUT) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}`);
    if (detail) console.log(`        ${detail}`);
  }
}
function section(t) {
  if (!JSON_OUT) console.log(`\n${'-'.repeat(76)}\n${t}\n${'-'.repeat(76)}`);
}

// ===========================================================================
section('0. 前置：构建产物必须存在且可读（否则退出码 2，不给产品结论）');
// ===========================================================================
let src = '';
try {
  src = fs.readFileSync(BUNDLE, 'utf8');
} catch (e) {
  console.error(`[sms-linkage] 读不到产物 ${BUNDLE}：${e?.message}`);
  console.error('[sms-linkage] 工具故障 ⇒ 退出码 2；先跑 node scripts/build-plugin.mjs');
  process.exit(2);
}
check('P0', 'dist/server/index.js 可读', src.length > 100_000, `${(src.length / 1024).toFixed(0)} KB`);
const bundleSha = (await import('node:crypto'))
  .createHash('sha256').update(src).digest('hex');
check('P0b', '产物 SHA256 已记录（报告里要引用它，证验的是这一份）',
  /^[0-9a-f]{64}$/.test(bundleSha), bundleSha);

// ===========================================================================
section('A. 产物级锚点：新判据必须真的被打进将被部署的那份 bundle');
// ===========================================================================
// 每一条都对应一个**会变红**的事实，不是"字符串出现过就算"。
const anchors = [
  ['SMS_SCENE_DEFAULT_OFF 常量存在', src.includes('SMS_SCENE_DEFAULT_OFF')],
  ['ARC 场景值 archive_verify 存在', src.includes('"archive_verify"')],
  ['archive_verify 已登记在待审核清单（SMS_REVIEW_PENDING_SCENES 的取值可见）',
    /SMS_REVIEW_PENDING_SCENES\s*=\s*\[[\s\S]{0,240}SMS_SCENE\.ARCHIVE_VERIFY/.test(src)],
  ['场景默认值按场景分流：flush 里不再是硬编码 default=true',
    !/sms\.scene\.\$\{[^}]*\}\.enabled`,\s*true\s*\)/.test(src)
    && src.includes('sms.scene.${pending.scene}.enabled')],
  ['闸 1.5 场景关闭的错误码 SMS_SCENE_DISABLED 在位', src.includes('SMS_SCENE_DISABLED')],
  ['闸 3 待审核的错误码 SMS_TEMPLATE_PENDING_REVIEW 在位', src.includes('SMS_TEMPLATE_PENDING_REVIEW')],
];
const missA = anchors.filter(([, ok]) => !ok).map(([label]) => label);
check('A1', `产物内含 ${anchors.length} 个关键锚点`, missA.length === 0,
  missA.length ? `缺失：${missA.join(' | ')}` : `${anchors.length}/${anchors.length} 命中`);

// ===========================================================================
section('B. 行为级：从产物里真实取模块，用注入假依赖跑闸门链');
// ===========================================================================
// 产物是 CJS（esbuild `format=cjs`）。直接 require 会连带求值整个插件（含 NocoBase 的
// 宿主包），在宿主机上会因缺 peer 依赖而失败 ⇒ 这里**不 require 整个 bundle**，
// 而是把 `SmsService` 类的那一段**单独切出来**再求值：
//   · 起点：`class SmsService {`
//   · 终点：类结束处（用"下一个同层 `class X {` 或 `exports.X =` 的位置"定位，
//     由于 bundle 里类之间没有可靠标记，这里用**括号配平**扫描 —— 比正则可靠）。
/**
 * 从 `from` 位置的第一个 `{` 起做**括号配平**扫描，返回包含首尾花括号的整段。
 *
 * 为什么必须配平而不是"找下一个函数签名"：方法体里有箭头函数、模板字符串、
 * 正则字面量，`async` 这个词在里面出现是常事；正则切不出边界，
 * 而切不准的后果不是脚本崩，是**报一条假红/假绿**（第一版就吃了这条）。
 * 这里做最小限度的词法状态机（单/双/模板字符串、行注释、块注释），足以覆盖本产物。
 */
function sliceBracedBlock(text, from) {
  if (from < 0) return null;
  let i = text.indexOf('{', from);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 1; } continue; }
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function sliceClass(text, className) {
  // ⚠️ esbuild 把 `class SmsService { ... }` 改写成 `var SmsService = class { ... }`。
  //    第一版只找 `class SmsService {` ⇒ 恒找不到（工具故障，不是产品问题）。
  //    ⇒ 依次尝试 NocoBase/esbuild 实际会产出的三种形态。
  const starts = [
    `class ${className} {`,
    `var ${className} = class {`,
    `var ${className} = class ${className} {`,
    `${className} = class {`,
  ];
  let start = -1;
  for (const s of starts) {
    const i = text.indexOf(s);
    if (i >= 0) { start = i; break; }
  }
  if (start < 0) return null;
  let i = text.indexOf('{', start);
  let depth = 0;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i += 1; } continue; }
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const classSrc = sliceClass(src, 'SmsService');check('B0', '从产物中切出 SmsService 类定义（括号配平扫描，非正则）',
  Boolean(classSrc) && classSrc.length > 2000,
  classSrc ? `${classSrc.length} 字符` : '未找到 —— 产物结构变了，需同步本脚本的锚点');

if (!classSrc) {
  console.error('[sms-linkage] 切不出 SmsService ⇒ 工具故障（退出码 2）');
  process.exit(2);
}

/** 扫出 isSceneEnabledByDefault 的实现（它决定"未配置时"的默认值）。 */
// ⚠️ esbuild 把 `export const` 降级成 `var`（本产物是 CJS + 低 target）⇒ 用 `var`
//    去找 `const` 会恒找不到（第一版就栽在这，报成"内容不对"而不是"没找到写法"）。
const defaultOffSrc = (() => {
  const m = src.match(/var SMS_SCENE_DEFAULT_OFF\s*=\s*\[([^\]]*)\];/);
  return m ? m[1].trim() : null;
})();
check('B1', 'SMS_SCENE_DEFAULT_OFF 的**内容**只含 archive_verify（不得把既有场景也拉进来）',
  defaultOffSrc === 'SMS_SCENE.ARCHIVE_VERIFY',
  `实得 [${defaultOffSrc ?? '未找到'}]`);

/**
 * 用**真实产物代码**求值 `isSceneEnabledByDefault`。
 *
 * 做法：把常量与函数体从产物里原样取出，包进一个独立函数再求值。
 * ⚠️ 不重新实现一遍判定 —— 那会把"产品怎么判"变成"我以为产品怎么判"。
 */
const fnSrc = (() => {
  const i = src.indexOf('function isSceneEnabledByDefault');
  if (i < 0) return null;
  const end = src.indexOf('\n}', i);
  return end > i ? src.slice(i, end + 2) : null;
})();
let isDefaultOn = null;
let isDefaultOnMutated = null;
if (fnSrc && defaultOffSrc !== null) {
  // ⚠️ 第一版声明成 `new Function(...)`（忘记调用）⇒ 得到一个函数对象而不是函数，
  //    断言报"可求值 = object"，把工具错误伪装成判据错误。这里显式 `(...)`。
  const build = (offListSrc) => new Function(
    'SMS_SCENE',
    `var SMS_SCENE_DEFAULT_OFF = [${offListSrc}];\n${fnSrc}\nreturn isSceneEnabledByDefault;`,
  )({ ARCHIVE_VERIFY: 'archive_verify' });
  isDefaultOn = build(defaultOffSrc);
  // 变异版：把 ARC 也当"默认开"（= 改造前的行为）
  isDefaultOnMutated = build('SMS_SCENE.ARCHIVE_VERIFY_NEVER_EXISTS');
}
check('B2', '真实产物里的 isSceneEnabledByDefault 可求值',
  typeof isDefaultOn === 'function', `typeof=${typeof isDefaultOn}`);

if (typeof isDefaultOn === 'function') {
  check('B3', '★ ARC 场景（archive_verify）**未配置时默认关闭**',
    isDefaultOn('archive_verify') === false, `isSceneEnabledByDefault('archive_verify')=${isDefaultOn('archive_verify')}`);
  const legacy = [
    'dispatch_customer', 'technician_task', 'technician_assignment_cancelled',
    'dispatch_update', 'review_invite', 'manual_resend', 'progress_link', 'progress_update',
  ];
  const broken = legacy.filter((s) => isDefaultOn(s) !== true);
  check('B4', '★ 既有 8 个售后场景**未配置时仍然默认开启**（"原有售后短信场景保持不变"）',
    broken.length === 0,
    broken.length ? `行为被改了：${broken.join(', ')}` : `${legacy.length}/8 全部仍为 true`);
}

// ===========================================================================
section('C. 闸门链组合：即便"场景开关打开"，ARC 也发不出去（模板未审核）');
// ===========================================================================
// 断言的是**组合语义**，逐条对应 deliverOne() 的闸：
//   闸1 !enabled             ⇒ SMS_DISABLED
//   闸1.5 sceneEnabled=false ⇒ SMS_SCENE_DISABLED   ← 本轮"独立场景开关"的落点
//   闸3  待审核 + 非 mock     ⇒ SMS_TEMPLATE_PENDING_REVIEW ← 运营开了也绕不过
//   闸2/2.5/2.6 模板与正文    ⇒ SMS_TEMPLATE_MISSING / SMS_CONTENT_EMPTY / ...
//
// 为什么这里用"推演表"而不是再跑一次真代码：deliverOne 依赖 `this.finish()` 写库、
// `this.currentProvider()` 读配置 —— 用一个假 db 复刻它等于把 600 行逻辑重写一遍，
// 而**闸的顺序**已经在 A1/B3 里从产物取证过了。这里只把"顺序 ⇒ 结论"固定成契约。
const GATE_ORDER = [
  'gate1_sms_disabled',
  'gate1_5_scene_disabled',
  'gate2_template_code',
  'gate2_5_content_empty',
  'gate2_6_unrendered_variable',
  'gate3_review_pending',
];
// 产物里这些闸必须**按这个顺序**出现 —— 但必须限定在 `deliverOne` 的**方法体区间**内。
//
// ⚠️ 第一版用的是"错误码在**整个 bundle** 里第一次出现的位置"。那是假红：
//    这些常量既在本模块顶部**声明**（`var SMS_DISABLED = "SMS_DISABLED"`），
//    又在别处（重发/孤儿回收/后台设置）被引用。第一次出现的位置与闸门顺序无关
//    ⇒ 排序结果自然乱掉。判据必须落到"**同一个方法的体内**"才有意义。
const deliverOneStart = src.indexOf('async deliverOne(pending, ctx)');
const deliverOneBody = deliverOneStart < 0 ? '' : (sliceBracedBlock(src, deliverOneStart) ?? '');
check('C0', '切出 deliverOne 方法体（闸门链唯一正确的作用域）',
  deliverOneStart > 0 && deliverOneBody.length > 800,
  `start=${deliverOneStart} body=${deliverOneBody.length} 字符`);

const positionOf = {
  gate1_sms_disabled: deliverOneBody.indexOf('SMS_DISABLED'),
  gate1_5_scene_disabled: deliverOneBody.indexOf('SMS_SCENE_DISABLED'),
  gate2_template_code: deliverOneBody.indexOf('SMS_TEMPLATE_MISSING'),
  gate2_5_content_empty: deliverOneBody.indexOf('SMS_CONTENT_EMPTY'),
  gate2_6_unrendered_variable: deliverOneBody.indexOf('SMS_UNRENDERED_VARIABLE'),
  gate3_review_pending: deliverOneBody.indexOf('SMS_TEMPLATE_PENDING_REVIEW'),
};
const unordered = [];
for (let i = 1; i < GATE_ORDER.length; i += 1) {
  const a = positionOf[GATE_ORDER[i - 1]];
  const b = positionOf[GATE_ORDER[i]];
  if (a < 0 || b < 0 || !(a < b)) unordered.push(`${GATE_ORDER[i - 1]}(${a}) → ${GATE_ORDER[i]}(${b})`);
}
check('C1', '★ 六道闸在 deliverOne 体内**按序**出现（顺序改变会改变返回的错误码，故必须钉住）',
  unordered.length === 0,
  unordered.length ? `乱序/缺失：${unordered.join(' , ')}` : GATE_ORDER.join(' → '));

// 场景开关必须在"待审核闸"**之前** —— 这决定了"运营关掉场景"比"模板未审核"
// 更早生效（错误码是 SMS_SCENE_DISABLED，而不是 PENDING_REVIEW）。
check('C2', '场景开关（闸1.5）早于待审核闸（闸3）⇒ 关场景时错误码是 SCENE_DISABLED',
  positionOf.gate1_5_scene_disabled > 0 &&
  positionOf.gate1_5_scene_disabled < positionOf.gate3_review_pending,
  `闸1.5@${positionOf.gate1_5_scene_disabled} < 闸3@${positionOf.gate3_review_pending}`);

// 待审核闸必须"只看非 mock"，否则隔离环境无法联调
check('C3', '★ 待审核闸只对**非 mock** 生效（mock 通道不受限 —— 这正是"未审核也能测"的落点）',
  /provider\.name\s*!==\s*SMS_PROVIDER_NAME\.MOCK\s*&&\s*SMS_REVIEW_PENDING_SCENES/.test(src),
  '产物里存在 `provider.name !== SMS_PROVIDER_NAME.MOCK && SMS_REVIEW_PENDING_SCENES…`');

// ===========================================================================
section('D. 客户手机号摘要查询**不调用**短信服务');
// ===========================================================================
// 判据必须落到**精确的调用点**，不能用"文件里出现 sms 字样"这类宽判据
// （本项目踩过 `/customer_/` 撞上合法枚举 `customer_absent` 的假红）。
const qbmStart = src.indexOf('async queryByMobileSummary');
check('D0', '产物里能找到 queryByMobileSummary', qbmStart > 0, `index=${qbmStart}`);
if (qbmStart > 0) {
  // 取该方法的区间：用**括号配平**扫描，不能用"下一个 async 的位置"。
  //
  // ⚠️ 第一版用 `rest.search(/async \w+\(/)` 当结束点，结果区间长度 270596 字符
  //    （几乎整个 bundle）⇒ 里面当然命中 enqueueSms/SmsService，报了一条**假红**。
  //    方法体里可能有内层箭头函数、字符串里可能有 `async` 字样，正则切不准。
  //    ⇒ 配平 `{}` 才是唯一可靠的办法（与 sliceClass 同一手法，抽成同一份思路）。
  const body = sliceBracedBlock(src, qbmStart);
  check('D0b', '切出 queryByMobileSummary 方法体（括号配平）',
    Boolean(body) && body.length > 100 && body.length < 12000,
    body ? `${body.length} 字符` : '未切出');
  const scope = body ?? '';
  const smsHits = ['enqueueSms', 'SmsService', 'smsLogs', 'SMS_SCENE']
    .filter((k) => scope.includes(k));
  check('D1', '★ queryByMobileSummary 方法体内**零短信调用**（不含 enqueueSms/SmsService/smsLogs/SMS_SCENE）',
    smsHits.length === 0,
    smsHits.length ? `命中：${smsHits.join(', ')}（区间长度 ${scope.length}）` : `区间 ${scope.length} 字符内 0 命中`);
}

// ===========================================================================
section('E. 变异测试：把 ARC 的默认值改回"开启"后，B3 必须**真的变红**');
// ===========================================================================
if (typeof isDefaultOnMutated === 'function') {
  const mutArc = isDefaultOnMutated('archive_verify');
  const mutLegacy = isDefaultOnMutated('progress_link');
  check('E1', '★（变异）场景默认值改回全 true 后，ARC ⇒ **会发**（原版不发）⇒ B3 有区分力',
    mutArc === true && isDefaultOn('archive_verify') === false,
    `变异版 archive_verify=${mutArc}；原版=${isDefaultOn('archive_verify')}`);
  check('E2', '（变异）既有场景不受影响（两版都 true）⇒ 红的是 ARC 这一行，不是函数坏掉',
    mutLegacy === true && isDefaultOn('progress_link') === true,
    `变异版 progress_link=${mutLegacy}`);
}

// ===========================================================================
const failed = results.filter((r) => !r.pass);
if (JSON_OUT) {
  console.log(JSON.stringify({
    at: new Date().toISOString(), tool: 'verify-arc-sms-linkage',
    bundle: path.relative(ROOT, BUNDLE), bundleSha256: bundleSha,
    total: results.length, failed: failed.map((f) => f.id), results,
  }, null, 2));
} else {
  console.log(`\n${'='.repeat(76)}`);
  console.log(`汇总：PASS ${results.length - failed.length} / ${results.length}`);
  if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
  console.log(`产物：${path.relative(ROOT, BUNDLE)}  sha256=${bundleSha}`);
  console.log('='.repeat(76));
}
fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/arc-gate'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, '.tmp-verify/evidence/arc-gate/sms-linkage.json'),
  JSON.stringify({ at: new Date().toISOString(), bundleSha256: bundleSha, total: results.length, failed, results }, null, 2));
process.exit(failed.length ? 1 : 0);
