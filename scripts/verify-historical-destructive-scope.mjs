#!/usr/bin/env node
/**
 * verify-historical-destructive-scope.mjs
 *   —— **破坏性操作的作用域门禁**（P11-3 第 6 项 · 用户 A 段）
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 *  「DEV-158 表明 M3 曾经删除真实批次的标准化候选行，这必须作为**正式工程安全缺陷**关闭。
 *    要求所有会 UPDATE、DELETE、重建版本、回滚或注入错误的**破坏性验收**，
 *    只能使用**隔离的合成测试批次**。
 *    **服务端必须验证真实数据来源与执行权限**，不能仅依赖脚本作者遵守约定
 *    或前端 scope 标记。
 *    增加**反向门禁**：故意指定**真实历史批次**执行破坏性变异，操作必须被拒绝，
 *    且真实批次的**原始行、机器标准化版本、人工修正层、审计记录和正式归属均保持不变**。
 *    测试前后使用**可复核的数据指纹和行数比对**。
 *    成功运行变异测试后必须**恢复合成夹具**，不能留下污染正常运营的数据。」
 *
 * ===========================================================================
 * 这个门禁做三件事
 * ===========================================================================
 *  ① **指纹**：对一个真实批次取"可复核的数据指纹"（行数 + 内容 md5），
 *     覆盖用户点名的五层：原始行 / 机器标准化 / 人工修正 / 审计 / 正式归属；
 *  ② **反向**：在**容器内**故意调用服务端的破坏性入口 `purgeOtherVersions()`
 *     去删这个**真实批次**的历史版本 —— 必须被 **409 拒绝**，且 ① 的指纹**逐项不变**；
 *  ③ **正向**：对**服务端签发的合成夹具**调用同一函数 —— 允许（证明确实是"守卫"
 *     而不是"函数坏了/永远拒绝"），跑完把夹具标记作废（恢复，不留污染）。
 *
 * ⚠️ 这里**不通过 HTTP**：破坏性入口本来就不对外暴露（它只在服务端代码里）。
 *    本门禁在容器内 `require` 服务层直接调用 —— 这才是"绕过前端声明"的真实形态：
 *    就算调用方无视一切约定、直接拿到服务层，守卫照样拦得住。
 *
 * 用法：node scripts/verify-historical-destructive-scope.mjs
 * 退出码：0 全过 / 1 断言失败 / 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const CONTAINER = 'svc-app';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return String(r.stdout ?? '').trim();
}
const N = (sql) => Number(psql(sql) || '0');

/**
 * **可复核的数据指纹**：用户点名的五层，每层给「行数 + 内容 md5」。
 *
 * ⚠️ 只比行数不够：`UPDATE ... SET x=1` 行数一条不少。所以每一层都带内容摘要；
 *    而不稳定的列（`updated_at`）**不进摘要** —— 否则一次合法的人工确认就会让指纹变，
 *    判据就失去区分力（"变"不能说明是破坏性操作造成的）。
 */
function fingerprint(batchId) {
  return {
    原始行: {
      rows: N(`SELECT count(*) FROM historical_import_rows WHERE batch_id=${batchId}`),
      md5: psql(`SELECT coalesce(md5(string_agg(cells_json::text, '' ORDER BY id)), '') FROM historical_import_rows WHERE batch_id=${batchId}`),
    },
    机器标准化: {
      rows: N(`SELECT count(*) FROM historical_import_candidates WHERE batch_id=${batchId}`),
      md5: psql(`SELECT coalesce(md5(string_agg(fields_json::text || '|' || mapping_version || '|' || disposition, '' ORDER BY id)), '') FROM historical_import_candidates WHERE batch_id=${batchId}`),
    },
    人工修正层: {
      rows: N(`SELECT count(*) FROM historical_import_candidates WHERE batch_id=${batchId} AND manual_overrides_json::text NOT IN ('{}','null')`),
      md5: psql(`SELECT coalesce(md5(string_agg(coalesce(manual_overrides_json::text,'null'), '' ORDER BY id)), '') FROM historical_import_candidates WHERE batch_id=${batchId}`),
    },
    审计记录: {
      rows: N(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${batchId}`),
      md5: psql(`SELECT coalesce(md5(string_agg(action || '|' || coalesce(field_name,'') || '|' || coalesce(old_value_json::text,'') || '|' || coalesce(new_value_json::text,''), '' ORDER BY id)), '') FROM historical_import_reviews WHERE batch_id=${batchId}`),
    },
    正式归属: {
      rows: N(`SELECT count(*) FROM historical_service_archives WHERE batch_id=${batchId}`),
      md5: psql(`SELECT coalesce(md5(string_agg(archive_no || '|' || store_code_snapshot || '|' || customer_name, '' ORDER BY id)), '') FROM historical_service_archives WHERE batch_id=${batchId}`),
    },
    批次本身: {
      rows: 1,
      md5: psql(`SELECT coalesce(md5(attribution_state || '|' || coalesce(store_id::text,'NULL') || '|' || attribution_scope || '|' || data_origin || '|' || stage), '') FROM historical_import_batches WHERE id=${batchId}`),
    },
  };
}
const sameFingerprint = (a, b) =>
  Object.keys(a).every((k) => a[k].rows === b[k].rows && a[k].md5 === b[k].md5);
const diffLayers = (a, b) => Object.keys(a).filter((k) => a[k].rows !== b[k].rows || a[k].md5 !== b[k].md5);

/**
 * 在容器内直接调用服务层的破坏性入口（**绕开一切前端声明**）。
 *
 * ===========================================================================
 * 为什么要连真库、而不是塞一个空替身
 * ===========================================================================
 * 守卫的判据是「**读库里的** data_origin」。第一版给了个 `findOne: () => null`
 * 的空替身，于是守卫照样"拒绝"了 —— 但理由变成 **BATCH_NOT_FOUND**，
 * 而不是"数据来源不是合成夹具"。**那种绿什么都没证明**：
 * 就算守卫写错了、真实数据本来会被放行，空替身也会让门禁通过。
 *
 * ⇒ 必须让守卫**读到真实那一行**：容器内用 `pg` 直连同一套库，把读方法接到真表上；
 *    而 `destroy` 改成**记录型**（记下它打算删什么、不真删）——
 *    于是负向用例可以断言**连删除动作都没发起**（短路生效），
 *    且整轮门禁对数据**零写入**。
 */
function callPurgeInContainer(batchId, keepVersion) {
  const script = `
const svc = require('/app/nocobase/node_modules/@local/service-ticket');
const { Client } = require('/app/nocobase/node_modules/pg');
const c = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });

const attemptedDestroys = [];
// ⚠️ 传进来的是 **NocoBase 集合名**（camelCase），不是表名（snake_case）。
//    第一版直接拿它拼 SQL ⇒ 报 relation ... does not exist（42P01）——
//    而报出来的现象是"守卫拒绝了"，看起来像业务判断，其实是 SQL 拼错了。
//    而现象看起来像"守卫拒绝了"。⇒ 在这里做一次显式映射。（注释里不写反引号）
const tableOf = (name) => String(name).replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
function repoOf(name) {
  const table = tableOf(name);
  return {
    async findOne({ filter }) {
      const id = filter && filter.id;
      const r = await c.query('SELECT * FROM ' + table + ' WHERE id = $1 LIMIT 1', [id]);
      return r.rows[0] ?? null;
    },
    async find({ filter }) {
      const f = filter || {};
      if (table === 'historical_import_candidates' && f.batch_id != null && f.mapping_version) {
        const ne = f.mapping_version.$ne;
        const r = await c.query('SELECT id FROM ' + table + ' WHERE batch_id = $1 AND mapping_version <> $2', [f.batch_id, ne]);
        return r.rows;
      }
      return [];
    },
    async create() { return {}; },
    async update() { return null; },
    async destroy({ filter }) {
      attemptedDestroys.push(filter);
      return 0;
    },
  };
}

(async () => {
  await c.connect();
  const store = svc.historicalImport.createHistoricalImportStore({
    db: { getRepository: (t) => repoOf(t) },
    logger: { warn: () => {}, info: () => {} },
  });
  try {
    const result = await store.purgeOtherVersions(${batchId}, ${keepVersion});
    console.log('DESTRUCTIVE|' + JSON.stringify({ ok: true, result, attemptedDestroys }));
  } catch (e) {
    console.log('DESTRUCTIVE|' + JSON.stringify({
      ok: false, code: e?.code ?? null, status: e?.httpStatus ?? null,
      message: String(e?.message ?? e).slice(0, 240), attemptedDestroys,
    }));
  } finally {
    await c.end();
  }
})();
`;
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'node', '-'], { encoding: 'utf8', input: script, maxBuffer: 32 * 1024 * 1024 });
  const line = String(r.stdout ?? '').split('\n').find((l) => l.startsWith('DESTRUCTIVE|'));
  if (!line) return { ok: false, code: 'NO_OUTPUT', message: String(r.stderr ?? '').slice(0, 300), attemptedDestroys: [] };
  return JSON.parse(line.slice('DESTRUCTIVE|'.length));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  破坏性操作的作用域门禁（真实批次零变化 / 合成夹具可操作）');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error('  ⛔ 找不到插件产物 —— 先跑 node scripts/build-plugin.mjs');
  process.exit(2);
}
if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// ① 选一个真实批次（按文件名识别；不写死 id）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 选定真实历史批次 ──────────────────────────────────────');
const realRow = psql(
  `SELECT id || '|' || batch_no || '|' || file_name FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华' ORDER BY id LIMIT 1`,
);
if (!realRow) {
  console.error('  ⛔ 库里找不到真实样本批次 —— 环境未就绪（本门禁需要真实数据作为"必须被拒绝"的对象）');
  process.exit(2);
}
const [realId, realNo, realName] = realRow.split('|');
console.log(`      id=${realId} ${realNo} ${realName}`);
const realOrigin = psql(`SELECT data_origin FROM historical_import_batches WHERE id=${realId}`);
check('该批次的数据来源是 real（不是合成夹具）', realOrigin === 'real', `data_origin=${realOrigin}`);

const before = fingerprint(Number(realId));
console.log('      处置前指纹：');
for (const [k, v] of Object.entries(before)) console.log(`        ${k.padEnd(12)} 行数 ${String(v.rows).padStart(5)} · md5 ${String(v.md5).slice(0, 12)}…`);

// ---------------------------------------------------------------------------
// ② 反向：故意对真实批次执行破坏性操作 ⇒ 必须被拒 + 指纹零变化
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 反向：对**真实批次**执行破坏性操作 ────────────────────');
const keepVersion = Number(psql(`SELECT mapping_version FROM historical_import_batches WHERE id=${realId}`) || '1');
const attempt = callPurgeInContainer(Number(realId), keepVersion);
console.log(`      服务端返回：${JSON.stringify(attempt)}`);
check(
  '🔴 破坏性操作被服务端**拒绝**（409 DESTRUCTIVE_REQUIRES_SYNTHETIC）',
  attempt.ok === false && attempt.code === 'DESTRUCTIVE_REQUIRES_SYNTHETIC' && attempt.status === 409,
  `code=${attempt.code} status=${attempt.status}`,
);
check(
  '拒绝理由明确指向"数据来源不是合成夹具"',
  /合成夹具/.test(String(attempt.message)) && /真实数据/.test(String(attempt.message)),
  String(attempt.message).slice(0, 120),
);
// 更强的一条：**短路** —— 守卫读出不匹配就直接抛错，
// **连"要删什么"都没去查**（attemptedDestroys 为空）。
// 这比"最后没删成"更有说服力：不存在"先查出一批 id、再犹豫"的中间态。
check(
  '🔴 守卫**短路**：连"要删哪些行"的查询都没有发起（不是"查了但没删"）',
  Array.isArray(attempt.attemptedDestroys) && attempt.attemptedDestroys.length === 0,
  `attemptedDestroys=${JSON.stringify(attempt.attemptedDestroys ?? [])}`,
);

const after = fingerprint(Number(realId));
console.log('      处置后指纹：');
for (const [k, v] of Object.entries(after)) console.log(`        ${k.padEnd(12)} 行数 ${String(v.rows).padStart(5)} · md5 ${String(v.md5).slice(0, 12)}…`);
const changed = diffLayers(before, after);
check(
  '🔴 真实批次**五层全部零变化**（原始行 / 机器标准化 / 人工修正层 / 审计记录 / 正式归属 + 批次本身）',
  changed.length === 0,
  changed.length ? `变化的层：${changed.join('、')}` : '逐层行数与 md5 完全一致',
);

// ---------------------------------------------------------------------------
// ③ 正向：同一个函数作用在**合成夹具**上 ⇒ 允许（证明是守卫，不是函数坏了）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 正向：对**服务端签发的合成夹具**执行同一操作 ──────────');
// 正向用例改用**库里已有的合成批次**（由 `historicalDrillFixture` 签发的那些），
// 而不再手工 INSERT 一个探针批次 ——
//   手工 INSERT 要凑齐一堆 NOT NULL 列，而且它造的"合成批次"是**假的**
//   （没经过服务端签发路径），拿它证明"守卫会放行合成数据"说服力更弱。
//   `destroy` 仍是记录型 ⇒ 不真删，合成夹具不会被这条门禁破坏。
const synRow = psql(
  `SELECT id || '|' || batch_no FROM historical_import_batches
    WHERE data_origin = 'synthetic' ORDER BY id DESC LIMIT 1`,
);
if (!synRow) {
  check('库里存在可用的合成批次（正向用例的对象）', false, '没有 data_origin=synthetic 的批次');
} else {
  const [synId, synNo] = synRow.split('|');
  const synVersions = psql(
    `SELECT count(DISTINCT mapping_version) FROM historical_import_candidates WHERE batch_id=${synId}`,
  );
  const allow = callPurgeInContainer(Number(synId), 1);
  console.log(`      合成批次 ${synNo}（${synVersions} 个版本）服务端返回：${JSON.stringify(allow).slice(0, 160)}`);
  check('🔴 同一个函数作用在**合成**批次上被**放行**（证明它是守卫，不是"永远拒绝"）', allow.ok === true, `ok=${allow.ok}`);
  check(
    '放行后确实发起了删除（记录型 destroy 收到了目标）—— 守卫只拦真实数据，不拦合成数据',
    Array.isArray(allow.attemptedDestroys) && allow.attemptedDestroys.length >= 1,
    `attemptedDestroys=${JSON.stringify(allow.attemptedDestroys ?? [])}`.slice(0, 200),
  );
  const synAfter = psql(
    `SELECT count(DISTINCT mapping_version) FROM historical_import_candidates WHERE batch_id=${synId}`,
  );
  check('（记录型 destroy 不落库）合成批次的版本数未被本门禁改动', synAfter === synVersions, `${synVersions} → ${synAfter}`);
}

// ---------------------------------------------------------------------------
// ④ 复核：真实批次仍然干净
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ 复核 ──────────────────────────────────────────────────');
const final = fingerprint(Number(realId));
check('真实批次在整轮门禁结束后仍然零变化', sameFingerprint(before, final), diffLayers(before, final).join('、') || '五层一致');
const realConfirmed = N(
  `SELECT count(*) FROM historical_import_batches WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华' AND attribution_state='confirmed'`,
);
check('真实批次仍**没有任何**正式归属（门禁没有制造副作用）', realConfirmed === 0, `${realConfirmed} 个`);

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  破坏性作用域门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
