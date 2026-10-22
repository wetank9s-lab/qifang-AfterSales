#!/usr/bin/env node
/**
 * verify-ux-media-01.mjs —— 客户媒体在**售后后台**可查看（UX-MEDIA-01 门禁）
 *
 * ===========================================================================
 * 为什么需要一支专门的"端到端"门禁
 * ===========================================================================
 * 这个 P0 的原始现象是"客户上传了，后台看不到"。它有三种完全不同的坏法：
 *   ① **数据完整性**：会话没绑工单 / 媒体行丢了 / 私有文件不存在；
 *   ② **接口缺失**：后台根本没有取媒体的接口（本次的真实根因）；
 *   ③ **UI 缺失**：接口有数据，但抽屉里没有区块 / 取不到 blob / 播放器打不开。
 * 只验其中一层就会出现"修了 UI 但文件早没了"或"SQL 里能看到行就宣布修好"。
 * ⇒ 本脚本按 ①②③ 三层分别取证，任何一层不成立都不给通过。
 *
 * ===========================================================================
 * 真实样本 + 受控合成样本（用户 §一 明令）
 * ===========================================================================
 *   · `FW20261017-0012`（真实工单）：只读了它的数据，**没有**改任何字段/附件；
 *     实测它含 **2 张图片 + 1 段录音，没有视频**。
 *   · 视频用**受控合成工单**补验：走真实匿名链路（会话 → 上传 → 建单），
 *     视频由浏览器 `MediaRecorder` 现场录制（真 WebM，不是伪造字节）。
 *     🔴 2026-10-17 起夹具**每次运行自建、跑完按 id 清理**（用户裁决：不保留长期夹具）；
 *        若要人工保留一张，用 `UX_MEDIA_FIXTURE_TICKET=<id>` 显式指定（那种情况不清理）。
 *
 * ===========================================================================
 * 安全判据（用户 §三 的红线，逐条对应）
 * ===========================================================================
 *   · 未登录：401；viewer：403（**不**因本次修复开放媒体）；
 *   · 门店账号：本店 200 / 跨店 404（与"不存在"同形，不给存在性信号）；
 *   · 响应**不含** storage_key / 原始文件名 / 上传 IP —— 只回白名单元数据；
 *   · 文件响应：库中 MIME + nosniff + private,no-store + Range 206 / 416；
 *   · 不出现任何"公开 URL / 长期凭证"（全部走登录态 fetch → Blob）。
 *
 * 用法：node scripts/verify-ux-media-01.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, psql, psqlRows, sleep } from './verify-store-ui-primary-action.mjs';
// 夹具清理复用共享实现（按 id 精确删除，含客户媒体行/会话/私有文件）
import { cleanupTicket } from './technician-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const REAL_TICKET_NO = 'FW20261017-0012';
const ORIGIN = new URL(SVC_BASE_URL).origin;

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 落到 process.env */
  }
  return process.env[key] ?? fallback;
}

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

async function login(emailKey, emailFallback) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: envValue(emailKey, emailFallback), password: envValue(emailKey.replace('_EMAIL', '_PASSWORD')) }),
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`${emailFallback} 登录失败 HTTP ${r.status} ${text.slice(0, 120)}`);
  return JSON.parse(text).data.token;
}

/** 直接读容器内私有文件（只用于核对"文件真的在、类型真的对"） */
function containerSh(cmd) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'sh', '-c', cmd], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

const MAGIC = {
  'audio/webm': '1a45dfa3',
  'video/webm': '1a45dfa3',
  'image/png': '89504e47',
  'image/jpeg': 'ffd8ff',
  'video/mp4': '00000018',
};

async function apiGet(token, pathname, headers = {}) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* noop */
    }
    return { status: r.status, json, headers: r.headers, text };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, headers: r.headers, ct };
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-MEDIA-01：客户媒体 → 售后后台可查看');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · 入口：${SVC_BASE_URL}`);

// ---- 环境自检 -------------------------------------------------------------
const realRows = psqlRows(
  `select id, ticket_no, store_id, status from service_tickets where ticket_no='${REAL_TICKET_NO}'`,
);
if (realRows.length === 0) {
  console.log(`  ⛔ 找不到真实工单 ${REAL_TICKET_NO} —— 环境未就绪`);
  process.exit(2);
}
const real = { id: Number(realRows[0][0]), no: realRows[0][1], storeId: Number(realRows[0][2]) };
note('真实工单', `${real.no} · id=${real.id} · store=${real.storeId}`);


/**
 * 视频夹具：**每次运行自建、跑完精确清理**（用户 2026-10-17 裁决：不保留长期夹具）。
 *
 * 为什么不再复用一张固定工单：
 *   那张 `FW20261017-0015` 曾被门店主门禁的"客户取消"用例改成 CANCELLED ——
 *   跨脚本共享一张可写夹具，等于把隔离交给运气。
 * ⇒ 本门禁自己造：浏览器 `MediaRecorder` 录真 WebM → 匿名会话 → 上传 → 建单，
 *   结束后 `cleanupTicket()` 按 id 删除（含媒体行/会话/私有文件/事件/短信）。
 *   可用 `UX_MEDIA_FIXTURE_TICKET=<id>` 显式指定一张**人工登记**的夹具；
 *   那种情况不清理（由人负责）。
 */
let synthetic = null;
let fixtureProvisioned = false;

async function provisionVideoFixture(hqToken) {
  // ① 真视频：浏览器录 1.5s canvas（不是伪造字节）
  const session = await launchCdp({ label: 'media-fixture' });
  let rec = null;
  try {
    const { cdp } = session;
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/` });
    await sleep(1200);
    rec = await cdp.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      const stream = c.captureStream(12);
      const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { mr.onstop = r; });
      mr.start();
      const t0 = performance.now();
      await new Promise((res) => {
        const tick = () => {
          const el = performance.now() - t0;
          ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = '#22cc88'; ctx.font = '28px sans-serif';
          ctx.fillText('UX-MEDIA-01 ' + Math.round(el), 16, 120);
          if (el < 1500) requestAnimationFrame(tick); else res();
        };
        tick();
      });
      mr.stop();
      await stopped;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return { size: blob.size, b64: btoa(bin) };
    })()`, 120000);
  } finally {
    session.close();
  }
  const videoBuf = Buffer.from(rec?.b64 ?? '', 'base64');
  if (!(videoBuf.length > 1000)) throw new Error('视频录制失败（字节数不足）');

  // ② 门店入口（受控签名）
  const links = await apiGet(hqToken, 'svc:storeEntryLinks');
  const entry = (links.json?.data?.items ?? []).find((x) => x.code === 'S01')?.entry;
  if (!entry) throw new Error('取不到 S01 门店入口');

  // ③ 匿名会话 → 上传 → 建单（与客户 H5 完全同一条链路）
  const sessRes = await fetch(`${SVC_BASE_URL}/api/public/media/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ media_consent: true }),
  });
  const sess = await sessRes.json().catch(() => null);
  if (sessRes.status !== 200) throw new Error(`媒体会话创建失败 HTTP ${sessRes.status}`);

  const fd = new FormData();
  fd.append('file', new Blob([videoBuf], { type: 'video/webm' }), 'ux-media-01-fixture.webm');
  const up = await fetch(`${SVC_BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': sess.data.session_token, Origin: ORIGIN },
    body: fd,
  });
  if (up.status !== 200) throw new Error(`视频上传失败 HTTP ${up.status}`);

  const tk = await fetch(`${SVC_BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      k: entry,
      ticket_type: 'repair',
      content: '合成测试：客户上传视频（UX-MEDIA-01 门禁自建，跑完按 id 清理）',
      customer_name: 'UX-MEDIA-01夹具',
      customer_mobile: '13800000002',
      media_session: { id: sess.data.session_id, token: sess.data.session_token },
    }),
  });
  const tj = await tk.json().catch(() => null);
  const ticketNo = tj?.data?.ticket_no;
  if (!(tk.status === 200 || tk.status === 201) || !ticketNo) {
    throw new Error(`建单失败 HTTP ${tk.status} ${JSON.stringify(tj).slice(0, 160)}`);
  }
  const rows = psqlRows(`select id, store_id from service_tickets where ticket_no='${ticketNo}'`);
  return { id: Number(rows[0][0]), no: ticketNo, storeId: Number(rows[0][1]) };
}

// ---- A. 数据完整性（只读）-------------------------------------------------
console.log('');
console.log('  A. 数据完整性（只读；不改任何字段/附件）');
{
  const sessions = psqlRows(
    `select id, status, ticket_id, upload_count from customer_media_sessions where ticket_id=${real.id}`,
  );
  check(sessions.length === 1, '真实工单恰好 1 个媒体会话', `实际 ${sessions.length}`);
  if (sessions.length === 1) {
    const [sid, status, ticketId, uploadCount] = sessions[0];
    check(status === 'bound', '会话已绑定（status=bound）', status);
    check(Number(ticketId) === real.id, '会话 ticket_id 指向该工单', ticketId);
    check(Number(uploadCount) > 0, '会话记录了上传数', uploadCount);
  }

  const media = psqlRows(
    `select id, session_id, ticket_id, media_kind, storage_key, mime, size from customer_medias where ticket_id=${real.id} order by id`,
  );
  const kinds = media.map((r) => r[3]);
  note('真实工单媒体', media.map((r) => `${r[3]}#${r[0]}`).join(' / ') || '(无)');
  check(media.length > 0, '媒体行存在', `${media.length} 条`);
  check(kinds.includes('image'), '含图片（至少 1 张）', kinds.join(','));
  check(media.every((r) => Number(r[2]) === real.id), '每条媒体的 ticket_id 都指向该工单');

  let fileOk = 0;
  for (const [id, sessionId, , kind, storageKey, mime, size] of media) {
    const abs = `${envValue('UPLOAD_PRIVATE_DIR', '/app/nocobase/storage/uploads-private')}/${storageKey}`;
    let statSize = 0;
    let head = '';
    try {
      statSize = Number(containerSh(`stat -c %s '${abs}'`));
      head = containerSh(`od -An -tx1 -N4 '${abs}' | tr -d ' \\n'`);
    } catch {
      check(false, `媒体 ${id} 的私有文件存在`, abs);
      continue;
    }
    const magicOk = Boolean(MAGIC[mime]) && head.startsWith(MAGIC[mime]);
    const sizeOk = Math.abs(statSize - Number(size)) <= 1;
    check(sizeOk, `媒体 ${id}（${kind}/${mime}）文件大小与库一致`, `库 ${size} / 盘 ${statSize}`);
    check(magicOk, `媒体 ${id} 的文件头与 MIME 相符`, `head=${head} mime=${mime}`);
    if (sizeOk && magicOk) fileOk += 1;
  }
  check(fileOk === media.length, '所有媒体文件真实存在且类型正确', `${fileOk}/${media.length}`);

}

// ---- B. 接口边界 ----------------------------------------------------------
console.log('');
console.log('  B. 接口边界（登录态 + 角色 + 数据范围 + Range）');

const tokens = {};
try {
  tokens.hqAdmin = await login('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
  tokens.hq = await login('UAT_HQ_EMAIL', 'uat.hq@svc.local');
  tokens.viewer = await login('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local');
  tokens.storeA = await login('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
  tokens.storeB = await login('UAT_STORE_B_EMAIL', 'uat.store.b@svc.local');
} catch (error) {
  console.log(`  ⛔ ${String(error?.message ?? error)}`);
  process.exit(2);
}

// 视频夹具：显式指定 or 自建（跑完清理）
const presetFixture = Number(process.env.UX_MEDIA_FIXTURE_TICKET || 0);
if (presetFixture) {
  const rows = psqlRows(`select id, ticket_no, store_id from service_tickets where id=${presetFixture}`);
  if (rows.length === 0) {
    console.log(`  ⛔ UX_MEDIA_FIXTURE_TICKET=${presetFixture} 在库里不存在 —— 环境未就绪`);
    process.exit(2);
  }
  synthetic = { id: Number(rows[0][0]), no: rows[0][1], storeId: Number(rows[0][2]) };
  note('视频夹具（人工指定，不清理）', `${synthetic.no} · id=${synthetic.id}`);
} else {
  try {
    synthetic = await provisionVideoFixture(tokens.hqAdmin);
    fixtureProvisioned = true;
    note('视频夹具（本次自建，跑完清理）', `${synthetic.no} · id=${synthetic.id}`);
  } catch (error) {
    console.log(`  ⛔ 自建视频夹具失败：${String(error?.message ?? error).slice(0, 200)}`);
    process.exit(2);
  }
}
{
  const synMedia = psqlRows(
    `select id, media_kind, mime, size from customer_medias where ticket_id=${synthetic.id}`,
  );
  check(synMedia.length === 1 && synMedia[0][1] === 'video', '视频夹具含 1 段视频', JSON.stringify(synMedia));
}

const LIST_FIELDS = ['durationMs', 'height', 'id', 'kind', 'mime', 'size', 'uploadedAt', 'width'];
const mediaIds = {};
{
  const r = await apiGet(tokens.hqAdmin, `svc:ticketMedia?filterByTk=${real.id}`);
  check(r.status === 200 && r.json?.data?.count === 3, 'hq_admin 读到 3 个媒体', `HTTP ${r.status} count=${r.json?.data?.count}`);
  const list = r.json?.data?.media ?? [];
  const fields = [...new Set(list.flatMap((m) => Object.keys(m)))].sort();
  check(JSON.stringify(fields) === JSON.stringify(LIST_FIELDS), '响应只含白名单字段', fields.join(','));
  const rawText = JSON.stringify(r.json);
  check(!/storage_key|customer\/\d+\/|original_name|upload_ip_hash/.test(rawText), '响应不含存储路径/原文件名/IP');
  for (const m of list) mediaIds[m.kind] = m.id;
  note('媒体元数据', list.map((m) => `${m.kind}:${m.id}(${m.size}B)`).join(' / '));

  const hq = await apiGet(tokens.hq, `svc:ticketMedia?filterByTk=${real.id}`);
  check(hq.status === 200 && hq.json?.data?.count === 3, 'hq_after_sales 也能读到（全量范围）', `HTTP ${hq.status}`);

  const viewer = await apiGet(tokens.viewer, `svc:ticketMedia?filterByTk=${real.id}`);
  check(viewer.status === 403, 'viewer 读清单 403（不因本次修复开放媒体）', `HTTP ${viewer.status}`);

  const crossA = await apiGet(tokens.storeA, `svc:ticketMedia?filterByTk=${real.id}`);
  const crossB = await apiGet(tokens.storeB, `svc:ticketMedia?filterByTk=${real.id}`);
  check(crossA.status === 404 && crossB.status === 404, '跨店门店账号读清单 404（与不存在同形）', `A=${crossA.status} B=${crossB.status}`);

  const own = await apiGet(tokens.storeA, `svc:ticketMedia?filterByTk=${synthetic.id}`);
  check(own.status === 200 && own.json?.data?.count === 1 && own.json?.data?.media?.[0]?.kind === 'video', '本店门店账号能读自己的视频媒体', `HTTP ${own.status}`);

  const anonList = await apiGet('', `svc:ticketMedia?filterByTk=${real.id}`);
  check(anonList.status === 401, '未登录读清单 401', `HTTP ${anonList.status}`);
}

// ---- 文件流：MIME / 缓存头 / Range / 越权 -------------------------------
{
  const id = mediaIds.audio ?? mediaIds.image;
  const full = await apiGet(tokens.hqAdmin, `svc:ticketMediaFile?id=${id}`);
  check(full.status === 200 && full.buf?.length > 0, '文件读取 200 且非空', `HTTP ${full.status} bytes=${full.buf?.length}`);
  check((full.headers.get('x-content-type-options') ?? '').includes('nosniff'), 'X-Content-Type-Options 含 nosniff', full.headers.get('x-content-type-options') ?? '');
  check((full.headers.get('cache-control') ?? '').includes('no-store'), 'Cache-Control 含 no-store', full.headers.get('cache-control') ?? '');
  check((full.headers.get('content-type') ?? '').startsWith('audio/') || (full.headers.get('content-type') ?? '').startsWith('image/'), 'Content-Type 取自库中 MIME', full.headers.get('content-type') ?? '');

  const part = await apiGet(tokens.hqAdmin, `svc:ticketMediaFile?id=${id}`, { Range: 'bytes=0-1023' });
  check(part.status === 206 && part.buf?.length === 1024, 'Range 请求 206 + 1024 字节', `HTTP ${part.status} bytes=${part.buf?.length}`);
  check(/^bytes 0-1023\//.test(part.headers.get('content-range') ?? ''), 'Content-Range 正确', part.headers.get('content-range') ?? '');
  check(part.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges: bytes');

  const bad = await apiGet(tokens.hqAdmin, `svc:ticketMediaFile?id=${id}`, { Range: 'bytes=99999999-' });
  check(bad.status === 416, '越界 Range 416', `HTTP ${bad.status}`);

  const viewerFile = await apiGet(tokens.viewer, `svc:ticketMediaFile?id=${id}`);
  check(viewerFile.status === 403, 'viewer 读文件 403', `HTTP ${viewerFile.status}`);

  const crossFile = await apiGet(tokens.storeA, `svc:ticketMediaFile?id=${id}`);
  check(crossFile.status === 404, '跨店读文件 404', `HTTP ${crossFile.status}`);

  const anonFile = await apiGet('', `svc:ticketMediaFile?id=${id}`);
  check(anonFile.status === 401, '未登录读文件 401', `HTTP ${anonFile.status}`);

  const missing = await apiGet(tokens.hqAdmin, 'svc:ticketMediaFile?id=99999999');
  check(missing.status === 404, '不存在的媒体 404', `HTTP ${missing.status}`);

  const synId = psqlRows(`select id from customer_medias where ticket_id=${synthetic.id}`)[0][0];
  const video = await apiGet(tokens.storeA, `svc:ticketMediaFile?id=${synId}`);
  check(video.status === 200 && (video.headers.get('content-type') ?? '').includes('video/webm'), '视频文件 Content-Type=video/webm', `${video.status} ${video.headers.get('content-type')}`);
}

// ---- C/D/E. 浏览器 -------------------------------------------------------
async function withCdp(label, fn) {
  const session = await launchCdp({ label });
  const { cdp } = session;
  try {
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页' });
    return await fn(cdp);
  } finally {
    session.close();
  }
}

async function uiLogin(cdp, emailKey, fallback) {
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(ins[0], ${JSON.stringify(envValue(emailKey, fallback))});
    setVal(ins[1], ${JSON.stringify(envValue(emailKey.replace('_EMAIL', '_PASSWORD')))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
}

/** 在列表页按工单号打开详情抽屉，返回 DOM 证据 */
async function openDrawer(cdp, pageUid, ticketNo, { expectMedia = true } = {}) {
  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${pageUid}` });
  await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '列表', timeout: 60_000 });
  await sleep(1500);
  const found = await cdp.evaluate(`(() => {
    const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].find((r) => r.innerText.includes(${JSON.stringify(ticketNo)}));
    if (!tr) return false;
    const link = tr.querySelector('[data-testid="row-view-link"]');
    if (link) { link.click(); return true; }
    const btn = [...tr.querySelectorAll('button, a')].find((b) => (b.innerText || '').includes('查看'));
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  if (!found) return { found: false };
  await cdp.waitFor(`!!document.querySelector('.ant-drawer-content')`, { what: '抽屉', timeout: 30_000 });
  if (expectMedia) {
    await cdp.waitFor(`!!document.querySelector('[data-testid="customer-media-list"]')`, { what: '媒体区块', timeout: 30_000 });
    // 等音视频元数据就绪（duration 要加载后才可读；不等就会偶发 NaN 造成假红）
    await cdp
      .waitFor(
        `[...document.querySelectorAll('audio,video')].every((m) => Number.isFinite(m.duration) && m.duration > 0)`,
        { what: '媒体元数据就绪', timeout: 20_000 },
      )
      .catch(() => {});
    await sleep(1200);
  } else {
    await sleep(2000);
  }
  return {
    found: true,
    dom: await cdp.evaluate(`(() => {
      const d = document.querySelector('.ant-drawer-content');
      const list = d.querySelector('[data-testid="customer-media-list"]');
      const imgs = list ? [...list.querySelectorAll('[data-testid="customer-media-image"] img')] : [];
      const audios = list ? [...list.querySelectorAll('[data-testid="customer-media-audio"] audio')] : [];
      const videos = list ? [...list.querySelectorAll('[data-testid="customer-media-video"] video')] : [];
      return {
        hasSection: /客户提交的材料/.test(d.innerText),
        imgs: imgs.length,
        imgBlob: imgs.every((i) => (i.getAttribute('src') || '').startsWith('blob:')),
        imgDecoded: imgs.map((i) => i.naturalWidth > 0),
        audios: audios.length,
        audioBlob: audios.every((a) => (a.getAttribute('src') || '').startsWith('blob:')),
        audioDurations: audios.map((a) => a.duration),
        videos: videos.length,
        videoBlob: videos.every((v) => (v.getAttribute('src') || '').startsWith('blob:')),
        videoDurations: videos.map((v) => v.duration),
        videoSizes: videos.map((v) => [Math.round(v.getBoundingClientRect().width), Math.round(v.getBoundingClientRect().height)]),
        hasFailedBlock: /客户材料读取失败|读取失败：/.test(d.innerText),
        leaksStorage: (() => { const s = d.innerText || ''; return s.indexOf('customer/') >= 0 || s.indexOf('storage_key') >= 0; })(),
        text: (list?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200),
      };
    })()`),
  };
}

console.log('');
console.log('  C. 浏览器（hq_admin）');
await withCdp('media-hq', async (cdp) => {
  await uiLogin(cdp, 'UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');

  const realUi = await openDrawer(cdp, 'a7p45sundsb', real.no);
  check(realUi.found, '真实工单可在列表定位并打开抽屉');
  if (realUi.found) {
    const d = realUi.dom;
    check(d.hasSection, '抽屉出现「客户提交的材料」');
    check(d.imgs === 2, '2 张图片渲染为缩略图', `实际 ${d.imgs}`);
    check(d.imgBlob && d.imgDecoded.every(Boolean), '图片走 blob 且解码成功', JSON.stringify(d.imgDecoded));
    check(d.audios === 1, '1 段录音渲染为播放器');
    check(d.audioBlob && d.audioDurations[0] > 1, '录音 blob 可读且时长正常', `duration=${d.audioDurations[0]}`);
    check(!d.hasFailedBlock, '没有"读取失败"提示');
    check(!d.leaksStorage, '界面不含存储路径');
    note('媒体区文本', d.text);

    // 点开大图
    await cdp.evaluate(`document.querySelectorAll('[data-testid="customer-media-image"]')[0].click()`);
    await cdp.waitFor(`!!document.querySelector('.ant-modal-content img')`, { what: '图片预览', timeout: 15_000 });
    const prev = await cdp.evaluate(`(() => { const i = document.querySelector('.ant-modal-content img'); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), natural: i.naturalWidth }; })()`);
    check(prev.w > 300 && prev.natural > 0, '点击图片可看大图', `渲染宽 ${prev.w} / 原图 ${prev.natural}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'ux-media-01-real-ticket.png'), Buffer.from(shot.data, 'base64'));
    await cdp.evaluate(`document.querySelector('.ant-modal-close')?.click()`);
  }

  const videoUi = await openDrawer(cdp, 'a7p45sundsb', synthetic.no);
  check(videoUi.found, '合成视频工单可打开');
  if (videoUi.found) {
    const d = videoUi.dom;
    check(d.videos === 1, '视频渲染为播放器', `实际 ${d.videos}`);
    check(d.videoBlob && d.videoDurations[0] > 0.5, '视频 blob 可播放且有真实时长', `duration=${d.videoDurations[0]}`);
    check(d.videoSizes[0]?.[0] > 100, '视频元素有可见尺寸', JSON.stringify(d.videoSizes));
    check(!d.hasFailedBlock, '视频没有读取失败');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'ux-media-01-synthetic-video.png'), Buffer.from(shot.data, 'base64'));
  }
});

console.log('');
console.log('  D. 浏览器（store_after_sales，本店）');
await withCdp('media-store', async (cdp) => {
  await uiLogin(cdp, 'UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
  const own = await openDrawer(cdp, 'tujyw08ec1d', synthetic.no);
  check(own.found, '门店账号能在本店列表找到合成工单');
  if (own.found) {
    check(own.dom.videos === 1 && own.dom.videoBlob, '门店账号能播放本店工单的视频', `videos=${own.dom.videos}`);
    check(!own.dom.hasFailedBlock && !own.dom.leaksStorage, '门店账号视图无错误、无存储路径');
  }
  // 跨店工单不应出现在本店列表
  const absent = await cdp.evaluate(`(() => !document.body.innerText.includes(${JSON.stringify(real.no)}))()`);
  check(absent, '跨店工单不在本店列表（数据范围隔离）');
});

console.log('');
console.log('  E. 浏览器（viewer，只读角色）');
await withCdp('media-viewer', async (cdp) => {
  await uiLogin(cdp, 'UAT_VIEWER_EMAIL', 'uat.viewer@svc.local');
  const denied = await openDrawer(cdp, 'a7p45sundsb', real.no, { expectMedia: false });
  check(denied.found, 'viewer 能打开工单详情（只读本身不受影响）');
  if (denied.found) {
    const d = denied.dom;
    check(!d.hasSection, 'viewer **看不到**「客户提交的材料」');
    check(!d.hasFailedBlock, 'viewer 也不显示"读取失败"（静默，不是报错）');
  }
});

// ---- 夹具收尾（用户 2026-10-17 裁决：不保留长期夹具）----------------------
if (fixtureProvisioned && synthetic) {
  try {
    cleanupTicket(synthetic.id);
    const left = psqlRows(
      `select (select count(*) from service_tickets where id=${synthetic.id})` +
        ` + (select count(*) from customer_medias where ticket_id=${synthetic.id})` +
        ` + (select count(*) from customer_media_sessions where ticket_id=${synthetic.id})`,
    );
    check(Number(left[0][0]) === 0, '视频夹具已按 id 精确清理', `残留 ${left[0][0]}`);
  } catch (error) {
    check(false, '视频夹具清理', String(error?.message ?? error).slice(0, 160));
  }
}

// ---- 汇总 ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
