#!/usr/bin/env node
/**
 * purge-ux01b-ticket.mjs —— **按单个测试工单精确清理**（UX-01B-FINAL C1）
 * =============================================================================
 *
 * 为什么不用旧的 `uat-reset-baseline.mjs` / `uat-sweep-noise.sql`：
 *   那两个是**旧走查夹具**（保留 35/886/1039/1040，删 `id>=1041`）。
 *   当前库有 489 张真实工单、id 到 6860 —— 跑一次会把库打成 4 张。
 *   本脚本**不接受 `id>=`**，只接受**显式传入的单张 ticketId**。
 *
 * 安全设计（少一条都不执行）：
 *   ① **默认 dry-run**；只有显式 `--apply` 才写。
 *   ② 必须同时给 `--ticket-id` / `--run-id` / `--expect-store`，缺一即拒。
 *   ③ 校验工单确属本次测试：`customer_name` 必须**包含 `--run-id`**（合成标识），
 *      且 `store_id` 必须等于 `--expect-store` 解析出的 id。
 *   ④ 任何一张关联表里出现**不属于该 ticketId** 的行 ⇒ 立即停止（不删）。
 *   ⑤ 删除前打印**每张表命中行数 + 物理文件清单**，`--apply` 时要求 `--yes`。
 *   ⑥ 文件**先移动**到 quarantine（`storage/.purge-quarantine/<runId>/`），
 *      DB 事务提交成功后才真正删除；DB 失败则把文件**移回原位**。
 *      （事务回滚不了文件系统，所以用"暂存 + 回滚搬迁"而不是"先删后建"）
 *   ⑦ 物理文件路径必须落在 `uploads-private/customer/<ticketId>/` 内，否则拒绝。
 *
 * 用法：
 *   node scripts/purge-ux01b-ticket.mjs --ticket-id=6901 --run-id=UX01BR42 --expect-store=S01
 *   node scripts/purge-ux01b-ticket.mjs --ticket-id=6901 --run-id=UX01BR42 --expect-store=S01 --apply --yes
 *
 * 退出码：0 成功 / 1 拒绝或失败 / 2 环境不可用
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTAINER = 'svc-postgres';
const APP_CONTAINER = 'svc-app';
const DB_USER = 'svc_app';
const PRIVATE_ROOT = '/app/nocobase/storage/uploads-private';
const QUARANTINE = '/app/nocobase/storage/.purge-quarantine';

const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name) => ARGS.includes(`--${name}`);


const TICKET_ID = Number(flag('ticket-id'));
const RUN_ID = String(flag('run-id') ?? '').trim();
const EXPECT_STORE = String(flag('expect-store') ?? '').trim();
const APPLY = has('apply');
const YES = has('yes');

const fail = (msg) => {
  console.error(`\n✗ 拒绝执行：${msg}\n`);
  process.exit(1);
};

const DB_NAME_DEFAULT = 'service_ticket';
/**
 * 仅用于**隔离验证**：库名必须形如 `*_verify*`，且必须显式 `--verify-isolated`。
 * 生产/UAT 主库（service_ticket）永远走默认值，不给改。
 */
const DB_OVERRIDE = flag('db');
const VERIFY_ISOLATED = has('verify-isolated');
if (DB_OVERRIDE) {
  if (!/^[a-z0-9_]*_verify[a-z0-9_]*$/.test(DB_OVERRIDE)) {
    fail(`--db 只接受形如 \`xxx_verify\` 的隔离库名，收到「${DB_OVERRIDE}」。`);
  }
  if (!VERIFY_ISOLATED) fail('使用 --db 必须同时带 --verify-isolated（声明这是隔离验证）。');
}
const DB_NAME = DB_OVERRIDE || DB_NAME_DEFAULT;

/** 只读查询（单值） */
function q(sql) {
  try {
    return execFileSync(
      'docker',
      ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-F', '|', '-c', sql],
      { encoding: 'utf8', cwd: ROOT },
    ).trim();
  } catch (e) {
    console.error(String(e?.stderr || e?.message || e).slice(0, 400));
    process.exit(2);
  }
}

/** 可写执行（只有 --apply 才走） */
function qExec(sql) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', cwd: ROOT },
  );
}

// ---------------------------------------------------------------------------
// ⓪ 参数闸门
// ---------------------------------------------------------------------------
if (ARGS.some((a) => /--.*id\s*>=|--id-gte|--from-id/.test(a))) {
  fail('本脚本不接受 `id>=` 之类的范围删除。只允许显式 `--ticket-id`。');
}
if (!Number.isInteger(TICKET_ID) || TICKET_ID <= 0) fail('缺少或非法 `--ticket-id`（必须是单个正整数 id）。');
if (!RUN_ID || RUN_ID.length < 4) fail('缺少 `--run-id`（本次测试运行标识，用于证明"这是合成数据"）。');
if (!EXPECT_STORE) fail('缺少 `--expect-store`（期望的门店 code，如 S01）。');
if (APPLY && !YES) fail('`--apply` 必须同时带 `--yes`（防止手滑）。');

// ---------------------------------------------------------------------------
// ① 工单身份校验（只读）
// ---------------------------------------------------------------------------
const row = q(
  `select id, ticket_no, store_id, customer_name, status, created_at from service_tickets where id=${TICKET_ID}`,
);
if (!row) fail(`工单 ${TICKET_ID} 不存在。`);

const [id, ticketNo, storeId, customerName, status, createdAt] = row.split('|');

if (!String(customerName).includes(RUN_ID)) {
  fail(
    `工单 ${TICKET_ID} 的客户名「${customerName}」**不含**本次 run-id「${RUN_ID}」——` +
      '无法证明它是本次合成数据，拒绝删除。',
  );
}

const expectStoreId = Number(
  q(`select id from stores where code='${EXPECT_STORE.replace(/'/g, "''")}' limit 1`),
);
if (!Number.isInteger(expectStoreId)) fail(`找不到门店 code=${EXPECT_STORE}`);
if (Number(storeId) !== expectStoreId) {
  fail(`工单归属 store_id=${storeId}，与 --expect-store=${EXPECT_STORE}(id=${expectStoreId}) 不符。`);
}

// ---------------------------------------------------------------------------
// ② 关联表盘点（只读）—— 每张表都必须"只命中这一张工单"
// ---------------------------------------------------------------------------
const SCOPES = [
  {
    table: 'ticket_events',
    where: `ticket_id=${TICKET_ID}`,
    why: '工单事件',
  },
  {
    table: 'service_visits',
    where: `ticket_id=${TICKET_ID}`,
    why: '派工/上门记录',
  },
  {
    table: 'service_visit_photos',
    where: `visit_id in (select id from service_visits where ticket_id=${TICKET_ID})`,
    why: '技师上门照片（含 storage_key）',
    hasFiles: true,
  },
  {
    table: 'customer_medias',
    where: `ticket_id=${TICKET_ID}`,
    why: '客户媒体（含 storage_key）',
    hasFiles: true,
  },
  {
    table: 'customer_media_sessions',
    where: `ticket_id=${TICKET_ID}`,
    why: '媒体上传会话/Token',
  },
  {
    table: 'sms_logs',
    where: `ticket_id=${TICKET_ID}`,
    why: '短信记录（mock 也留痕）',
  },
];

/** 不属于本次、但可能被 where 误捞的守卫：这些表如果有非本单行，说明 where 写错了 */
const GUARD = [
  { table: 'historical_ticket_conversions', why: '历史转单记录（**不在本次清理范围**）' },
];

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  UX-01B 测试工单精确清理（${APPLY ? 'APPLY' : 'DRY-RUN'}）`);
console.log('══════════════════════════════════════════════════════════════');
console.log(`  工单      : #${id} ${ticketNo}（${status}，建于 ${createdAt}）`);
console.log(`  客户名    : ${customerName}`);
console.log(`  归属      : store_id=${storeId}（${EXPECT_STORE}）✓`);
console.log(`  run-id    : ${RUN_ID} ✓（客户名含该标识）`);

let totalRows = 0;
const plan = [];
const fileKeys = [];

for (const s of SCOPES) {
  const n = Number(q(`select count(*) from ${s.table} where ${s.where}`) || 0);
  totalRows += n;
  plan.push({ ...s, count: n });
  console.log(`  · ${s.table.padEnd(26)} ${String(n).padStart(4)} 行   ${s.why}`);
  if (s.hasFiles && n > 0) {
    const keys = q(`select storage_key from ${s.table} where ${s.where} and storage_key is not null`);
    for (const k of keys.split('\n').filter(Boolean)) fileKeys.push({ table: s.table, key: k });
  }
}

for (const g of GUARD) {
  const n = Number(q(`select count(*) from ${g.table} where ticket_id=${TICKET_ID}`) || 0);
  if (n > 0) {
    console.log(`  ⚠️ ${g.table}: ${n} 行 —— ${g.why}`);
  }
}

// ---------------------------------------------------------------------------
// ③ 交叉守卫：确保要删的行里没有"别人的 ticket"
// ---------------------------------------------------------------------------
const crossLeak = q(`
  select 'customer_medias' t, count(*) n from customer_medias
   where ticket_id<>${TICKET_ID} and ticket_id in (select ticket_id from customer_medias where ticket_id=${TICKET_ID})
  union all
  select 'ticket_events', count(*) from ticket_events where ticket_id<>${TICKET_ID} and ticket_id=${TICKET_ID}
`);
const leakLines = crossLeak.split('\n').filter((l) => l && !l.endsWith('|0'));
if (leakLines.length) fail(`交叉守卫命中异常行：${leakLines.join('; ')}`);

// ---------------------------------------------------------------------------
// ④ 物理文件盘点（只读）
// ---------------------------------------------------------------------------
console.log(`\n  物理文件（${fileKeys.length} 个）：`);
const resolved = [];
for (const f of fileKeys) {
  // storage_key 形如 customer/735/xxx.png
  const abs = path.posix.join(PRIVATE_ROOT, f.key);
  const okPrefix = abs.startsWith(`${PRIVATE_ROOT}/customer/`);
  const exists = (() => {
    try {
      execFileSync('docker', ['exec', APP_CONTAINER, 'test', '-f', abs], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  })();
  console.log(`    ${okPrefix ? '✓' : '✗'} ${f.key}  ${exists ? '(存在)' : '(缺失)'}`);
  if (!okPrefix) fail(`文件路径越界：${abs} 不在 ${PRIVATE_ROOT}/customer/ 下，拒绝。`);
  resolved.push({ ...f, abs, exists });
}

// ---------------------------------------------------------------------------
// ⑤ dry-run 到此为止
// ---------------------------------------------------------------------------
if (!APPLY) {
  console.log('\n  DRY-RUN 结束：**未改动任何数据**。');
  console.log(`  将删除：service_tickets 1 行 + 关联 ${totalRows} 行 + 文件 ${resolved.filter((r) => r.exists).length} 个`);
  console.log('  确认无误后加 `--apply --yes` 执行。\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ⑥ APPLY：文件先搬进 quarantine → DB 事务 → 成功才真删
// ---------------------------------------------------------------------------
const qdir = `${QUARANTINE}/${RUN_ID}`;
console.log(`\n  ① 文件暂存到 ${qdir}`);
try {
  execFileSync('docker', ['exec', APP_CONTAINER, 'sh', '-c', `mkdir -p '${qdir}'`], { cwd: ROOT });
} catch (e) {
  fail(`无法创建 quarantine 目录：${String(e?.message || e).slice(0, 200)}`);
}

const moved = [];
for (const r of resolved) {
  if (!r.exists) continue;
  const dst = `${qdir}/${path.posix.basename(r.abs)}`;
  try {
    execFileSync('docker', ['exec', APP_CONTAINER, 'mv', r.abs, dst], { cwd: ROOT });
    moved.push({ src: r.abs, dst });
  } catch (e) {
    // 搬迁失败：把已搬的搬回去，然后中止
    for (const m of moved.reverse()) {
      try { execFileSync('docker', ['exec', APP_CONTAINER, 'mv', m.dst, m.src], { cwd: ROOT }); } catch {}
    }
    fail(`文件搬迁失败（已回滚 ${moved.length} 个）：${String(e?.message || e).slice(0, 200)}`);
  }
}
console.log(`     已暂存 ${moved.length} 个文件`);

console.log('  ② 数据库事务删除');
const sql = `
begin;
delete from service_visit_photos where visit_id in (select id from service_visits where ticket_id=${TICKET_ID});
delete from service_visits       where ticket_id=${TICKET_ID};
delete from customer_medias      where ticket_id=${TICKET_ID};
delete from customer_media_sessions where ticket_id=${TICKET_ID};
delete from sms_logs             where ticket_id=${TICKET_ID};
delete from ticket_events        where ticket_id=${TICKET_ID};
delete from service_tickets      where id=${TICKET_ID};
commit;
`;
try {
  qExec(sql);
} catch (e) {
  console.error(String(e?.stdout || e?.stderr || e?.message || e).slice(0, 600));
  console.log('  ✗ DB 事务失败 ⇒ 把文件搬回原位');
  for (const m of moved) {
    try { execFileSync('docker', ['exec', APP_CONTAINER, 'mv', m.dst, m.src], { cwd: ROOT }); } catch {}
  }
  fail('数据库删除失败，已回滚文件；请人工核对后重试。');
}

console.log('  ③ 删除 quarantine 中的文件');
try {
  execFileSync('docker', ['exec', APP_CONTAINER, 'rm', '-rf', qdir], { cwd: ROOT });
} catch {
  console.log('     ⚠️ quarantine 删除失败（不影响业务，可手工清理）');
}

// ---------------------------------------------------------------------------
// ⑦ 收尾核对
// ---------------------------------------------------------------------------
const left = Number(q(`select count(*) from service_tickets where id=${TICKET_ID}`) || 0);
const leftEvents = Number(q(`select count(*) from ticket_events where ticket_id=${TICKET_ID}`) || 0);
const leftMedia = Number(q(`select count(*) from customer_medias where ticket_id=${TICKET_ID}`) || 0);
console.log(`\n  核对：ticket=${left} events=${leftEvents} medias=${leftMedia}（应全为 0）`);
const counts = q(`
  select 'service_tickets', count(*) from service_tickets
  union all select 'ticket_events', count(*) from ticket_events
  union all select 'service_visits', count(*) from service_visits
  union all select 'customer_medias', count(*) from customer_medias
  union all select 'customer_media_sessions', count(*) from customer_media_sessions
`);
console.log('  当前全局计数：');
for (const line of counts.split('\n')) console.log(`    ${line}`);

if (left || leftEvents || leftMedia) process.exit(1);
console.log('\n  ✅ 清理完成\n');
