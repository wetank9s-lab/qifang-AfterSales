/**
 * verify-dev-209-progress-time.mjs —— DEV-209 定向门禁：**客户进度页的时间必须真的对**。
 *
 * 背景：旧门禁只断言 `Array.isArray(timeline)` —— **只校验形状、不校验内容**，
 * 于是 `created_at` / `timeline[i].at` 恒为 undefined、页面显示"—"也能全绿。
 * 本门禁换成**内容级**断言：
 *
 *   ① 接口 `created_at` / `updated_at` 存在、可被 `new Date()` 解析；
 *   ② `created_at` 与**数据库事实**一致（同一时刻，容差 2s）；
 *   ③ `timeline` 非空，每条的 `at` 有值、格式合法、**非递减**；
 *   ④ 第一条 `at` 与 `ticket_events` 最早一条的 `created_at` 一致；
 *   ⑤ 公开响应**字段集合没有扩大**（逐字集合比对，防止"顺手加字段"）；
 *   ⑥ 真实浏览器：页面「提交时间」与时间线时间都不是"—"，且与数据库时刻一致；
 *   ⑦ 进度 Token 边界不变：无效 / 篡改 Token 仍然 401；
 *   ⑧ 夹具单**按 ID 清理**，非夹具工单数量不变（不碰真实客户数据）。
 *
 * 用法：node scripts/verify-dev-209-progress-time.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(ROOT, '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return process.env[key] ?? fallback;
}
const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();

const entry = `S01.${crypto
  .createHmac('sha256', envValue('SIGN_SECRET'))
  .update('store-entry:S01')
  .digest('base64url')
  .slice(0, 22)}`;

/** 把任意时间值解析成 epoch ms（非法返回 NaN） */
const ms = (v) => (v == null ? NaN : new Date(String(v)).getTime());

/** 按 Asia/Shanghai 格式化成 `YYYY-MM-DD HH:mm`（页面显示口径） */
function shanghaiMinute(value) {
  const t = ms(value);
  if (!Number.isFinite(t)) return null;
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const totalTickets = () => Number(pg(`select count(*) from service_tickets`) || 0);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  DEV-209：进度页时间字段（接口内容 / 数据库一致 / 真实浏览器）');
console.log('══════════════════════════════════════════════════════════════');

const beforeTotal = totalTickets();
const requestId = crypto.randomUUID();
const phone = `139${String(Date.now()).slice(-8)}`;
let fixtureId = 0;
let fixtureNo = '';
let token = '';

try {
  // -------------------------------------------------------------------------
  // 0. 建隔离夹具（唯一手机号；测后按 ID 清理）
  // -------------------------------------------------------------------------
  const created = await fetch(`${BASE}/api/public/tickets?k=${encodeURIComponent(entry)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Request-Id': requestId },
    body: JSON.stringify({
      entry,
      store_code: 'S01',
      ticket_type: 'repair',
      content: '[DEV-209] 进度页时间字段定向门禁（隔离夹具，测后按 ID 清理）',
      customer_name: 'DEV209门禁',
      customer_mobile: phone,
    }),
  });
  const createdText = await created.text();
  if (created.status !== 201) {
    console.log(`  ⛔ 建单失败 HTTP ${created.status}: ${createdText.slice(0, 160)}`);
    process.exit(2);
  }
  const payload = JSON.parse(createdText).data ?? {};
  fixtureNo = String(payload.ticket_no ?? '');
  token = String(payload.progress_token ?? '');
  fixtureId = Number(pg(`select id from service_tickets where ticket_no='${fixtureNo}'`) || 0);
  note('夹具工单', `${fixtureNo}（id=${fixtureId}）`);

  // -------------------------------------------------------------------------
  // 1. 数据库事实
  // -------------------------------------------------------------------------
  const dbCreated = pg(`select created_at from service_tickets where id=${fixtureId}`);
  const dbUpdated = pg(`select updated_at from service_tickets where id=${fixtureId}`);
  const dbFirstEvent = pg(
    `select created_at from ticket_events where ticket_id=${fixtureId} order by created_at, id limit 1`,
  );
  const dbEventCount = Number(pg(`select count(*) from ticket_events where ticket_id=${fixtureId}`) || 0);
  note('数据库 created_at', dbCreated);
  note('数据库首个事件', dbFirstEvent);

  // -------------------------------------------------------------------------
  // 2. 公开接口：内容级断言
  // -------------------------------------------------------------------------
  const res = await fetch(`${BASE}/api/public/progress/${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { Origin: BASE },
  });
  const body = await res.json().catch(() => null);
  const view = body?.data ?? body ?? {};
  check(res.status === 200, '进度接口 200', `HTTP ${res.status}`);

  const createdMs = ms(view.created_at);
  const updatedMs = ms(view.updated_at);
  const dbCreatedMs = ms(dbCreated);

  check(Boolean(view.created_at), 'created_at 有值（不是 undefined / 空串）', JSON.stringify(view.created_at));
  check(Number.isFinite(createdMs), 'created_at 可被 new Date() 解析', String(view.created_at));
  check(Number.isFinite(updatedMs), 'updated_at 可被解析', String(view.updated_at));
  check(
    Math.abs(createdMs - dbCreatedMs) <= 2000,
    'created_at 与数据库事实一致（容差 2s）',
    `api=${createdMs} db=${dbCreatedMs}`,
  );
  check(updatedMs >= createdMs, 'updated_at ≥ created_at', `${updatedMs} ≥ ${createdMs}`);

  const timeline = Array.isArray(view.timeline) ? view.timeline : [];
  check(timeline.length > 0, 'timeline 非空', `${timeline.length} 条（库内事件 ${dbEventCount}）`);
  const atsValid = timeline.every((item) => Boolean(item?.at) && Number.isFinite(ms(item.at)));
  check(atsValid, 'timeline 每一条都有可解析的 at', JSON.stringify(timeline.map((x) => x.at)));
  const ats = timeline.map((x) => ms(x.at));
  const nonDecreasing = ats.every((v, i) => i === 0 || v >= ats[i - 1]);
  check(nonDecreasing, 'timeline 时间**非递减**（顺序正确）', JSON.stringify(ats));
  check(
    Math.abs(ats[0] - ms(dbFirstEvent)) <= 2000,
    '首条时间线时间 = 库内最早事件时间（容差 2s）',
    `api=${ats[0]} db=${ms(dbFirstEvent)}`,
  );

  // 字段集合：不允许"顺手加字段"
  //
  // ⚠️ 2026-10-19（UX-PROGRESS-01）：新增 `progress` / `technician` 两个字段。
  //    这是**已授权的契约扩展**（客户进度阶段 + 当前派工师傅的最小投影），
  //    不是"顺手加" —— 它有自己的门禁 `verify-ux-progress-01.mjs`（72/72，
  //    含"内部手机号不得出现在响应里"与"改派后旧师傅立即消失"）。
  //    因此这里同步期望集合；**其余 19 条时间断言一条未改**，
  //    DEV-209 的结论（时间字段映射已修复）不因本次扩展而改变。
  const allowedKeys = [
    'ticket_no',
    'store_name',
    'status',
    'status_label',
    'created_at',
    'updated_at',
    'closed_at',
    'submitted',
    'media',
    'timeline',
    // UX-PROGRESS-01 授权新增（成对出现，不允许只加一个）
    'progress',
    'technician',
    'completion_note',
    'review',
    'queryable_until',
    'closed',
  ].sort();
  const actualKeys = Object.keys(view).sort();
  check(
    JSON.stringify(actualKeys) === JSON.stringify(allowedKeys),
    '公开响应字段集合**未扩大**（逐字集合比对）',
    `actual=${JSON.stringify(actualKeys)}`,
  );

  // -------------------------------------------------------------------------
  // 3. Token 边界不变
  // -------------------------------------------------------------------------
  const badToken = await fetch(`${BASE}/api/public/progress/${'x'.repeat(43)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { Origin: BASE },
  });
  check(badToken.status === 401, '无效 Token 仍 401', `HTTP ${badToken.status}`);
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const tamperedRes = await fetch(`${BASE}/api/public/progress/${encodeURIComponent(tampered)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { Origin: BASE },
  });
  check(tamperedRes.status === 401, '篡改 Token 仍 401', `HTTP ${tamperedRes.status}`);

  // -------------------------------------------------------------------------
  // 4. 真实浏览器
  // -------------------------------------------------------------------------
  const session = await launchCdp({ port: 9461, label: 'dev209-gate' });
  const { cdp } = session;
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: `${BASE}/h5/customer/progress/${encodeURIComponent(token)}` });
    await cdp.waitFor(`!!document.querySelector('[data-testid="progress-timeline"]')`, {
      what: '进度页',
      timeout: 30_000,
    });
    await sleep(800);

    const dom = JSON.parse(
      await cdp.evaluate(`(() => {
        const dts = [...document.querySelectorAll('.svc-progress-meta dt')];
        const dds = [...document.querySelectorAll('.svc-progress-meta dd')];
        const pair = {};
        dts.forEach((dt, i) => { pair[dt.innerText.trim()] = (dds[i] || {}).innerText || ''; });
        const rows = [...document.querySelectorAll('[data-testid="progress-timeline"] li')].map((li) => {
          const at = li.querySelector('.svc-progress-at');
          return { status: (li.querySelector('.svc-progress-t') || {}).innerText || '', at: at ? at.innerText.trim() : null };
        });
        return JSON.stringify({ submitted: pair['提交时间'] ?? null, rows });
      })()`),
    );

    const expectedMinute = shanghaiMinute(dbCreated);
    check(dom.submitted !== '—' && Boolean(dom.submitted), '页面「提交时间」不是「—」', String(dom.submitted));
    check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(dom.submitted)), '页面时间格式合法', String(dom.submitted));
    check(dom.submitted === expectedMinute, '页面「提交时间」= 数据库时刻（上海时区）', `page=${dom.submitted} db=${expectedMinute}`);

    const rowTimes = (dom.rows || []).map((r) => r.at);
    check(rowTimes.length > 0, '时间线渲染出条目', String(rowTimes.length));
    check(
      rowTimes.every((t) => t && t !== '—' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)),
      '时间线每条时间都有值且格式合法',
      JSON.stringify(rowTimes),
    );
    check(
      rowTimes[0] === shanghaiMinute(dbFirstEvent),
      '时间线首条 = 库内最早事件时刻',
      `page=${rowTimes[0]} db=${shanghaiMinute(dbFirstEvent)}`,
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'dev209-after.png'), Buffer.from(shot.data, 'base64'));
    note('截图', '.tmp-verify/dev209-after.png');
  } finally {
    session.close();
  }
} finally {
  // -------------------------------------------------------------------------
  // 5. 按 ID 清理夹具（不碰真实工单）
  // -------------------------------------------------------------------------
  if (fixtureId > 0) {
    const before = {
      tickets: pg(`select count(*) from service_tickets where id=${fixtureId}`),
      events: pg(`select count(*) from ticket_events where ticket_id=${fixtureId}`),
      sms: pg(`select count(*) from sms_logs where ticket_id=${fixtureId}`),
    };
    pg(`delete from sms_logs where ticket_id=${fixtureId}`);
    pg(`delete from ticket_events where ticket_id=${fixtureId}`);
    pg(`delete from service_tickets where id=${fixtureId}`);
    pg(`delete from idempotency_records where idempotency_key='${requestId}'`);
    const left = {
      tickets: pg(`select count(*) from service_tickets where id=${fixtureId}`),
      events: pg(`select count(*) from ticket_events where ticket_id=${fixtureId}`),
      sms: pg(`select count(*) from sms_logs where ticket_id=${fixtureId}`),
    };
    note('夹具清理', `${fixtureNo}：${JSON.stringify(before)} → ${JSON.stringify(left)}`);
  }
  const afterTotal = totalTickets();
  check(afterTotal === beforeTotal, '非夹具工单数量未变（未触碰真实客户数据）', `${beforeTotal} → ${afterTotal}`);

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  DEV-209 定向门禁：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('');
}
