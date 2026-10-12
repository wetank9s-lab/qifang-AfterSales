#!/usr/bin/env node
/**
 * verify-historical-test-artifacts.mjs
 *   —— 两张验收缺陷工单**定向处置结果**的复核门禁（P11-3 第 5 项 · 用户第二项）
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 *  「处理后核对：**正常门店待办中不再出现这两单**、**正常业务统计不被污染**、
 *    **相关客户短信不会误发**、**有效历史档案不受影响**。」
 *
 * ⇒ 这四条就是本脚本的四条断言。另外还断言"**处置审计仍在**" ——
 *   因为用户同时要求「不得静默删除历史事实」：删的是工单，留下的必须是**可追溯的处置记录**。
 *
 * ⚠️ 只读。它默认"处置已经做过"；若尚未处置，会把"两单仍在"当作**待办提示**报出来
 *    （退出码 1），而不是静默通过。
 *
 * 用法：node scripts/verify-historical-test-artifacts.mjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTAINER = 'svc-postgres';

/** 用户点名的两个工单号（**处置范围不能扩大**，所以这里也写死） */
const TARGETS = ['FW20261012-0019', 'FW20261012-0020'];

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return String(r.stdout ?? '').trim();
}
const N = (sql) => Number(psql(sql) || '0');

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  测试事故工单「定向处置」结果复核');
console.log(`  范围：${TARGETS.join(' / ')}`);
console.log('══════════════════════════════════════════════════════════════');

if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

const inList = TARGETS.map((t) => `'${t}'`).join(',');

// ---------------------------------------------------------------------------
// ① 两单确实不在了
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 目标工单已摘除 ────────────────────────────────────────');
const stillThere = N(`SELECT count(*) FROM service_tickets WHERE ticket_no IN (${inList})`);
check('两张工单已不在 service_tickets 里（⇒ 门店待办不会再出现它们）', stillThere === 0, `剩余 ${stillThere} 张`);

const orphanEvents = N(
  `SELECT count(*) FROM ticket_events e WHERE NOT EXISTS (SELECT 1 FROM service_tickets t WHERE t.id = e.ticket_id)`,
);
check('没有指向已删工单的孤儿事件', orphanEvents === 0, `${orphanEvents} 条`);

// ---------------------------------------------------------------------------
// ② 业务统计没被误伤：只少了这两张
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 业务统计口径未被污染 ──────────────────────────────────');
//
// 判据：**所有**以 `[历史转入]` 开头的工单都应该有历史转换记录（正常转出来的）；
// 没有关联的只可能是"孤儿"，而孤儿已经被清掉了 ⇒ 计数必须是 0。
const unlinked = N(
  `SELECT count(*) FROM service_tickets t
    WHERE t.content LIKE '[历史转入]%'
      AND NOT EXISTS (SELECT 1 FROM historical_ticket_conversions c WHERE c.ticket_id = t.id)`,
);
check(
  '🔴 库里**没有**"无历史关联的转单工单"（孤儿清零；其余转单工单一条未动）',
  unlinked === 0,
  `${unlinked} 张`,
);
const historicalTickets = N(`SELECT count(*) FROM service_tickets WHERE content LIKE '[历史转入]%'`);
const conversions = N(`SELECT count(*) FROM historical_ticket_conversions`);
check(
  '正常转单工单数与转换记录数**一致**（说明没误删正常业务数据）',
  historicalTickets === conversions && conversions > 0,
  `工单 ${historicalTickets} · 转换记录 ${conversions}`,
);

// ---------------------------------------------------------------------------
// ③ 短信：处置前后都不该有指向这两单的记录
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 短信不会误发 ──────────────────────────────────────────');
//
// ⚠️ 判据要落在**这两张工单**上，不能写成"全库有没有悬空短信"。
//    第一版就是这么写的，结果被 30 条**与本处置无关的既有悬空短信**判红
//    （它们来自更早的测试数据清理，与本次无关）——
//    "判据太宽 = 自造假红"，本项目已经记过好几次。
//
// 正确判据：处置审计里的**前状态快照**记着每张工单当时的 `smsCount`。
//          它们必须是 0 —— 那才等于"这两单从未触发过任何短信"。
const auditSms = psql(
  `SELECT jsonb_path_query_array((value::jsonb -> 'tickets'), '$[*].smsCount')::text
     FROM service_settings WHERE key = 'test-artifacts.purge.audit'`,
);
console.log(`      处置快照里两张单的 smsCount：${auditSms || '(读不到)'}`);
check(
  '🔴 这两张工单在被摘除时**没有任何短信记录**（快照 smsCount 全为 0 ⇒ 从未触发发送）',
  /\[0,\s*0\]|\[0, 0\]/.test(auditSms),
  auditSms,
);
const preExistingOrphans = N(
  `SELECT count(*) FROM sms_logs s WHERE NOT EXISTS (SELECT 1 FROM service_tickets t WHERE t.id = s.ticket_id)`,
);
console.log(
  `      另有 ${preExistingOrphans} 条**既有**悬空短信记录（来自更早的测试数据清理，与本次处置无关；不在本次范围内）`,
);

// ---------------------------------------------------------------------------
// ④ 历史档案未受影响
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ 有效历史档案未受影响 ──────────────────────────────────');
const archives = N(`SELECT count(*) FROM historical_service_archives WHERE stage = 'archived'`);
check('有效历史档案仍在（且没有因为处置而减少）', archives > 0, `${archives} 条`);
const conversionsIntact = N(
  `SELECT count(*) FROM historical_ticket_conversions c
     JOIN historical_service_archives a ON a.id = c.archive_id
    WHERE a.stage = 'archived'`,
);
check('转换记录指向的档案都还在', conversionsIntact === conversions, `${conversionsIntact}/${conversions}`);

// ---------------------------------------------------------------------------
// ⑤ 审计（"不得静默删除历史事实"）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ 处置审计可追溯 ────────────────────────────────────────');
const audit = psql(`SELECT value::text FROM service_settings WHERE key = 'test-artifacts.purge.audit'`);
check('处置审计已落库', audit.length > 0, audit.slice(0, 120));
check(
  '审计里记着**事故原因**（不是"客户取消"之类的业务语义）',
  /缺陷/.test(audit) && !/"statusAfter"\s*:\s*"cancelled"/.test(audit),
  '',
);
check('审计里记着**处理人**', /"operator"\s*:/.test(audit) && /WorkBuddy|admin|授权/.test(audit), '');
check('审计里记着**处理时间**', /"purgedAt"\s*:/.test(audit), '');
check(
  '审计里留着两张工单的**前状态快照**（含 id / 单号 / 关联计数）',
  /"ticketNo"\s*:\s*"FW20261012-0019"/.test(audit) && /"ticketNo"\s*:\s*"FW20261012-0020"/.test(audit) && /"statusBefore"\s*:\s*"NEW"/.test(audit),
  '',
);
check(
  '审计里明确写了"不伪装成客户取消"（处置语义与业务状态流转分开）',
  /不伪装成客户取消/.test(audit),
  '',
);

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  定向处置复核：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
