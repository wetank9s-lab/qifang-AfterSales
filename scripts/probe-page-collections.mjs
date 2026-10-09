/**
 * probe-page-collections.mjs —— 实测「页面真正依赖哪些 collection 元数据」（Phase 11 / P11-0）
 *
 * 用户锁死的第一条：`collections:listMeta` 的收窄必须采用**正向允许**（fail-closed），
 * 不能实现成"返回全部再删掉 users/roles/collections"的黑名单 —— 因为 NocoBase 以后
 * 新增 `authenticators` / `apiKeys` 之类平台集合时会**再次泄漏**。
 * ⇒ 第一步是**实测页面到底需要哪些 collection**，再据此写 allowlist。
 *
 * 口径（可复算，不靠猜）：
 *   ① `collections` 表 = NocoBase 注册的**全部逻辑集合名**（`collections:listMeta` 的取值域）
 *   ② `flowModels` 表 = 页面/区块的模型定义（页面 schema 就存在这里）
 *   ③ 用 ① 的名字去扫 ② 的 JSON 文本 ⇒ "页面**真的引用**了哪些集合"
 *   ④ 再把被引用集合的**关联字段目标**（`fields.target`）展开一层
 *      —— 区块要渲染关联字段，就需要目标集合的 metadata
 *
 * ⚠️ 只读；不改授权。用法：node scripts/probe-page-collections.mjs
 */
import { execFileSync } from 'node:child_process';

function psql(sql, { tuplesOnly = true } = {}) {
  const args = ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-A', '-F', '\u0001'];
  if (tuplesOnly) args.push('-t');
  args.push('-c', sql);
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  实测页面依赖的 collection 元数据（Phase 11 / P11-0）');
console.log('══════════════════════════════════════════════════════════════');

// ① 全部注册的逻辑集合名 + 哪些是"插件自有业务集合"
const allCollections = psql(`SELECT name FROM collections ORDER BY name`)
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const BUSINESS = new Set([
  'stores',
  'storeUsers',
  'serviceTickets',
  'serviceVisits',
  'serviceVisitPhotos',
  'ticketEvents',
  'smsLogs',
  'serviceSettings',
  'apiGuards',
  'dailySequences',
  'idempotencyRecords',
  'exportAudits',
]);

console.log(`  · NocoBase 注册的逻辑集合：${allCollections.length} 个`);
console.log(`  · 其中插件自有业务集合：${[...BUSINESS].filter((b) => allCollections.includes(b)).length} 个`);

// ② 页面/区块模型定义（页面 schema 在这里）
const modelText = psql(`SELECT options::text FROM "flowModels"`);

// ③ 以集合名扫模型文本 ⇒ 被页面引用的集合
const referenced = new Map(); // name -> 出现次数
for (const name of allCollections) {
  // 用引号包住的名字做整体匹配，降低"子串误命中"（如 stores 命中 storeUsers 之外的东西）
  const re = new RegExp(`["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'g');
  const n = (modelText.match(re) ?? []).length;
  if (n > 0) referenced.set(name, n);
}

console.log('');
console.log('【页面/区块模型里实际引用的集合】（按出现次数降序）');
const rows = [...referenced.entries()].sort((a, b) => b[1] - a[1]);
if (!rows.length) {
  console.log('  ⚠️ 没有解析出任何集合引用 —— 抽取口径需再核（不要把空的清单当结论）');
} else {
  for (const [name, n] of rows) {
    const tag = BUSINESS.has(name) ? '业务' : '⚠️ 平台';
    console.log(`  ·  ${name.padEnd(30)} ×${String(n).padEnd(4)} [${tag}]`);
  }
}

// ④ 展开被引用集合的关联字段目标（一层）
//
// ⚠️ `fields` 表**没有** `target` 列 —— 关联目标在 `options` JSON 里
//    （第一版按列名查，直接报 column "target" does not exist）。
//    ⇒ 这里读 `options::text` 再解析，且**容错**：任何一步失败都打印出来，不让整份报告消失。
const referencedNames = [...referenced.keys()];
if (referencedNames.length) {
  const inList = referencedNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  let rows = [];
  try {
    rows = psql(
      `SELECT "collectionName" || '|' || name || '|' || coalesce(options::text,'{}') FROM fields
        WHERE "collectionName" IN (${inList}) ORDER BY "collectionName", name`,
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [collectionName, fieldName, optionsText] = line.split('|');
        let target = null;
        try {
          const o = JSON.parse(optionsText ?? '{}');
          target = o?.target ?? o?.targetKey ?? null;
        } catch {
          target = null;
        }
        return { collectionName, fieldName, target };
      })
      .filter((f) => f.target);
  } catch (e) {
    console.log('');
    console.log(`  ⚠️ 关联目标展开失败（打印出来，不让报告消失）：${String(e?.message ?? e).slice(0, 200)}`);
  }

  console.log('');
  console.log('【被引用集合的关联目标（一层）—— 渲染关联字段也需要它】');
  const targets = new Set();
  for (const f of rows) {
    targets.add(f.target);
    console.log(`  ·  ${f.collectionName}.${f.fieldName} → ${f.target}`);
  }
  if (!targets.size) console.log('  （无关联字段，或 options 里没有 target）');
  console.log('');
  console.log(`  ⇒ 关联目标集合：${[...targets].sort().join(', ') || '（无）'}`);
  const missing = [...targets].filter((t) => !referenced.has(t));
  if (missing.length) {
    console.log(`  ⚠️ 这些目标**没有直接出现在模型里但会被关联字段暴露**：${missing.sort().join(', ')}`);
    console.log('     ⇒ 正向 allowlist **必须把它们算进去**（否则关联字段渲染不出来）');
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  说明：本清单 = **正向 allowlist 的输入**；未知 collection 默认不返回（fail-closed）。');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
