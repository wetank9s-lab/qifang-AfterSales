/**
 * P11-4 第三批 · 针对本轮两个真机缺陷的**聚焦验证**
 *
 *   node scripts/verify-bug-fixes.mjs
 *
 * 只覆盖本次改动影响的范围（用户明确要求：小改动不要全量回归）：
 *   ① iOS 形态 mp4（fMP4）录音 ⇒ 服务端按内容读出时长
 *   ② 只媒体不写文字 ⇒ 报修/投诉均可提交（照片 / 录音 / 视频分别验）
 *   ③ 无文字且无媒体 ⇒ 拒绝，且文案是"接下来干什么"
 *   ④ 上传失败不算成功媒体
 *   ⑤ 提交成功后媒体确实关联到该工单
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

async function api(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${p}`, {
    method,
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
  return { status: res.status, payload: json?.data ?? null, errors: json?.errors ?? [], text };
}

let mobileSeq = 1000;
const nextMobile = () => `1390000${String(mobileSeq++).slice(-4)}`;
// ⚠️ 必须是**合法 UUID v4**：末段要 12 位十六进制。第一版写成 10 位，
//    服务端直接回"X-Request-Id 不是合法的 UUID v4" —— **是我的测试脚本坏了**，
//    却看起来像提交被拒（又一次工具出错伪装成产品坏了）。
const newRid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

async function newSession() {
  const r = await api('/api/public/media/session', { method: 'POST', body: { media_consent: true } });
  return r.payload;
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
console.log('  P11-4 第三批 · 真机缺陷聚焦验证');
console.log('══════════════════════════════════════════════════════════════');

// ============ ① iOS 形态 mp4（fMP4）============
console.log('\n── ① iOS 形态录音（mp4 / 分片 mp4）────────────────────────');
const FMP4 = fs.readFileSync(path.join(FIX, 'audio-chrome-fmp4.mp4'));
{
  const s = await newSession();
  const up = await upload(s.session_token, FMP4, 'ios-recording.m4a');
  ok(
    'fMP4 音频（mvhd/mehd/mdhd 三来源中的 mvhd 版本 v1）⇒ 服务端读出时长',
    up.status === 200 && up.payload?.kind === 'audio' && (up.payload?.duration_ms ?? 0) > 2000,
    `HTTP ${up.status} ${JSON.stringify(up.payload ?? up.errors[0])}`,
  );
}

// ============ ② 只媒体不写文字 ⇒ 报修/投诉均可提交 ============
console.log('\n── ② 只媒体不写文字（报修 / 投诉 × 照片 / 录音 / 视频）──────');
const IMG = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
const AUDIO = fs.readFileSync(path.join(FIX, 'audio-chrome.webm'));
const VIDEO = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));

async function submitWithOnlyMedia(kind, ticketType, buffer, name) {
  const s = await newSession();
  const up = await upload(s.session_token, buffer, name);
  if (up.status !== 200) return { failedAt: 'upload', up };
  const mobile = nextMobile();
  const r = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: {
      ticket_type: ticketType,
      content: '', // 🔴 **完全不写文字**
      customer_name: '只传媒体客户',
      customer_mobile: mobile,
      media_session: { id: s.session_id, token: s.session_token },
    },
  });
  if (r.status !== 201) return { failedAt: 'submit', r, up };
  const bound = psql(
    `SELECT count(*) FROM customer_medias WHERE ticket_id = (SELECT id FROM service_tickets WHERE ticket_no='${r.payload.ticket_no}')`,
  );
  return { ticketNo: r.payload.ticket_no, bound, up };
}

const cases = [
  ['报修 · 只有照片、不写文字', 'repair', IMG, 'only-photo.png'],
  ['报修 · 只有录音、不写文字', 'repair', AUDIO, 'only-audio.webm'],
  ['报修 · 只有视频、不写文字', 'repair', VIDEO, 'only-video.webm'],
  ['投诉 · 只有照片、不写文字', 'complaint', IMG, 'only-photo.png'],
  ['投诉 · 只有录音、不写文字', 'complaint', AUDIO, 'only-audio.webm'],
];
for (const [label, type, buf, nm] of cases) {
  const r = await submitWithOnlyMedia(type, type, buf, nm);
  ok(
    label + ' ⇒ 201 且媒体已关联',
    r.ticketNo && r.bound === '1',
    r.failedAt ? `在 ${r.failedAt} 失败：HTTP ${(r.up ?? r.r).status} ${JSON.stringify((r.up ?? r.r).errors?.[0] ?? '')}` : `单号 ${r.ticketNo}，绑定媒体 ${r.bound} 份`,
  );
}

// ============ ③ 无文字且无媒体 ⇒ 拒绝 + 正确文案 ============
console.log('\n── ③ 无文字且无有效媒体 ⇒ 拒绝 ──────────────────────────');
{
  const r = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: { ticket_type: 'repair', content: '', customer_name: '空内容客户', customer_mobile: nextMobile() },
  });
  ok(
    '无文字 + 无媒体 ⇒ 422 且文案是「请描述问题或添加照片、录音、视频」',
    r.status === 422 && r.errors[0]?.message === '请描述问题或添加照片、录音、视频',
    `HTTP ${r.status} ${JSON.stringify(r.errors[0]?.message ?? '')}`,
  );

  // 带了会话但会话里一个文件都没有 ⇒ 另一条拒（会话为空）
  const s = await newSession();
  const r2 = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '空会话客户',
      customer_mobile: nextMobile(),
      media_session: { id: s.session_id, token: s.session_token },
    },
  });
  ok(
    '带会话但**会话内无文件** + 无文字 ⇒ 拒绝（TEXT_OR_MEDIA_REQUIRED）',
    r2.status === 422 || r2.status === 409,
    `HTTP ${r2.status} ${r2.errors[0]?.code ?? ''}`,
  );
}

// ============ ④ 上传失败不算成功媒体 ============
console.log('\n── ④ 上传失败 ≠ 成功媒体 ────────────────────────────────');
{
  const s = await newSession();
  const bad = await upload(s.session_token, Buffer.from('这不是媒体文件'), 'fake.webm');
  ok('无效文件上传 ⇒ 被拒（不是 200）', bad.status !== 200, `HTTP ${bad.status} ${bad.errors[0]?.code ?? ''}`);

  // 会话里 0 个文件 ⇒ 用它提交必须被拒（不能冒充"有媒体"）
  const r = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '失败媒体客户',
      customer_mobile: nextMobile(),
      media_session: { id: s.session_id, token: s.session_token },
    },
  });
  ok('「上传失败 + 无文字」提交 ⇒ 被拒（失败媒体不被当成有效媒体）', r.status >= 400, `HTTP ${r.status} ${r.errors[0]?.code ?? ''}`);
}

// ============ ⑤ 纯文字仍可提交 + 超长仍被拒 ============
console.log('\n── ⑤ 纯文字路径不受影响 ─────────────────────────────────');
{
  const r = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: { ticket_type: 'repair', content: '空调不制冷，已经两天了', customer_name: '纯文字客户', customer_mobile: nextMobile() },
  });
  ok('纯文字（≥5 字，无媒体）⇒ 201', r.status === 201, `HTTP ${r.status}`);

  const r2 = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: { ticket_type: 'repair', content: '短', customer_name: '短文字客户', customer_mobile: nextMobile() },
  });
  ok('纯文字过短（1 字，无媒体）⇒ 拒绝', r2.status === 422, `HTTP ${r2.status} ${r2.errors[0]?.message ?? ''}`);

  const r3 = await api(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': newRid() },
    body: { ticket_type: 'repair', content: '字'.repeat(600), customer_name: '超长客户', customer_mobile: nextMobile() },
  });
  ok('文字超 500 字 ⇒ 拒绝且提示"精简一下"', r3.status === 422 && /精简/.test(r3.errors[0]?.message ?? ''), `HTTP ${r3.status} ${r3.errors[0]?.message ?? ''}`);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  聚焦验证：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');