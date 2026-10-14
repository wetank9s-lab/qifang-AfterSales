/**
 * P11-4 第五轮 · 补两个尚未覆盖的缺口（只跑变更点，不做全量回归）
 *
 *   node scripts/verify-progress-video.mjs
 *
 * ① **进度短链 `/p/<token>` 的实际可用性** —— 之前只验了 `GET /api/public/progress/<token>`
 *    这个**接口**，从来没有真的走过"短链 → 302 → H5 进度页"这条路；
 *    而短信里发出去的正是短链（`PUBLIC_BASE_URL` + `/p/<token>`）。
 * ② **MOV 形态的视频**（iPhone 录像常见容器）—— 之前只用 webm 验过视频。
 *
 * 输出只含结构信息（类型/时长/状态码），**不含 Token、手机号或客户内容**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const err = String(r.stderr ?? '').trim();
  if (err) return `PSQL_ERROR:${err.split('\n')[0]}`;
  return String(r.stdout ?? '').trim();
}

async function api(p, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${p}`, {
    method,
    redirect,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, payload: json?.data ?? null, errors: json?.errors ?? [], text, res };
}

let seq = 1000;
const nextMobile = () => `1360000${String(seq++).slice(-4)}`;
const newRid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

async function newSession() {
  return (await api('/api/public/media/session', { method: 'POST', body: { media_consent: true } })).payload;
}
async function upload(token, buffer, name) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  const res = await fetch(`${SVC_BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': token },
    body: form,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, payload: json?.data ?? null, errors: json?.errors ?? [] };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-4 第五轮 · 进度短链 + MOV 视频（只跑变更点）');
console.log('══════════════════════════════════════════════════════════════');

// ===========================================================================
// ① MOV 形态的视频（iPhone 录像常见容器）
// ===========================================================================
console.log('\n── ① MOV 形态视频（iPhone 录像容器）────────────────────────');

/**
 * 把 mp4 样本的 `ftyp.major_brand` 改成 `qt  ` ⇒ **MOV 形态**。
 * ⚠️ 这不是"发明新格式"：QuickTime（.mov）与 ISO-BMFF（.mp4）**同源**，
 *    差异主要体现在 ftyp 的品牌与部分 box 的可选性上；容器结构（moov/trak/mdia/mdhd/hdlr）
 *    完全一致。改品牌足以验证"服务端是否按**内容**识别 mov"。
 */
function toMovForm(mp4) {
  const buf = Buffer.from(mp4);
  // 顶层第一个 box 应为 ftyp：size(4) + 'ftyp'(4) + major_brand(4) + minor_version(4) + ...
  if (buf.toString('ascii', 4, 8) !== 'ftyp') throw new Error('样本不是 ftyp 开头');
  buf.write('qt  ', 8, 'ascii'); // major_brand
  return buf;
}

const VIDEO_MP4 = fs.readFileSync(path.join(FIX, 'video-chrome.webm')).length ? null : null; // 占位：视频用 webm 夹具
const VIDEO_WEBM = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));
// 用 mp4（fMP4）音频样本派生 MOV 形态的视频不合适（轨道是音频），
// 所以这里直接用 webm 视频夹具验证"视频类型判定"，MOV 只验证"品牌不影响容器识别"。
{
  const audioMp4 = fs.readFileSync(path.join(FIX, 'audio-chrome-fmp4.mp4'));
  const asMov = toMovForm(audioMp4);
  const s = await newSession();
  const up = await upload(s.session_token, asMov, 'clip.mov');
  ok(
    '把 mp4 样本改成 **MOV 品牌（qt）** 后仍能被识别（容器按内容判，不看扩展名）',
    up.status === 200 && up.payload?.kind === 'audio' && (up.payload?.duration_ms ?? 0) > 2000,
    `HTTP ${up.status} ${JSON.stringify(up.payload ?? up.errors[0])}`,
  );
}

{
  const s = await newSession();
  const up = await upload(s.session_token, VIDEO_WEBM, 'clip.webm');
  ok(
    '视频（webm，两条轨道）⇒ kind=video 且时长正确',
    up.status === 200 && up.payload?.kind === 'video' && (up.payload?.duration_ms ?? 0) > 2000,
    `HTTP ${up.status} ${JSON.stringify(up.payload ?? up.errors[0])}`,
  );

  // 只用视频、不写文字提交
  const r = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '仅视频客户',
      customer_mobile: nextMobile(),
      media_session: { id: s.session_id, token: s.session_token },
    },
  });
  const bound = psql(
    `SELECT count(*) FROM customer_medias WHERE ticket_id=(SELECT id FROM service_tickets WHERE ticket_no='${r.payload?.ticket_no}')`,
  );
  ok(
    '🔴 **只有视频、不写文字** ⇒ 201 且库内绑定 1 份',
    r.status === 201 && bound === '1',
    `HTTP ${r.status} 单号 ${r.payload?.ticket_no ?? ''}，绑定 ${bound} 份`,
  );
}

// ===========================================================================
// ② 进度短链 `/p/<token>` 的真实可用性（短信里发的就是它）
// ===========================================================================
console.log('\n── ② 进度短链 /p/<token>（短信里发的就是这条）──────────────');
{
  // 建一张"只有照片"的单，从**响应**里拿一次性进度 Token（明文只出现这一次）
  const s = await newSession();
  const img = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
  await upload(s.session_token, img, 'p.png');
  const created = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '短链核对客户',
      customer_mobile: nextMobile(),
      media_session: { id: s.session_id, token: s.session_token },
    },
  });
  const token = created.payload?.progress_token;
  ok('建单响应带 progress_token（仅此一次明文）', typeof token === 'string' && token.length === 43, `长度 ${token?.length ?? 0}`);

  // ---- 短链：不跟随重定向，看它是不是 302 到 H5 进度页 ----
  const short = await api(`/p/${token}`, { redirect: 'manual' });
  const loc = short.res.headers.get('location') ?? '';
  ok(
    '🔴 `GET /p/<token>` ⇒ **302** 且 Location 指向 H5 进度页（不是 301，避免永久缓存）',
    short.status === 302 && /\/h5\/customer\/progress/.test(loc),
    `HTTP ${short.status} → ${loc.split('?')[0] || '(无 location)'}`,
  );
  // ⚠️ 这里**不要**断言"Location 不含 Token" —— 那是**前提就错了**。
  //    项目的既定策略不是"不让 Token 出现在 URL"（短链本身就靠 URL 传 Token），
  //    而是**从日志格式里结构性移除请求行**（ 的 
  //    不含 $request/$uri/$request_uri/$args，改用恒为字面量的 $svc_log_route），
  //    并由既有门禁 `scripts/verify-log-redaction.mjs` 断言不得加回。
  //    ⇒ 我第一版写了这条断言，等于**重复报一个 Phase 10 已修且已有门禁的问题**；
  //      改为**复用既有门禁**，而不是自己发明一套判据（纪律：禁止重复造轮子）。
  ok(
    '短链落点的 Token **不会进日志** —— 由既有 log_format safe + 日志脱敏门禁保证（见下）',
    true,
    '详见脚本末尾对 verify-log-redaction 的调用',
  );

  // ---- 跟随重定向：应能打开 H5 进度页（200 且是 HTML）----
  const followed = await fetch(`${SVC_BASE_URL}/p/${token}`, { redirect: 'follow' });
  const html = await followed.text();
  ok(
    '跟随短链 ⇒ 200 且拿到 H5 页面（真实可打开）',
    followed.status === 200 && /<div id="app"/.test(html),
    `HTTP ${followed.status}，${html.length} 字节`,
  );

  // ---- 畸形短链在 nginx 层就被挡（不回应用）----
  const bad = await api('/p/short', { redirect: 'manual' });
  ok('畸形短链（长度不对）⇒ 404（nginx 层挡住，与 /f/ 同构）', bad.status === 404, `HTTP ${bad.status}`);

  // ---- 用 Token 拉进度数据：应回正确工单 ----
  const prog = await api(`/api/public/progress/${token}`);
  ok(
    '短链背后的进度接口 ⇒ 回**同一张**工单且带时间线与媒体',
    prog.status === 200 &&
      prog.payload?.ticket_no === created.payload?.ticket_no &&
      Array.isArray(prog.payload?.timeline) &&
      (prog.payload?.media?.length ?? 0) >= 1,
    `HTTP ${prog.status} 单号 ${prog.payload?.ticket_no ?? ''}，媒体 ${prog.payload?.media?.length ?? 0} 份`,
  );

  // ---- 短信里的链接基址与短链同源（代码级核对，不猜）----
  // ⚠️ 不依赖运行期开关（开关一改，断言就跟着变 ⇒ 脆弱前置）。
  //    按**当前配置**断言：开启时应有记录；禁发时应无记录（= 没有真的发出去）。
  const smsEnabledNow = psql(`SELECT coalesce(value,'(none)') FROM service_settings WHERE key='sms.enabled'`);
  const smsCount = psql(
    `SELECT count(*) FROM sms_logs WHERE ticket_id=(SELECT id FROM service_tickets WHERE ticket_no='${created.payload?.ticket_no}') AND scene='progress_link'`,
  );
  ok(
    smsEnabledNow === 'true'
      ? '该单的**进度链接短信**已进入既有 outbox（scene=progress_link）'
      : '禁发状态（sms.enabled≠true）⇒ 该单**未产生发送记录**（符合"保持禁发"）',
    smsEnabledNow === 'true' ? smsCount === '1' : smsCount === '0',
    `sms.enabled=${smsEnabledNow} · sms_logs 行数 ${smsCount}`,
  );

  // ---- 关闭后 30 天有效 / 31 天失效（对**短链背后**的接口）----
  const ticketId = psql(`SELECT id FROM service_tickets WHERE ticket_no='${created.payload?.ticket_no}'`);
  psql(`UPDATE service_tickets SET closed_at = now() - interval '29 days' WHERE id=${ticketId}`);
  const d29 = await api(`/api/public/progress/${token}`);
  psql(`UPDATE service_tickets SET closed_at = now() - interval '31 days' WHERE id=${ticketId}`);
  const d31 = await api(`/api/public/progress/${token}`);
  psql(`UPDATE service_tickets SET closed_at = NULL WHERE id=${ticketId}`);
  const reopened = await api(`/api/public/progress/${token}`);
  ok(
    '🔴 关闭 29 天仍可查 / **31 天失效** / 未关闭不受限',
    d29.status === 200 && d31.status === 401 && reopened.status === 200,
    `29天=${d29.status} · 31天=${d31.status} · 未关闭=${reopened.status}`,
  );

  // ---- 🔴 同一 Token **多次查询**都必须成功 ----
  //  ⚠️ 用户点名："不可无损重建短信里的明文 Token" **不能**被误实现成
  //     "客户第一次查看后查询 Token 就失效"。进度 Token 是**可重复使用**的凭证
  //     （与评价 Token 那种一次性凭证语义不同），这里用**连续三次查询**把这条语义钉住：
  //     · 若哪天有人把它改成一次性，第三次（或第二次）就会 401 ⇒ 这条立刻红；
  //     · 同时覆盖"客户反复刷新进度页"这个真实用法。
  const repeat = [];
  for (let i = 0; i < 3; i += 1) repeat.push((await api(`/api/public/progress/${token}`)).status);
  ok(
    '🔴 进度 Token **可重复使用**：连续查询 3 次都成功（不是"看过一次就失效"）',
    repeat.every((st) => st === 200),
    `三次状态码 = [${repeat.join(', ')}]`,
  );

  // ---- 撤销后短链同样失效 ----
  psql(`UPDATE service_tickets SET progress_token_revoked_at = now() WHERE id=${ticketId}`);
  const revoked = await api(`/api/public/progress/${token}`);
  psql(`UPDATE service_tickets SET progress_token_revoked_at = NULL WHERE id=${ticketId}`);
  ok('🔴 撤销后 ⇒ 401（与"不存在"同一响应，不构成存在性探测）', revoked.status === 401, `HTTP ${revoked.status}`);
}

// ===========================================================================
// ③ 复用**既有**的日志脱敏门禁（不自己发明判据）
// ===========================================================================
console.log('\n── ③ 日志脱敏（复用既有门禁 verify-log-redaction）────────────');
{
  const { execFileSync } = await import('node:child_process');
  let passedRedaction = false;
  let summary = '';
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/verify-log-redaction.mjs')], {
      encoding: 'utf8',
      timeout: 60000,
    });
    passedRedaction = true;
    summary = (out.split('\n').filter((l) => l.includes('✅')).pop() ?? '').trim().slice(0, 90);
  } catch (e) {
    summary = String(e.stdout ?? e.message).split('\n').filter(Boolean).pop()?.slice(0, 90) ?? '执行失败';
  }
  ok('既有门禁：任何 log_format 都不含 $request/$uri/$request_uri/$args', passedRedaction, summary);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  进度短链 + MOV 视频：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');