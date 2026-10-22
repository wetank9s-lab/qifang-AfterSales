/**
 * patch-be04-date-model.mjs —— post-seed（D2）：沿**当前页面树**定位 createdAt 筛选项
 *
 * ===========================================================================
 * 为什么是这条路（2026-10-20 三轮调查的结论）
 * ===========================================================================
 * 走过的死路：
 *   · 全库按 `filterPaths 含 createdAt` 匹配 → 7 个页面都有日期筛选，无法收敛；
 *   · 从 `applyBlueprint` 响应树里取 → `--only` 模式只返回根节点，不可靠；
 *   · 按 `flowModels` 的 parentId 遍历 → **表里根本没有持久化的父子关系**
 *     （grid 没有 parentId；tab 只有 `{"schema":...}` 占位）。
 *
 * 走通的路：
 *   `flowSurfaces:get?pageSchemaUid=<页面 schemaUid>` **直接返回该页面的完整模型树**
 *   （200，含 `subModels.tabs → grid → filterManager`）。它接受
 *   `uid / pageSchemaUid / tabSchemaUid / routeId`，与 applyBlueprint 的响应同构，
 *   但**随时可读**、不依赖一次写操作的返回值。
 *
 * ===========================================================================
 * 定位链（每一级都校验，任何一级对不上就失败）
 * ===========================================================================
 *   desktopRoutes(title=所有工单, type=flowPage).schemaUid
 *     → flowSurfaces:get → tree
 *       → 递归找 filterManager[] 里 filterPaths 含 'createdAt' 的条目
 *         → 取 filterId（本页范围内必须恰好 1 个）
 *           → flowModels:get(filterId) 校验 use / collectionName / fieldPath
 *             → flowModels:update { use: BE04DateRangeFilterItemModel }
 *               → 回读确认
 */

export const BE04_DATE_MODEL_NAME = 'BE04DateRangeFilterItemModel';

const PAGE_TITLE = '所有工单';
const ALLOWED_FROM_USE = new Set(['FilterFormItemModel', BE04_DATE_MODEL_NAME]);

/** 在页面树里收集 filterManager 中指向 createdAt 的 filterId（带深度上限，防循环） */
export function collectCreatedAtFilterIds(node, acc = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectCreatedAtFilterIds(item, acc, depth + 1);
    return acc;
  }
  if (Array.isArray(node.filterManager)) {
    for (const cfg of node.filterManager) {
      if (Array.isArray(cfg?.filterPaths) && cfg.filterPaths.includes('createdAt') && cfg.filterId) {
        acc.push({ filterId: cfg.filterId, targetId: cfg.targetId ?? null, gridUid: node.uid ?? null });
      }
    }
  }
  // ⚠️ `subModels` 是**容器对象**（`{tabs:[...]}` / `{grid:{...}}`），
  //    必须遍历它的**值**；只递归容器本身会漏掉所有子节点（这里踩过一次）。
  if (node.subModels && typeof node.subModels === 'object') {
    for (const child of Object.values(node.subModels)) {
      if (child && typeof child === 'object') collectCreatedAtFilterIds(child, acc, depth + 1);
    }
  }
  return acc;
}

/**
 * @returns {Promise<{ok:boolean, uid?:string, action?:string, reason?:string, path?:string[], evidence?:any}>}
 */
export async function patchBe04DateModel({ api, token, log = () => {} }) {
  const path = [];

  // 1. 当前有效路由
  // ⚠️ seed 的 `api()` 默认是 POST；这三个都是 GET 接口，必须显式指定
  const routes = await api(`/api/desktopRoutes:list?pageSize=200&filter[title]=${encodeURIComponent(PAGE_TITLE)}`, {
    token,
    method: 'GET',
  });
  if (routes.status >= 400) return { ok: false, reason: `routes-http-${routes.status}`, path };
  const pageRoutes = (routes.json?.data ?? []).filter((r) => r?.type === 'flowPage' && r?.title === PAGE_TITLE);
  if (pageRoutes.length === 0) return { ok: false, reason: 'route-not-found', path };
  if (pageRoutes.length > 1) return { ok: false, reason: `route-multiple:${pageRoutes.length}`, path };
  const schemaUid = pageRoutes[0].schemaUid;
  if (!schemaUid) return { ok: false, reason: 'route-no-schema-uid', path };
  path.push(`route(schemaUid=${schemaUid})`);

  // 2. 读该页面的完整模型树（正式接口，随时可读）
  const surface = await api(`/api/flowSurfaces:get?pageSchemaUid=${encodeURIComponent(schemaUid)}`, {
    token,
    method: 'GET',
  });
  if (surface.status >= 400) {
    return {
      ok: false,
      reason: `surface-http-${surface.status}:schemaUid=${schemaUid}:${(surface.text ?? '').slice(0, 160)}`,
      path,
    };
  }
  const tree = surface.json?.data?.tree;
  if (!tree) {
    return {
      ok: false,
      reason: `surface-no-tree:dataKeys=${JSON.stringify(Object.keys(surface.json?.data ?? {}))}:topKeys=${JSON.stringify(Object.keys(surface.json ?? {}))}`,
      path,
    };
  }
  path.push(`root(${tree.uid ?? '?'})`);

  // 3. 本页范围内收集 createdAt 映射
  const hits = collectCreatedAtFilterIds(tree);
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `createdAt-not-found:treeKeys=${JSON.stringify(Object.keys(tree))}:hasFM=${JSON.stringify(tree).includes('filterManager')}`,
      path,
    };
  }
  const uniq = [...new Map(hits.map((h) => [h.filterId, h])).values()]; // 同一 uid 去重
  if (uniq.length > 1) {
    return { ok: false, reason: `createdAt-multiple:${uniq.map((h) => h.filterId).join(',')}`, path };
  }
  const { filterId, targetId, gridUid } = uniq[0];
  path.push(`grid(${gridUid ?? '?'})`, `filterId(${filterId})`);
  if (!targetId) return { ok: false, reason: 'no-target-id', path };

  // 4. 读目标模型并做业务校验
  const item = await api(`/api/flowModels:get?filterByTk=${filterId}`, { token, method: 'GET' });
  if (item.status >= 400) return { ok: false, reason: `item-http-${item.status}`, path };
  const m = item.json?.data;
  const init = m?.stepParams?.fieldSettings?.init;
  if (m?.use !== undefined && !ALLOWED_FROM_USE.has(m.use)) {
    return { ok: false, reason: `unexpected-use:${m.use}`, path };
  }
  if (init?.collectionName !== 'serviceTickets' || init?.fieldPath !== 'createdAt') {
    return { ok: false, reason: `field-mismatch:${init?.collectionName}/${init?.fieldPath}`, path };
  }
  if (m?.use === BE04_DATE_MODEL_NAME) {
    log(`  · 日期模型已是 ${BE04_DATE_MODEL_NAME}（filterId=${filterId}），跳过`);
    return { ok: true, uid: filterId, action: 'noop', path, evidence: { targetId, gridUid } };
  }

  // 5. 只更新这一个模型
  const upd = await api(`/api/flowModels:update?filterByTk=${filterId}`, {
    token,
    method: 'POST',
    body: { use: BE04_DATE_MODEL_NAME },
  });
  if (upd.status >= 400) return { ok: false, uid: filterId, reason: `update-http-${upd.status}`, path };

  // 6. 回读确认
  const rb = await api(`/api/flowModels:get?filterByTk=${filterId}`, { token, method: 'GET' });
  const finalUse = rb?.json?.data?.use;
  if (finalUse !== BE04_DATE_MODEL_NAME) {
    return { ok: false, uid: filterId, reason: `readback-mismatch:${finalUse}`, path };
  }

  log(`  ✓ 日期模型已切换：${path.join(' → ')}`);
  return { ok: true, uid: filterId, action: 'updated', path, evidence: { targetId, gridUid } };
}
