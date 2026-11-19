/**
 * arc-a5-page-structure.mjs —— ARC-V1 / A5 移动页真实结构取证（只读）
 *
 * ⚠️ 关键事实（这一轮才搞清楚，写下来免得再错）：
 *   · V2 页面模型的父子关系**不靠** flowModels.options.parentId 查询，
 *     真实链在 **flowModelTreePath(ancestor, descendant, depth, type, sort)**。
 *   · flowModels.options 结构为：
 *       { parentId, subKey, subType, use, props, stepParams, sortIndex, flowRegistry, ... }
 *     根行（desktopRoutes.schemaUid 指向的那行）是例外，形如 { schema: { use: 'RouteModel' } }。
 *   · 路由 → 页面的连接键是 **desktopRoutes.schemaUid = flowModels.uid = flowModelTreePath.ancestor**。
 *   · desktopRoutes 没有 flowRegistry 列；flowModels 只有 uid / name / options 三列。
 *
 * 纪律：全程只读（SELECT），不 INSERT / UPDATE / DELETE。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SCHEMA_UID = process.argv[2] || 'n5c25yq5qlt';

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
      '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '\u0001', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}
function rows(sql) {
  const out = psql(sql).trim();
  if (!out) return [];
  return out.split('\n').map((l) => l.split('\u0001'));
}
const J = (s) => { try { return JSON.parse(s); } catch { return s; } };

console.log('='.repeat(78));
console.log(`ARC-V1 / A5 · 移动页结构取证  schemaUid = ${SCHEMA_UID}`);
console.log(`时间: ${new Date().toISOString()}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
console.log('\n### 1. desktopRoutes 上该 schemaUid 的路由行');
const routeRows = rows(`
  SELECT id, COALESCE("parentId"::text,'-'), type, COALESCE(title,''), "schemaUid",
         COALESCE("menuSchemaUid",''), icon, COALESCE(hidden::text,'-'),
         COALESCE("hideInMenu"::text,'-'), COALESCE("enableTabs"::text,'-'), sort
  FROM "desktopRoutes"
  WHERE "schemaUid" = '${SCHEMA_UID}' OR "menuSchemaUid" = '${SCHEMA_UID}'
  ORDER BY id;
`);
if (!routeRows.length) console.log('  (无)');
for (const r of routeRows) {
  console.log('  ' + JSON.stringify({
    id: r[0], parentId: r[1], type: r[2], title: r[3], schemaUid: r[4],
    menuSchemaUid: r[5], icon: r[6], hidden: r[7], hideInMenu: r[8],
    enableTabs: r[9], sort: r[10],
  }));
}

const parentIds = routeRows.map((r) => r[0]).filter((x) => /^\d+$/.test(x));
if (parentIds.length) {
  console.log('\n### 2. 这些路由的子路由（tabs）');
  const childRows = rows(`
    SELECT id, "parentId", type, COALESCE(title,''), COALESCE("schemaUid",''),
           COALESCE(hidden::text,'-'), sort
    FROM "desktopRoutes" WHERE "parentId" IN (${parentIds.join(',')}) ORDER BY sort, id;
  `);
  if (!childRows.length) console.log('  (无子路由)');
  for (const c of childRows) {
    console.log('  ' + JSON.stringify({
      id: c[0], parentId: c[1], type: c[2], title: c[3], schemaUid: c[4], hidden: c[5], sort: c[6],
    }));
  }
}

// ---------------------------------------------------------------------------
// 3. 用 flowModelTreePath 展开真实子树
// ---------------------------------------------------------------------------
const roots = [...new Set([
  SCHEMA_UID,
  ...routeRows.map((r) => r[4]).filter(Boolean),
  ...routeRows.flatMap((r) => [r[5]]).filter(Boolean),
])];

console.log(`\n### 3. flowModelTreePath 从根展开（根集合: ${roots.join(', ')}）`);
const seedList = roots.map((u) => `'${u}'`).join(',');
const tree = rows(`
  SELECT p.ancestor, p.descendant, p.depth, COALESCE(p.type,''),
         COALESCE(m.options->>'use','(root/route)'), COALESCE(m.options->>'subKey',''),
         COALESCE(m.options->>'sortIndex','-')
  FROM "flowModelTreePath" p
  LEFT JOIN "flowModels" m ON m.uid = p.descendant
  WHERE p.ancestor IN (${seedList})
  ORDER BY p.ancestor, p.depth, COALESCE(m.options->>'sortIndex','0')::int, p.descendant;
`);
if (!tree.length) {
  console.log('  (无模型行)');
} else {
  for (const t of tree) {
    const indent = '  '.repeat(Number(t[2]) + 1);
    console.log(`${indent}${t[1]}  use=${t[4]}${t[5] ? ` subKey=${t[5]}` : ''} ${t[3] ? `[${t[3]}]` : ''} depth=${t[2]}`);
  }
}

// ---------------------------------------------------------------------------
// 4. 导出 options 原文
// ---------------------------------------------------------------------------
const outDir = '.tmp-verify';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const descendants = [...new Set(tree.map((t) => t[1]))];
const dumpPath = `${outDir}/arc-a5-flowmodels-${SCHEMA_UID}.json`;
let dumped = [];
if (descendants.length) {
  const dl = descendants.map((u) => `'${u}'`).join(',');
  const raw = rows(`SELECT uid, name, options::text FROM "flowModels" WHERE uid IN (${dl}) ORDER BY uid;`);
  dumped = raw.map((r) => ({ uid: r[0], name: r[1], options: J(r[2]) }));
}
fs.writeFileSync(dumpPath, JSON.stringify(dumped, null, 2), 'utf8');
console.log(`\n  已导出 ${dumped.length} 个 FlowModel 的 options → ${dumpPath}`);

// ---------------------------------------------------------------------------
// 5. 扫描业务引用
// ---------------------------------------------------------------------------
console.log('\n### 4. 子树里的资源 / 动作引用');
const hits = [];
const walk = (obj, path, uid) => {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length < 200
        && /^(svc:|collection:|publicArchive|serviceArchive)/i.test(v)) {
      hits.push({ uid, path: `${path}.${k}`, value: v });
    } else if (typeof v === 'object') {
      walk(v, `${path}.${k}`, uid);
    }
  }
};
for (const d of dumped) walk(d.options, 'options', d.uid);
if (!hits.length) console.log('  (未发现 svc: / collection: / serviceArchive 引用 —— 空页面符合预期)');
for (const h of hits) console.log(`  [${h.uid}] ${h.path} = ${JSON.stringify(h.value)}`);

// ---------------------------------------------------------------------------
// 6. 该页在角色可见性表里的现状
// ---------------------------------------------------------------------------
console.log('\n### 5. 角色路由可见性现状');
const vis = rows(`
  SELECT r.name, r.title,
         count(rd."desktopRouteId") FILTER (WHERE rd."desktopRouteId" IN (${parentIds.concat(['-1']).join(',')})) AS granted
  FROM "roles" r
  LEFT JOIN "rolesDesktopRoutes" rd ON rd."roleName" = r.name
  WHERE r.name IN ('store_sales','store_manager','store_after_sales','hq_admin','root','admin','viewer','member')
  GROUP BY r.name, r.title ORDER BY r.name;
`);
for (const v of vis) console.log(`  ${v[0].padEnd(20)} ${String(v[1]).padEnd(12)} 本页授权=${v[2]}`);

console.log('\n完成（全程只读）。');
