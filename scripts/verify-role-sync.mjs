#!/usr/bin/env node
/**
 * verify-role-sync.mjs —— R2.2.1 用户第九条「门店账号同步」的四处一致性门禁。
 *
 * ===========================================================================
 * 为什么需要它（用户原话）
 * ===========================================================================
 * 「若新角色未建立，先检查四处同步（`ROLE`、`ROLE_ROLE_NAME_MAP`、
 *   `HQ_ROLES`/写权限清单、`ROLE_MENU_MATRIX`）」
 *
 * 这四处的漏失**都不会报错**，而且表现各不相同，极难归因：
 *   · 漏 ①`ROLE` 枚举      → 代码里拼不出角色名，编译期就红（唯一会自己红的）
 *   · 漏 ②`ROLE_ROLE_NAME_MAP` → `normalizeRoles()` 不认 ⇒ `scopeOf()` 判 `none`（fail closed），
 *                              账号登录后"什么都看不到"，看起来像权限没生效
 *   · 漏 ③`HQ_ROLES`/写权限清单 → 后端认这个角色，但它既不在总部也不在门店清单里，
 *                              结果是**能登录、能看菜单、点什么都 403**
 *   · 漏 ④`ROLE_MENU_MATRIX` → 后端全对，但**导航里一个菜单都没有**，界面像坏了
 *
 * 「不会报错」正是必须做成静态判据的理由。
 *
 * ===========================================================================
 * 判据
 * ===========================================================================
 *   R1  `ROLE` 枚举里的每个业务角色都在 `ROLE_ROLE_NAME_MAP` 里（自映射或受控别名）
 *   R2  `ROLE_ROLE_NAME_MAP` 的**值**都必须是 `ROLE` 枚举里真实存在的名字
 *       （防止映射打错字——错字会让 normalize 静默丢弃）
 *   R3  每个业务角色必须**恰好**落在 HQ 侧或门店侧之一，不得两边都不在
 *       （两边都在也算红：scope 判定会出现两种解释）
 *   R4  `ROLE_MENU_MATRIX` 的键集合 ⊆ 业务角色集合，且**每个门店角色至少有一个菜单**
 *   R5  `ROLE_MENU_MATRIX` 里出现的页面名，必须都在已知页面清单里（防拼写漂移）
 *   R6  **反向**：`store_sales` / `store_manager` 不得获得工单/派工/短信菜单
 *       （用户 2026-11-09 明确要求"不要自动赋予原 serviceTickets/serviceVisits 权限"）
 *   R7  生产保护：`user_id=904` 的 `store_after_sales` 绑定不得被本仓库任何脚本重置
 *       —— 扫 `scripts/` 下是否出现"删除全部绑定"的写法作用在非测试库上
 *
 * 用法：node scripts/verify-role-sync.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONSTANTS = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts');
const EXPECTED = path.join(ROOT, 'scripts/expected-sensitive-columns.mjs');

const out = [];
const rec = (id, ok, d) => {
  out.push({ id, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${id} ${d}`);
};

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 取 `export const X = {...}` / `[...]` 的源码片段。
 *
 * 🔴 第一版有 bug，而且它**表现为产品红**（R3 报"六个角色两边都不在"）。
 *    原因：`export const X` 之后先遇到的是**注释里的方括号**，例如
 *        `/** ⚠️ 它与 STORE_SCOPED_ROLES 当前取值相同… —— 见 [XXX]`
 *    于是截取从注释里的 `[` 开始，永远配不上括号 ⇒ 返回空串 ⇒ 集合为空。
 *    ⇒ 解析器自己错时不许把结论说成"产品坏了"。修法：先剥注释，再找第一个括号。
 *    （这条已写进 ENGINEERING-RULES：「工具坏了」与「产品坏了」必须分开报）
 */
function blockOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  const eq = src.indexOf('=', i);
  if (eq < 0) return '';
  // 从 `=` 之后开始，跳过空白，遇到 `{` 或 `[` 才算开始
  let start = -1;
  for (let k = eq + 1; k < src.length; k += 1) {
    const c = src[k];
    if (c === '{' || c === '[') { start = k; break; }
    if (c === ';') break;
  }
  if (start < 0) return '';
  let depth = 0;
  for (let k = start; k < src.length; k += 1) {
    const c = src[k];
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return '';
}

function main() {
  const cs = read(CONSTANTS);
  const ex = read(EXPECTED);

  // ── ROLE 枚举 ─────────────────────────────────────────────────────────────
  const roleBlock = blockOf(cs, 'export const ROLE =');
  // 形如 `STORE_SALES: 'store_sales',` 或 `STORE_SALES = 'store_sales'`
  const roleKeys = [...roleBlock.matchAll(/([A-Z][A-Z0-9_]+)\s*[:=]\s*'(store_[a-z_]+|hq_[a-z_]+|viewer)'/g)].map(
    (m) => ({ key: m[1], value: m[2] }),
  );
  const roleValues = new Set(roleKeys.map((r) => r.value));
  rec('R0-role-enum', roleValues.size >= 5, `ROLE 枚举解析到 ${roleValues.size} 个业务角色：${JSON.stringify([...roleValues])}`);

  // ── R1 每个 ROLE 都在映射表里 ─────────────────────────────────────────────
  const mapBlock = blockOf(cs, 'export const ROLE_ROLE_NAME_MAP');
  const mapPairs = [...mapBlock.matchAll(/\[ROLE\.([A-Z0-9_]+)\]\s*:\s*ROLE\.([A-Z0-9_]+)/g)].map((m) => ({
    fromKey: m[1],
    toKey: m[2],
  }));
  const aliasPairs = [...mapBlock.matchAll(/'([a-z0-9-]+)'\s*:\s*ROLE\.([A-Z0-9_]+)/g)].map((m) => ({
    alias: m[1],
    toKey: m[2],
  }));
  const mappedFromKeys = new Set(mapPairs.map((p) => p.fromKey));
  const missingInMap = roleKeys.filter((r) => !mappedFromKeys.has(r.key)).map((r) => r.key);
  rec('R1-role-in-map', missingInMap.length === 0,
    `ROLE 枚举 ${roleKeys.length} 个，未进 ROLE_ROLE_NAME_MAP 的=${JSON.stringify(missingInMap)}`);

  // ── R2 映射目标必须是真实角色 ─────────────────────────────────────────────
  const keyToValue = new Map(roleKeys.map((r) => [r.key, r.value]));
  const badTargets = [];
  for (const p of mapPairs) {
    if (!keyToValue.has(p.toKey)) badTargets.push(`ROLE.${p.fromKey} → ROLE.${p.toKey}（目标不存在）`);
  }
  for (const p of aliasPairs) {
    if (!keyToValue.has(p.toKey)) badTargets.push(`'${p.alias}' → ROLE.${p.toKey}（目标不存在）`);
  }
  rec('R2-map-targets-valid', badTargets.length === 0,
    badTargets.length ? badTargets.join(' | ') : `${mapPairs.length} 条自映射 + ${aliasPairs.length} 条别名，目标全部有效`);

  // ── R3 每个角色恰好落在 HQ 或门店一侧 ─────────────────────────────────────
  const hqBlock = blockOf(cs, 'export const HQ_ROLES');
  const storeBlock = blockOf(cs, 'export const STORE_SCOPED_ROLES');
  const pickRoleKeys = (b) => [...b.matchAll(/ROLE\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const hqKeys = new Set(pickRoleKeys(hqBlock));
  const storeKeys = new Set(pickRoleKeys(storeBlock));
  const neither = [];
  const both = [];
  for (const r of roleKeys) {
    // viewer 归总部侧；其余按名字判断——这里用"集合归属"而不是名字前缀，避免同义反复
    const inHq = hqKeys.has(r.key);
    const inStore = storeKeys.has(r.key);
    if (!inHq && !inStore) neither.push(r.value);
    if (inHq && inStore) both.push(r.value);
  }
  rec('R3-scope-exactly-one', neither.length === 0 && both.length === 0,
    `既不在 HQ 也不在门店=${JSON.stringify(neither)} 两边都在=${JSON.stringify(both)}`);

  // ── R4 / R5 / R6 ROLE_MENU_MATRIX ────────────────────────────────────────
  const matrixBlock = blockOf(ex, 'export const ROLE_MENU_MATRIX');
  const matrix = {};
  for (const m of matrixBlock.matchAll(/([a-z_]+)\s*:\s*\[([^\]]*)\]/g)) {
    matrix[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  const matrixKeys = Object.keys(matrix);
  const unknownKeys = matrixKeys.filter((k) => !roleValues.has(k));
  const storeRolesNoMenu = [...storeKeys]
    .map((k) => keyToValue.get(k))
    .filter((v) => v && !(matrix[v]?.length > 0));
  rec('R4-matrix-covers-store-roles', unknownKeys.length === 0 && storeRolesNoMenu.length === 0,
    `矩阵键=${JSON.stringify(matrixKeys)} 未知角色=${JSON.stringify(unknownKeys)} 无菜单的门店角色=${JSON.stringify(storeRolesNoMenu)}`);

  // 已知页面清单：从矩阵所有值里取并集，再与后台页面名清单交叉——这里只做"非空且像中文"
  const allPages = [...new Set(Object.values(matrix).flat())];
  const weirdPages = allPages.filter((p) => !/^[\u4e00-\u9fa5]{2,}$/.test(p));
  rec('R5-page-names-sane', weirdPages.length === 0,
    `页面名 ${allPages.length} 个，不像中文页面名的=${JSON.stringify(weirdPages)}`);

  const TICKET_MENUS = ['所有工单', '我的门店工单', '派工记录', '工单事件时间线', '短信通知', '短信通知总览', '服务时效'];
  const leaked = ['store_sales', 'store_manager'].flatMap((r) =>
    (matrix[r] ?? []).filter((p) => TICKET_MENUS.includes(p)).map((p) => `${r}←${p}`),
  );
  rec('R6-no-ticket-menu-for-archive-roles', leaked.length === 0,
    leaked.length ? `越权菜单：${leaked.join(' | ')}` : 'store_sales / store_manager 只有档案入口，无工单/派工/短信菜单');

  // ── R7 生产账号保护 ──────────────────────────────────────────────────────
  // 扫 scripts/ 里是否有「**无 WHERE** 地清空 store_users」的写法 —— 那是 904 十家门店
  // 绑定被一次性抹掉的唯一路径。
  //
  // 🔴 判据第一版太宽，报了假红：它把 `scripts/uat-accounts.mjs` 也抓了进来，
  //    而那个脚本删的是 `WHERE user_id = ${userId}`（UAT 账号停用，定点、可解释）。
  //    ⇒ 精确到"没有 WHERE 子句"这一条，才是真正危险的形态。
  //    这正是"判据太宽 = 自造假红"的又一个实例：宽度不到位，红得再多也没意义。
  const scriptsDir = path.join(ROOT, 'scripts');
  const offenders = [];
  const SELF = path.basename(import.meta.filename ?? 'verify-role-sync.mjs');
  // 🔴 扫描器必须**排除自己**，否则字面量命中字面量（自我判红）。
  //    这不是第一次踩：`repo-publish-secret-audit` 里的敏感串扫描也栽在同一处。
  //    更彻底的做法是把正则写成片段拼接（见下 `SQL_DELETE`），让源码里不存在完整形态；
  //    但排除自身是必须的兜底 —— 因为注释里也会出现那串文本。
  const SQL_DELETE = 'DELETE' + '\\s+FROM\\s+' + '"?' + 'store_' + 'users' + '"?';
  const re = new RegExp(SQL_DELETE + '\\s*(?:;|$|`|\'|"|\\n)', 'gi');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(p);
      } else if (/\.(mjs|js|cjs|py|ts)$/.test(name)) {
        if (name === SELF) continue; // 排除自身
        const s = fs.readFileSync(p, 'utf8');
        if (re.test(s)) offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(scriptsDir);
  rec('R7-no-blanket-store-unlink', offenders.length === 0,
    offenders.length
      ? `发现无 WHERE 地清空 store_users 的脚本：${JSON.stringify(offenders)}`
      : '未发现无 WHERE 清空门店绑定的脚本（定点删除如 uat-accounts 的 `WHERE user_id=…` 属正常）');

  const fail = out.filter((r) => !r.ok);
  console.log(`\n汇总：PASS ${out.length - fail.length} / ${out.length}`);
  if (fail.length) {
    console.log('未通过：' + fail.map((f) => f.id).join(', '));
    process.exitCode = 1;
  }
}

main();
