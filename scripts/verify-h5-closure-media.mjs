/**
 * verify-h5-closure-media.mjs —— H5-CLOSURE-01 媒体闭环（媒体-only + 拒绝语义 + 幂等）
 *
 * 覆盖（**真实服务端 + 真实 PostgreSQL**，不是 mock）：
 *   A. 报修 media-only：仅照片 / 仅录音 / 仅视频 / 照片+录音组合 —— 文字为空也能建单；
 *   B. 投诉 media-only：仅照片 / 仅录音 —— 用投诉 DTO，不塞报修专属字段；
 *   C. 上传拒绝语义：超大 / 不支持格式 / 无会话 / 伪造会话；
 *   D. 幂等：同一 X-Request-Id + 同一媒体会话重复提交 ⇒ 不产生第二张工单；
 *   E. 清理：按 ticket_id 删干净（含 customer_medias 与磁盘文件）。
 *
 * ⚠️ 本门禁**只证明接口与库**。页面渲染（四入口、错误提示、三视口）由
 *    `verify-customer-media-ui.mjs` 与真机清单覆盖，二者不能互相冒充。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cleanupTicket, ensureFixtureJpeg } from './technician-harness.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

const psql = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();

async function paced(fn, label) {
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const r = await fn();
    if (r.status !== 429) return r;
    const wait = 5_000 * (attempt + 1);
    note('限流退避', `${label} → ${wait / 1000}s`);
    await new Promise((r2) => setTimeout(r2, wait));
  }
  throw new Error(`${label} 持续 429`);
}

async function api(p, { method = 'GET', body, headers = {} } = {}) {
  const r = await paced(
    () =>
      fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => ({ status: 0, text: async () => '' })),
    p,
  );
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, payload: json?.data ?? null, errors: json?.errors ?? [], text };
}

async function newSession() {
  const r = await api('/api/public/media/session', { method: 'POST', body: { media_consent: true } });
  if (!r.payload?.session_token) throw new Error(`建会话失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return r.payload;
}

async function upload(sessionToken, buffer, name) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  const r = await paced(
    () =>
      fetch(`${BASE}/api/public/media/upload`, {
        method: 'POST',
        headers: { 'X-Media-Session': sessionToken },
        body: form,
      }).catch(() => ({ status: 0, json: async () => null })),
    '上传媒体',
  );
  const json = await r.json().catch(() => null);
  return { status: r.status, payload: json?.data ?? null, errors: json?.errors ?? [] };
}

let mobileSeq = 300;
const nextMobile = () => `1360000${String(mobileSeq++).padStart(4, '0')}`;
const rid = () => crypto.randomUUID();

async function createTicket({ type, session, content = '', requestId, extra = {} }) {
  return api(`/api/public/tickets${storeEntryQuery('S01')}`, {
    method: 'POST',
    headers: { 'X-Request-Id': requestId ?? rid() },
    body: {
      store_code: 'S01',
      ticket_type: type,
      content,
      customer_name: 'H5CLOSURE夹具',
      customer_mobile: nextMobile(),
      privacy_agreed: true,
      ...(session ? { media_session: { id: session.session_id, token: session.session_token } } : {}),
      ...extra,
    },
  });
}

const jpg = ensureFixtureJpeg();
const audio = fs.readFileSync(path.join(FIX, 'audio-chrome-fmp4.mp4'));
const video = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));
const created = [];

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  H5-CLOSURE-01：媒体-only 提交 / 拒绝语义 / 幂等（真实接口）');
console.log('══════════════════════════════════════════════════════════════');

try {
  // ══════════════════════════════════════════════ A. 报修 media-only
  const cases = [
    { name: '仅照片', files: [['photo.jpg', jpg]], expect: { image: 1 } },
    { name: '仅录音', files: [['voice.mp4', audio]], expect: { audio: 1 } },
    { name: '仅视频', files: [['clip.webm', video]], expect: { video: 1 } },
    { name: '照片+录音组合', files: [['photo.jpg', jpg], ['voice.mp4', audio]], expect: { image: 1, audio: 1 } },
  ];

  for (const c of cases) {
    const s = await newSession();
    const ups = [];
    for (const [fname, buf] of c.files) ups.push(await upload(s.session_token, buf, fname));
    const bad = ups.filter((u) => ![200, 201].includes(u.status));
    if (bad.length) {
      check(false, `A. ${c.name}：上传成功`, JSON.stringify(bad));
      continue;
    }
    const t = await createTicket({ type: 'repair', session: s });
    const ticketNo = t.payload?.ticket_no;
    if (!ticketNo) {
      check(false, `A. ${c.name}：文字为空也能建单`, `HTTP ${t.status} ${t.text.slice(0, 160)}`);
      continue;
    }
    const id = Number(psql(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
    created.push({ ticketId: id, ticketNo });

    const kinds = psql(
      `SELECT coalesce(string_agg(media_kind, '+' ORDER BY media_kind),'') FROM customer_medias WHERE ticket_id=${id}`,
    );
    const content = psql(`SELECT coalesce(content,'') FROM service_tickets WHERE id=${id}`);
    const want = Object.entries(c.expect)
      .map(([k, n]) => (n === 1 ? k : `${k}×${n}`))
      .sort()
      .join('+');
    check([200, 201].includes(t.status), `A. ${c.name}：media-only 建单成功`, `HTTP ${t.status} ${ticketNo}`);
    check(kinds === want, `A. ${c.name}：库内绑定类型正确`, `实际=${kinds || '(空)'} 期望=${want}`);
    check(content === '', `A. ${c.name}：文字确实为空（不是被自动填了占位）`, JSON.stringify(content));
  }

  // ══════════════════════════════════════════════ B. 投诉 media-only
  {
    const s = await newSession();
    const up1 = await upload(s.session_token, jpg, 'evidence.jpg');
    const up2 = await upload(s.session_token, audio, 'complain.mp4');
    check([200, 201].includes(up1.status) && [200, 201].includes(up2.status), 'B. 投诉：媒体上传成功', `${up1.status}/${up2.status}`);

    const t = await createTicket({ type: 'complaint', session: s });
    const ticketNo = t.payload?.ticket_no;
    if (ticketNo) {
      const id = Number(psql(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
      created.push({ ticketId: id, ticketNo });
      const type = psql(`SELECT ticket_type FROM service_tickets WHERE id=${id}`);
      const kinds = psql(
        `SELECT coalesce(string_agg(media_kind,'+' ORDER BY media_kind),'') FROM customer_medias WHERE ticket_id=${id}`,
      );
      check([200, 201].includes(t.status), 'B. 投诉 media-only 建单成功（用投诉 DTO）', `HTTP ${t.status} ${ticketNo}`);
      check(type === 'complaint', 'B. 落库类型 = complaint（没被塞成 repair）', type);
      check(kinds === 'audio+image', 'B. 投诉：两类媒体都绑定', kinds);
    } else {
      check(false, 'B. 投诉 media-only 建单成功', `HTTP ${t.status} ${t.text.slice(0, 200)}`);
    }
  }

  // ══════════════════════════════════════════════ C. 拒绝语义
  {
    const s = await newSession();

    const txt = await upload(s.session_token, Buffer.from('not an image'), 'note.txt');
    check([415, 422].includes(txt.status), 'C. 不支持格式（.txt）⇒ 明确拒绝', `HTTP ${txt.status} ${JSON.stringify(txt.errors?.[0]?.code ?? '')}`);

    const big = Buffer.concat([jpg, Buffer.alloc(11 * 1024 * 1024, 0)]);
    const over = await upload(s.session_token, big, 'huge.jpg');
    check([413, 415, 422].includes(over.status), 'C. 超出大小上限 ⇒ 明确拒绝', `HTTP ${over.status} ${JSON.stringify(over.errors?.[0]?.code ?? '')}`);

    const noSession = await upload('Z'.repeat(43), jpg, 'x.jpg');
    check(noSession.status >= 400 && noSession.status < 500, 'C. 无/伪造会话 ⇒ 拒绝（不写入）', `HTTP ${noSession.status}`);

    const t = await api(`/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      body: {
        store_code: 'S01',
        ticket_type: 'repair',
        content: '伪造会话建单',
        customer_name: 'H5CLOSURE夹具',
        customer_mobile: nextMobile(),
        privacy_agreed: true,
        media_session: { id: 999999, token: 'Z'.repeat(43) },
      },
    });
    check(t.status >= 400 && t.status < 500, 'C. 伪造媒体会话建单 ⇒ 4xx（不能把材料挂到别人的单）', `HTTP ${t.status}`);
    if (t.payload?.ticket_no) {
      const id = Number(psql(`SELECT id FROM service_tickets WHERE ticket_no='${t.payload.ticket_no}'`));
      created.push({ ticketId: id, ticketNo: t.payload.ticket_no });
    }
  }

  // ══════════════════════════════════════════════ D. 幂等（重复点击）
  {
    const s = await newSession();
    await upload(s.session_token, jpg, 'dup.jpg');
    const requestId = rid();
    const body = {
      store_code: 'S01',
      ticket_type: 'repair',
      content: '幂等重复提交夹具',
      customer_name: 'H5CLOSURE夹具',
      customer_mobile: nextMobile(),
      privacy_agreed: true,
      media_session: { id: s.session_id, token: s.session_token },
    };
    const first = await api(`/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      headers: { 'X-Request-Id': requestId },
      body,
    });
    const second = await api(`/api/public/tickets${storeEntryQuery('S01')}`, {
      method: 'POST',
      headers: { 'X-Request-Id': requestId },
      body,
    });
    const no1 = first.payload?.ticket_no;
    const no2 = second.payload?.ticket_no;
    check(Boolean(no1) && no1 === no2, 'D. 同请求号重复提交 ⇒ 回放同一张工单（不重复建单）', `${no1} / ${no2}`);
    if (no1) {
      const id = Number(psql(`SELECT id FROM service_tickets WHERE ticket_no='${no1}'`));
      created.push({ ticketId: id, ticketNo: no1 });
      const cnt = Number(psql(`SELECT count(*) FROM service_tickets WHERE ticket_no='${no1}'`));
      check(cnt === 1, 'D. 库里该单号只有 1 行', String(cnt));
    }
  }
} finally {
  for (const t of created) {
    try {
      cleanupTicket(t.ticketId);
    } catch (error) {
      console.log(`  ⚠️ 清理 ${t.ticketNo} 失败：${error.message}`);
    }
  }
  const left = created.filter(
    (t) =>
      Number(psql(`SELECT count(*) FROM service_tickets WHERE id=${t.ticketId}`)) !== 0 ||
      Number(psql(`SELECT count(*) FROM customer_medias WHERE ticket_id=${t.ticketId}`)) !== 0,
  );
  check(left.length === 0, 'E. 夹具按 ID 清理干净（工单 + 客户媒体）', left.map((t) => t.ticketNo).join(',') || `共 ${created.length} 张，0 残留`);
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  H5 媒体闭环：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
