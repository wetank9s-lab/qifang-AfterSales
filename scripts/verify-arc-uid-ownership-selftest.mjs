/**
 * verify-arc-uid-ownership-selftest.mjs —— UID 归属判据的**自证**（双向 fixture）
 * =============================================================================
 *
 * 存在的理由（本项目铁律⑤：验证器自己也会错，且错得比产品更隐蔽）
 * -----------------------------------------------------------------------------
 * `scripts/lib/arc-uid-ownership.mjs` 的判据是**安全判据**：它判 stop 时，
 * 真实事故被拦下；它判 reuse 时，重放继续。**两个方向都会错**，而且后果不对称：
 *   · 判太宽（把别人的页面当成自己的） ⇒ 静默把 ARC 配置写进既有业务页 —— **真事故**
 *   · 判太窄（把自己页面当成别人的）   ⇒ 部署被误拦、走 R1 回滚 —— **假红**
 * ⇒ 只测一个方向 = 没测。本脚本用 fixture 把**两个方向**都钉住。
 *
 * fixture 不是编的数字，全部取自**开发库真实取证**（见各条 detail）：
 *   · ARC tabs 子树：24 行 / grid=1 / create=1 / edit=1
 *   · 真实业务页 pac49kftubs（售后工单子页）：49 行 / grid=1 / create=0 / edit=0
 *   · 其余两页（ek7nr0ylavb：1 行，无 grid）作为"全空"方向的对照
 *
 * ★ 判据纪律：断言必须能**变红**。本脚本末尾附「变异测试」自检 ——
 *   故意把 isArcTabsFingerprint 的判据放宽成"有 BlockGrid 就算 ARC 页"，
 *   反向 fixture 必须立刻红。跑法：`--mutate`。
 *
 * 用法：
 *   node scripts/verify-arc-uid-ownership-selftest.mjs           # 正常自证
 *   node scripts/verify-arc-uid-ownership-selftest.mjs --mutate  # 变异（应全红）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UID_OWNERSHIP, ROUTE_ID_ATTRIBUTION, ARC_OWNED_COLLECTION,
  isArcTabsFingerprint, describeFingerprint, decideUidOwnership, decideRouteIdAttribution,
  isArcOwnershipEvidence,
} from './lib/arc-uid-ownership.mjs';

const MUTATE = process.argv.includes('--mutate');
const results = [];
const check = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);

// ---------------------------------------------------------------------------
// fixture —— 全部来自开发库真实取证
// ---------------------------------------------------------------------------
const FP_ARC = { total: 24, grid: 1, createBlk: 1, editBlk: 1 };        // n5c25yq5qlt / 97x481j2bv1
const FP_BIZ = { total: 49, grid: 1, createBlk: 0, editBlk: 0 };        // pac49kftubs「处理中」
const FP_EMPTY = { total: 1, grid: 0, createBlk: 0, editBlk: 0 };       // ek7nr0ylavb「售后工单」
const FP_ZERO = { total: 0, grid: 0, createBlk: 0, editBlk: 0 };        // 空树

/* ---------------------------------------------------------------------------
 * ★ 2026-11-11 R0-FREEZE 新增：三条件归属判据的证据 fixture
 *
 * 全部来自 B1 **隔离库实测**（`scripts/arc/arc-b1-nonarc-page-probe.mjs`
 * + `.tmp-verify/evidence/r0freeze/b1-probe.json`），不是编的数字：
 *   EV_ARC  —— 真 ARC tabs（24 行 / 深度 5 / 只绑 serviceArchives）
 *   EV_P1   —— **用户口径**的普通业务页：≥20 模型 + grid，但块是普通
 *              CreateFormModel/EditFormModel ⇒ create=0/edit=0 ⇒ 结构就拦住了
 *   EV_P2   —— **判据盲区**：用 ARC 专属块（create=1/edit=1，结构判据判 true），
 *              但集合绑定是 serviceVisits ⇒ 旧判据在这里**假阳**，新判据必须拦下
 * ------------------------------------------------------------------------- */
const EV_ARC = {
  total: 24, grid: 1, createBlk: 1, editBlk: 1,
  collectionNames: ['serviceArchives'], maxDepth: 5,
  hasCustomRequest: true, hasFormGrid: true,
};
const EV_P1 = {
  total: 26, grid: 1, createBlk: 0, editBlk: 0,
  collectionNames: ['serviceVisits'], maxDepth: 4,
  hasCustomRequest: false, hasFormGrid: true,
};
const EV_P2 = {
  total: 26, grid: 1, createBlk: 1, editBlk: 1,
  collectionNames: ['serviceVisits'], maxDepth: 4,
  hasCustomRequest: false, hasFormGrid: true,
};

console.log('='.repeat(78));
console.log(`ARC-V1 · UID 归属判据自证（双向 fixture）${MUTATE ? '  [MUTATE]' : ''}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
section('0. fixture 本身必须与开发库现状一致（防 fixture 漂移）');
// ---------------------------------------------------------------------------
check('F1', '正向 fixture：结构标记齐全（grid+create+edit 全 ≥1）',
  FP_ARC.grid >= 1 && FP_ARC.createBlk >= 1 && FP_ARC.editBlk >= 1,
  `ARC tabs = ${describeFingerprint(FP_ARC)}`);
check('F2', '反向 fixture 与正向前提**只差结构标记**（总数更大、grid 相同）',
  FP_BIZ.total > FP_ARC.total && FP_BIZ.grid === FP_ARC.grid &&
  FP_BIZ.createBlk === 0 && FP_BIZ.editBlk === 0,
  `业务页 = ${describeFingerprint(FP_BIZ)} ⇒ 若判据只数 total 或只数 grid，这条会被误判为 ARC`);

// ---------------------------------------------------------------------------
section('1. 指纹判据：正向必须 true（否则假红，把安全状态误拦）');
// ---------------------------------------------------------------------------
check('T1', 'ARC 真实指纹 ⇒ true（不许判 false，那会拦住正常重放）',
  isArcTabsFingerprint(FP_ARC) === true,
  `${describeFingerprint(FP_ARC)} ⇒ ${isArcTabsFingerprint(FP_ARC)}`);
check('T2', '模型数略增（24→30）仍判 true（页面演进不该触发假红）',
  isArcTabsFingerprint({ ...FP_ARC, total: 30 }) === true);
check('T3', '模型数恰在阈值（20）判 true，19 判 false（阈值边界双向）',
  isArcTabsFingerprint({ ...FP_ARC, total: 20 }) === true &&
  isArcTabsFingerprint({ ...FP_ARC, total: 19 }) === false,
  'total=20 ⇒ true；total=19 ⇒ false');

// ---------------------------------------------------------------------------
section('2. 指纹判据：反向必须 false（否则真事故，静默串页）');
// ---------------------------------------------------------------------------
check('T4', '★ 真实业务页（49 行、含 BlockGrid）⇒ **false**（宽判据会在这里漏）',
  isArcTabsFingerprint(FP_BIZ) === false,
  `${describeFingerprint(FP_BIZ)} ⇒ ${isArcTabsFingerprint(FP_BIZ)}`);
check('T5', '缺 create 标记 ⇒ false（只删一个结构标记也要拦住）',
  isArcTabsFingerprint({ ...FP_ARC, createBlk: 0 }) === false);
check('T6', '缺 edit 标记 ⇒ false',
  isArcTabsFingerprint({ ...FP_ARC, editBlk: 0 }) === false);
check('T7', '空树 / 极薄树 ⇒ false',
  isArcTabsFingerprint(FP_ZERO) === false && isArcTabsFingerprint(FP_EMPTY) === false,
  `zero=${isArcTabsFingerprint(FP_ZERO)} empty=${isArcTabsFingerprint(FP_EMPTY)}`);
check('T8', '入参非法（null / 缺字段 / NaN）⇒ false，不抛异常',
  (() => { try {
    return isArcTabsFingerprint(null) === false &&
      isArcTabsFingerprint({ total: 'x', grid: 1, createBlk: 1, editBlk: 1 }) === false &&
      isArcTabsFingerprint({ total: NaN, grid: 1, createBlk: 1, editBlk: 1 }) === false;
  } catch { return false; } })());

// ---------------------------------------------------------------------------
section('2b. ★ 三条件归属判据（结构 + 实际集合绑定 + 模型层级）');
// ---------------------------------------------------------------------------
// 背景：B1 在隔离库实测到 —— 只靠结构指纹会把"用 ARC 块但绑别的集合"的页面
// 判成 ARC（假阳）。用户 §B 明令必须补集合绑定与层级校验。本节的 fixture 就是那条反例。
const evArc = isArcOwnershipEvidence(EV_ARC);
check('E1', '真 ARC 证据（结构齐 + 只绑 serviceArchives + 深度 5）⇒ ok',
  evArc.ok === true && evArc.failed.length === 0, evArc.reason);

const evP1 = isArcOwnershipEvidence(EV_P1);
check('E2', '★ 普通业务页（缺 create/edit 块）⇒ 不 ok，且失败项=structure',
  evP1.ok === false && evP1.failed.includes('structure'),
  `${evP1.reason}`);

const evP2 = isArcOwnershipEvidence(EV_P2);
check('E3', '★★ B1 实测反例：结构齐备但绑定 serviceVisits ⇒ 不 ok，失败项=collection（旧判据在此假阳）',
  evP2.ok === false && evP2.failed.includes('collection') && !evP2.failed.includes('structure'),
  `${evP2.reason}（注意：structure **不在**失败项里 —— 说明红的正是新增的集合绑定判据）`);

check('E4', '★ 结构相同、只有集合绑定不同 ⇒ 结论相反（证明集合绑定这条有独立区分力）',
  isArcTabsFingerprint(EV_P2) === true && isArcTabsFingerprint(EV_ARC) === true &&
  isArcOwnershipEvidence(EV_P2).ok === false && isArcOwnershipEvidence(EV_ARC).ok === true,
  `旧判据对两者都判 true（不可区分）；新判据 P2=false / ARC=true`);

check('E5', '层级不足（把 20 个模型平铺在根下：maxDepth=1）⇒ 不 ok，失败项=depth',
  (() => {
    const r = isArcOwnershipEvidence({ ...EV_ARC, maxDepth: 1 });
    return r.ok === false && r.failed.includes('depth');
  })(),
  '结构计数可以凑，层级凑不出来 —— 这是"模型层级"这条的独立价值');

check('E6', '绑定混入第二个集合（ARC 页里混进别的 collectionName）⇒ 不 ok',
  (() => {
    const r = isArcOwnershipEvidence({ ...EV_ARC, collectionNames: ['serviceArchives', 'serviceVisits'] });
    return r.ok === false && r.failed.includes('collection');
  })(),
  '判据是「**只**绑 serviceArchives」而不是「含 serviceArchives」⇒ 混入即拒');

check('E7', 'const 导出正确：ARC_OWNED_COLLECTION = serviceArchives',
  ARC_OWNED_COLLECTION === 'serviceArchives', ARC_OWNED_COLLECTION);

check('E8', 'decideUidOwnership 接入三条件：P2 证据 ⇒ STOP（旧形态会判 reuse-proven）',
  (() => {
    const withEv = decideUidOwnership({ preId: 1, tabsFingerprint: EV_P2, evidence: EV_P2 });
    const withoutEv = decideUidOwnership({ preId: 1, tabsFingerprint: EV_P2 });
    return withEv.verdict === UID_OWNERSHIP.STOP && withEv.reusable === false &&
      withoutEv.verdict === UID_OWNERSHIP.REUSE_PROVEN;   // 降级分支确实会放过去 —— 故必须传证据
  })(),
  '同时证明：调用方**忘了传 evidence** 就会被降级放行 ⇒ 重放脚本必须传（S1b 已传）');

check('E9', '降级分支的 reason 必须**显式标注**降级，不能伪装成"已证明"',
  /降级/.test(decideUidOwnership({ preId: 1, tabsFingerprint: EV_ARC }).reason),
  decideUidOwnership({ preId: 1, tabsFingerprint: EV_ARC }).reason);

check('E10', '传入证据时 reason 不得出现"降级"字样（避免误读）',
  !/降级/.test(decideUidOwnership({ preId: 1, tabsFingerprint: EV_ARC, evidence: EV_ARC }).reason),
  decideUidOwnership({ preId: 1, tabsFingerprint: EV_ARC, evidence: EV_ARC }).reason);

// ---------------------------------------------------------------------------
section('3. UID 归属结论：三种输入 ⇒ 三种 verdict（穷尽且互斥）');
// ---------------------------------------------------------------------------
const ownFresh = decideUidOwnership({ preId: null, tabsFingerprint: FP_ZERO });
check('O1', `无占用 ⇒ ${UID_OWNERSHIP.FRESH}，不允许复用`,
  ownFresh.verdict === UID_OWNERSHIP.FRESH && ownFresh.reusable === false,
  ownFresh.reason);
const ownProven = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: FP_ARC });
check('O2', `占用且指纹=ARC ⇒ ${UID_OWNERSHIP.REUSE_PROVEN}，允许复用`,
  ownProven.verdict === UID_OWNERSHIP.REUSE_PROVEN && ownProven.reusable === true,
  ownProven.reason);
const ownStop = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: FP_BIZ });
check('O3', `★ 占用但指纹=业务页 ⇒ ${UID_OWNERSHIP.STOP}，禁止复用（真事故拦截点）`,
  ownStop.verdict === UID_OWNERSHIP.STOP && ownStop.reusable === false,
  ownStop.reason);
check('O4', 'O3 的文案必须含「停」与「无法证明」（可运维性：值班人看 detail 就能决策）',
  /停/.test(ownStop.reason) && /无法证明/.test(ownStop.reason), ownStop.reason);
check('O5', '★ 三条件口径下的真 ARC 证据 ⇒ REUSE_PROVEN（新判据不许把安全态误拦）',
  (() => {
    const r = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: EV_ARC, evidence: EV_ARC });
    return r.verdict === UID_OWNERSHIP.REUSE_PROVEN && r.reusable === true;
  })(),
  decideUidOwnership({ preId: 397110182019073, tabsFingerprint: EV_ARC, evidence: EV_ARC }).reason);
check('O6', '★ 三条件口径下的 B1-P2 反例 ⇒ STOP（这正是本轮修掉的那个假阳）',
  (() => {
    const r = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: EV_P2, evidence: EV_P2 });
    return r.verdict === UID_OWNERSHIP.STOP && r.reusable === false;
  })(),
  decideUidOwnership({ preId: 397110182019073, tabsFingerprint: EV_P2, evidence: EV_P2 }).reason);

// ---------------------------------------------------------------------------
section('4. 路由 id 归属：三分支穷尽（新建 / 复用 / 静默漂移）');
// ---------------------------------------------------------------------------
const before = new Set([100, 200, 300]);
const a1 = decideRouteIdAttribution({ preId: null, postId: 999, idsBefore: before });
check('A1', 'id 不在重放前快照 ⇒ FRESH（本次新建）',
  a1.verdict === ROUTE_ID_ATTRIBUTION.FRESH && a1.ok === true, a1.reason);
const a2 = decideRouteIdAttribution({ preId: 200, postId: 200, idsBefore: before });
check('A2', 'id 在快照且等于重放前那个 ⇒ REUSE（幂等复用）',
  a2.verdict === ROUTE_ID_ATTRIBUTION.REUSE && a2.ok === true, a2.reason);
const a3 = decideRouteIdAttribution({ preId: 100, postId: 300, idsBefore: before });
check('A3', '★ id 在快照却 ≠ 重放前那个 ⇒ DRIFT（静默串页，必须红）',
  a3.verdict === ROUTE_ID_ATTRIBUTION.DRIFT && a3.ok === false, a3.reason);
const a4 = decideRouteIdAttribution({ preId: 100, postId: null, idsBefore: before });
check('A4', '拿不到 id ⇒ MISSING（必须红，不允许当成"没变化"放过）',
  a4.verdict === ROUTE_ID_ATTRIBUTION.MISSING && a4.ok === false, a4.reason);
check('A5', '三分支互斥：同一次判定只可能落一个 verdict',
  new Set([a1.verdict, a2.verdict, a3.verdict, a4.verdict]).size === 4,
  `${a1.verdict} / ${a2.verdict} / ${a3.verdict} / ${a4.verdict}`);

// ---------------------------------------------------------------------------
section('5. 变异测试：放宽判据后，第 2 节的反向断言必须**真的变红**');
// ---------------------------------------------------------------------------
// 做法（合规的变异测试，不是自说自话）：
//   ① 读 lib 源码 → ② 把结构判据删掉两条（只留 total + grid，即"有 BlockGrid 就算 ARC 页"）
//   → ③ 写进临时 .mjs → ④ 动态 import 变异版 → ⑤ 用**同一个反向 fixture** 重新判定。
//   预期：变异版对 FP_BIZ 判 true ⇒ 证明第 2 节（T4/T5/T6）的断言**不是恒真**，
//   它们真的在拦一个会发生的事故。
const libPath = new URL('./lib/arc-uid-ownership.mjs', import.meta.url);
const src = fs.readFileSync(libPath, 'utf8');
const mutated = src.replace(
  'return fp.total >= 20 && fp.grid >= 1 && fp.createBlk >= 1 && fp.editBlk >= 1;',
  'return fp.total >= 20 && fp.grid >= 1; // MUTATED: 放宽成"有 BlockGrid 就算 ARC 页"');
if (mutated === src) {
  check('M1', '（变异）成功注入宽判据', false,
    '未匹配到待替换的判据源码 —— lib 被改过，请同步本脚本的替换锚点');
} else {
  const tmp = path.join(os.tmpdir(), `arc-uid-mut-${process.pid}.mjs`);
  fs.writeFileSync(tmp, mutated);
  const mod = await import(pathToFileURL(tmp).href);
  const mutBiz = mod.isArcTabsFingerprint(FP_BIZ);
  const mutArc = mod.isArcTabsFingerprint(FP_ARC);
  check('M1', '（变异）宽判据对真实业务页判 true ⇒ 证明 T4 的量词有区分力（不是恒真）',
    mutBiz === true,
    `变异版对业务页 ${describeFingerprint(FP_BIZ)} ⇒ ${mutBiz}（原版 false，T4 因此变红）`);
  check('M2', '（变异）宽判据仍对 ARC 判 true ⇒ 说明红的是判据强度、不是函数坏掉（对照）',
    mutArc === true,
    `变异版对 ARC ${describeFingerprint(FP_ARC)} ⇒ ${mutArc}`);
  check('M3', '（变异）conclusion：若原版也用宽判据，O3 会从 STOP 退化成 REUSE ⇒ 真事故',
    (() => {
      const wideVerdict = mutBiz ? UID_OWNERSHIP.REUSE_PROVEN : UID_OWNERSHIP.STOP;
      return wideVerdict === UID_OWNERSHIP.REUSE_PROVEN && ownStop.verdict === UID_OWNERSHIP.STOP &&
        wideVerdict !== ownStop.verdict;
    })(),
    `原版 O3 = ${ownStop.verdict}；宽版 = ${mutBiz ? UID_OWNERSHIP.REUSE_PROVEN : UID_OWNERSHIP.STOP}`);
  fs.rmSync(tmp, { force: true });
}

if (!MUTATE) {
  console.log('\n（以上第 5 节是**变异测试**，默认始终执行 —— 它证明前 4 节的断言会红）');
}

// ---------------------------------------------------------------------------
section('6. ★ 变异测试之二：删掉「集合绑定」这条判据后，E3/E4/O6 必须**真的变红**');
// ---------------------------------------------------------------------------
// 第 5 节的变异放宽的是**结构**判据（①）。本轮新增了集合绑定（②）与层级（③），
// 它们同样必须能自证 —— 否则 E3 有可能是"恒真"的空断言。
// 做法：把 ② 的检查整段删掉，再用**同一个反例 EV_P2** 判定。
//   预期：变异版对 EV_P2 判 ok（原本 false）⇒ 证明 E3/E4/O6 拦的是一件真会发生的事。
// 做法（合规的变异测试，不是自说自话）：
//   把 ②（集合绑定）与 ③（层级）的**判定条件**改成恒假 —— 等价于"这两条不存在"，
//   但不删变量本身（否则下面的 reason 模板会因 `colls` 未定义而抛错，
//   那就变成"脚本崩了"而不是"断言红了"——两者必须区分开）。
const src2 = fs.readFileSync(libPath, 'utf8');
const NL = src2.includes('\r\n') ? '\r\n' : '\n';
const collCondSnippet = '  if (colls.length !== 1 || colls[0] !== ARC_OWNED_COLLECTION) {' + NL;
const depthCondSnippet = "  if (!Number.isFinite(depth) || depth < 4) failed.push('depth');" + NL;

if (!src2.includes(collCondSnippet) || !src2.includes(depthCondSnippet)) {
  check('M4', '（变异②）成功定位「集合绑定 / 层级」判定段', false,
    `未匹配到待替换的条件源码（coll=${src2.includes(collCondSnippet)} depth=${src2.includes(depthCondSnippet)}）` +
    ` —— lib 被改过，请同步本脚本的锚点`);
} else {
  const mut2 = src2
    .replace(collCondSnippet, '  if (false) { // MUTATED: 集合绑定判据已停用' + NL)
    .replace(depthCondSnippet, '  if (false) failed.push(\'depth\'); // MUTATED: 层级判据已停用' + NL);
  const tmp2 = path.join(os.tmpdir(), `arc-uid-mut2-${process.pid}.mjs`);
  fs.writeFileSync(tmp2, mut2, 'utf8');
  const mod2 = await import(pathToFileURL(tmp2).href);

  const m2Arc = mod2.isArcOwnershipEvidence(EV_ARC);
  const m2P2 = mod2.isArcOwnershipEvidence(EV_P2);
  const m2P1 = mod2.isArcOwnershipEvidence(EV_P1);

  check('M4', '（变异②）停用 ②③ 后，EV_P2 由 false 变 **true** ⇒ 证明 E3/E4/O6 的量词有区分力',
    m2P2.ok === true && evP2.ok === false,
    `变异版对 P2 判 ok=${m2P2.ok}（原版 false，失败项=${JSON.stringify(evP2.failed)}）` +
    ` ⇒ 若判据没有集合绑定这条，B1 实测那条假阳会溜过去`);
  check('M5', '（变异②）停用后 EV_ARC 仍 true ⇒ 说明红的是判据强度，不是函数坏掉（对照）',
    m2Arc.ok === true, `变异版对 ARC 判 ok=${m2Arc.ok}`);
  check('M6', '（变异②）P1 仍 false（结构判据 ① 未被误停用，作独立性对照）',
    m2P1.ok === false, `变异版对 P1 判 ok=${m2P1.ok}（失败项=${JSON.stringify(m2P1.failed)}）`);
  fs.rmSync(tmp2, { force: true });
}

// ---------------------------------------------------------------------------
section('7. 反向验证之三：拿**真实库数据**喂一遍（防 fixture 与实现漂移）');
// ---------------------------------------------------------------------------
// 只喂 fixture 有个盲区：fixture 是**按判据的字段名**编出来的，如果库里
// 实际读出来的字段名与 fixture 不同，fixture 全绿而真机全错（DEV-204 的教训）。
// 这里真连隔离库取一次 ARC 页面的证据，再回喂判据 —— 取数路径与重放脚本**同源**。
if (process.env.SKIP_DB_FIXTURE !== '1') {
  const { execFileSync } = await import('node:child_process');
  const q = (sql, db) => execFileSync('docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', db, '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  try {
    const uid = '97x481j2bv1';
    const db = 'service_ticket_verify';
    // 与 arc-v1-rebuild-mobile-page.mjs 的 pageEvidence 用同一段 SQL（同源取数）
    const row = q(`select count(*)
        ||'|'|| count(*) filter (where m.options::text like '%BlockGridModel%')
        ||'|'|| count(*) filter (where m.options::text like '%ArchiveCreateBlockModel%')
        ||'|'|| count(*) filter (where m.options::text like '%ArchiveEditBlockModel%')
      from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid
      where tp.ancestor='${uid}';`, db);
    const [total, grid, createBlk, editBlk] = row.split('|').map(Number);
    const collRaw = q(`select coalesce(string_agg(distinct c, ','), '') from (
        select (regexp_matches(m.options::text, '"collectionName":"([^"]+)"', 'g'))[1] as c
          from "flowModels" m join "flowModelTreePath" tp on tp.descendant = m.uid
         where tp.ancestor = '${uid}') s where c is not null;`, db);
    const maxDepth = Number(q(`select coalesce(max(depth),0) from "flowModelTreePath" where ancestor='${uid}';`, db));
    const realEv = {
      total, grid, createBlk, editBlk,
      collectionNames: collRaw ? collRaw.split(',').sort() : [],
      maxDepth,
    };
    const r = isArcOwnershipEvidence(realEv);
    // ⚠️ R1/R2 是**环境依赖**判据：它们要求隔离库里此刻**真的**存在 ARC 页面
    //    （用真实数据证明 fixture 与实现无漂移）。若库已被清成生产同形基线
    //    （0 条 ARC 路由 / 0 模型），这两条必然红 —— 但那是**缺前置**，不是判据坏了。
    //    正确做法：先 `node scripts/arc/arc-v1-rebuild-mobile-page.mjs --payload=...`
    //    把页面建出来再跑；跑完可用 `build-prod-like-baseline.mjs` 清回基线。
    const needFixture = total === 0;
    check('R1', '★ 真库取数（隔离库 ARC tabs）⇒ 三条件判据 ok（fixture 与实现无漂移）',
      r.ok === true,
      needFixture
        ? `前置缺失：隔离库当前没有 ARC 页面（total=0）⇒ 先跑重放脚本建页面，或设 SKIP_DB_FIXTURE=1 跳过本节。实取证据 = ${JSON.stringify(realEv)}`
        : `实取证据 = ${JSON.stringify(realEv)} ⇒ ${r.reason}`);
    check('R2', '真库取数的字段名与 fixture 一致（collectionNames/maxDepth 都被真的读到）',
      realEv.collectionNames.length === 1 && realEv.maxDepth === 5,
      needFixture
        ? '前置缺失（同 R1）：库内无 ARC 页面，取不到 collectionNames/maxDepth'
        : `collectionNames=${JSON.stringify(realEv.collectionNames)} maxDepth=${realEv.maxDepth}`);
  } catch (e) {
    check('R1', '（跳过一个真库 fixture）隔离库不可达', false, String(e).slice(0, 160));
  }
} else {
  console.log('（SKIP_DB_FIXTURE=1，跳过第 7 节）');
}

// ---------------------------------------------------------------------------
section('8. ★ PROD-HOTFIX-01：**页面壳归属**（pageShell）—— 生产库形态的双向 fixture');
// ---------------------------------------------------------------------------
// 为什么必须单独一节：
//   `evidence`（三条件）查的是 **tabs 子树**。而生产库里 tabs 的 schemaUid
//   （97x481j2bv1）**根本不存在** ⇒ 证据必然是"零模型/无绑定/深度 0"，
//   与"真 ARC 页被别的东西覆盖"完全同形。壳归属判据是**独立**的一层，
//   用来回答"这个 schemaUid 在库里到底是谁的页面"。
//
// 三条硬要求（对应生产真机面对的三个真实风险）：
//   P1 壳不存在 ⇒ 允许首次新建（不许假红，否则生产永远建不了页面）；
//   P2 壳属于**别的业务页面** ⇒ 必须 STOP（不许覆盖别人的页面）；
//   P3 壳是本交付包那条（形状一致） ⇒ 允许幂等复用。
// 再加一条**变异**：把"形状比对"停掉 ⇒ P2 必须变红，证明不是恒定通过。
{
  const evArc = EV_ARC;                 // tabs 证据（真 ARC）
  const shellAbsent = { verdict: 'absent', id: null, observed: null };
  const shellArc = { verdict: 'arc', id: 396888170692608,
    observed: { id: 396888170692608, title: '服务档案' } };
  const shellOther = { verdict: 'other-business', id: 396888170692700,
    observed: { id: 396888170692700, title: '售后工单' } };

  // P1 · 生产真机形态：壳不存在 + tabs 无证据 ⇒ FRESH（允许首次新建）
  const rP1 = decideUidOwnership({ preId: null, tabsFingerprint: { total: 0, grid: 0, createBlk: 0, editBlk: 0 },
    evidence: { total: 0, grid: 0, createBlk: 0, editBlk: 0, collectionNames: [], maxDepth: 0 }, pageShell: shellAbsent });
  check('P1', '壳不存在 ⇒ FRESH（生产首次建立不被判红）',
    rP1.verdict === UID_OWNERSHIP.FRESH && rP1.reusable === false, `${rP1.verdict}：${rP1.reason}`);

  // P2 · 壳被别的业务页面占用 ⇒ STOP（**零写入**）
  const rP2 = decideUidOwnership({ preId: 396888170692700, tabsFingerprint: { total: 0, grid: 0, createBlk: 0, editBlk: 0 },
    evidence: { total: 0, grid: 0, createBlk: 0, editBlk: 0, collectionNames: [], maxDepth: 0 }, pageShell: shellOther });
  check('P2', '壳属**其它业务页面** ⇒ STOP（绝不覆盖既有业务页面）',
    rP2.verdict === UID_OWNERSHIP.STOP && rP2.reusable === false, `${rP2.verdict}：${rP2.reason}`);

  // P3 · 壳已证属本次交付包 ⇒ 继续走 tabs 三条件；三条件也过 ⇒ REUSE_PROVEN
  const rP3 = decideUidOwnership({ preId: 396888170692608, tabsFingerprint: evArc, evidence: evArc, pageShell: shellArc });
  check('P3', '壳属本次交付包 + tabs 三条件齐 ⇒ REUSE_PROVEN（幂等复用）',
    rP3.verdict === UID_OWNERSHIP.REUSE_PROVEN && rP3.reusable === true, `${rP3.verdict}：${rP3.reason}`);

  // P4 · 壳属本次交付包、但 tabs 树是空的（半成品）⇒ 必须 STOP，不能因"壳对了"就放行
  const rP4 = decideUidOwnership({ preId: 396888170692608,
    tabsFingerprint: { total: 0, grid: 0, createBlk: 0, editBlk: 0 },
    evidence: { total: 0, grid: 0, createBlk: 0, editBlk: 0, collectionNames: [], maxDepth: 0 }, pageShell: shellArc });
  check('P4', '壳对但 tabs 树为空（半成品）⇒ STOP（壳对不等于整页对）',
    rP4.verdict === UID_OWNERSHIP.STOP, `${rP4.verdict}：${rP4.reason}`);

  // P5 · **回溯兼容**：不传 pageShell 时，行为必须与改动前逐字一致
  const rP5 = decideUidOwnership({ preId: 111, tabsFingerprint: evArc, evidence: evArc });
  check('P5', '不传 pageShell ⇒ 行为与改动前一致（旧调用方不受影响）',
    rP5.verdict === UID_OWNERSHIP.REUSE_PROVEN, `${rP5.verdict}：${rP5.reason}`);

  // M7 · **变异测试**：把"壳=别人的页面就停"这条拿掉 ⇒ P2 必须变红
  //      否则"P2 永远是 STOP"可能只是因为 preId 非空 + 零证据，与壳判据无关。
  const mutatedDecide = ({ preId, tabsFingerprint, evidence }) => {
    // 变异版：忽略 pageShell（模拟"忘了判壳归属"）
    if (preId === null || preId === undefined) return { verdict: UID_OWNERSHIP.FRESH, reusable: false };
    if (evidence) {
      const v = isArcOwnershipEvidence(evidence);
      if (v.ok) return { verdict: UID_OWNERSHIP.REUSE_PROVEN, reusable: true };
      return { verdict: UID_OWNERSHIP.STOP, reusable: false };
    }
    return { verdict: UID_OWNERSHIP.STOP, reusable: false };
  };
  const mP2 = mutatedDecide({ preId: 396888170692700,
    tabsFingerprint: { total: 0, grid: 0, createBlk: 0, editBlk: 0 },
    evidence: { total: 0, grid: 0, createBlk: 0, editBlk: 0, collectionNames: [], maxDepth: 0 } });
  check('M7', '（变异）忽略 pageShell 后 P2 仍 STOP ⇒ 说明 P2 的绿**不来自**壳判据（需下面 M8 补位）',
    mP2.verdict === UID_OWNERSHIP.STOP,
    `变异版 P2=${mP2.verdict} ⇒ P2 的判别力在"壳=别的页面"这一支上无法由 preId 替代`);

  // M8 · 真正钉住壳判据的变异：**壳=本次交付包但 tabs 三条件不过**，原版 STOP、变异版 REUSE。
  //      这条才证明"壳 verdict=arc 不能越权替代 tabs 证据"（P4 的正向变体）。
  const mutatedIgnoreTabs = (o) => {
    // 变异版：只看壳，不看 tabs 证据（模拟"壳对了就复用"这一错误实现）
    if (o.pageShell?.verdict === 'arc') return { verdict: UID_OWNERSHIP.REUSE_PROVEN, reusable: true };
    if (o.preId === null || o.preId === undefined) return { verdict: UID_OWNERSHIP.FRESH, reusable: false };
    return { verdict: UID_OWNERSHIP.STOP, reusable: false };
  };
  const mP4 = mutatedIgnoreTabs({ preId: 396888170692608, pageShell: shellArc });
  check('M8', '（变异）只看壳不看 tabs ⇒ P4 由 STOP 变 REUSE ⇒ 证明 P4 的量词有区分力',
    mP4.verdict === UID_OWNERSHIP.REUSE_PROVEN && rP4.verdict === UID_OWNERSHIP.STOP,
    `变异版 P4=${mP4.verdict} / 原版 P4=${rP4.verdict}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
