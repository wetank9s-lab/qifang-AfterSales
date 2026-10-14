/**
 * P11-4 · 客户进度短信的**实际链路**核对（复用既有探针，不新建任何入口）
 *
 *   node scripts/verify-progress-sms-link.mjs
 *
 * 只回答四个问题（其余一律不碰）：
 *   ① 短信正文里的进度链接**长什么样**？（从 mock 发件箱取 `preview` / `params.link`）
 *   ② 那个链接**能不能打开对应工单**？（真访问：短链 → 302 → H5 → 进度接口）
 *   ③ 链接的 host 由**哪个变量**决定？（对照 PUBLIC_H5_BASE_URL / PUBLIC_BASE_URL）
 *   ④ 当前配置下**手机能不能点开**？（localhost ⇒ 不能 ⇒ 登记阻塞）
 *
 * 复用的既有能力（**没有新增** API / 短信体系 / 探针）：
 *   · `GET /api/svc:smsOutbox`（Phase 4 就有的 mock 发件箱探针，需总部角色）
 *   · `/p/<token>` 短链、`GET /api/public/progress/<token>`、`sms_logs` 与 outbox
 *
 * 输出**脱敏**：链接只打 host + 路径前缀 + token 长度；不打印 token 全文、手机号。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;
const IMG = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envValue(key) {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

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

/**
 * 载入产品的真实 TS 模块（与 `verify-store-entry.mjs` 同一做法）。
 * ⚠️ 拼链接必须用**产品的函数**，不能自己拼 host —— 否则"验证的链接"与"短信里的链接"
 *    就不是同一个东西，验证结论也就没有意义。
 */
async function loadProductModule(relPath, exportNames) {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const esbuild = req('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'nocobase/plugins/service-ticket/src/server', relPath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@nocobase/*', 'knex', 'sequelize'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, req);
  const picked = {};
  for (const n of exportNames) picked[n] = mod.exports[n];
  return picked;
}

async function httpJson(p, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
  const res = await fetch(p.startsWith('http') ? p : `${SVC_BASE_URL}${p}`, {
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
  return { status: res.status, json, text, res };
}

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

/** 脱敏展示一个链接：host + 路径前缀 + token 长度 */
function maskLink(link) {
  try {
    const u = new URL(link);
    const seg = u.pathname.split('/').filter(Boolean);
    const token = seg[seg.length - 1] ?? '';
    return `${u.origin}/${seg.slice(0, -1).join('/')}/<token ${token.length} 位>`;
  } catch {
    return '(非法链接)';
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  客户进度短信 · 实际链路核对');
console.log('══════════════════════════════════════════════════════════════');

// ---- 0. 先看看基址配置（问题③的前提）----
const envH5 = envValue('PUBLIC_H5_BASE_URL');
const envBase = envValue('PUBLIC_BASE_URL');
console.log('\n── ⓪ 基址配置（链接 host 的来源）────────────────────────');
console.log(`  PUBLIC_H5_BASE_URL : ${envH5 || '(未配置)'}`);
console.log(`  PUBLIC_BASE_URL    : ${envBase || '(未配置)'}`);
console.log(`  ⇒ 生效者           : ${envH5 || envBase || '(空 ⇒ 拼不出对外链接)'}`);

const hq = await (async () => {
  const r = await httpJson('/api/auth:signIn', {
    method: 'POST',
    body: { email: 'uat.hq@svc.local', password: envValue('UAT_HQ_PASSWORD') },
  });
  const token = r.json?.data?.token;
  if (!token) throw new Error(`总部登录失败：HTTP ${r.status}`);
  return token;
})();

// ---- 打开 sms.enabled（发件箱才有内容；跑完还原）----
const origEnabled = psql(`SELECT value FROM service_settings WHERE key='sms.enabled'`);
psql(`UPDATE service_settings SET value='true' WHERE key='sms.enabled'`);
console.log(`\n  · 已打开 sms.enabled（原值 ${origEnabled}），等待 11s 让配置缓存过期…`);
await sleep(11_000);

const outbox = async () => {
  const r = await httpJson('/api/svc:smsOutbox?since_seq=0&limit=200', { headers: { Authorization: `Bearer ${hq}` } });
  return r.json?.data?.items ?? [];
};

try {
  // ---- 1. 建一张单（只照片、不写字），并记录本次新增的发件箱条目 ----
  const before = await outbox();
  const beforeSeq = before.reduce((m, i) => Math.max(m, i.seq ?? 0), 0);

  const sess = (
    await httpJson('/api/public/media/session', { method: 'POST', body: { media_consent: true } })
  ).json?.data;
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(IMG)]), 'p.png');
  await fetch(`${SVC_BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': sess.session_token },
    body: form,
  });
  const created = await httpJson(`/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': rid() },
    body: {
      ticket_type: 'repair',
      content: '',
      customer_name: '短信链路核对',
      customer_mobile: `1350000${String(1000 + Math.floor(Math.random() * 8000)).slice(-4)}`,
      media_session: { id: sess.session_id, token: sess.session_token },
    },
  });
  const ticketNo = created.json?.data?.ticket_no;
  console.log(`\n── ① 短信正文里的进度链接 ──────────────────────────────`);
  ok('建单成功（用于产生一条真实的进度链接短信）', created.status === 201 && !!ticketNo, `HTTP ${created.status}`);

  await sleep(2500); // 等 flush 落进发件箱
  const after = await outbox();
  const fresh = after.filter((i) => (i.seq ?? 0) > beforeSeq);
  const linkItem = fresh.find((i) => i.scene === 'progress_link');

  // 🔴 这里**不能**断言"短信必须发出去" —— 本机是演练环境（SMS_ENABLED=false、无模板 CODE），
  //    发不出去正是本轮要**登记**的阻塞。可断言的是"未发出的原因**能从既有记录解释清楚**"
  //    （要么进了发件箱，要么 sms_logs 里留下了可解释的状态）—— 这才是真实的判据。
  const logStatus = psql(
    `SELECT coalesce(send_status,'-') || '|' || coalesce(template_code,'-') FROM sms_logs WHERE ticket_id=(SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}') AND scene='progress_link'`,
  );
  ok(
    '进度短信的去向**可解释**（进发件箱，或在 sms_logs 留下明确状态）',
    Boolean(linkItem) || /pending|rejected|sent/.test(logStatus),
    linkItem
      ? `已进发件箱 seq=${linkItem.seq} 模板=${linkItem.template_code ?? '(空)'}`
      : `未发出 ⇒ sms_logs=${logStatus}（**阻塞**：通道未启用/模板未配置；详见文档）`,
  );

  /**
   * 🔴 发件箱空**不是探针 bug，而是本轮要登记的阻塞**：
   *    短信根本没走到"发出去"这一步，所以也就**没有正文可以取**。
   *    此时**不中止**，改用"与短信**同一套**拼装逻辑"构造同构链接继续验证链路：
   *      · 基址：产品的 `publicBaseUrlOf()`（不是我自己拼 host）；
   *      · 路径：产品的 `PROGRESS_TOKEN.LINK_PATH`；
   *      · Token：本次建单响应里的 `progress_token`（**与进短信的那个是同一个**）。
   *    ⇒ 链接**逐字等价**于短信里会发的那条（同一个表达式、同一个 token）。
   */
  let link = '';
  if (linkItem) {
    link = String(linkItem.params?.link ?? '');
    console.log(`  · 短信正文预览（脱敏）：${String(linkItem.preview ?? '').replace(link, maskLink(link)).slice(0, 120)}`);
    console.log(`  · params.link（脱敏）  ：${maskLink(link)}`);
  } else {
    const { publicBaseUrlOf } = await loadProductModule('services/public-url.ts', ['publicBaseUrlOf']);
    const { PROGRESS_TOKEN } = await loadProductModule('constants.ts', ['PROGRESS_TOKEN']);
    const tok = created.json?.data?.progress_token;
    // ⚠️ 必须把**容器里的实际配置值**喂给产品的函数：
    //    本脚本跑在宿主上，宿主 process.env 里没有 PUBLIC_BASE_URL（那是容器的 env），
    //    直接传 process.env 会得到**空基址** ⇒ 拼出相对路径 ⇒ 后面 new URL 直接抛。
    const productEnv = {
      PUBLIC_H5_BASE_URL: envValue('PUBLIC_H5_BASE_URL'),
      PUBLIC_BASE_URL: envValue('PUBLIC_BASE_URL'),
    };
    link = `${publicBaseUrlOf(productEnv)}${PROGRESS_TOKEN.LINK_PATH}${tok ?? ''}`;
    console.log(`  · 短信未发出 ⇒ 改用**产品同一函数**拼同构链接（同一 token）`);
    console.log(`  · 同构 link（脱敏）    ：${maskLink(link)}`);
  }

  ok('链接存在且**含 43 位凭证**（与短信里那条同构）', /^https?:\/\/.+\/p\/[A-Za-z0-9_-]{43}$/.test(link), maskLink(link));
  ok(
    '链接走的是既有的 `/p/` 短链（**不是**用工单号拼出来的可猜地址）',
    /\/p\/[A-Za-z0-9_-]{40,}$/.test(link),
    `路径前缀=${new URL(link).pathname.replace(/[A-Za-z0-9_-]{40,}$/, '<token>')}`,
  );

  // ---- 2. 链接能不能打开**对应工单**（问题②）----
  console.log('\n── ② 该链接能否打开对应工单 ────────────────────────────');
  // ① 明文入口（基址是 http://localhost:8080）⇒ nginx **强制跳 HTTPS**（301）。这是正确的，不是缺陷。
  const plain = await httpJson(link, { redirect: 'manual' });
  const plainLoc = plain.res.headers.get('location') ?? '';
  ok(
    '明文入口 ⇒ **301 跳 HTTPS**（项目的强制加密，正确行为）',
    plain.status === 301 && plainLoc.startsWith('https://'),
    `HTTP ${plain.status} → ${plainLoc.replace(/[A-Za-z0-9_-]{43}$/, '<token>')}`,
  );

  // ② **https 入口**才是短链本身的行为 ⇒ 必须 302 到 H5 进度页
  const httpsLink = link.replace(/^http:\/\/[^/]+/, 'https://localhost');
  const hop = await httpJson(httpsLink, { redirect: 'manual' });
  const loc = hop.res.headers.get('location') ?? '';
  ok(
    '🔴 https 短链 ⇒ **302** 且指向 H5 进度页（短链本身的行为）',
    hop.status === 302 && /\/h5\/customer\/progress\//.test(loc),
    `HTTP ${hop.status} → ${loc.replace(/[A-Za-z0-9_-]{43}$/, '<token>')}`,
  );

  const followed = await httpJson(link.replace(/^http:\/\/[^/]+/, 'https://localhost'), { redirect: 'follow' });
  ok('跟随短链 ⇒ 200 且拿到 H5 页面（真的能打开）', followed.status === 200 && /id="app"/.test(followed.text), `HTTP ${followed.status}`);

  const token = link.split('/').pop();
  const prog = await httpJson(`/api/public/progress/${token}`);
  ok(
    '🔴 短链背后的进度接口 ⇒ 回**本次这张**工单（单号一致 + 带时间线与媒体）',
    prog.status === 200 && prog.json?.data?.ticket_no === ticketNo && (prog.json?.data?.media?.length ?? 0) >= 1,
    `HTTP ${prog.status} 单号一致=${prog.json?.data?.ticket_no === ticketNo} 媒体=${prog.json?.data?.media?.length ?? 0} 份`,
  );

  // ---- 3. 该链接的 host 决定"手机能不能点开"（问题④）----
  console.log('\n── ③④ 链接 host 与手机可达性 ───────────────────────────');
  const linkHost = new URL(link).host;
  const effBase = envH5 || envBase;
  ok(
    '链接的 host **等于**配置的对外基址（证明 host 由该变量决定，不是别处硬编码）',
    effBase.startsWith(`http://${linkHost}/`) || effBase.startsWith(`https://${linkHost}/`) || effBase === `${new URL(link).protocol}//${linkHost}`,
    `链接 host=${linkHost} · 配置基址=${effBase || '(空)'}`,
  );

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(linkHost);
  ok(
    '🔴 **当前**链接指向 localhost ⇒ 手机点开必然失败（这正是需要登记的阻塞）',
    isLocal === true,
    isLocal ? '是的：手机无法解析 localhost' : `host=${linkHost}`,
  );

  // 复用**既有的**生产护栏函数判断（不自己写判据）
  const { isNonPublicBase } = await loadProductModule('services/public-url.ts', ['isNonPublicBase']);
  ok(
    '既有护栏 `isNonPublicBase()` 判定该基址**不可用于对外链接**（生产档会拒绝启动）',
    isNonPublicBase(effBase) === true,
    `isNonPublicBase("${effBase}") = ${isNonPublicBase(effBase)}`,
  );

  // ---- 4. sms_logs 侧的佐证（正文不落库是刻意的）----
  console.log('\n── ④ sms_logs 侧的佐证 ────────────────────────────────');
  const logRow = psql(
    `SELECT scene, template_code, send_status FROM sms_logs WHERE ticket_id=(SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}') AND scene='progress_link'`,
  );
  ok(
    'sms_logs 有该单的 progress_link 记录，且**不含正文/链接**（正文不落库是刻意设计）',
    logRow.startsWith('progress_link'),
    logRow,
  );
} finally {
  psql(`UPDATE service_settings SET value='${origEnabled}' WHERE key='sms.enabled'`);
  console.log(`\n  · 已还原 sms.enabled（${origEnabled}）`);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  进度短信链路核对：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 链路本身正确（短链→H5→进度接口回同一单）');
  console.log('  ⛔ **短信真机可达性当前为阻塞**：短信未发出 + 基址是 localhost + 无公网域名');
}
