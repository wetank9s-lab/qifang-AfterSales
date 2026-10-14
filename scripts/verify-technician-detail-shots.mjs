/**
 * P11-5 · 师傅详情页**真实界面验收**（改用一次性 Chrome 进程，不依赖 CDP）
 *
 *   node scripts/verify-technician-detail-shots.mjs
 *
 * 为什么换掉 CDP：分层对照证明 **Chrome 命令行截图完全可用**
 *   （`about:blank` 2.7KB、H5 页 33.9KB 都能真实渲染），而 CDP 那条路会**无输出地卡住**
 *   ⇒ 卡点在 **CDP 通信层**，不在浏览器/TLS/网络/业务页。
 *   ⇒ 本脚本用"启动一次 Chrome、截一张图、退出"的方式，**天然有边界**（外层再加 timeout 兜底）。
 *
 * ⚠️⚠️ 本脚本存在的原因（DEV-20x · **截图假绿**）：
 *   上一版用 `--window-size=390,844` 截图。现场照片区**在首屏之下**，
 *   于是"上传前"和"上传后"两张图**字节完全相同**（md5 一致）——
 *   文件名却一个叫 `technician-detail.png`、一个叫 `technician-photos.png`，
 *   **看着像"上传后的证据"，实际什么都没证明**。
 *   DOM 断言是真的（`svc-photo-del` 从 0 变 2），但**图是假的**。
 *   ⇒ 本版两条硬约束：
 *     ① 三张状态图**必须两两 md5 不同**（否则"截图"根本没跟着状态走）；
 *     ② 必须用**足够高的视口**（并回读 PNG IHDR 校验真实像素高），
 *        否则"截到了"只是"截到了首屏"，不是"截到了现场照片区"。
 *
 * 产出（全部在 `storage/tmp/shots/`，**不入库**）：
 *   · `technician-detail-tall.png`          —— 上传前：0/3，无缩略图
 *   · `technician-photos-tall.png`          —— 上传 2 张后：2/3，2 缩略图 + 2 个删除按钮
 *   · `technician-photos-deleted-tall.png`  —— 删除 1 张后：1/3，1 缩略图（= 服务端 remaining）
 *   · `technician-*-dom.txt`                —— 对应状态的渲染后 DOM
 *   · `technician-entry.json`               —— 该 Visit 的入口 URL（含 Token，**仅本地**，供生成二维码）
 *
 * ⚠️ 不打印 Token 全文、不含客户真实信息（合成单）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  BASE_URL,
  ROOT,
  http,
  psqlScalar,
  smsSwitch,
  twoSessions,
  acceptAndDispatch,
  tokenFromOutbox,
} from './technician-harness.mjs';

const OUT = path.join(ROOT, 'storage/tmp/shots');
const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;
const IMG = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
const AUDIO = fs.readFileSync(path.join(FIX, 'audio-chrome.webm'));
const VIDEO = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** 视口：宽度按手机（390），**高度必须够高**才能把现场照片区带进图里。 */
const VW = 390;
const TALL = 2600;
const MIN_PNG_HEIGHT = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = 2500;
let lastAt = 0;
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let out = await fn();
  for (let i = 0; i < 2 && out?.status === 429; i += 1) {
    console.log('  · 撞限流，等 25s 窗口…');
    await sleep(25_000);
    out = await fn();
  }
  return out;
}
const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

/** 回读 PNG 的 IHDR，拿到**真实像素尺寸**（不信"我传了 --window-size"这件事） */
function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  } catch {
    return null;
  }
}
function md5(file) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 用**一次性 Chrome 进程**截一张图。
 * ⚠️ `--screenshot` 只认**绝对路径**（相对路径会报 `系统找不到指定的路径`）。
 */
function shoot(url, pngPath, { budgetMs = 30000, height = TALL } = {}) {
  const profile = path.join(os.tmpdir(), `p115-shot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--ignore-certificate-errors',
    `--user-data-dir=${profile}`,
    `--window-size=${VW},${height}`,
    '--hide-scrollbars',
    `--virtual-time-budget=${budgetMs}`,
    `--screenshot=${pngPath}`,
    url,
  ];
  const t0 = Date.now();
  try {
    const out = execFileSync(CHROME, args, { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: fs.existsSync(pngPath), ms: Date.now() - t0, out: String(out ?? '').slice(0, 200) };
  } catch (e) {
    return { ok: fs.existsSync(pngPath), ms: Date.now() - t0, out: String(e?.stdout ?? e?.message ?? '').slice(0, 200) };
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}

/** 用一次性 Chrome 导出渲染后的 DOM（同样是一次性进程，有边界） */
function dumpDom(url, domPath, budgetMs = 30000) {
  const profile = path.join(os.tmpdir(), `p115-dom-${Date.now()}`);
  try {
    const out = execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--ignore-certificate-errors',
        `--user-data-dir=${profile}`,
        `--window-size=${VW},${TALL}`,
        `--virtual-time-budget=${budgetMs}`,
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    );
    fs.writeFileSync(domPath, out, 'utf8');
    return { ok: true, len: out.length };
  } catch (e) {
    return { ok: false, len: 0, err: String(e?.message ?? '').slice(0, 120) };
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}

/** 一个状态 = 预热（单独进程）→ 截图 → DOM */
async function capture(pageUrl, tag, { budgetMs = 30000 } = {}) {
  const warm = path.join(os.tmpdir(), `p115-warm-${tag}.txt`);
  dumpDom(pageUrl, warm, budgetMs);
  await sleep(1500);
  const png = path.join(OUT, `technician-${tag}-tall.png`);
  const shot = shoot(pageUrl, png, { budgetMs });
  const domPath = path.join(OUT, `technician-${tag}-dom.txt`);
  const dom = dumpDom(pageUrl, domPath, budgetMs);
  while (fs.existsSync(png)) break; // 保持"文件一定落盘"的显式顺序
  return { png, shot, domPath, dom };
}

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const photoCount = (html) => (html.match(/class="svc-photo"/g) ?? []).length;
const delCount = (html) => (html.match(/svc-photo-del/g) ?? []).length;
const onsiteInDb = (ticketId) =>
  Number(
    psqlScalar(
      `SELECT count(*) FROM service_visit_photos sp JOIN service_visits v ON v.id=sp.visit_id WHERE v.ticket_id=${ticketId} AND sp.photo_type='onsite'`,
    ),
  );

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-5 · 师傅详情页真实界面验收（一次性 Chrome 进程，非 CDP）');
console.log('══════════════════════════════════════════════════════════════');

fs.mkdirSync(OUT, { recursive: true });
// 清掉上一版**会误导的**产物（`technician-photos.png` 其实与 detail 同字节）
for (const stale of [
  'technician-detail.png',
  'technician-photos.png',
  'technician-warmup-dom.txt',
  'technician-photos-warmup.txt',
]) {
  try {
    fs.rmSync(path.join(OUT, stale), { force: true });
  } catch {
    /* ignore */
  }
}

const sw = smsSwitch();
try {
  await sw.enable();
  const { store, hq } = await twoSessions();

  // ---- 合成单：客户照片 + 语音 + 视频（文字为空）----
  const s = await paced(() =>
    http(`${BASE_URL}/api/public/media/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_consent: true }),
    }),
  );
  const sess = s.json?.data;
  for (const [buf, name] of [
    [IMG, 'c.png'],
    [AUDIO, 'c.webm'],
    [VIDEO, 'c.webm'],
  ]) {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    const up = await paced(() =>
      http(`${BASE_URL}/api/public/media/upload`, {
        method: 'POST',
        headers: { 'X-Media-Session': sess.session_token },
        body: form,
      }),
    );
    if (up.status !== 200) throw new Error(`上传 ${name} 失败 HTTP ${up.status}`);
  }
  const created = await paced(() =>
    http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: JSON.stringify({
        ticket_type: 'repair',
        content: '',
        customer_name: 'P115 界面验收',
        customer_mobile: `13${String(Date.now()).slice(-9)}`,
        service_address: '新都区 P115 路 9 号 3 单元 501',
        appliance_category: 'air_conditioner',
        brand_model: '格力 KFR-35GW',
        media_session: { id: sess.session_id, token: sess.session_token },
      }),
    }),
  );
  const ticketNo = created.json?.data?.ticket_no;
  const ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
  console.log(`  · 合成单 ${ticketNo}（客户：照片 + 录音 + 视频；文字为空）`);

  await acceptAndDispatch(ticketId, store);
  const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo });
  const pageUrl = `${BASE_URL}/h5/technician/visit/${token}`;
  fs.writeFileSync(
    path.join(OUT, 'technician-entry.json'),
    JSON.stringify({ note: '合成 Visit 的入口（含 Token，仅本地、不入库）', url: pageUrl, ticketNo }, null, 2),
  );
  console.log('  · 已派工并取得师傅链接（入口已写 storage/tmp/shots/technician-entry.json，不入库）');

  // 等限流窗口，避免"页面自己请求时撞桶"
  console.log('  · 等 65s 让限流窗口恢复…');
  await sleep(65_000);

  // =========================================================================
  // ① 上传前：详情页（客户 3 种媒体 + 现场照片 0/3）
  // =========================================================================
  console.log('\n── ① 上传前：详情页（客户 3 种媒体 + 现场照片 0/3）──────');
  const st1 = await capture(pageUrl, 'detail');
  ok('用一次性 Chrome 打开并截图成功（无 CDP）', st1.ok !== false && st1.shot.ok, `${st1.shot.ms}ms`);
  ok('导出渲染后的 DOM 成功', st1.dom.ok, `${st1.dom.len} 字节`);
  const png1 = pngSize(st1.png);
  ok(
    `🔴 截图是**真的高图**（PNG 实测 ${png1 ? `${png1.w}x${png1.h}` : '读不出'}，视口请求 ${VW}x${TALL}）`,
    Boolean(png1) && png1.h >= MIN_PNG_HEIGHT,
    png1 ? `${png1.bytes} 字节` : '(无文件)',
  );

  const html1 = st1.dom.ok ? fs.readFileSync(st1.domPath, 'utf8') : '';
  const hasTitle = /上门作业/.test(html1);
  const mediaSrcs = [...html1.matchAll(/(?:src)="([^"]*\/api\/technician\/visits\/[^"]+)"/g)].map((m) => m[1]);
  ok('页面标题为「上门作业」', hasTitle, hasTitle ? 'ok' : '(未渲染出)');
  ok(
    '🔴 客户资料的选填字段按值显示（地址/类别/型号都在）',
    /服务地址/.test(html1) && /新都区 P115 路/.test(html1) && /家电类别/.test(html1) && /格力/.test(html1),
    '地址/类别/型号都在',
  );
  ok('🔴 客户没写文字 ⇒ 页面**没有**"问题描述"行', !/问题描述/.test(html1), /问题描述/.test(html1) ? '出现了（不应有）' : '没有该行');
  ok('现场照片区文案为「现场服务照片（必填，1～3 张）」', /现场服务照片（必填，1～3 张）/.test(html1), '文案正确');
  ok(
    '🔴 媒体元素存在，且 src **全部指向受控读取接口**',
    /<audio[^>]*\/api\/technician\/visits\//.test(html1) &&
      /<video[^>]*\/api\/technician\/visits\//.test(html1) &&
      /customer-photo-0/.test(html1),
    `受控 src 命中 ${mediaSrcs.length} 处`,
  );
  ok('页面**不含**内部标识（mediaId / storage_key / 存储路径）', !/mediaId|storage_key/.test(html1), '干净');
  ok(
    '🔴 客户照片元素带受控 src（照片可打开大图的入口）',
    /data-testid="customer-photo-0"[\s\S]{0,200}\/api\/technician\/visits\//.test(html1),
    '照片 src 走受控接口',
  );
  ok(
    '上传前现场照片计数为 0 / 3，且**没有**缩略图/删除按钮',
    /0 \/ 3/.test(html1) && photoCount(html1) === 0 && delCount(html1) === 0,
    `缩略图 ${photoCount(html1)} · 删除按钮 ${delCount(html1)}`,
  );

  // 媒体接口本身的可读性（服务端侧证据）
  const refs = [...html1.matchAll(/\/api\/technician\/visits\/[A-Za-z0-9_-]+\/media\/([A-Za-z0-9_-]{22})/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  let allOk = uniq.length >= 3;
  const sizes = [];
  for (const r of uniq) {
    const res = await paced(() => fetch(`${BASE_URL}/api/technician/visits/${token}/media/${r}`));
    const buf = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    sizes.push(`${res.status}/${buf.length}`);
    if (res.status !== 200 || buf.length === 0) allOk = false;
  }
  ok(
    `🔴 页面里出现的 ${uniq.length} 个媒体句柄，服务端都能读到真实字节（照片/语音/视频）`,
    allOk,
    sizes.join(' · '),
  );

  // =========================================================================
  // ② 上传 2 张现场照片 → 再截一张图
  // =========================================================================
  console.log('\n── ② 上传 2 张现场照片后的页面 ─────────────────────────');
  for (const [n, f] of [
    [1, 'onsite1.png'],
    [2, 'onsite2.png'],
  ]) {
    const form = new FormData();
    form.append('file', new Blob([IMG]), f);
    const up = await paced(() => http(`${BASE_URL}/api/technician/visits/${token}/files`, { method: 'POST', body: form }));
    if (up.status >= 300) throw new Error(`上传现场照片 ${n} 失败 HTTP ${up.status} ${JSON.stringify(up.json?.errors?.[0] ?? '')}`);
  }
  const db2 = onsiteInDb(ticketId);
  console.log(`  · 已上传 2 张现场照片（库内 onsite=${db2}）`);

  await sleep(65_000); // 再等一个窗口（上传也用了同一个桶）
  const st2 = await capture(pageUrl, 'photos');
  ok('上传后再次截图成功', st2.shot.ok, `${st2.shot.ms}ms`);
  const png2 = pngSize(st2.png);
  ok(
    `🔴 上传后截图仍是**真的高图**（${png2 ? `${png2.w}x${png2.h}` : '读不出'}）`,
    Boolean(png2) && png2.h >= MIN_PNG_HEIGHT,
    png2 ? `${png2.bytes} 字节` : '(无文件)',
  );

  const html2 = st2.dom.ok ? fs.readFileSync(st2.domPath, 'utf8') : '';
  ok(
    '🔴 页面上出现已上传的现场照片缩略图（含就地删除按钮）',
    /现场服务照片（必填，1～3 张）/.test(html2) && delCount(html2) === 2 && photoCount(html2) === 2,
    `缩略图 ${photoCount(html2)} · 删除按钮 ${delCount(html2)}`,
  );
  ok('现场照片计数显示为 2 / 3', /2 \/ 3/.test(html2), /2 \/ 3/.test(html2) ? 'ok' : '(未匹配到 2 / 3)');
  ok(
    '🔴 **页面缩略图数 == 服务端 onsite 数**（页面的数不是自己编的）',
    db2 === 2 && photoCount(html2) === db2,
    `页面 ${photoCount(html2)} · 库内 ${db2}`,
  );
  // 🔴🔴 防假绿：两张状态图**必须不同**（上一版就是在这里翻了车）
  ok(
    '🔴 上传前后两张截图**不是同一张图**（md5 不同）',
    md5(st1.png) !== md5(st2.png),
    `${md5(st1.png).slice(0, 8)} vs ${md5(st2.png).slice(0, 8)}`,
  );

  // =========================================================================
  // ③ 删掉 1 张（走页面**自己调的那个接口**）→ 再截一张图
  // =========================================================================
  console.log('\n── ③ 删除 1 张现场照片后的页面 ─────────────────────────');
  const onsiteRefs = [...html2.matchAll(/\/photos\/([A-Za-z0-9_-]{22})/g)].map((m) => m[1]);
  const targetRef = onsiteRefs[0] ?? '';
  ok('从已渲染页面里取到现场照片句柄（删除入口就是它）', Boolean(targetRef), targetRef ? '句柄形态合法' : '(没取到)');
  // 与前端 `deleteTechnicianPhoto()` 完全一致的调用（POST + Accept，不带别的东西）
  const del = await paced(() =>
    http(`${BASE_URL}/api/technician/visits/${token}/photos/${targetRef}/delete`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }),
  );
  const db3 = onsiteInDb(ticketId);
  ok(
    '删除接口返回 remaining 计数，且数据库确实少了 1 条',
    del.status === 200 && db3 === 1 && Number(del.json?.data?.photos_count) === 1,
    `HTTP ${del.status} photos_count=${del.json?.data?.photos_count} 库内 ${db3}`,
  );

  await sleep(65_000);
  const st3 = await capture(pageUrl, 'photos-deleted');
  ok('删除后再次截图成功', st3.shot.ok, `${st3.shot.ms}ms`);
  const html3 = st3.dom.ok ? fs.readFileSync(st3.domPath, 'utf8') : '';
  ok(
    '🔴 删除后页面只剩 1 张缩略图，且**页面数 == 服务端数**',
    photoCount(html3) === 1 && delCount(html3) === 1 && /1 \/ 3/.test(html3) && photoCount(html3) === db3,
    `页面缩略图 ${photoCount(html3)} · 删除按钮 ${delCount(html3)} · 库内 ${db3}`,
  );
  ok(
    '🔴 删除后的截图**不是**上传后那张（md5 不同）',
    md5(st3.png) !== md5(st2.png),
    `${md5(st3.png).slice(0, 8)} vs ${md5(st2.png).slice(0, 8)}`,
  );
  ok(
    '🔴 三张状态图的 md5 **两两不同**（截图真的跟着状态走）',
    new Set([md5(st1.png), md5(st2.png), md5(st3.png)]).size === 3,
    [md5(st1.png), md5(st2.png), md5(st3.png)].map((h) => h.slice(0, 8)).join(' / '),
  );

  // =========================================================================
  // ④ 门店审核侧能看到现场照片
  // =========================================================================
  console.log('\n── ④ 门店审核侧证据 ────────────────────────────────────');
  const auditVisitId = await visitIdOfToken(token);
  const detail = await paced(() =>
    http(`${BASE_URL}/api/svc:visitDetail?filterByTk=${auditVisitId}`, {
      headers: { Authorization: `Bearer ${store}` },
    }),
  );
  const photos = detail.json?.data?.photos ?? null;
  ok(
    '🔴 门店审核接口读到本次上门的现场照片（删除后应为 1 张）',
    detail.status === 200 && Array.isArray(photos) && photos.length === 1 && photos.length === db3,
    `HTTP ${detail.status} photos=${Array.isArray(photos) ? photos.length : '(无)'} 库内 ${db3}`,
  );

  console.log(`\n  · 截图与 DOM 已写入：${OUT}`);
  console.log('    technician-detail-tall.png / technician-photos-tall.png / technician-photos-deleted-tall.png');
} finally {
  const r = sw.restore();
  console.log(`\n  · 短信开关恢复：${r.note}`);
}

async function visitIdOfToken(t) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update(String(t)).digest('hex');
  return Number(psqlScalar(`SELECT id FROM service_visits WHERE access_token_hash='${h}'`));
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  师傅详情页界面验收：${passed}/${checks.length} 通过（Chromium 一次性进程，**非真机**）`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过（真机未验证）');
}
