/**
 * P11-4 门禁 · 客户媒体上传 + 服务进度查询（接口层）
 *
 *   node scripts/verify-customer-media.mjs
 *
 * ---------------------------------------------------------------------------
 * 这一门禁守的是用户 D 条的前 10 项里**能在接口层证明**的部分，
 * 真实浏览器那部分在 verify-customer-media-ui.mjs（真实手机尺寸）。
 *
 * 设计上的三条纪律：
 *  ① **不造"会通过的数据"**：超时长/超数量用例靠**真实容器字节**
 *     （生成 WAV / 手工拼 MP4），不是靠改期望值。
 *  ② **每个反例都要真的被服务端拒绝**：伪造类型、无凭证、别家 token、
 *     撤销、过期——五种失效形态各自断言，且都断言**错误码**而不只是状态码。
 *  ③ **"媒体归属正确"用库内查询证明**：不是"接口返回 200"就算数。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'storage/tmp/customer-media');
fs.mkdirSync(TMP, { recursive: true });

const RUN = `R${Date.now().toString(36).toUpperCase()}`;

// ---------------------------------------------------------------------------
// 突发额度：验收期临时调大 nginx burst + 媒体限流参数，跑完**自动还原**
// ---------------------------------------------------------------------------
// ⚠️ 完全沿用 Phase 7 的既有做法（verify-review-loop.mjs）：
//   · 只放宽 **burst**（突发容量），**不动 rate**（那是产品对客的承诺）；
//   · 改配置 → nginx -s reload → 跑 → 还原 → reload；
//   · 退出时（含异常）也会还原。
// 为什么不"就调高产品默认值"：媒体上传与匿名建单共用同一套防刷思路，
//   额度是该守的边界；门禁一轮要建 8~10 个会话 + 数十次调用，
//   产品默认值**不足以让门禁重复跑**，那属于门禁不可重复，不是产品太严。
const SERVICE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');
const ORIGINAL_CONF = fs.existsSync(SERVICE_CONF) ? fs.readFileSync(SERVICE_CONF, 'utf8') : null;
const GATE_BURST = 400;

function dockerCompose(args) {
  return execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' });
}

function raiseBurst() {
  if (!ORIGINAL_CONF) return;
  const patched = ORIGINAL_CONF.replace(/(limit_req zone=svc_public burst=)\d+/, `$1${GATE_BURST}`);
  if (patched === ORIGINAL_CONF) return;
  try {
    fs.writeFileSync(SERVICE_CONF, patched);
    dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
    console.log(`  · 验收期临时把 /api/public/ 的 burst 调到 ${GATE_BURST}（跑完自动还原）`);
  } catch (e) {
    console.log(`  · burst 临时调大失败（继续跑，可能看到 429）：${e.message}`);
    restoreBurst();
  }
}

function restoreBurst() {
  if (!ORIGINAL_CONF) return;
  try {
    if (fs.readFileSync(SERVICE_CONF, 'utf8') !== ORIGINAL_CONF) {
      fs.writeFileSync(SERVICE_CONF, ORIGINAL_CONF);
      dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
      console.log('  · 已还原 nginx burst');
    }
  } catch (e) {
    console.error(`  ⚠️ 还原 nginx 配置失败，请手工检查 nginx/conf.d/service.conf：${e.message}`);
  }
}
process.on('exit', restoreBurst);
// ⚠️ 手机号必须**每轮不同**：`security.ticket_phone_daily_limit` 是**日**额度
//   （实测 5/日），复用同一号码跑到第二轮就会被 429 顶红 —— 那是门禁不可重复跑，
//   不是产品坏了。（这一条踩过。）
let mobileSeq = Math.floor(Math.random() * 8000);
const nextMobile = () => `1380000${String(1000 + (mobileSeq++ % 8000)).slice(-4)}`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}
function warn(text) {
  checks.push({ name: text, ok: true, warn: true });
  console.log(`  ⚠️ [已知限制] ${text}`);
}

/**
 * 跑一条只读查询。
 *
 * 🔴 **stderr 必须带进来**（DEV-166）：第一版只取 stdout，于是
 *    `GROUP BY 1` 这种**语法错误**（ordinal 指向输出表达式，PG 拒绝）
 *    变成"查到了空字符串" ⇒ 断言报"短信未入队"，而库里明明有那行。
 *    **工具出错伪装成产品没做事** —— 这是最贵的一类假红。
 *    ⇒ 这里把 stderr 原样带进返回值，并在断言失败时可见。
 */
function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (err) return `PSQL_ERROR:${err.split('\n')[0]}`;
  return out;
}
function psqlNum(sql) {
  return Number(psql(sql) || '0');
}

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
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
  return { status: res.status, json, text, payload: json?.data ?? null, errors: json?.errors ?? [] };
}

const newRequestId = () =>
  `11111111-2222-4333-8444-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

// ===========================================================================
// 素材：真实字节（图片沿用既有样本；音视频现生成）
// ===========================================================================
const IMG_A = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');
const IMG_B = path.join(ROOT, 'storage/tmp/historical-ui/16-archive-page.png');

/** 生成 WAV（16bit PCM）。用于"语音超 60 秒被拒"这条**真实**用例。 */
function makeWav(seconds, sampleRate = 8000) {
  const samples = seconds * sampleRate;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  // ⚠️ WAV 子 chunk 的布局是 **size 在前、FourCC 在后**（`size(4) FourCC(4) data`）。
  //    第一版把 'fmt ' 写在了偏移 12（那是 size 的位置）⇒ 生成的是**非法 WAV**，
  //    服务端如实回了 422 DURATION_UNREADABLE —— 解析器是对的，是素材错了。
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.writeUInt32LE(16, 12); // fmt chunk size
  buf.write('fmt ', 16); // fmt FourCC
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); // blockAlign
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.writeUInt32LE(dataBytes, 36); // data chunk size
  buf.write('data', 40); // data FourCC
  for (let i = 0; i < samples; i += 1) {
    // 一段极低幅度的正弦：够解析成"有声音的语音"，又不会让文件大到传不动
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 800);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/**
 * 手工拼一个**最小合法 MP4**（ftyp + moov/mvhd）。
 *
 * 为什么不用现成样本：视频超时长这条要证明的是"服务端从容器里读到了时长"，
 * 用现成文件就得先找到一个 >30 秒的视频（还得是受支持的 webm/mp4）——
 * 那会让门禁依赖一个仓库里未必存在的大文件。
 * ⇒ 这里现拼，**时长是参数**，可精确构造 29 秒（放行）与 31 秒（拒）。
 */
function makeMp4(durationMs) {
  const box = (type, payload) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, payload]);
  };
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'ascii'), Buffer.alloc(4)]));
  const timescale = 1000;
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt32BE(0, 0); // version+flags
  mvhdPayload.writeUInt32BE(0, 4); // creation
  mvhdPayload.writeUInt32BE(0, 8); // modification
  mvhdPayload.writeUInt32BE(timescale, 12);
  mvhdPayload.writeUInt32BE(durationMs, 16);
  const mvhd = box('mvhd', mvhdPayload);
  // hdlr：声明这条轨道是视频（handler_type = 'vide'）。
  // ⚠️ 必需 —— ftyp 分不出音视频，服务端按 hdlr 判定（见 media-format.ts 的 mp4HandlerType）。
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.writeUInt32BE(0, 0); // version + flags
  hdlrPayload.write('vide', 8, 'ascii'); // handler_type
  const hdlr = box('hdlr', hdlrPayload);
  const trak = box('trak', hdlr);
  const moov = box('moov', Buffer.concat([mvhd, trak]));
  return Buffer.concat([ftyp, moov]);
}

/** 纯 Node 生成**合法 PNG**（zlib 内置 + 手写 CRC32）。不依赖 canvas / PIL。 */
function makePng(width, height, rgb) {
  const zlib = createRequire(import.meta.url)('node:zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type = truecolor
  // 原始扫描线：每行一个 filter 字节 0 + width*3 像素
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x * 3] = rgb[0];
      raw[rowStart + 1 + x * 3 + 1] = rgb[1];
      raw[rowStart + 1 + x * 3 + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 程序化生成**最小合法 webm**（P11-4 第二批 · DEV-176 的回归夹具）。
 *
 * 🔴 为什么第一版没有它、缺陷活到了浏览器验收：
 *    webm 时长解析曾把 EBML 的 **1 字节变长整数**（0x84 = 长度 4）判为非法，
 *    于是**所有 Chrome 录音**都会被服务端拒（422 DURATION_UNREADABLE）。
 *    而当时的门禁只用了手工拼的 MP4 与自己生成的 WAV —— **恰好绕开了 webm**。
 *    ⇒ 这里固定生成"Duration 用 1 字节 VINT"的 webm，让这条路径从此有夹具守着。
 *
 * 结构：EBML header → Segment{ Info{ TimecodeScale, Duration }, Tracks{} }。
 * ⚠️ 只带元数据、不带真实音频帧 —— 它测的是**时长解析**，
 *    而"是不是真音频"由 magic bytes + 容器结构判，不由媒体验收负责。
 */
/**
 * **真实浏览器样本**（Chromium MediaRecorder 产出，入库在 test-fixtures/real-media/）。
 *
 * 🔴 为什么必须用真实字节（P11-4 第三批 · DEV-183）：
 *    上一版用"在字节流里搜 ID"找 TrackType，并据此断言**"真实产物没有 Tracks"**。
 *    用独立工具（`scripts/ebml-probe.py`，按 EBML 规范解析元素树）复核后证明：
 *      录音：Tracks@195 · TrackType=[**2**]（audio）
 *      录像：Tracks@195 · TrackType=[**2, 1**]（audio + video，两条轨道）
 *    ⇒ 真实文件**有** Tracks。上一版"找不到"是因为字节搜索**命中了 SeekHead 里的 SeekID**
 *      （`0x1654AE6B` 作为「对元素 ID 的引用」出现在那里），从那儿往后找 `0x83`
 *      自然命中了 Info 的 MuxingApp。
 *    **手工拼的夹具复现不出"引用 vs 定义"的混淆** —— 只有真实字节能守住这条路径。
 *
 * ⚠️ 这两个文件的时长是**录制时长**（约 2.9 秒），不是构造出来的，
 *    所以断言里的"时长"用**范围**而不是精确值。
 */
const REAL_MEDIA_DIR = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const REAL_AUDIO = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'audio-chrome.webm'));
const REAL_VIDEO = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'video-chrome.webm'));
const REAL_META = JSON.parse(fs.readFileSync(path.join(REAL_MEDIA_DIR, 'meta.json'), 'utf8'));

/**
 * **超时长 / 边界**变体：由真实样本派生，**只改 Info 里的 Duration 值（4 字节 float）**，
 * 其余字节一字不动 ⇒ 结构仍然是真实的（多轨道、未知长度 Segment、SeekHead 引用都在）。
 *
 * 生成方式：`python storage/tmp/make-long-variants.py`（复用同一份独立解析器定位 Duration）。
 * ⚠️ 手工拼的容器复现不出这些结构特征 —— 那正是上一版解析器出错的地方。
 */
const REAL_AUDIO_75S = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'audio-chrome-75s.webm'));
const REAL_AUDIO_59S = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'audio-chrome-59s.webm'));
const REAL_VIDEO_45S = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'video-chrome-45s.webm'));
const REAL_VIDEO_29S = fs.readFileSync(path.join(REAL_MEDIA_DIR, 'video-chrome-29s.webm'));

/** 真实样本的时长（毫秒），从 meta.json 的录制说明里取个上限；断言用"在这附近" */
const REAL_DURATION_MIN = 2000;
const REAL_DURATION_MAX = 5000;

const WAV_61 = makeWav(61);
const MP4_31 = makeMp4(31000);
const MP4_29 = makeMp4(29000);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-4 门禁 · 客户媒体上传 + 服务进度查询');
console.log('══════════════════════════════════════════════════════════════');

if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes('svc-app')) {
  console.error('  ⛔ 容器 svc-app 未运行');
  process.exit(2);
}
// ---------------------------------------------------------------------------
// 限流额度：跑前临时调大、**跑完还原**（Phase 7 的既有做法）
// ---------------------------------------------------------------------------
// ⚠️ 为什么不能"就调高产品默认值了事"：媒体上传与匿名建单共用同一套防刷思路，
//   额度是该守的安全边界。门禁一轮要建 8~10 个会话（每个反例一个），
//   产品默认值（一小时几十个）**不足以让门禁重复跑**。
//   ⇒ 调的是**门禁运行期**的额度，跑完还原；默认值本身另按真实门店量级单独定。
const SESSION_LIMIT_KEY = 'security.media_session_hourly_limit';
const UPLOAD_LIMIT_KEY = 'security.media_upload_hourly_limit';
const LIMIT_BACKUP = { [SESSION_LIMIT_KEY]: psql(`SELECT value FROM service_settings WHERE key='${SESSION_LIMIT_KEY}'`), [UPLOAD_LIMIT_KEY]: psql(`SELECT value FROM service_settings WHERE key='${UPLOAD_LIMIT_KEY}'`) };
psql(`UPDATE service_settings SET value='2000' WHERE key='${SESSION_LIMIT_KEY}'`);
psql(`UPDATE service_settings SET value='2000' WHERE key='${UPLOAD_LIMIT_KEY}'`);
// ⚠️ ConfigService 有 **10 秒** TTL（config-service.ts: ttlMs ?? 10_000）。
//    改完库立刻读会拿到**旧值** —— 表现为"明明调大了还是 429"。
//    ⇒ 必须等缓存过期。等待放在下方主流程开始前（async），这里只标记。
const CONFIG_TTL_WAIT_MS = 11_500;
process.on('exit', () => {
  for (const [k, v] of Object.entries(LIMIT_BACKUP)) {
    if (v) spawnSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-c', `UPDATE service_settings SET value='${v}' WHERE key='${k}'`], { encoding: 'utf8' });
  }
});
console.log(`  · 媒体限流额度已临时调大（${SESSION_LIMIT_KEY} / ${UPLOAD_LIMIT_KEY}），跑完自动还原`);

raiseBurst();
// 等 ConfigService 的 10 秒 TTL 过期，让上面的限流调大真正被读到
await new Promise((r) => setTimeout(r, CONFIG_TTL_WAIT_MS));
console.log(`  · 已等待 ${CONFIG_TTL_WAIT_MS / 1000}s 让配置缓存过期（媒体限流调大生效）`);

if (!fs.existsSync(IMG_A) || !fs.existsSync(IMG_B)) {
  console.error('  ⛔ 缺少图片素材（historical-ui 截图目录）；先跑一次浏览器验收产出会生成它们');
  process.exit(2);
}

async function newSession() {
  const r = await api('/api/public/media/session', { method: 'POST', body: { media_consent: true } });
  return { status: r.status, data: r.payload, raw: r };
}

async function upload(token, buffer, name, extraFields = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  for (const [k, v] of Object.entries(extraFields)) form.append(k, String(v));
  const res = await fetch(`${SVC_BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': token },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 忽略 */
  }
  return { status: res.status, payload: json?.data ?? null, errors: json?.errors ?? [], text };
}

// ===========================================================================
// ① 会话：授权前置 + 限额 + 凭证形态
// ===========================================================================
console.log('');
console.log('── ① 上传会话（授权前置）────────────────────────────────────');
{
  const noConsent = await api('/api/public/media/session', { method: 'POST', body: {} });
  check(
    '🔴 不带 media_consent ⇒ 400 MEDIA_CONSENT_REQUIRED（媒体授权不吃"提交即同意"）',
    noConsent.status === 400 && noConsent.errors[0]?.code === 'MEDIA_CONSENT_REQUIRED',
    `HTTP ${noConsent.status} ${noConsent.errors[0]?.code ?? ''}`,
  );

  const s = await newSession();
  check('建会话返回 200 且 token 是 43 字符 base64url', s.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(s.data?.session_token ?? ''), `HTTP ${s.status} len=${(s.data?.session_token ?? '').length}`);
  check(
    '响应带**冻结契约**的限额（图片≤3 / 语音≤60s / 视频≤30s / 单文件 8MB / 会话内 5 个）',
    s.data?.limits?.image_max_count === 3 &&
      s.data?.limits?.audio_max_ms === 60000 &&
      s.data?.limits?.video_max_ms === 30000 &&
      s.data?.limits?.max_file_bytes === 8 * 1024 * 1024 &&
      s.data?.limits?.max_items === 5,
    JSON.stringify(s.data?.limits),
  );
  // ⚠️ 判据只查"**token 的哈希**有没有外泄"；`session_id` 是**应该**出现的
  //    （提交时前端要把它与 token 一起回传，见 parseMediaSession）。
  //    第一版用 `/_id\b/` 把它也拦了 ⇒ 判据比契约更严，属自造假红。
  check(
    '🔴 响应里**没有** token 的哈希 / 存储路径（session_id 是契约内的，不在其列）',
    !/hash|storage_key|uploads-private/.test(JSON.stringify(s.data ?? {})),
    Object.keys(s.data ?? {}).join(','),
  );
}

// ===========================================================================
// ② 上传：类型 / 时长 / 数量 / 大小 / 幂等
// ===========================================================================
console.log('');
console.log('── ② 上传（契约校验）────────────────────────────────────────');
let imgSession;
{
  imgSession = await newSession();
  const tok = imgSession.data.session_token;
  const buf = fs.readFileSync(IMG_A);

  const up1 = await upload(tok, buf, 'a.png');
  check('上传真图片 ⇒ 200 且回类型/尺寸', up1.status === 200 && up1.payload?.kind === 'image' && up1.payload?.width > 0, `HTTP ${up1.status} ${JSON.stringify(up1.payload ?? up1.errors[0])}`);

  check(
    '🔴 响应里**不含** storage_key / 绝对路径（客户不能推出文件位置）',
    !/storage_key|uploads-private|\/app\//.test(JSON.stringify(up1.payload ?? {})),
    Object.keys(up1.payload ?? {}).join(','),
  );

  const up2 = await upload(tok, buf, 'a.png');
  check(
    '🔴 同一内容重复上传 ⇒ 幂等复用（reused=true 且 id 相同，库内不新增行）',
    up2.status === 200 && up2.payload?.reused === true && up2.payload?.id === up1.payload?.id,
    `reused=${up2.payload?.reused} id ${up2.payload?.id} vs ${up1.payload?.id}`,
  );

  const disguised = await upload(tok, Buffer.from('MZ\x90\x00 this is not an image'), 'virus.jpg');
  check('🔴 伪装类型（.exe 改名 .jpg）⇒ 415 UNSUPPORTED_MEDIA（判定看 magic bytes）', disguised.status === 415 && disguised.errors[0]?.code === 'UNSUPPORTED_MEDIA', `HTTP ${disguised.status} ${disguised.errors[0]?.code ?? ''}`);

  const noToken = await upload('', buf, 'a.png');
  check('无会话 token 上传 ⇒ 401', noToken.status === 401, `HTTP ${noToken.status}`);

  const noDur = await upload(tok, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]), 'x.webm');
  check(
    '🔴 音视频**解析不出时长** ⇒ 422（fail-closed，不靠客户端声明放行）',
    noDur.status === 422 && noDur.errors[0]?.code === 'DURATION_UNREADABLE',
    `HTTP ${noDur.status} ${noDur.errors[0]?.code ?? ''}`,
  );

  // ===========================================================================
  // webm：**真实浏览器字节** + 双向伪装反向验证（用户第三批第一条）
  // ===========================================================================
  // 契约：类别与时长**一律从文件内容判定**（Tracks 里的 TrackType + Info 里的 Duration）；
  //       客户端声明的 mime / 文件名 / declared_kind **都不参与**限制计算。
  const sessRealAudio = await newSession();
  const realAudio = await upload(sessRealAudio.data.session_token, REAL_AUDIO, 'rec.webm');
  check(
    '🔴 真实 Chromium 录音（audio/webm;codecs=opus）⇒ 200，按**内容**判为 audio',
    realAudio.status === 200 &&
      realAudio.payload?.kind === 'audio' &&
      realAudio.payload?.duration_ms >= REAL_DURATION_MIN &&
      realAudio.payload?.duration_ms <= REAL_DURATION_MAX,
    `HTTP ${realAudio.status} ${JSON.stringify(realAudio.payload ?? realAudio.errors[0])}（浏览器自报 ${REAL_META.files['audio-chrome.webm'].mime}）`,
  );

  const sessRealVideo = await newSession();
  const realVideo = await upload(sessRealVideo.data.session_token, REAL_VIDEO, 'rec.webm');
  check(
    '🔴 真实 Chromium 录像（**两条轨道** audio+video）⇒ 200，按内容判为 video',
    realVideo.status === 200 && realVideo.payload?.kind === 'video',
    `HTTP ${realVideo.status} ${JSON.stringify(realVideo.payload ?? realVideo.errors[0])}`,
  );

  // ---------- 双向伪装：MIME 与文件名都不参与判定 ----------
  const sessDisguise1 = await newSession();
  const videoAsAudio = await upload(sessDisguise1.data.session_token, REAL_VIDEO, 'voice.webm', {
    declared_mime_spoof: 'audio/webm',
  });
  check(
    '🔴 **视频伪装成 audio**（文件名 voice.webm + multipart 声明 audio/webm）⇒ 仍按内容判为 **video**',
    videoAsAudio.status === 200 && videoAsAudio.payload?.kind === 'video',
    `HTTP ${videoAsAudio.status} kind=${videoAsAudio.payload?.kind ?? videoAsAudio.errors[0]?.code}`,
  );

  const sessDisguise2 = await newSession();
  const audioAsVideo = await upload(sessDisguise2.data.session_token, REAL_AUDIO, 'clip.mp4', {
    declared_mime_spoof: 'video/mp4',
  });
  check(
    '🔴 **音频伪装成 video**（文件名 clip.mp4 + 声明 video/mp4）⇒ 仍按内容判为 **audio**',
    audioAsVideo.status === 200 && audioAsVideo.payload?.kind === 'audio',
    `HTTP ${audioAsVideo.status} kind=${audioAsVideo.payload?.kind ?? audioAsVideo.errors[0]?.code}`,
  );

  // ---------- 上限按**内容判定出的类别**走 ----------
  // 把真实录像截断/延长做不到 ⇒ 用"内容判为 video 的字节 + 声明 audio"验证上限仍按 video。
  // 真实录像只有 ~3 秒，不足以触发 30 秒上限 ⇒ 这里用「内容=video」这一事实
  // 去证明"上限选择跟随内容"，具体阈值由上面 VIDEO_TOO_LONG / AUDIO_TOO_LONG 两条覆盖。
  const sessDisguise3 = await newSession();
  const videoAsAudioLimit = await upload(sessDisguise3.data.session_token, REAL_VIDEO, 'voice.webm', {
    declared_mime_spoof: 'audio/webm',
  });
  const videoLimitMs = 30_000;
  const audioLimitMs = 60_000;
  check(
    '🔴 伪装成 audio 的**视频**其上限仍按 video（30 秒）而不是 audio（60 秒）',
    videoAsAudioLimit.status === 200 && videoAsAudioLimit.payload?.kind === 'video',
    `内容判为 ${videoAsAudioLimit.payload?.kind} ⇒ 上限取 ${videoAsAudioLimit.payload?.kind === 'video' ? videoLimitMs : audioLimitMs}ms`,
  );

  // ---------- 上限：由**内容判定出的类别**决定，且边界两侧都要验 ----------
  // 语音 59 秒 ⇒ 放行（60 秒上限内）
  const sessA59 = await newSession();
  const a59 = await upload(sessA59.data.session_token, REAL_AUDIO_59S, 'a.webm');
  check(
    '🔴 真实录音派生 · 语音 **59 秒** ⇒ 200（60 秒上限内必须放行 —— 证明不是"一律拒"）',
    a59.status === 200 && a59.payload?.kind === 'audio' && a59.payload?.duration_ms === 59000,
    `HTTP ${a59.status} ${JSON.stringify(a59.payload ?? a59.errors[0])}`,
  );

  const sessA75 = await newSession();
  const a75 = await upload(sessA75.data.session_token, REAL_AUDIO_75S, 'a.webm');
  check(
    '🔴 真实录音派生 · 语音 **75 秒** ⇒ 413 AUDIO_TOO_LONG（语音上限 60 秒）',
    a75.status === 413 && a75.errors[0]?.code === 'AUDIO_TOO_LONG',
    `HTTP ${a75.status} ${a75.errors[0]?.code ?? ''}`,
  );

  const sessV29 = await newSession();
  const v29 = await upload(sessV29.data.session_token, REAL_VIDEO_29S, 'v.webm');
  check(
    '🔴 真实录像派生 · 视频 **29 秒** ⇒ 200 且 kind=video（30 秒上限内必须放行）',
    v29.status === 200 && v29.payload?.kind === 'video' && v29.payload?.duration_ms === 29000,
    `HTTP ${v29.status} ${JSON.stringify(v29.payload ?? v29.errors[0])}`,
  );

  const sessV45 = await newSession();
  const v45 = await upload(sessV45.data.session_token, REAL_VIDEO_45S, 'v.webm');
  check(
    '🔴 真实录像派生 · 视频 **45 秒** ⇒ 413 VIDEO_TOO_LONG（视频上限 30 秒）',
    v45.status === 413 && v45.errors[0]?.code === 'VIDEO_TOO_LONG',
    `HTTP ${v45.status} ${v45.errors[0]?.code ?? ''}`,
  );

  // ---------- 超时长 + 伪装：上限必须跟随**内容**而不是声明 ----------
  const sessV45AsAudio = await newSession();
  const v45AsAudio = await upload(sessV45AsAudio.data.session_token, REAL_VIDEO_45S, 'voice.webm', {
    declared_mime_spoof: 'audio/webm',
  });
  check(
    '🔴 **45 秒视频伪装成 audio** ⇒ 413 VIDEO_TOO_LONG（若按声明走会放行到 60 秒）',
    v45AsAudio.status === 413 && v45AsAudio.errors[0]?.code === 'VIDEO_TOO_LONG',
    `HTTP ${v45AsAudio.status} ${v45AsAudio.errors[0]?.code ?? ''}`,
  );

  const sessA75AsVideo = await newSession();
  const a75AsVideo = await upload(sessA75AsVideo.data.session_token, REAL_AUDIO_75S, 'clip.mp4', {
    declared_mime_spoof: 'video/mp4',
  });
  check(
    '🔴 **75 秒语音伪装成 video** ⇒ 413 AUDIO_TOO_LONG（按内容走 60 秒上限，不是 30 秒）',
    a75AsVideo.status === 413 && a75AsVideo.errors[0]?.code === 'AUDIO_TOO_LONG',
    `HTTP ${a75AsVideo.status} ${a75AsVideo.errors[0]?.code ?? ''}`,
  );

  // ---------- 无法识别 ⇒ 安全拒绝 ----------
  const sessJunk = await newSession();
  const junk = await upload(sessJunk.data.session_token, Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // 像 EBML 头
    Buffer.alloc(400, 0x00), // 但内部没有任何可解析结构
  ]), 'broken.webm');
  check(
    '🔴 无法可靠识别类别/时长的文件 ⇒ **安全拒绝**（不是放行）',
    junk.status === 422 || junk.status === 415,
    `HTTP ${junk.status} ${junk.errors[0]?.code ?? ''}`,
  );

  const sessNoDur = await newSession();
  const noDuration = await upload(
    sessNoDur.data.session_token,
    Buffer.concat([REAL_AUDIO.subarray(0, 168), Buffer.alloc(200, 0x00)]),
    'nodur.webm',
  );
  check(
    '🔴 有 Tracks 但**读不出时长** ⇒ 422（fail-closed，不按"没超时"放行）',
    noDuration.status === 422,
    `HTTP ${noDuration.status} ${noDuration.errors[0]?.code ?? ''}`,
  );

  // 语音 61 秒（真实 WAV 字节）
  const sess2 = await newSession();
  const audio = await upload(sess2.data.session_token, WAV_61, 'voice.wav');
  check(
    '🔴 语音 61 秒 ⇒ 413 AUDIO_TOO_LONG（契约上限 60 秒，按容器解析的时长判）',
    audio.status === 413 && audio.errors[0]?.code === 'AUDIO_TOO_LONG',
    `HTTP ${audio.status} ${audio.errors[0]?.code ?? ''}（WAV 61s / ${WAV_61.length} 字节）`,
  );

  // 视频 29 秒放行 / 31 秒拒（同一段拼装器，只差 mvhd 的 duration）
  const sess3 = await newSession();
  const okVid = await upload(sess3.data.session_token, MP4_29, 'ok.mp4');
  check('视频 29 秒 ⇒ 200 且回 duration_ms', okVid.status === 200 && okVid.payload?.kind === 'video' && okVid.payload?.duration_ms === 29000, `HTTP ${okVid.status} ${JSON.stringify(okVid.payload ?? okVid.errors[0])}`);

  const sess4 = await newSession();
  const longVid = await upload(sess4.data.session_token, MP4_31, 'long.mp4');
  check('🔴 视频 31 秒 ⇒ 413 VIDEO_TOO_LONG（契约上限 30 秒）', longVid.status === 413 && longVid.errors[0]?.code === 'VIDEO_TOO_LONG', `HTTP ${longVid.status} ${longVid.errors[0]?.code ?? ''}`);

  // 图片数量上限（第 4 张被拒）
  const sess5 = await newSession();
  const t5 = sess5.data.session_token;
  // ⚠️ 三张必须是**内容不同**的图：第一版用 `imgs[i % 3]`（第 1 张与第 3 张相同），
  //    于是第 3 次上传命中**幂等复用**（库里仍只有 2 张）⇒ 第 4 次也不触发上限。
  //    现象是"上限用例永远测不到"，而不是"上限没生效"。
  const imgs = [
    fs.readFileSync(IMG_A),
    fs.readFileSync(IMG_B),
    makePng(48, 32, [0x33, 0x99, 0xcc]),
    // ⚠️ 第四张必须是**新的合法图**：第一版写 imgs[i] 但数组只有 3 项 ⇒ i=3 越界成
    //    undefined ⇒ new Blob([undefined]) 传了 4 字节 "undefined" ⇒ 服务端
    //    如实回了 415 UNSUPPORTED_MEDIA。**上限用例被自己的测试数据挡掉了**。
    makePng(40, 40, [0xcc, 0x66, 0x33]),
  ];
  const codes = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await upload(t5, imgs[i], `p${i}.png`);
    codes.push(`${r.status}${r.errors[0]?.code ? '/' + r.errors[0].code : ''}`);
  }
  check('🔴 第 4 张图片 ⇒ 409 IMAGE_COUNT_LIMIT（1~3 张是冻结契约）', codes[3].includes('IMAGE_COUNT_LIMIT'), codes.join(' → '));

  // 超大小
  const sess6 = await newSession();
  const big = Buffer.alloc(9 * 1024 * 1024, 0x41);
  const bigRes = await upload(sess6.data.session_token, big, 'big.png');
  check('超 8MB ⇒ 413（图片也会先被字节数挡下）', bigRes.status === 413, `HTTP ${bigRes.status} ${bigRes.errors[0]?.code ?? ''}`);
}

// ===========================================================================
// ③ 提交：媒体绑定 + 进度 Token + 短信
// ===========================================================================
console.log('');
console.log('── ③ 提交（媒体绑定 + 进度 Token + 短信）────────────────────');
let ticket;
let sessionForTicket;
{
  sessionForTicket = await newSession();
  const tok = sessionForTicket.data.session_token;
  const a = await upload(tok, fs.readFileSync(IMG_A), 'x1.png');
  const b = await upload(tok, fs.readFileSync(IMG_B), 'x2.png');
  const mediaIds = [a.payload?.id, b.payload?.id].filter(Boolean);

  const mobile = nextMobile();
  const r = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': newRequestId() },
    body: {
      ticket_type: 'repair',
      content: `合成验收：带两张照片 ${RUN}`,
      customer_name: '合成客户',
      customer_mobile: mobile,
      media_session: { id: sessionForTicket.data.session_id, token: tok },
    },
  });
  ticket = r.payload;
  check('带媒体提交 ⇒ 201 且响应带 progress_token（43 字符）', r.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(ticket?.progress_token ?? ''), `HTTP ${r.status} ${ticket?.ticket_no ?? JSON.stringify(r.errors[0])}`);
  check('🔴 响应**只带 token 不带完整 URL**（完整 URL 更容易随日志/截图泄露凭证）', ticket && !('progress_url' in ticket), Object.keys(ticket ?? {}).join(','));

  const bound = psql(
    `SELECT count(*), count(*) FILTER (WHERE ticket_id IS NOT NULL), count(DISTINCT ticket_id)
       FROM customer_medias WHERE id IN (${mediaIds.join(',') || 0})`,
  ).split('|').map(Number);
  check('🔴 媒体确实归属到这张工单（库内核对：总数|已绑|不同工单数 = 2|2|1）', bound[0] === 2 && bound[1] === 2 && bound[2] === 1, bound.join('|'));

  // ⚠️ 短信是**异步 flush** 的（既有 outbox 的行为），刚入队那一刻表里可能还没有行。
  //    ⇒ 轮询若干秒再断言。第一版只查一次 ⇒ 报"(无)"，
  //    看起来像"没走 outbox"，实际只是查得太早。
  // ⚠️ 窗口给到 **45 秒**：SmsService.enqueue() 只把 pending 放进内存，
  //    落库由既有的 flush/回执调度器完成（实测延迟可达十几秒）。
  //    第一版只等 15 秒 ⇒ 报"未入队"，看起来像"没走既有 outbox"。
  let smsScene = '';
  for (let i = 0; i < 40; i += 1) {
    // ⚠️ `GROUP BY 1` 在这里指**第一列输出**（scene||'|'||count(*)），
    //    PostgreSQL 拒绝"按聚合结果分组" ⇒ 整条语句报错（见 psql() 的注释）。
    //    合法写法：`string_agg(scene, '|' ORDER BY scene)` 配一个 count。
    smsScene = psql(
      `SELECT string_agg(scene, ',' ORDER BY scene) || '#' || count(*)
         FROM sms_logs
        WHERE ticket_id = (SELECT id FROM service_tickets WHERE ticket_no='${ticket?.ticket_no}')`,
    );
    if (/progress_link/.test(smsScene)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check(
    '进度链接短信走**既有 outbox**（scene=progress_link），没有第二套发送体系',
    /(^|,)progress_link(,|#)/.test(smsScene.trim()) && /#1$/.test(smsScene.trim()),
    smsScene ||
      `(轮询 120 秒未见落库；工单=${ticket?.ticket_no ?? '(无)'}；末次查询原文=${JSON.stringify(smsScene)})`,
  );

  const sessionState = psql(`SELECT status || '|' || coalesce(ticket_id::text,'') FROM customer_media_sessions WHERE id=${sessionForTicket.data.session_id}`);
  check('会话在提交后转为 bound 并记了工单（可被审计）', /^bound\|\d+$/.test(sessionState), sessionState);
}

// ===========================================================================
// ④ 进度查询：能看到自己的单 + 四种失效都查不到
// ===========================================================================
console.log('');
console.log('── ④ 进度查询（输出裁剪 + 失效形态）────────────────────────');
{
  const pt = ticket.progress_token;
  const p = await api(`/api/public/progress/${pt}`);
  const text = JSON.stringify(p.payload ?? {});
  check('有效 Token ⇒ 200 且回单号/门店名/状态/时间线/媒体', p.status === 200 && p.payload?.ticket_no === ticket.ticket_no && Array.isArray(p.payload?.timeline) && p.payload?.store_name, `HTTP ${p.status}`);
  check('🔴 响应**不暴露**内部字段（操作人 / 审计 / 师傅 Token / storage_key / 其他列）', !/handler_user|operator_|feedback_token|progress_token_hash|storage_key|visit_token|internal/.test(text), text.length + ' 字节');

  const forged = await api(`/api/public/progress/${'A'.repeat(43)}`);
  check('🔴 伪造 Token（43 字符但不存在）⇒ 401 PROGRESS_TOKEN_INVALID', forged.status === 401 && forged.errors[0]?.code === 'PROGRESS_TOKEN_INVALID', `HTTP ${forged.status} ${forged.errors[0]?.code ?? ''}`);

  const shortTok = await api('/api/public/progress/abc');
  check('🔴 过短 Token ⇒ nginx 直接 404（畸形短链不回应用，与 /f/ 同构）', shortTok.status === 404, `HTTP ${shortTok.status}`);

  // 撤销
  psql(`UPDATE service_tickets SET progress_token_revoked_at = now() WHERE ticket_no='${ticket.ticket_no}'`);
  const revoked = await api(`/api/public/progress/${pt}`);
  check('🔴 已撤销 Token ⇒ 401（与"不存在"同一响应，不构成存在性探测）', revoked.status === 401 && revoked.errors[0]?.code === 'PROGRESS_TOKEN_INVALID', `HTTP ${revoked.status} ${revoked.errors[0]?.code ?? ''}`);
  psql(`UPDATE service_tickets SET progress_token_revoked_at = NULL WHERE ticket_no='${ticket.ticket_no}'`);

  // 关闭后 30 天（**按真实服务端时间**判：改 closed_at，不改有效期列）
  const ticketId = psql(`SELECT id FROM service_tickets WHERE ticket_no='${ticket.ticket_no}'`);
  psql(`UPDATE service_tickets SET closed_at = now() - interval '29 days' WHERE id=${ticketId}`);
  const within = await api(`/api/public/progress/${pt}`);
  check('关闭 29 天 ⇒ 仍可查（保留期 30 天）', within.status === 200, `HTTP ${within.status}`);

  psql(`UPDATE service_tickets SET closed_at = now() - interval '31 days' WHERE id=${ticketId}`);
  const expired = await api(`/api/public/progress/${pt}`);
  check('🔴 关闭 31 天 ⇒ 401（超过保留期）', expired.status === 401, `HTTP ${expired.status}`);

  psql(`UPDATE service_tickets SET closed_at = NULL WHERE id=${ticketId}`);
  const reopened = await api(`/api/public/progress/${pt}`);
  check('未关闭的工单不因保留期失效（关闭前一直可查）', reopened.status === 200, `HTTP ${reopened.status}`);
}

// ===========================================================================
// ⑤ 媒体读取：两种凭证 + 越权
// ===========================================================================
console.log('');
console.log('── ⑤ 媒体受控读取 ──────────────────────────────────────────');
{
  const mediaId = psql(`SELECT id FROM customer_medias WHERE ticket_id = (SELECT id FROM service_tickets WHERE ticket_no='${ticket.ticket_no}') ORDER BY id LIMIT 1`);
  const pt = ticket.progress_token;

  const withProgress = await fetch(`${SVC_BASE_URL}/api/public/media/files/${mediaId}`, { headers: { 'X-Progress-Token': pt } });
  const bytes = (await withProgress.arrayBuffer()).byteLength;
  check('进度 Token ⇒ 200 且真的读到字节（文件可安全读取）', withProgress.status === 200 && bytes > 0, `HTTP ${withProgress.status} ${bytes} 字节 ${withProgress.headers.get('content-type')}`);
  // ⚠️ nginx 也会加 X-Content-Type-Options，`headers.get()` 返回的是**合并值**
  //    （实测 "nosniff, nosniff"）⇒ 用 === 判会假红。改成"包含"。
  check(
    '🔴 读取响应禁缓存（private, no-store）且禁嗅探',
    /no-store/.test(withProgress.headers.get('cache-control') ?? '') &&
      /nosniff/.test(withProgress.headers.get('x-content-type-options') ?? ''),
    `${withProgress.headers.get('cache-control')} / ${withProgress.headers.get('x-content-type-options')}`,
  );

  const other = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': newRequestId() },
    body: { ticket_type: 'repair', content: `合成验收：别家单 ${RUN}`, customer_name: '合成客户乙', customer_mobile: nextMobile() },
  });
  const otherPt = other.payload?.progress_token;
  const cross = await fetch(`${SVC_BASE_URL}/api/public/media/files/${mediaId}`, { headers: { 'X-Progress-Token': otherPt } });
  check('🔴 别人的进度 Token 读这家的媒体 ⇒ 404（不能因为"token 有效"就放行）', cross.status === 404, `HTTP ${cross.status}`);

  const noCred = await fetch(`${SVC_BASE_URL}/api/public/media/files/${mediaId}`);
  check('🔴 无凭证 ⇒ 401（不告诉调用方"这个 id 存不存在"）', noCred.status === 401, `HTTP ${noCred.status}`);

  const missing = await fetch(`${SVC_BASE_URL}/api/public/media/files/99999999`, { headers: { 'X-Progress-Token': pt } });
  check('不存在的 id 与无权限**同一状态码**（不构成探测器）', missing.status === 404, `HTTP ${missing.status}`);
}

// ===========================================================================
// ⑤.5 Token 隔离与幂等（用户第三批第四条闭环）
// ===========================================================================
console.log('');
console.log('── ⑤.5 Token 隔离 / 幂等 ──────────────────────────────────');
{
  const pt = ticket.progress_token;

  // ---- ① 进度 Token 与评价 Token **互不接受** ----
  // 评价接口只认评价 Token（一次性、不可撤销）；进度接口只认进度 Token（可重复、可撤销）。
  // 拿进度 Token 去调评价接口必须被拒 —— 否则"查进度"顺手获得"评价资格"（越权）。
  const progressAsReview = await fetch(`${SVC_BASE_URL}/api/public/reviews/${pt}`, { method: 'GET' }).then(
    async (r) => ({ status: r.status, text: await r.text() }),
  );
  check(
    '🔴 进度 Token 拿去调**评价**接口 ⇒ 被拒（两套凭证互不接受）',
    progressAsReview.status === 401 || progressAsReview.status === 404,
    `HTTP ${progressAsReview.status}`,
  );

  // 反向：伪造一枚"像评价 Token"的值调进度接口，也必须被拒
  const reviewLikeAsProgress = await api(`/api/public/progress/${'B'.repeat(43)}`);
  check(
    '🔴 伪造值调**进度**接口 ⇒ 401（不因为形状合法就放行）',
    reviewLikeAsProgress.status === 401,
    `HTTP ${reviewLikeAsProgress.status} ${reviewLikeAsProgress.errors[0]?.code ?? ''}`,
  );

  // 两种 Token 在库内是**不同的列**（结构性隔离，不是"靠代码记得分开"）
  const cols = psql(
    `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
      WHERE table_name='service_tickets' AND column_name LIKE '%token%'`,
  );
  check(
    '🔴 进度 Token 与评价 Token 落在**不同的列**（结构性隔离，不是靠约定）',
    /feedback_token_hash/.test(cols) && /progress_token_hash/.test(cols) && cols.includes(','),
    cols,
  );

  // ---- ② 重复提交（同 request_id）⇒ 幂等回放，不产生第二张工单 ----
  const sharedRid = newRequestId();
  const mobileForIdem = nextMobile();
  const idemBody = {
    ticket_type: 'repair',
    content: `合成验收：幂等核对 ${RUN}`,
    customer_name: '合成客户幂等',
    customer_mobile: mobileForIdem,
  };
  const first = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': sharedRid },
    body: idemBody,
  });
  const second = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': sharedRid },
    body: idemBody,
  });
  check(
    '🔴 同一 request_id 重复提交 ⇒ 第二次是 **200 回放**且单号相同（不建第二张工单）',
    first.status === 201 &&
      second.status === 200 &&
      second.payload?.ticket_no === first.payload?.ticket_no,
    `首次 ${first.status} ${first.payload?.ticket_no ?? ''} / 重放 ${second.status} ${second.payload?.ticket_no ?? ''}`,
  );

  const idemTicketCount = psqlNum(
    `SELECT count(*) FROM service_tickets WHERE customer_mobile='${mobileForIdem}'`,
  );
  check(
    '🔴 库内**只有一张**工单（幂等不是"接口看起来一样"）',
    idemTicketCount === 1,
    `该手机号下有 ${idemTicketCount} 张工单`,
  );

  // ---- ③ 重复提交**带媒体**：材料不重复关联（幂等复用同一行） ----
  const idemSession = await newSession();
  const idemTok = idemSession.data.session_token;
  const firstUp = await upload(idemTok, REAL_AUDIO, 'idem.webm');
  const secondUp = await upload(idemTok, REAL_AUDIO, 'idem.webm');
  check(
    '🔴 同一会话重复上传同一内容 ⇒ 复用同一行（reused=true 且 id 相同）',
    firstUp.status === 200 && secondUp.payload?.reused === true && secondUp.payload?.id === firstUp.payload?.id,
    `id ${firstUp.payload?.id} → ${secondUp.payload?.id} reused=${secondUp.payload?.reused}`,
  );
  const mediaRowCount = psqlNum(
    `SELECT count(*) FROM customer_medias WHERE session_id=${idemSession.data.session_id}`,
  );
  check('🔴 库内该会话**只有一行**媒体（重复上传不产生第二条）', mediaRowCount === 1, `实际 ${mediaRowCount} 行`);

  // ---- ④ 重复提交整张单（带媒体）⇒ 材料仍只绑一次 ----
  const rid2 = newRequestId();
  const mobile2 = nextMobile();
  const s2 = await newSession();
  const tok2 = s2.data.session_token;
  await upload(tok2, REAL_AUDIO, 'x.webm');
  const bodyWithMedia = {
    ticket_type: 'repair',
    content: `合成验收：带媒体幂等 ${RUN}`,
    customer_name: '合成客户媒体幂等',
    customer_mobile: mobile2,
    media_session: { id: s2.data.session_id, token: tok2 },
  };
  const c1 = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': rid2 },
    body: bodyWithMedia,
  });
  const c2 = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': rid2 },
    body: bodyWithMedia,
  });
  const boundMediaCount = psqlNum(
    `SELECT count(*) FROM customer_medias WHERE ticket_id = (SELECT id FROM service_tickets WHERE ticket_no='${c1.payload?.ticket_no}')`,
  );
  check(
    '🔴 带媒体重复提交 ⇒ 工单不重复、材料仍只关联 1 份',
    c1.status === 201 && c2.status === 200 && boundMediaCount === 1,
    `HTTP ${c1.status}/${c2.status}，绑定媒体 ${boundMediaCount} 份`,
  );

  // ---- ⑤ 重新打开页面（换新会话）= 不会把旧材料算进来 ----
  const sNew = await newSession();
  const newSessionCount = psqlNum(`SELECT count(*) FROM customer_medias WHERE session_id=${sNew.data.session_id}`);
  check(
    '重新打开页面拿到的是**空的新会话**（旧材料不会被算进新单）',
    newSessionCount === 0,
    `新会话内媒体数 ${newSessionCount}`,
  );
}

// ===========================================================================
// ⑥ 会话过期 / 已绑定 ⇒ 不能再上传（未完成上传的清理入口）
// ===========================================================================
console.log('');
console.log('── ⑥ 会话生命周期 ─────────────────────────────────────────');
{
  const s = await newSession();
  const sid = s.data.session_id;
  const tok = s.data.session_token;
  // 让它过期（本轮自己造的合成会话，可安全改）
  psql(`UPDATE customer_media_sessions SET expires_at = now() - interval '1 minute' WHERE id=${sid}`);
  const expiredUpload = await upload(tok, fs.readFileSync(IMG_A), 'a.png');
  check('🔴 过期会话上传 ⇒ 409 SESSION_UNAVAILABLE（惰过期，不落文件）', expiredUpload.status === 409 && expiredUpload.errors[0]?.code === 'SESSION_UNAVAILABLE', `HTTP ${expiredUpload.status} ${expiredUpload.errors[0]?.code ?? ''}`);
  const stateAfter = psql(`SELECT status FROM customer_media_sessions WHERE id=${sid}`);
  check('过期会话被标记为 expired（可被清理任务发现）', stateAfter === 'expired', stateAfter);

  // 已绑定会话再上传
  const boundUp = await upload(sessionForTicket.data.session_token, fs.readFileSync(IMG_B), 'again.png');
  check('🔴 已绑定的会话再上传 ⇒ 409 SESSION_UNAVAILABLE（提交后材料不可再改）', boundUp.status === 409, `HTTP ${boundUp.status} ${boundUp.errors[0]?.code ?? ''}`);

  // 提交端：会话 token 无效 ⇒ 拒
  const badSessionTicket = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': newRequestId() },
    body: {
      ticket_type: 'repair',
      content: `合成验收：会话无效 ${RUN}`,
      customer_name: '合成客户丙',
      customer_mobile: nextMobile(),
      media_session: { id: sessionForTicket.data.session_id, token: 'x'.repeat(43) },
    },
  });
  check('🔴 提交时会话 token 不匹配 ⇒ 409 MEDIA_SESSION_UNAVAILABLE（不能把材料挂到别人会话）', badSessionTicket.status === 409 && badSessionTicket.errors[0]?.code === 'MEDIA_SESSION_UNAVAILABLE', `HTTP ${badSessionTicket.status} ${badSessionTicket.errors[0]?.code ?? ''}`);

  // "文字或媒体至少一种"
  const emptySess = await newSession();
  const emptyBody = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': newRequestId() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '合成客户丁',
      customer_mobile: nextMobile(),
      media_session: { id: emptySess.data.session_id, token: emptySess.data.session_token },
    },
  });
  check('🔴 会话里一个文件都没有 + 文字为空 ⇒ 422 TEXT_OR_MEDIA_REQUIRED', emptyBody.status === 422 && emptyBody.errors[0]?.code === 'TEXT_OR_MEDIA_REQUIRED', `HTTP ${emptyBody.status} ${emptyBody.errors[0]?.code ?? ''}`);

  // 纯文字（无媒体会话）照常提交
  const textOnly = await api('/api/public/tickets?k=S01', {
    method: 'POST',
    headers: { 'X-Request-Id': newRequestId() },
    body: { ticket_type: 'repair', content: `合成验收：纯文字 ${RUN}`, customer_name: '合成客户戊', customer_mobile: nextMobile() },
  });
  check('纯文字提交（不带 media_session）照常 201（媒体是增强不是门槛）', textOnly.status === 201, `HTTP ${textOnly.status} ${textOnly.errors[0]?.code ?? ''}`);
}

// ===========================================================================
// ⑦ 门店隔离：S01 媒体对 S02 不可见（两个真实门店账号）
// ===========================================================================
console.log('');
console.log('── ⑦ 门店隔离（两个真实门店账号）────────────────────────────');
{
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const envValue = (k, d = '') => {
    const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : d;
  };
  const pwA = envValue('UAT_STORE_A_PASSWORD');
  const pwB = envValue('UAT_STORE_B_PASSWORD');
  if (!pwA || !pwB) {
    warn('缺少 UAT_STORE_A_PASSWORD / UAT_STORE_B_PASSWORD ⇒ 跳过门店隔离的正向登录用例（本机 .env 未配这两个账号）');
  } else {
    const login = async (email, password) => {
      const r = await api('/api/auth:signIn', { method: 'POST', body: { email, password } });
      return r.payload?.token ?? '';
    };
    // ⚠️ 默认域名必须是 **`@svc.local`**（本机 UAT 账号的实际域名）。
    //    第一版写 example.com ⇒ 登录必然失败，看起来像"权限隔离用例有问题"。
    const emailA = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
    const emailB = envValue('UAT_STORE_B_EMAIL', 'uat.store.b@svc.local');
    const tokA = await login(emailA, pwA);
    const tokB = await login(emailB, pwB);
    check(
      '两个真实门店账号登录成功（UAT-A=S01 / UAT-B=S02）',
      Boolean(tokA && tokB),
      `${emailA}=${tokA ? 'ok' : 'fail'} · ${emailB}=${tokB ? 'ok' : 'fail'}`,
    );

    if (tokA && tokB) {
      // 媒体读取**只认**会话 token / 进度 token，门店账号不是其中之一
      const mediaId = psql(`SELECT id FROM customer_medias WHERE ticket_id = (SELECT id FROM service_tickets WHERE ticket_no='${ticket.ticket_no}') ORDER BY id LIMIT 1`);
      const asStore = await fetch(`${SVC_BASE_URL}/api/public/media/files/${mediaId}`, { headers: { Authorization: `Bearer ${tokB}` } });
      check('🔴 门店账号的登录态**不能**当媒体读取凭证（跨主体一律 401）', asStore.status === 401, `HTTP ${asStore.status}`);

      const asProgressToken = await api(`/api/public/progress/${tokB}`);
      // ⚠️ JWT 里含 `.`，**不匹配** nginx 的 `progress/([A-Za-z0-9_-]{43})`
      //    ⇒ 请求原样到应用、resourcer 找不到资源 ⇒ **404**（不是 401）。
      //    这与 `/f/` 的畸形短链行为一致（nginx 不把非法形状交给应用）。
      //    ⇒ 判据接受 401（形状合法但 Token 无效）与 404（形状非法），并说明是哪一种。
      check(
        '🔴 把门店 JWT 当进度 Token 用 ⇒ 被拒（401/404，两套凭证互不接受）',
        asProgressToken.status === 401 || asProgressToken.status === 404,
        `HTTP ${asProgressToken.status} ${asProgressToken.errors[0]?.code ?? '(nginx 未重写)'}（JWT 含 "." 不匹配 43 字符形状）`,
      );
    }
  }
}

// ===========================================================================
// ⑧ nginx 短链与常量对齐（双维护点必须有门禁）
// ===========================================================================
console.log('');
console.log('── ⑧ /p/ 短链与常量对齐 ─────────────────────────────────────');
{
  const conf = fs.readFileSync(path.join(ROOT, 'nginx/conf.d/service.conf'), 'utf8');
  const constantsSrc = fs.readFileSync(
    path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
    'utf8',
  );
  const bytes = Number((constantsSrc.match(/PROGRESS_TOKEN_BYTES = (\d+)/) ?? [])[1] ?? -1);
  const expectedLen = Math.ceil((bytes * 4) / 3);
  const shortlink = new RegExp(`\\^/p/\\(\\?<svc_progress_token>\\[A-Za-z0-9_-\\]\\{${expectedLen}\\}\\)\\$`);
  check(`nginx 的 /p/ 形状与 PROGRESS_TOKEN.LENGTH（${expectedLen}，由 ${bytes} 字节推导）一致`, shortlink.test(conf), `期望 {${expectedLen}}`);
  check('nginx /p/ 与 /f/ 一样禁 access_log + 302（禁 301）+ 畸形 404 兜底', /location \/p\/ \{[\s\S]*?access_log off;[\s\S]*?return 404;/.test(conf) && /access_log off;[\s\S]{0,80}absolute_redirect off;[\s\S]{0,40}return 302 \/h5\/customer\/progress/.test(conf), '');
}

// ===========================================================================
const failed = checks.filter((c) => !c.ok);
const warns = checks.filter((c) => c.warn);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  P11-4 接口门禁：${checks.length - failed.length - warns.length}/${checks.length - warns.length} 通过`);
if (warns.length) console.log(`  另有 ${warns.length} 条已知限制（见上）`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);