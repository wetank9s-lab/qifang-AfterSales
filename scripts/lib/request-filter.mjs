/**
 * request-filter.mjs —— **统一**的请求 Filter 判据
 *
 * 为什么单独成文件（2026-10-20 假红事故）：
 *   曾用 `decodeURIComponent(url).includes('createdAt')` 判断"日期条件是否残留"，
 *   结果撞上排序参数 `sort[]=-createdAt`，把"已经清除"误判成"仍然残留"，
 *   白报了一个不存在的产品 Bug。
 *
 * 规矩：
 *   ① 只解析 `filter` 查询参数，**不要**对整条 URL 做字符串包含；
 *   ② 解析后按字段路径**递归**找条件，不在 JSON 文本上做 includes；
 *   ③ 判"清除成功" = 解析结果里**没有**该字段的条件（哪怕 URL 里还有别的 filter）。
 */

/** 从请求 URL 里解析出 filter 对象（没有则 null） */
export function parseRequestFilter(urlStr) {
  try {
    const u = new URL(String(urlStr), 'https://placeholder.local');
    const raw = u.searchParams.get('filter');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从请求 URL 里取普通查询参数（如 page） */
export function queryParam(urlStr, key) {
  try {
    return new URL(String(urlStr), 'https://placeholder.local').searchParams.get(key);
  } catch {
    return null;
  }
}

/**
 * 在 filter 结构里找某个字段的条件（递归 `$and` / `$or` / 直接对象）。
 * @returns {any[]} 命中的条件片段（空数组 = 该字段没有任何条件）
 */
export function findFieldConditions(filter, field) {
  const hits = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === field) {
        hits.push(v);
        continue;
      }
      if (k === '$and' || k === '$or' || k === '$not') {
        walk(v);
        continue;
      }
      // 形如 { "store": { "id": 1 } } 的关联字段
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(filter);
  return hits;
}

/** 该请求是否带某字段的筛选条件 */
export function hasFieldFilter(filter, field) {
  return findFieldConditions(filter, field).length > 0;
}

/** 本页日期条件的规范形态检查（必须是 $dateNotBefore + $dateBefore，且不含 $dateOn） */
export function inspectDateCondition(filter) {
  const conds = findFieldConditions(filter, 'createdAt');
  if (conds.length === 0) return { present: false, ok: false, conds };
  const c = conds[0] ?? {};
  const keys = Object.keys(c);
  return {
    present: true,
    ok: Boolean(c.$dateNotBefore) && Boolean(c.$dateBefore) && !keys.includes('$dateOn') && !keys.includes('$dateBetween'),
    keys,
    conds,
  };
}
