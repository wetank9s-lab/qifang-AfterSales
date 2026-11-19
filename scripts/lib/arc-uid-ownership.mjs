/**
 * arc-uid-ownership.mjs —— ARC 页面重放的 **UID 归属判据**（唯一实现）
 * =============================================================================
 *
 * 为什么需要这个模块（而不是在重放脚本里内联几行 if）
 * -----------------------------------------------------------------------------
 * `arc-v1-rebuild-mobile-page.mjs` 的路由写入是**幂等**的：create 撞 `already exists`
 * 时按 `schemaUid` 回查已有 id 继续用。ARC 两条 UID（`n5c25yq5qlt` / `97x481j2bv1`）
 * 是随机 11 位 base36，撞号概率≈0 —— **但撞上就是灾难**：
 * 会把 ARC 的整套页面配置**静默写进一个既有的、可能有真实业务数据的页面**，
 * 而所有断言都是绿的（路由数=2、模型数=26 全对）。
 *
 * ⇒ 判据不是"UID 相同就算我的"，而是**必须证明已占用的 UID 其内容就是 ARC 页**。
 *    证明不了 ⇒ **停**，绝不允许"回查到就复用"。
 *
 * 怎么证明（不靠 UID 字面，靠**内容指纹**）
 * -----------------------------------------------------------------------------
 * 两层指纹，缺一不可：
 *   ① **结构层**：ARC 页的 tabs 子树同时含 BlockGridModel + ArchiveCreateBlockModel
 *      + ArchiveEditBlockModel 各 ≥1（实测开发库 24 行/grid=1/create=1/edit=1）。
 *   ② **命名空间层**：page 树里必须有且只有 ARC 的 shell 模型（实测 2 行）。
 *
 * 反向对照（必须有区分力）：开发库 `pac49kftubs` 是一个**真实业务页**（售后工单子页），
 * 它的子树也有 BlockGrid=1（49 行），但 Create/Edit **都是 0** ⇒ 同一判据判 negative。
 * 若判据写成"有 BlockGrid 就算 ARC 页"，`pac49kftubs` 会被误判成 ARC
 * ⇒ 这条反向对照就是用来钉死这个宽判据的。
 *
 * 判据红线（本项目铁律⑤：验证器自己也会错）
 * -----------------------------------------------------------------------------
 * 本模块只做**纯函数判定**，不碰数据库。取数由调用方完成，
 * 并由 `scripts/verify-arc-uid-ownership-selftest.mjs` 用**双向 fixture** 钉住：
 *   · 正向：ARC 指纹 ⇒ reuse-proven（不许判 stop，那会假红）
 *   · 反向：真实业务页指纹 ⇒ stop（不许判 reuse-proven，那是真事故）
 *   · 漂移：id 变了又不属于新建 ⇒ drift（不许静默放过）
 *
 * ★ 判据的**最小充分条件**：它同时排除「假事故」与「静默串页」两种错向。
 */

/** 已占用 UID 的处置结论。 */
export const UID_OWNERSHIP = {
  FRESH: 'fresh',              // 无占用 ⇒ 首次重建，正常新建
  REUSE_PROVEN: 'reuse-proven',// 有占用、且内容已证明是 ARC 页 ⇒ 允许幂等复用
  STOP: 'stop',                // 有占用、但证明不了 ⇒ 停（禁止静默复用）
};

/** ARC 页面定义上必须绑定的集合（tabs 子树内 fieldSettings.init.collectionName）。 */
export const ARC_OWNED_COLLECTION = 'serviceArchives';

/** 本次路由 id 的归属结论。 */
export const ROUTE_ID_ATTRIBUTION = {
  FRESH: 'fresh',   // id 不在重放前快照里 ⇒ 本次新建，符合预期
  REUSE: 'reuse',   // id 等于重放前那个 ⇒ 走幂等复用分支（合法性由 UID 归属前置保证）
  DRIFT: 'drift',   // id 存在但不是本次新建、又不等于重放前那个 ⇒ 静默漂移，必须红
  MISSING: 'missing',// 根本没拿到 id ⇒ 必须红
};

/**
 * ARC tabs 子树的**结构**指纹判据（证据之一，**不是充分条件**）。
 *
 * ⚠️ `total >= 20` 而不是 `=== 24`：模型树会随页面演进增删，
 *    把 24 写死会让"页面正常改版"变成假红。结构标记（grid/create/edit）才是语义。
 * ⚠️ 三个标记**都要**有，尤其 create + edit 两条组合把 BlockGrid 那种宽判据排除掉。
 *
 * ★ 2026-11-11 R0-FREEZE：**此函数单独使用已不构成归属证明**。
 *    B1 实测（见 `scripts/arc/arc-b1-nonarc-page-probe.mjs`）：
 *    在隔离库真实构造一个"用了 ARC 专属块、但集合绑定为 serviceVisits"的页面，
 *    它的指纹是 26 行/grid=1/create=1/edit=1 —— **与真 ARC 页在本判据下不可区分**。
 *    ⇒ 归属判定必须走 `isArcOwnershipEvidence()`（三条件），本函数只作为其中的①。
 *    保留导出是因为它仍用于"结构完整性"的单项断言与 fixture 边界测试。
 *
 * @param {{total:number,grid:number,createBlk:number,editBlk:number}} fp
 * @returns {boolean}
 */
export function isArcTabsFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return false;
  const nums = [fp.total, fp.grid, fp.createBlk, fp.editBlk];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;
  return fp.total >= 20 && fp.grid >= 1 && fp.createBlk >= 1 && fp.editBlk >= 1;
}

/** 指纹的一句话描述（进断言 detail，便于排障时直接看懂）。 */
export function describeFingerprint(fp) {
  if (!fp) return '(无指纹)';
  return `${fp.total} 行/grid=${fp.grid}/create=${fp.createBlk}/edit=${fp.editBlk}`;
}

/**
 * 页面取证快照 —— 归属判定所需的**全部**证据（由调用方从库里取）。
 *
 * @typedef {{
 *   total:number, grid:number, createBlk:number, editBlk:number,
 *   collectionNames:string[],      // 子树内出现的 collectionName（去重）
 *   pageDepth:number|null,         // tabs 子树最大深度
 *   maxDepth:number|null,
 *   hasCustomRequest:boolean,      // 是否含 CustomRequestActionModel（ARC 建档块的提交按钮）
 *   hasFormGrid:boolean,           // 是否含 FormGridModel
 * }} ArcEvidence
 */

/**
 * ★ ARC 归属的**充分**判据（三条件），替代单独使用 `isArcTabsFingerprint`。
 *
 * 用户 §B 明令（R0-FREEZE）：
 *   「UID 已占用时**必须**校验 ARC **实际集合绑定**、**模型层级**和**预期页面结构**。
 *     不能证明归属则停止，不能静默复用。」
 *
 * 三条各自挡一类假阳（每条都对应 B1 实测到的具体缺口）：
 *   ① 预期页面结构 —— grid + create 块 + edit 块 齐全（`isArcTabsFingerprint`）。
 *      挡"别的页面恰好模型很多、但没这两个块"。
 *   ② **实际集合绑定** —— 子树内必须出现且只出现 `serviceArchives`。
 *      ★ 挡 B1-P2 那条实测假阳：用了 ARC 专属块、却绑 serviceVisits 的页面，
 *        结构判据（①）判 true，但集合绑定一看就露馅。
 *      ⚠️ 用"必须**只**绑 serviceArchives"而不是"含 serviceArchives"：
 *         ARC 页整棵树本就只绑这一个集合（实测 9 处全为它）。
 *         "含"会让"ARC 页 + 混进别的集合引用"漏过去。
 *   ③ **模型层级** —— tabs 子树必须真的是一棵有深度的树（≥4 层）。
 *      ★ 挡"把 20 个模型平铺挂在根下"这种伪造：结构计数能凑齐，层级凑不出来。
 *      ARC 实测深度分布 0..5（见 B1 取证 JSON）。
 *
 * ⚠️ 判据必须能**双向**验证（本项目铁律①）：
 *    用于本函数的 fixture 见 `scripts/verify-arc-uid-ownership-selftest.mjs`，
 *    正例（真 ARC）必须 true；B1-P1/P2 两个反例必须 false。
 *
 * @param {ArcEvidence} ev
 * @returns {{ok:boolean, failed:string[], reason:string}}
 */
export function isArcOwnershipEvidence(ev) {
  const failed = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, failed: ['evidence'], reason: '(无证据)' };
  }
  // ① 预期页面结构
  if (!isArcTabsFingerprint(ev)) failed.push('structure');
  // ② 实际集合绑定
  const colls = Array.isArray(ev.collectionNames) ? ev.collectionNames : [];
  if (colls.length !== 1 || colls[0] !== ARC_OWNED_COLLECTION) {
    failed.push('collection');
  }
  // ③ 模型层级
  const depth = Number(ev.maxDepth);
  if (!Number.isFinite(depth) || depth < 4) failed.push('depth');

  const ok = failed.length === 0;
  return {
    ok,
    failed,
    reason: ok
      ? `归属证据齐备（结构 ${describeFingerprint(ev)} · 绑定 [${colls.join(',')}] · 深度 ${depth}）`
      : `归属证据不足（缺 ${failed.join(' + ')}）：结构 ${describeFingerprint(ev)} · ` +
        `绑定 [${colls.join(',') || '无'}] · 深度 ${Number.isFinite(depth) ? depth : '无'}`,
  };
}

/**
 * 判定「已占用的 UID 能不能复用」。
 *
 * @param {{preId:number|null, tabsFingerprint:object, evidence?:ArcEvidence,
 *          pageShell?:{verdict:string, id?:number|null, observed?:{title?:string,type?:string}}}} o
 *   preId —— 重放**前**该 UID 对应的路由 id（null = 无占用）
 *   tabsFingerprint —— 重放**前**该 UID 的 tabs 子树指纹
 *   evidence —— ★ 三条件归属证据（结构 + 实际集合绑定 + 模型层级）。
 *               给了就**必须**三条全过才复用；没给（undefined）时退化为只查结构，
 *               并在 reason 里**显式标注降级**，避免"忘了传证据"被静默当成已证明。
 *   pageShell —— ★ **页面壳**归属（PROD-HOTFIX-01 新增）。
 *               `{verdict:'absent'|'arc'|'other-business', id, observed}`；
 *               `other-business` ⇒ **无条件 STOP**（生产库有 34 条既有路由，
 *               任何"UID 撞上别人页面"的情形都必须零写入停下）。
 *               不传 ⇒ 跳过本层（向后兼容；自检 fixture 用它区分两种判据）。
 */
export function decideUidOwnership({ preId, tabsFingerprint, evidence, pageShell }) {
  if (preId === null || preId === undefined) {
    return { verdict: UID_OWNERSHIP.FRESH, reusable: false, reason: '无占用（首次重建）' };
  }

  // ---- ★ 前置：**路由壳**归属（PROD-HOTFIX-01）----
  //
  // 为什么必须在一切证据之前判，且必须**独立**判：
  //   `evidence`（三条件）查的是 **tabs 子树**。生产库里 tabs 的 schemaUid
  //   （`97x481j2bv1`）**根本不存在**（库里只有 34 条既有业务路由），
  //   于是 `evidence` 会显示"零模型、无绑定、深度 0" —— 与"真 ARC 页被覆盖"完全同形，
  //   但真实原因完全不同：**是 page 壳这个 UID 被别人占了**。
  //   混在一起判会把两种事故报成一种，排障时会去查一个根本没问题的子树。
  //
  // 判据（只有两种合法情形）：
  //   · 该 UID 上**不存在**路由（shell.absent）⇒ 首次新建；
  //   · 该 UID 上的路由**就是本次交付包的那一条**（按交付包的 title/type/parent 结构比对
  //     ⇒ shell.arc）⇒ 幂等复用。
  //   其余一切（尤其"存在一条其它业务的页面路由"）⇒ STOP，**零写入**。
  //
  // shell 未传（旧调用方）时跳过本层，行为与改动前完全一致 —— 向后兼容。
  if (pageShell) {
    if (pageShell.verdict === 'other-business') {
      return {
        verdict: UID_OWNERSHIP.STOP,
        reusable: false,
        reason: `页面壳 UID 已被**其它业务页面**占用（id=${pageShell.id}，` +
          `${pageShell.observed?.title ? `标题「${pageShell.observed.title}」，` : ''}` +
          `type=${pageShell.observed?.type ?? '?'}）⇒ 停（零写入，绝不覆盖既有业务页面）`,
      };
    }
    if (pageShell.verdict === 'arc') {
      // 壳已证属于本次重放 ⇒ 继续走 tabs 三条件证据（可为空树 ⇒ 那说明只建了壳没建树，
      // 属于"半成品"，交给 evidence 判 STOP，这里不替它放行）。
    }
    // pageShell.verdict === 'absent' ⇒ 无占用，最后落到下面的 evidence 分支
    // （evidence 会在 preId 非空时判 STOP —— 但 preId 非空时壳不可能 absent，自洽）。
  }

  if (evidence) {
    const v = isArcOwnershipEvidence(evidence);
    if (v.ok) {
      return { verdict: UID_OWNERSHIP.REUSE_PROVEN, reusable: true, reason: `${v.reason} ⇒ 证属本次重放，可幂等复用` };
    }
    return { verdict: UID_OWNERSHIP.STOP, reusable: false, reason: `${v.reason} ⇒ 停（不允许静默复用）` };
  }
  // ---- 降级分支：只查结构（兼容未升级的调用方）----
  if (isArcTabsFingerprint(tabsFingerprint)) {
    return {
      verdict: UID_OWNERSHIP.REUSE_PROVEN,
      reusable: true,
      reason: `已占用 UID 内容 = ARC 页（tabs ${describeFingerprint(tabsFingerprint)}）` +
        `⇒ 证属本次重放，可幂等复用` +
        ` ⚠️ 本次判定**未**提供集合绑定/层级证据（已降级为仅结构判据）`,
    };
  }
  return {
    verdict: UID_OWNERSHIP.STOP,
    reusable: false,
    reason: `已占用但**无法证明**属于本次重放（tabs ${describeFingerprint(tabsFingerprint)}）⇒ 停`,
  };
}

/**
 * 判定「本次拿到的路由 id 是不是符合预期的归属」。
 *
 * 三分支，互斥且穷尽：
 *   · id ∉ 重放前快照 ⇒ FRESH（本次新建）
 *   · id ∈ 快照 且 === 重放前那个 ⇒ REUSE（幂等复用）
 *   · id ∈ 快照 但 ≠ 重放前那个 ⇒ DRIFT（**两种都不属于**：不是新建，也不是复用同一个。
 *     说明重放前根本没查到这条 UID，写完却冒出一个旧 id —— 典型是
 *     "create 静默落到别人的既有路由上"，必须红）
 *
 * @param {{preId:number|null, postId:number|null, idsBefore:Set<number>|number[]}} o
 * @returns {{verdict:string, ok:boolean, reason:string}}
 */
export function decideRouteIdAttribution({ preId, postId, idsBefore }) {
  const before = idsBefore instanceof Set ? idsBefore : new Set(idsBefore ?? []);
  if (postId === null || postId === undefined || !Number.isFinite(Number(postId))) {
    return { verdict: ROUTE_ID_ATTRIBUTION.MISSING, ok: false, reason: '未拿到路由 id' };
  }
  const id = Number(postId);
  if (!before.has(id)) {
    return { verdict: ROUTE_ID_ATTRIBUTION.FRESH, ok: true, reason: `id=${id} 不在重放前快照 ⇒ 本次新建` };
  }
  if (preId !== null && preId !== undefined && id === Number(preId)) {
    return { verdict: ROUTE_ID_ATTRIBUTION.REUSE, ok: true, reason: `id=${id} 等于重放前那个 ⇒ 幂等复用` };
  }
  return {
    verdict: ROUTE_ID_ATTRIBUTION.DRIFT,
    ok: false,
    reason: `id=${id} 在重放前快照里，却不等于重放前该 UID 的 id（${preId ?? '无'}）⇒ 静默漂移，停`,
  };
}
