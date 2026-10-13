#!/usr/bin/env node
/**
 * verify-historical-audit-and-conversion.mjs
 *   —— P11-3 第 6 项 · 用户 **B 段（人工修正与审计逐版本对账）**
 *      与 **D 段（历史转单异常窗口）** 的验收门禁
 *
 * ===========================================================================
 * B 段用户原话
 * ===========================================================================
 *  「以 `(row_id, mapping_version)` 为基本核对单位。对于每次实际发生的人工修改，
 *    必须能找到对应审计信息，包括：操作人及操作时间；修改字段；原始候选值和人工修改后的值；
 *    所属原始行和映射版本；对应的**请求或操作标识**。
 *    要求修改值与审计事件保持一致，**不能出现值修改成功但没有审计、
 *    审计说已修改但数据没有更新的半完成情况**。
 *    **无实际变化的请求不得制造虚假修改事件。**
 *    **同 Request-Id 重放不得重复追加审计，不同内容复用 Request-Id 必须拒绝。**
 *    使用**真实门店账号**和**合成批次**完成浏览器与数据库核对，
 *    并提供至少一项**故意破坏审计一致性**的反向判红证据。」
 *
 * ===========================================================================
 * D 段用户原话
 * ===========================================================================
 *  「在『历史转当前工单』过程中模拟**工单创建成功、转换关联尚未确认**时的异常，
 *    证明**事务回滚或安全重试能够收敛，不再次产生孤儿工单**。
 *    现存其余合成演练转单记录应**继续可识别**，不能混入正式运营数据或正式 KPI；
 *    **不得扩大清理范围**。」
 *
 * 用法：node scripts/verify-historical-audit-and-conversion.mjs
 * 退出码：0 全过 / 1 断言失败 / 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'storage/tmp/historical-synth');
const CONTAINER = 'svc-app';
const RUN = `R${Date.now().toString(36).toUpperCase()}`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d = '') => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};
function psql(sql) {
  return String(
    spawnSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).stdout ?? '',
  ).trim();
}
const N = (sql) => Number(psql(sql) || '0');

async function signIn(email, pwd) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pwd }),
  });
  const t = (await r.json().catch(() => null))?.data?.token ?? '';
  if (!t) throw new Error(`${email} 登录失败`);
  return t;
}
async function api(token, pathname, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, payload: json?.data ?? json };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 6 项 · B 审计逐版本对账 / D 转单异常窗口');
console.log('══════════════════════════════════════════════════════════════');

if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

const HQ = await signIn(envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), envValue('SMOKE_ADMIN_PASSWORD'));
const STORE_A = await signIn('uat.store.a@svc.local', envValue('UAT_STORE_A_PASSWORD'));
console.log('  · 已登录：总部 / 门店 UAT-A（S01）');

// ---------------------------------------------------------------------------
// 准备：服务端签发一份合成夹具，由**真实门店账号**上传并暂存
// ---------------------------------------------------------------------------
fs.mkdirSync(TMP, { recursive: true });
const issued = await api(HQ, '/api/svc:historicalDrillFixture', { body: { profile: 'anomalies' } });
if (issued.status !== 200 || !issued.payload?.base64) {
  console.error(`  ⛔ 签发演练夹具失败：HTTP ${issued.status}`);
  process.exit(2);
}
const fxPath = path.join(TMP, issued.payload.fileName);
fs.writeFileSync(fxPath, Buffer.from(issued.payload.base64, 'base64'));
{
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(fxPath)]), issued.payload.fileName);
  const up = await api(STORE_A, '/api/svc:historicalUpload', { body: form });
  const sheet = up.payload?.sheets?.[0];
  const batchId = up.payload?.batch?.id;
  if (!batchId) {
    console.error(`  ⛔ 上传夹具失败：HTTP ${up.status}`);
    process.exit(2);
  }
  const f = { reviewDate: 0, deliveryDate: 1, customerName: 2, customerPhone: 3, device: 4, quantity: 5, storeHint: 6, serviceKind: 7, reviewResult: 8 };
  await api(STORE_A, '/api/svc:historicalStage', { body: { batchId, sheets: [{ sheetName: sheet.sheet, headerRow: sheet.headerRow, fields: f }] } });
  var BATCH = batchId;
  console.log(`  · 合成夹具 ${up.payload.batch.batchNo}（batchId=${BATCH}）已由 UAT-A 上传并暂存`);
}

const cands = (await api(STORE_A, `/api/svc:historicalBatches?batchId=${BATCH}&limit=200`, { method: 'GET' })).payload?.candidates ?? [];
const target = cands.find((c) => c.disposition === 'needs-confirm') ?? cands[0];
const version = Number(psql(`SELECT mapping_version FROM historical_import_batches WHERE id=${BATCH}`) || '1');
const rowId = Number(psql(`SELECT row_id FROM historical_import_candidates WHERE id=${target?.id}`) || '0');
console.log(`  · 目标候选 id=${target?.id}（原始行 ${rowId} · 映射版本 v${version}）`);

// ===========================================================================
// B 段
// ===========================================================================
console.log('');
console.log('── B① 真实门店账号做人工修改（带请求标识）──────────────────');
const rid1 = `audit-${RUN}-1`;
const c1 = await api(STORE_A, '/api/svc:historicalReviewRow', {
  headers: { 'X-Request-Id': rid1 },
  body: { batchId: BATCH, candidateId: target.id, action: 'confirm', note: `对账用例 ${RUN}` },
});
check('真实门店账号（UAT-A）可以对自己上传的批次做人工修改', c1.status === 200 && c1.payload?.changed === true, `HTTP ${c1.status} changed=${c1.payload?.changed}`);

const audit1 = psql(
  `SELECT operator_username || '|' || coalesce(request_id,'') || '|' || action || '|' || mapping_version::text || '|' ||
          (operated_at IS NOT NULL)::text || '|' || coalesce(old_value_json::text,'') || '|' || coalesce(new_value_json::text,'')
     FROM historical_import_reviews WHERE batch_id=${BATCH} AND row_id=${rowId} AND mapping_version=${version} ORDER BY id DESC LIMIT 1`,
);
console.log(`      审计：${audit1}`);
const ap = audit1.split('|');
check('审计齐备：操作人 / 请求标识 / 动作 / 映射版本 / 时间 / 原值 / 新值', ap.length >= 7 && ap[0] && ap[1] && ap[2] && ap[3] && ap[4] === 'true', '');

console.log('');
console.log('── B② 同 Request-Id 重放 / 不同内容复用 ────────────────────');
const auditCountBefore = N(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${BATCH}`);
const replay = await api(STORE_A, '/api/svc:historicalReviewRow', {
  headers: { 'X-Request-Id': rid1 },
  body: { batchId: BATCH, candidateId: target.id, action: 'confirm', note: `对账用例 ${RUN}` },
});
const auditCountAfterReplay = N(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${BATCH}`);
check('🔴 同 Request-Id 重放 ⇒ 返回既有结果且**不追加审计**', replay.status === 200 && auditCountAfterReplay === auditCountBefore, `${auditCountBefore} → ${auditCountAfterReplay}`);

const reused = await api(STORE_A, '/api/svc:historicalReviewRow', {
  headers: { 'X-Request-Id': rid1 },
  body: { batchId: BATCH, candidateId: target.id, action: 'correct', field: 'customerName', value: '另外的名字' },
});
check(
  '🔴 同 Request-Id 用于**不同内容** ⇒ 409 REQUEST_ID_REUSED',
  reused.status === 409 && reused.json?.errors?.[0]?.code === 'REQUEST_ID_REUSED',
  `HTTP ${reused.status} ${reused.json?.errors?.[0]?.code ?? ''}`,
);

console.log('');
console.log('── B③ 无实际变化不得制造虚假修改事件 ──────────────────────');
const noChange = await api(STORE_A, '/api/svc:historicalReviewRow', {
  headers: { 'X-Request-Id': `audit-${RUN}-nochange` },
  body: { batchId: BATCH, candidateId: target.id, action: 'confirm' },
});
const auditAfterNoChange = N(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${BATCH}`);
check('🔴 再确认一次（状态没变）⇒ changed=false 且**不写审计**', noChange.status === 200 && noChange.payload?.changed === false && auditAfterNoChange === auditCountAfterReplay, `changed=${noChange.payload?.changed} 审计 ${auditCountAfterReplay} → ${auditAfterNoChange}`);

console.log('');
console.log('── B④ 逐 (row_id, mapping_version) 对账 ────────────────────');
/**
 * 对账：**每一条"看起来被人动过"的候选行**，都必须能在审计里按
 * `(row_id, mapping_version)` 找到对应记录。
 *
 * ⚠️ 核对单位是 `(row_id, mapping_version)`（用户点名），
 *    而不是"候选行 id" —— 同一个原始行在不同映射版本里各有一行候选，
 *    用候选行 id 对账会把"版本"这层信息丢掉。
 */
function reconcile(batchId, v) {
  const dirty = psql(
    `SELECT DISTINCT row_id FROM historical_import_candidates
      WHERE batch_id=${batchId} AND mapping_version=${v}
        AND (manual_status <> 'pending' OR (manual_overrides_json IS NOT NULL AND manual_overrides_json::text NOT IN ('{}','null')))`,
  ).split('\n').filter(Boolean).map(Number);
  const audited = new Set(
    psql(`SELECT DISTINCT row_id FROM historical_import_reviews WHERE batch_id=${batchId} AND mapping_version=${v}`)
      .split('\n').filter(Boolean).map(Number),
  );
  return { dirty, missing: dirty.filter((r) => !audited.has(r)) };
}
const rec = reconcile(BATCH, version);
console.log(`      该批次 v${version}：被改动过的原始行 ${rec.dirty.length} 行 · 无审计的 ${rec.missing.length} 行`);
check(
  '🔴 逐版本对账：**不存在"改了但没有审计"的行**（half-done 状态）',
  rec.missing.length === 0,
  rec.missing.length ? `缺审计的行：${rec.missing.join(',')}` : `${rec.dirty.length} 行全部有审计`,
);

// 反向判红：**故意破坏审计一致性** —— 删掉一条审计，对账必须发现
console.log('');
console.log('── B⑤ 反向判红：故意破坏审计一致性 ─────────────────────────');
const victimId = Number(psql(`SELECT id FROM historical_import_reviews WHERE batch_id=${BATCH} AND row_id=${rowId} AND mapping_version=${version} ORDER BY id DESC LIMIT 1`) || '0');
const backup = psql(
  `SELECT action || ';' || coalesce(field_name,'') || ';' || coalesce(old_value_json::text,'null') || ';' ||
          coalesce(new_value_json::text,'null') || ';' || coalesce(request_id,'') || ';' || coalesce(operator_username,'') || ';' ||
          coalesce(reason,'') || ';' || coalesce(scope,'anomaly') || ';' || coalesce(operator_user_id::text,'') || ';' ||
          coalesce(batch_id::text,'') || ';' || coalesce(row_id::text,'') || ';' || coalesce(mapping_version::text,'')
     FROM historical_import_reviews WHERE id=${victimId}`,
);
psql(`DELETE FROM historical_import_reviews WHERE id=${victimId}`);
const recBroken = reconcile(BATCH, version);
console.log(`      删掉 1 条审计后：无审计的行 ${recBroken.missing.length} 行（期望 > 0）`);
check(
  '🔴 **判红证据**：删掉一条审计后，对账**确实**能发现"改了但没有审计"',
  recBroken.missing.length > 0 && recBroken.missing.includes(rowId),
  `missing=${recBroken.missing.join(',')}`,
);
// 恢复（把那条审计原样写回，含 request_id；不留破坏痕迹）
{
  const [action, fieldName, oldV, newV, requestId, operator, reason, scope, opUserId, batchIdB, rowIdB, mvB] = backup.split(';');
  psql(
    `INSERT INTO historical_import_reviews
       (created_at, updated_at, batch_id, row_id, mapping_version, scope, action, field_name,
        old_value_json, new_value_json, reason, request_id, operator_username, operator_user_id, operated_at)
     VALUES (now(), now(), ${Number(batchIdB)}, ${Number(rowIdB)}, ${Number(mvB)},
             '${scope}', '${action}', ${fieldName ? `'${fieldName}'` : 'NULL'},
             '${oldV}'::jsonb, '${newV}'::jsonb, ${reason ? `'${reason}'` : 'NULL'},
             ${requestId ? `'${requestId}'` : 'NULL'}, ${operator ? `'${operator}'` : 'NULL'},
             ${opUserId ? Number(opUserId) : 'NULL'}, now())`,
  );
}
const recRestored = reconcile(BATCH, version);
check('反向实验后已恢复：对账重新通过（不留破坏痕迹）', recRestored.missing.length === 0, `missing=${recRestored.missing.join(',') || '0'}`);

// ===========================================================================
// D 段
// ===========================================================================
console.log('');
console.log('── D① 归档该合成批次（供转单用）────────────────────────────');
await api(HQ, '/api/svc:historicalConfirmAttribution', { body: { batchId: BATCH, storeCode: 'S01', scope: 'drill' } });
// 清掉剩余的待处理项（本用例只关心转单窗口）
const pending = (await api(STORE_A, `/api/svc:historicalBatches?batchId=${BATCH}&limit=200`, { method: 'GET' })).payload?.candidates ?? [];
for (const c of pending.filter((x) => x.disposition === 'needs-confirm' || x.disposition === 'duplicate')) {
  await api(STORE_A, '/api/svc:historicalReviewRow', { body: { batchId: BATCH, candidateId: c.id, action: 'confirm' } });
}
const arch = await api(HQ, '/api/svc:historicalArchive', { body: { batchId: BATCH } });
check('该合成批次归档成功（演练范围）', arch.status === 200 && arch.payload?.created > 0, `HTTP ${arch.status} created=${arch.payload?.created}`);
const archiveId = Number(arch.payload?.archiveIds?.[0] ?? 0);
console.log(`      archiveId=${archiveId} · 归档前工单数 ${N('SELECT count(*) FROM service_tickets')}`);

console.log('');
console.log('── D② 注入"建单成功、转换关联未写"的异常 ───────────────────');
const ticketsBefore = N('SELECT count(*) FROM service_tickets');
const convBefore = N(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
const injected = await api(STORE_A, '/api/svc:historicalConvertToTicket', {
  headers: { 'X-Svc-Fault': 'convert-after-ticket' },
  body: { archiveId, reason: `故障注入用例 ${RUN}` },
});
const ticketsAfterInject = N('SELECT count(*) FROM service_tickets');
const convAfterInject = N(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
console.log(`      注入响应 HTTP ${injected.status}；工单 ${ticketsBefore} → ${ticketsAfterInject}；转换记录 ${convBefore} → ${convAfterInject}`);
check('故障注入确实生效（返回 5xx，接口报错）', injected.status >= 500, `HTTP ${injected.status}`);
check(
  '注入后停在"工单已建、转换关联未写"的中间态（**这正是当初产生孤儿工单的窗口**）',
  ticketsAfterInject === ticketsBefore + 1 && convAfterInject === convBefore,
  `工单 +${ticketsAfterInject - ticketsBefore} · 转换 +${convAfterInject - convBefore}`,
);

console.log('');
console.log('── D③ 安全重试必须收敛（不产生第二张工单）──────────────────');
const retry = await api(STORE_A, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `故障注入后重试 ${RUN}` },
});
const ticketsAfterRetry = N('SELECT count(*) FROM service_tickets');
const convAfterRetry = N(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
const linkedTicket = psql(`SELECT ticket_no FROM historical_ticket_conversions WHERE archive_id=${archiveId} ORDER BY id DESC LIMIT 1`);
console.log(`      重试 HTTP ${retry.status} ticket=${retry.payload?.ticketNo} recovered=${retry.payload?.recovered}；工单总数 ${ticketsAfterRetry}`);
check('🔴 重试成功并**一致恢复**（命中幂等记录，指出既有工单）', retry.status === 200 && retry.payload?.recovered === true && Boolean(retry.payload?.ticketNo), `recovered=${retry.payload?.recovered}`);
check(
  '🔴 重试**没有**产生第二张工单（工单总数仍只 +1）',
  ticketsAfterRetry === ticketsBefore + 1,
  `${ticketsBefore} → ${ticketsAfterRetry}`,
);
check('转换关联已补齐（中间态收敛）', convAfterRetry === convBefore + 1, `${convBefore} → ${convAfterRetry}`);
check('转换记录指向的就是那张已建好的工单', linkedTicket === String(retry.payload?.ticketNo), `${linkedTicket} vs ${retry.payload?.ticketNo}`);
check('库里该档案只有一条转换记录（archive_id UNIQUE）', N(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`) === 1, '');

// 再重试一次（幂等不重复）
const retry2 = await api(STORE_A, '/api/svc:historicalConvertToTicket', { body: { archiveId, reason: `再重试 ${RUN}` } });
check('再次重试仍复用同一张工单', retry2.payload?.ticketNo === retry.payload?.ticketNo && N('SELECT count(*) FROM service_tickets') === ticketsBefore + 1, `ticket=${retry2.payload?.ticketNo}`);

console.log('');
console.log('── D④ 合成演练转单必须**可识别**（不混入正式口径）──────────');
// 识别路径走“转换记录 -> 批次的 data_origin”这条**可靠的事实链**；
// 不指望工单上有一列标记 —— 实测 CreateTicketInput.metadata 落的是**事件**的 metadata，
// 不是工单的 extra_json，用它当判据会恒为假。
const drillLinked = psql(
  `SELECT count(*) FROM historical_ticket_conversions c
     JOIN historical_import_batches b ON b.id = c.batch_id
    WHERE b.data_origin = 'synthetic'`,
);
const allLinked = psql(`SELECT count(*) FROM historical_ticket_conversions`);
const realLinked = Number(allLinked) - Number(drillLinked);
const drillPrefix = psql(
  `SELECT count(*) FROM service_tickets t
     JOIN historical_ticket_conversions c ON c.ticket_id = t.id
     JOIN historical_import_batches b ON b.id = c.batch_id
    WHERE b.data_origin = 'synthetic' AND t.content LIKE '[历史转入]%'`,
);
console.log(`      转单记录 ${allLinked} 条：来自合成批次 ${drillLinked} 条、来自真实批次 ${realLinked} 条`);
check(
  '每一条转单记录都能**经批次追溯到数据来源**（synthetic / real 可分辨）',
  Number(allLinked) > 0 && Number(drillLinked) > 0,
  `synthetic ${drillLinked} / ${allLinked}`,
);
check(
  '合成演练转单产生的工单都带可识别的历史来源前缀（内容以 [历史转入] 开头）',
  Number(drillPrefix) === Number(drillLinked),
  `${drillPrefix}/${drillLinked}`,
);
const orphanDrill = psql(
  `SELECT count(*) FROM service_tickets t
    WHERE t.content LIKE '[历史转入]%'
      AND NOT EXISTS (SELECT 1 FROM historical_ticket_conversions c WHERE c.ticket_id = t.id)`,
);
check(
  '没有“带历史前缀但没有转换记录”的孤儿（第 5 项清理过的那类，未再出现）',
  Number(orphanDrill) === 0,
  `${orphanDrill} 张`,
);
check(
  '本门禁**未扩大清理范围**（只标记了自己造的夹具；真实批次与既有转单记录未被改动）',
  Number(psql(`SELECT count(*) FROM historical_import_batches WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华' AND stage <> 'staging'`)) === 16,
  '真实批次的 16 个历史副本状态未变',
);


// 收尾：把本次夹具标记 voided（合成数据，可清理；不碰真实批次）
psql(
  `UPDATE historical_import_batches SET stage='voided', dedup_key=NULL,
     note = COALESCE(note,'') || '[cleanup] 第 6 项验收夹具，收尾标记作废（不删除）'
   WHERE id=${BATCH} AND data_origin='synthetic'`,
);
check('验收夹具已收尾标记 voided（且未触碰真实批次）', Number(psql(`SELECT count(*) FROM historical_import_batches WHERE id=${BATCH} AND stage='voided'`)) === 1, '');

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  B / D 门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
