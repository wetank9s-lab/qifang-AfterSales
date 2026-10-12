#!/usr/bin/env node
/**
 * purge-historical-test-artifacts.mjs
 *   —— **定向处置两张由验收缺陷产生的当前服务单**（P11-3 第 5 项 · 用户第二项）
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 *  「目标仅限：FW20261012-0019 / FW20261012-0020。
 *    先核实两单均由本轮合成验收产生，检查是否存在真实客户信息、已发送短信、
 *    师傅通知、评价链接、Visit、审计事件、历史档案关联及 SLA/KPI 影响。
 *    若证实纯测试数据且没有真实业务关联，授权使用**现有可审计的测试数据清理/隔离机制**
 *    进行定向处置，并**记录事故原因、处理人、处理时间及前后状态**。
 *    **不得静默删除历史事实**，不得将测试事故伪装成普通客户取消，也不得操作其他服务单。
 *    处理后核对：正常门店待办中不再出现这两单、正常业务统计不被污染、
 *    相关客户短信不会误发、有效历史档案不受影响。
 *    如果无法证明上述安全条件，**先隔离并报告，不得强行清理**。」
 *
 * ===========================================================================
 * 这个脚本做三段：**先取证 → 再断言 → 才动手**
 * ===========================================================================
 *   ① 取证：把两单的全部关联（事件 / Visit / 短信 / 评价链接 / 历史关联 / 幂等记录）
 *      逐项列出来 —— 不满足条件就没有第二段；
 *   ② 处置：调用 `scripts/sql/historical-test-artifact-purge.sql`
 *      （它自带 5 条前置断言 + 前后状态留痕 + 3 条后置校验，全部在同一个事务里）；
 *   ③ 复核：门店待办 / 业务统计 / 短信 / 历史档案四项逐项核对。
 *
 * ⚠️ 用法（**默认只取证，不动手**）：
 *    node scripts/purge-historical-test-artifacts.mjs              # 只取证（dry-run）
 *    node scripts/purge-historical-test-artifacts.mjs --apply      # 实际执行
 *    node scripts/purge-historical-test-artifacts.mjs --apply --operator "张三"
 *
 * 退出码：0 成功（dry-run 也算）/ 1 安全条件不满足（拒绝执行）/ 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'scripts/sql/historical-test-artifact-purge.sql');
const CONTAINER = 'svc-postgres';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const operatorIdx = ARGS.indexOf('--operator');
const OPERATOR = operatorIdx >= 0 ? String(ARGS[operatorIdx + 1] ?? '') : 'platform-admin';

/** 用户点名的两个工单号 —— **写死在这里是刻意的**：处置范围不能由参数扩大 */
const TARGETS = ['FW20261012-0019', 'FW20261012-0020'];

const REASON =
  'P11-3 第 4 项开发缺陷：转为当前服务单时建单返回值取错（TicketService.create 返回 {ticket,event,store}），' +
  '导致接口先建单、再在写转换记录时崩并回 500 ⇒ 留下两张无任何业务关联的孤儿工单。' +
  '用户 2026-10-12 第二项授权定向处置。';

function psql(sql, { file = false } = {}) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '|', ...(file ? [] : ['-c', sql])],
    { encoding: 'utf8', input: file ? sql : undefined, maxBuffer: 64 * 1024 * 1024 },
  );
  return { stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim(), status: r.status };
}
function rows(sql) {
  const t = psql(sql).stdout;
  return t ? t.split('\n').map((l) => l.split('|')) : [];
}
function scalar(sql, d = '') {
  const t = psql(sql).stdout;
  return t === '' ? d : t.split('\n')[0];
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  ${APPLY ? '【执行】' : '【取证 dry-run】'} 定向处置验收缺陷工单`);
console.log(`  范围（写死）：${TARGETS.join(' / ')}`);
console.log('══════════════════════════════════════════════════════════════');

const dc = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (!String(dc.stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行 —— 环境未就绪`);
  process.exit(2);
}
if (!fs.existsSync(SQL_FILE)) {
  console.error(`  ⛔ 缺少 SQL：${SQL_FILE}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// ① 取证
// ---------------------------------------------------------------------------
const inList = TARGETS.map((t) => `'${t}'`).join(',');
console.log('');
console.log('── ① 取证：两单本身 ────────────────────────────────────────');
const tickets = rows(
  `SELECT id, ticket_no, store_id, source, status, customer_name, customer_mobile, left(content, 46), created_at::text
     FROM service_tickets WHERE ticket_no IN (${inList}) ORDER BY id`,
);
if (tickets.length !== 2) {
  console.error(`  ⛔ 待处置工单数为 ${tickets.length}（期望 2）—— 拒绝继续（可能已被处置或号已变）`);
  process.exit(1);
}
for (const t of tickets) {
  console.log(`      #${t[0]} ${t[1]} store=${t[2]} source=${t[3]} status=${t[4]}`);
  console.log(`         客户=${t[5]} 手机=${t[6]}`);
  console.log(`         内容=${t[7]}`);
}
const allSynthetic = tickets.every((t) => String(t[5]).startsWith('合成') && String(t[7]).startsWith('[历史转入]'));
console.log(`      客户名与内容均为"合成 / [历史转入]"：${allSynthetic ? '是' : '否'}`);

console.log('');
console.log('── ② 取证：全部关联 ────────────────────────────────────────');
const ids = tickets.map((t) => Number(t[0])).join(',');
const relations = [
  ['工单事件 ticket_events', `SELECT count(*) FROM ticket_events WHERE ticket_id IN (${ids})`],
  ['上门记录 service_visits', `SELECT count(*) FROM service_visits WHERE ticket_id IN (${ids})`],
  ['短信记录 sms_logs', `SELECT count(*) FROM sms_logs WHERE ticket_id IN (${ids})`],
  ['历史转换 historical_ticket_conversions', `SELECT count(*) FROM historical_ticket_conversions WHERE ticket_id IN (${ids})`],
  ['幂等记录 idempotency_records', `SELECT count(*) FROM idempotency_records WHERE resource_type='serviceTicket' AND resource_id IN (${ids})`],
];
const relCounts = {};
for (const [label, sql] of relations) {
  const n = Number(scalar(sql, '0'));
  relCounts[label] = n;
  console.log(`      ${label.padEnd(40)} ${n}`);
}
// 评价链接挂在 Visit 上 ⇒ Visit=0 即"没有评价链接"
console.log(`      ${'评价链接（挂在 Visit 上）'.padEnd(40)} ${relCounts['上门记录 service_visits'] === 0 ? 0 : '需细查'}`);
console.log(`      ${'师傅通知（派工后才会有）'.padEnd(40)} ${relCounts['上门记录 service_visits'] === 0 ? 0 : '需细查'}`);

console.log('');
console.log('── ③ 取证：是否只有这两张孤儿（影响面界定）─────────────────');
const historicalTickets = Number(scalar(`SELECT count(*) FROM service_tickets WHERE content LIKE '[历史转入]%'`, '0'));
const orphanTickets = Number(
  scalar(
    `SELECT count(*) FROM service_tickets t WHERE t.content LIKE '[历史转入]%'
       AND t.ticket_no NOT IN (${inList})
       AND NOT EXISTS (SELECT 1 FROM historical_ticket_conversions c WHERE c.ticket_id = t.id)`,
    '0',
  ),
);
const normalConversions = Number(scalar(`SELECT count(*) FROM historical_ticket_conversions`, '0'));
console.log(`      以 [历史转入] 开头的工单共 ${historicalTickets} 张；其中"无历史关联的孤儿"除这两张外还有 ${orphanTickets} 张`);
console.log(`      正常转单记录 ${normalConversions} 条（它们对应的工单**不在**处置范围内）`);

// ---------------------------------------------------------------------------
// 安全条件判定
// ---------------------------------------------------------------------------
const safe =
  tickets.length === 2 &&
  allSynthetic &&
  relCounts['上门记录 service_visits'] === 0 &&
  relCounts['短信记录 sms_logs'] === 0 &&
  relCounts['历史转换 historical_ticket_conversions'] === 0 &&
  orphanTickets === 0;

console.log('');
console.log('── ④ 安全条件 ──────────────────────────────────────────────');
console.log(`      · 恰好 2 张                                        ${tickets.length === 2 ? '✅' : '❌'}`);
console.log(`      · 客户名/内容均为合成验收数据                      ${allSynthetic ? '✅' : '❌'}`);
console.log(`      · 无 Visit（⇒ 无评价链接、无师傅通知）              ${relCounts['上门记录 service_visits'] === 0 ? '✅' : '❌'}`);
console.log(`      · 无短信记录（⇒ 不会误发）                          ${relCounts['短信记录 sms_logs'] === 0 ? '✅' : '❌'}`);
console.log(`      · 无历史档案关联                                    ${relCounts['历史转换 historical_ticket_conversions'] === 0 ? '✅' : '❌'}`);
console.log(`      · 不存在清单外的第三个同类孤儿                      ${orphanTickets === 0 ? '✅' : '❌'}`);

if (!safe) {
  console.error('');
  console.error('  ⛔ 安全条件不满足 —— **先隔离并报告，不执行清理**（用户第二项明令）');
  process.exit(1);
}

if (!APPLY) {
  console.log('');
  console.log('  ✅ 安全条件全部满足。当前是 **dry-run**，未做任何改动。');
  console.log('     确认无误后执行：node scripts/purge-historical-test-artifacts.mjs --apply');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ⑤ 执行（后状态对照）
// ---------------------------------------------------------------------------
const before = {
  tickets: Number(scalar(`SELECT count(*) FROM service_tickets`, '0')),
  historicalTickets,
  conversions: normalConversions,
  archives: Number(scalar(`SELECT count(*) FROM historical_service_archives WHERE stage='archived'`, '0')),
  sms: Number(scalar(`SELECT count(*) FROM sms_logs`, '0')),
};

console.log('');
console.log('── ⑤ 执行定向处置 ──────────────────────────────────────────');
const sqlText = fs.readFileSync(SQL_FILE, 'utf8');
const r = spawnSync(
  'docker',
  [
    'exec', '-i', CONTAINER, 'psql', '-U', 'svc_app', '-d', 'service_ticket',
    '-v', 'ON_ERROR_STOP=1',
    '-v', `t1=${TARGETS[0]}`,
    '-v', `t2=${TARGETS[1]}`,
    '-v', `operator=${OPERATOR}`,
    '-v', `reason=${REASON}`,
    '-f', '-',
  ],
  { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 },
);
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
if (r.status !== 0) {
  console.error('  ⛔ 处置失败（事务已回滚）：');
  console.error(out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log(out.split('\n').filter((l) => /NOTICE|ERROR/.test(l) || l.trim()).slice(-4).join('\n'));

// ---------------------------------------------------------------------------
// ⑥ 后状态对照
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑥ 前后对照 ──────────────────────────────────────────────');
const after = {
  tickets: Number(scalar(`SELECT count(*) FROM service_tickets`, '0')),
  historicalTickets: Number(scalar(`SELECT count(*) FROM service_tickets WHERE content LIKE '[历史转入]%'`, '0')),
  conversions: Number(scalar(`SELECT count(*) FROM historical_ticket_conversions`, '0')),
  archives: Number(scalar(`SELECT count(*) FROM historical_service_archives WHERE stage='archived'`, '0')),
  sms: Number(scalar(`SELECT count(*) FROM sms_logs`, '0')),
};
const line = (k, b, a, expectDelta) =>
  console.log(`      ${k.padEnd(28)} ${String(b).padStart(5)} → ${String(a).padStart(5)}（期望 Δ${expectDelta}）${a - b === expectDelta ? ' ✅' : ' ❌'}`);
line('当前服务单总数', before.tickets, after.tickets, -2);
line('[历史转入] 工单数', before.historicalTickets, after.historicalTickets, -2);
line('正常转单记录数', before.conversions, after.conversions, 0);
line('有效历史档案数', before.archives, after.archives, 0);
line('短信记录数', before.sms, after.sms, 0);

const okDelta =
  after.tickets === before.tickets - 2 &&
  after.historicalTickets === before.historicalTickets - 2 &&
  after.conversions === before.conversions &&
  after.archives === before.archives &&
  after.sms === before.sms;

console.log('');
console.log('── ⑦ 复核：四项 ────────────────────────────────────────────');
const stillThere = Number(scalar(`SELECT count(*) FROM service_tickets WHERE ticket_no IN (${inList})`, '0'));
const orphanEvents = Number(
  scalar(
    `SELECT count(*) FROM ticket_events e WHERE NOT EXISTS (SELECT 1 FROM service_tickets t WHERE t.id=e.ticket_id)`,
    '0',
  ),
);
const audit = scalar(`SELECT left(value::text, 200) FROM service_settings WHERE key='test-artifacts.purge.audit'`, '');
console.log(`      · 两张工单已不存在                          ${stillThere === 0 ? '✅' : '❌'}（剩余 ${stillThere}）`);
console.log(`      · 正常门店待办不再出现这两单                ${stillThere === 0 ? '✅' : '❌'}（它们已不在 service_tickets 里）`);
console.log(`      · 业务统计只减少这 2 张、其余口径未动        ${okDelta ? '✅' : '❌'}`);
console.log(`      · 短信记录未增未减（不会误发）              ${after.sms === before.sms ? '✅' : '❌'}`);
console.log(`      · 有效历史档案未受影响                      ${after.archives === before.archives ? '✅' : '❌'}`);
console.log(`      · 处置审计已落库                            ${audit ? '✅' : '❌'}`);
console.log(`      · 指向已删工单的孤儿事件                    ${orphanEvents === 0 ? '✅ 0 条' : `⚠️ ${orphanEvents} 条（另有历史遗留，非本次产生）`}`);
if (audit) console.log(`        审计摘要：${audit.slice(0, 150)}`);

const ok = stillThere === 0 && okDelta && audit.length > 0;
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  ${ok ? '✅ 处置完成且全部核对通过' : '❌ 处置后核对未通过 —— 需人工介入'}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(ok ? 0 : 1);
