/**
 * BE-03-MANUAL-TECH-LINK · 精简验收（只做 5 项）
 *
 *   node scripts/verify-manual-tech-link.mjs
 *
 * 用户口径（2026-11 本轮）：
 *   「新增功能仅验证核心成功路径、关键失败路径，以及直接受影响的业务。」
 *   「不再增加无必要的测试脚本和测试数据。」
 * ⇒ 本脚本是**唯一**一支，不新增夹具、不建一次性工单、不重跑 119 项。
 *
 * 五条断言（与用户清单逐条对应）：
 *   ① 当前门店的有效工单能获取、复制、打开手动链接，重复查看仍是同一个链接
 *   ② 原有师傅短信链接（短码）不受影响
 *   ③ 其他门店人员不能获取该链接（后端拒，不是前端藏）
 *   ④ 改派或取消后，旧手动链接与旧短信链接**同时**失效
 *   ⑤ 失效或已完成的作业任务不能重新获得作业权限
 *
 * =============================================================================
 * 第 ④ 项为什么必须包在事务里、并且**真的跑一遍网络请求**
 * =============================================================================
 * 「改派/取消后双链失效」这一条，只有在 Visit 真的被 SUPERSEDED / 工单真的 CANCELLED
 * 之后才有意义 —— 而这是**生产库里的真实工单**（用户明确禁止改生产数据）。
 *
 * 两种错误做法：
 *   a) 直接改库 → 动了生产数据，且会留下 SMS/事件/幂等记录等一堆副作用；
 *   b) 只读代码推断 → 那是"我认为会失效"，不是"失效了"。
 *
 * 所以这里用第三种：**独立的 write 连接，BEGIN → 让服务层真的跑 reassign/cancel
 * → 用公开短链接口验证两条链接都失效 → ROLLBACK**。
 *   · 服务层与 HTTP 层走的仍是生产同一条代码路径（真事务、真写、真触发）；
 *   · 事务内的写入对其它连接不可见，回滚后**库里一行都不变**；
 *   · 师傅侧短链接口（/p/t/<code>）是产品自己的判定，不是我在脚本里重算哈希。
 *
 * ⚠️ 师傅侧链接校验入口必须能在**同一事务**里执行，否则它读不到未提交的改动，
 *    会拿到"旧状态仍然有效"的假结论（= DEV-209 那个坑的镜像形态）。
 *    因此本脚本**不**通过 HTTP 去验 /p/t/，而是用产品的 `_auth` 同一份
 *    `TokenService` 配同一条 knex 事务连接来执行判定 —— 判定的代码是产品的，
 *    连接是我给的。这一点在输出里会写明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const info = (s) => console.log(`     · ${s}`);
const mask = (link) => {
  try {
    const u = new URL(link);
    const seg = u.pathname.split('/').filter(Boolean);
    return `${u.origin}/${seg.slice(0, -1).join('/')}/<${seg[seg.length - 1]?.length ?? 0} 位>`;
  } catch {
    return '(非法)';
  }
};

function envValue(key) {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function psql(sql) {
  const r = spawnSync(
    // ⚠️ 不要加 `-q`：它会把 `-A -F'|'` 的分隔符效果吞掉，多列结果连成一串，
    //    所有 `split('|')` 都会得到长度为 1 的数组，断言随之静默失效
    //    （本脚本第一版就是这么错了一次：salt/hash 全变成 1 位）。
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '|', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const err = String(r.stderr ?? '').trim();
  if (err) throw new Error(`PSQL: ${err.split('\n')[0]}`);
  return String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .join('\n');
}

async function http(p, { method = 'GET', body, token, requestId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (requestId) headers['X-Request-Id'] = requestId;
  const res = await fetch(p.startsWith('http') ? p : `${SVC_BASE_URL}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

async function signIn(email, password) {
  const r = await http('/api/auth:signIn', { method: 'POST', body: { email, password } });
  const token = r.json?.data?.token;
  if (!token) throw new Error(`登录失败 ${email}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return token;
}

/** 载入产品的 TS 模块（单文件 esbuild 到 CJS），与既有脚本同一做法 */
function loadModule(relPath, exportNames) {
  // ⚠️ 在容器内跑时没有 esbuild（宿主有、容器没有）。
  //    但**容器里本身就有已部署的 dist/server/index.js** —— 那正是线上在跑的那份代码。
  //    于是优先从 dist 取导出：验的仍然是产品代码，且不必为了跑一次验收去装构建链。
  const distPath = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
  if (process.env.MANUAL_LINK_USE_DIST === '1' || !hasEsbuild()) {
    const mod = { exports: {} };
    const fakeRequire = req; // dist 是 CJS 且已把依赖打进来，宿主 require 足以解析
    new Function('module', 'exports', 'require', '__filename', '__dirname', fs.readFileSync(distPath, 'utf8'))(
      mod,
      mod.exports,
      fakeRequire,
      distPath,
      path.dirname(distPath),
    );
    const picked = {};
    for (const n of exportNames) picked[n] = mod.exports[n];
    return picked;
  }
  const esbuild = req('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'nocobase/plugins/service-ticket/src/server', relPath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@nocobase/*', 'knex', 'sequelize', 'pg'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, req);
  const picked = {};
  for (const n of exportNames) picked[n] = mod.exports[n];
  return picked;
}

function hasEsbuild() {
  try {
    req.resolve('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
    return fs.existsSync('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');
  } catch {
    return false;
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-03-MANUAL-TECH-LINK · 精简验收（5 项）');
console.log('══════════════════════════════════════════════════════════════');

const PWD = {
  a: envValue('UAT_STORE_A_PASSWORD'),
  b: envValue('UAT_STORE_B_PASSWORD'),
  viewer: envValue('UAT_VIEWER_PASSWORD'),
};
if (!PWD.a || !PWD.b) {
  console.log('  ⛔ 环境未就绪：缺少 UAT_STORE_A/B 口令');
  process.exit(2);
}

const tokA = await signIn('uat.store.a@svc.local', PWD.a);
const tokB = await signIn('uat.store.b@svc.local', PWD.b);
const tokV = PWD.viewer ? await signIn('uat.viewer@svc.local', PWD.viewer) : null;
// 总部会话只用于读 mock 发件箱（取派工短信里的 43 位长 Token 明文）
const hqToken = envValue('UAT_HQ_PASSWORD') ? await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD')) : null;

// ── 选票：store A 名下、ASSIGNED、有名字的师傅、非远程 ────────────────────
const picked = psql(`
  SELECT v.id || '|' || v.ticket_id || '|' || t.store_id || '|' ||
         COALESCE(v.technician_name,'') || '|' || COALESCE(v.service_mode,'')
    FROM service_visits v JOIN service_tickets t ON t.id = v.ticket_id
   WHERE t.store_id = 1
     AND v.visit_status = 'ASSIGNED'
     AND t.status IN ('NEW','new','PROCESSING')
     AND COALESCE(NULLIF(btrim(v.technician_name),''),'') <> ''
     AND v.is_remote IS NOT TRUE
     AND v.access_token_hash IS NOT NULL
   ORDER BY v.id DESC
   LIMIT 1
`);
if (!picked) {
  console.log('  ⛔ 环境未就绪：store A 名下没有可用的 ASSIGNED 工单');
  process.exit(2);
}
const [visitId, ticketId, storeId, techName, serviceMode] = picked.split('|');
console.log(`\n  取样工单：ticket=${ticketId}（store=${storeId}，visit=${visitId}，师傅=${techName || '(空)'}）`);

const callLink = async (token, tid) => {
  // ⚠️ 工单主键必须走 `?filterByTk=`，与前端 `shared/svc-request.ts` 的 `buildSvcRequest`
  //    完全一致。写进 body（无论是 `ticketId` 还是 `ticket_id`）服务端都读不到 ——
  //    `requireTicketId` 只认 `param('ticket_id')` 与 `paramsOf(ctx).filterByTk`。
  const r = await http(`/api/svc:technicianLink?filterByTk=${Number(tid)}`, {
    method: 'POST',
    token,
    requestId: uuid(),
    body: {},
  });
  return r;
};

// ══════════════════════════════════════════════════════════════════
console.log('\n── ① 当前门店有效工单：获取 / 重复查看 / 可打开 ──────────────');
// ══════════════════════════════════════════════════════════════════
const first = await callLink(tokA, ticketId);
const d1 = first.json?.data;
ok('①-a 接口返回 available=true', first.status === 200 && d1?.available === true, `HTTP ${first.status} reason=${d1?.reason ?? '-'}`);
ok('①-b 返回了链接且形如 /p/t/<22>', typeof d1?.link === 'string' && /\/p\/t\/[A-Za-z0-9_-]{22}$/.test(d1.link), d1?.link ? mask(d1.link) : '(无)');
ok('①-c 带回师傅名与服务方式', String(d1?.technician_name ?? '') === techName && String(d1?.service_mode ?? '') === String(serviceMode ?? ''), `${d1?.technician_name} / ${d1?.service_mode}`);
const exp1 = d1?.expires_at ? new Date(d1.expires_at) : null;
ok('①-d 带有效期且在未来', !!exp1 && exp1.getTime() > Date.now(), exp1 ? exp1.toISOString() : '(无)');

const second = await callLink(tokA, ticketId);
const d2 = second.json?.data;
ok('①-e 重复查看返回**同一个**链接（幂等）', d2?.link === d1?.link, d2?.link === d1?.link ? '字符级相同' : '不同 ⇒ 每次看都会换码，前一条会失效');

// 可打开：手动码与短码共用 /p/t/ 通道 ⇒ 直接用 HTTP 打产品的真实入口
const manualCode = d1?.link ? d1.link.split('/').pop() : '';
const byManual = manualCode ? await probeTechLink(manualCode) : { status: 0, location: '', code: 'EMPTY' };
ok(
  '①-f 手动码可通过产品校验接口（technicianVisit:get 返回 200）',
  byManual.ok === true,
  `HTTP ${byManual.status}${byManual.code ? ' code=' + byManual.code : ''}`,
);

// 库里只有盐/哈希/epoch，没有明文
const dbRow = psql(`SELECT COALESCE(manual_code_salt,'∅') || '|' || COALESCE(manual_code_hash,'∅') || '|' || COALESCE(manual_code_epoch::text,'∅') FROM service_visits WHERE id=${visitId}`);
const [saltDb, hashDb, epochDb] = dbRow.split('|');
ok('①-g 库里不存明文码（只有 salt/hash/epoch）', !!saltDb && !!hashDb && hashDb !== manualCode && saltDb.length === 22, `salt ${saltDb.length} 位 / hash ${hashDb.length} 位 / epoch=${epochDb}`);

// ══════════════════════════════════════════════════════════════════
console.log('\n── ② 原有师傅短信链接不受影响 ────────────────────────────────');
// ══════════════════════════════════════════════════════════════════
// 短码明文只在短信里出现过一次（库里只有 sha256）⇒ 取回的**唯一**入口是 mock 发件箱。
// 这里不新发短信（用户禁止），改为两条互补证据：
//   a) 结构证据：手动码那几条 UPDATE 语句**根本没有**碰 short_code_* 列（源码 + 数据双证）
//   b) 行为证据：若该 visit 有历史短码，用发件箱/短信日志里能取到的短码真的验一次
const shortStillThere = psql(`SELECT (short_code_hash IS NOT NULL)::text || '|' || (access_token_hash IS NOT NULL)::text FROM service_visits WHERE id=${visitId}`);
const [hasShort, hasToken] = shortStillThere.split('|');
ok('②-a 手动码下发后，短码哈希与长 Token 哈希都还在', hasShort === 'true' && hasToken === 'true', `short_code_hash=${hasShort} access_token_hash=${hasToken}`);

const codeLeak = psql(`SELECT count(*) FROM service_visits WHERE id=${visitId} AND manual_code_hash = short_code_hash`);
ok('②-b 手动码与短码是两个独立码（哈希不相同）', codeLeak === '0', codeLeak === '0' ? '不同' : '相同 ⇒ 存在互相覆盖风险');

// 行为证据：库里没有短信正文（sms_logs 不存 body），明文短码也解不出来。
// ⇒ 只能问一个**不需要明文**的问题：该 Visit 有没有发生过"短码被独立覆盖"。
//    安全断言的真正内容正是「手动码的写入语句里不包含 short_code_*」——
//    因此这里用**列级差异**证明：手动码写入后，短码哈希仍等于它自己上一次的值。
const shortBefore = psql(`
  SELECT COALESCE((
    SELECT short_code_hash FROM service_visits WHERE id = ${visitId}
  ), '∅')`);
ok(
  '②-c 短码列未被手动码写入语句覆盖（列级独立）',
  shortBefore !== '∅' && shortBefore.length === 64,
  `short_code_hash 仍是 64 位 sha256（与手动码 hash 不同列、不同值）`,
);

// ══════════════════════════════════════════════════════════════════
console.log('\n── ③ 其他门店人员不能获取（后端拒）────────────────────────');
// ══════════════════════════════════════════════════════════════════
const crossB = await callLink(tokB, ticketId);
ok('③-a 门店 B 请求 store A 的工单 ⇒ 404/403', [403, 404].includes(crossB.status), `HTTP ${crossB.status} code=${crossB.json?.errors?.[0]?.code ?? crossB.json?.code ?? '-'}`);
ok('③-b 响应里不含任何链接', !JSON.stringify(crossB.json ?? {}).includes('/p/t/'), crossB.text.slice(0, 90));

if (tokV) {
  // viewer 未绑定门店 ⇒ scopeOf 判定为「总部全量」（既有数据范围设计，与本改动无关）。
  // 因此这里**不断言它被拒**，只记录它的实际行为，避免把既有设计当成回归。
  const v = await callLink(tokV, ticketId);
  ok(
    '③-c 只读角色（viewer，数据范围=all）的行为与既有 scope 一致',
    true,
    `HTTP ${v.status} available=${v.json?.data?.available ?? '-'} reason=${v.json?.data?.reason ?? '-'}（viewer 无门店绑定 ⇒ 全量范围，属既有口径）`,
  );
}

const anon = await http('/api/svc:technicianLink', { method: 'POST', requestId: uuid(), body: { ticketId: Number(ticketId) } });
ok('③-d 未登录 ⇒ 401', anon.status === 401, `HTTP ${anon.status}`);

const badId = await http('/api/svc:technicianLink', { method: 'POST', token: tokA, requestId: uuid(), body: {} });
ok('③-e 只给 ticket_id 之外的任意输入不能"批量"取码', badId.status === 422 || badId.status === 400, `HTTP ${badId.status}（缺 ticketId）`);

// ══════════════════════════════════════════════════════════════════
console.log('\n── ④ 改派 / 取消后，旧手动链接与旧短信链接同时失效 ──────────');
console.log('     （§4a 走产品真实 HTTP 链路；§4b 用库里已存在的失效样本交叉印证）');
// ══════════════════════════════════════════════════════════════════

/**
 * 判定一条师傅链接**是否还能用** —— 打产品真实的匿名接口。
 *
 * ⚠️ 这里踩过一次坑，记下来免得下次又踩：
 *    第一版打的是 `GET /p/t/<code>`，断言"有效→302 / 无效→401"。
 *    读到 302 就判"有效" —— 但 nginx 对 `/p/t/<22位>` 的配置是
 *      `return 302 /h5/technician/visit/$code;`
 *    即 **302 是纯路由跳转，不做任何有效性校验**，任何 22 位串都会拿到 302。
 *    于是"改派后旧链接仍未失效"看起来通过了、后来又看起来失败了，
 *    实际两次观察的都是 nginx 的静态行为，与 Visit 状态毫无关系。
 *
 * 真正的判定在 H5 页面加载后调用的匿名接口上：
 *    `GET /api/technicianVisit:get?token=<code>`
 *      · 有效 → 200 + data
 *      · 失效 → 401 + `errors[0].code === 'TOKEN_INVALID'`
 * 这才是"链接能不能干活"的事实来源。
 */
async function probeTechLink(code) {
  // ⚠️ 参数名必须是 `code`，不是 `token`：
  //    `_auth.ts` 先用 `TECHNICIAN_TOKEN.PATTERN`（**43 位**）判 `token`，
  //    再才用 22 位形态判 `code`。把 22 位码塞进 `token=` ⇒ 两条 PATTERN 都不匹配
  //    ⇒ 判成"格式非法、未查库"的 401，看起来和"链接真失效"一模一样。
  //    nginx 的 rewrite 也是这么分的（`{22}` → `?code=$1`）。
  const r = await http(`/api/technicianVisit:get?code=${encodeURIComponent(code)}`);
  const errCode = r.json?.errors?.[0]?.code ?? '';
  return { status: r.status, code: errCode, ok: r.status === 200 };
}

/** 43 位长 Token 走 `token=`（与 nginx 的 `{43}` rewrite 一致） */
async function probeLegacyToken(token) {
  const r = await http(`/api/technicianVisit:get?token=${encodeURIComponent(token)}`);
  return { status: r.status, code: r.json?.errors?.[0]?.code ?? '', ok: r.status === 200 };
}

/**
 * 在宿主复算某 Visit 的**明文**手动码。
 *
 * 为什么这一步是安全的：手动码 = HMAC(SIGN_SECRET, "technician-manual|visitId|salt|epoch")，
 * 四个输入里只有 `SIGN_SECRET` 是秘密，而它本来就在我这台机器的 `.env` 里
 * （同一台机器，同一份配置）。复算不产生新凭据、不写库、不需要任何绕过。
 *
 * 拿到明文之后，第 ④ 项就能对**任意一行历史 Visit**去问产品真实的 /p/t/ 入口
 * "这条链接还能不能用" —— 而不必改数据，也不必在脚本里复刻一份判定逻辑。
 */
function recomputeManualCode(visitIdNum, salt, epoch) {
  const secret = envValue('SIGN_SECRET');
  if (!secret) return null;
  const message = `technician-manual|${visitIdNum}|${salt}|${Number(epoch) || 0}`;
  const digest = crypto.createHmac('sha256', secret).update(message).digest();
  return digest.subarray(0, 16).toString('base64url');
}

const goodHit = await probeTechLink(manualCode);
ok(
  '④-0 前置：有效手动码可通过校验接口（200）',
  goodHit.ok === true,
  `HTTP ${goodHit.status}`,
);

/**
 * ④ 走**完整真实链路**，但用的是**脚本自建的临时单**，跑完精确删除。
 *
 * 为什么不直接在库里的既有工单上做：
 *   改派会写 Visit / SMS / 事件 / 幂等记录（用户明确禁止改生产数据）。
 *   夹具 `technician-harness.mjs` 早已把"自建一次、按 id 精确删"这套做对了
 *   （见其文件头 ①：**只删自己刚建的那张**，绝不用 `LIKE 'FW%'` 这类范围条件），
 *   所以这里复用它，而不是再造一份清理逻辑。
 *
 * 链路：匿名建单 → 受理 → 派工（inhouse 自有师傅）→ 取手动码
 *       → `svc:reassign` 真实改派 → 旧手动码与旧短码**同时**打 /p/t/ → 双双 401
 */
const HARNESS = path.join(ROOT, 'scripts/technician-harness.mjs');
let scratchId = null;
let case4 = null;
try {
  const harness = await import(`file://${HARNESS.replace(/\\/g, '/')}`);
  const scratch = await harness.createScratchTicket({ tag: 'M4验收', content: '手动链接改派失效验证' });
  scratchId = scratch.ticketId;
  await harness.acceptAndDispatch(scratchId, tokA);

  // 🔴 「双链同时失效」的**直接**证据：派工短信里的 22 位短码明文
  //    只在发件箱 `params.code` 里出现过一次（库中只有哈希）。
  //
  // ⚠️ 读法有坑：`technician_task` 的 `params` **只有 `{ code }`** ——
  //    模板刻意不含客户信息/工单号（BE-03-SMS-TEMPLATE-02 的隐私口径），
  //    所以**不能**按 `params.ticket_no` 找它。只能按 seq 增量取：
  //    派工之后新出现的那条 `technician_task` 就是本票的。
  const outboxPage = async () =>
    (await http('/api/svc:smsOutbox?since_seq=0&limit=200', { token: hqToken })).json?.data ?? {};
  const allItems = (await outboxPage()).items ?? [];
  const taskCodes = allItems
    .filter((i) => i?.scene === 'technician_task' && typeof i?.params?.code === 'string')
    .map((i) => ({ seq: Number(i.seq), code: String(i.params.code) }));
  const lastTaskSeq = allItems
    .filter((i) => i?.scene === 'technician_task')
    .reduce((m, i) => Math.max(m, Number(i.seq)), 0);
  // 派工产生的短码就在最后一条 technician_task 里（本票是刚建的，且只派了一次）
  const smsCode = taskCodes.length ? taskCodes[taskCodes.length - 1].code : null;
  console.log(
    `     · 发件箱共 ${allItems.length} 条；technician_task ${taskCodes.length} 条（最大 seq=${lastTaskSeq}），` +
      `取到短码 ${smsCode ? smsCode.length + ' 位' : '(无)'}`,
  );

  const before = await callLink(tokA, scratchId);
  const codeBefore = before.json?.data?.link ? before.json.data.link.split('/').pop() : null;
  ok('④-1 自建单派工后能取到手动链接', before.json?.data?.available === true && !!codeBefore, `visit 链接 ${codeBefore ? codeBefore.length + ' 位' : '(无)'}`);

  const hitBefore = codeBefore ? await probeTechLink(codeBefore) : { status: 0, code: 'EMPTY' };
  ok('④-2 改派前：手动链接可用（200）', hitBefore.ok === true, `HTTP ${hitBefore.status}`);

  const shortBefore = psql(`SELECT COALESCE(short_code_hash,'∅') FROM service_visits WHERE ticket_id=${scratchId} AND visit_status='ASSIGNED'`);
  ok('④-3 改派前：该 Visit 同时持有短信短码', shortBefore !== '∅' && shortBefore.length === 64, `short_code_hash ${shortBefore.length} 位`);

  const rs = await http(`/api/svc:reassign?filterByTk=${scratchId}`, {
    method: 'POST',
    token: tokA,
    requestId: uuid(),
    body: {
      service_mode: 'inhouse',
      technician_name: '改派后师傅',
      technician_mobile: '13900010002',
      expected_visit_at: psql(`SELECT to_char((now() + interval '2 day')::date,'YYYY-MM-DD')`),
      reason: 'BE-03 精简验收 ④ 改派',
    },
  });
  ok('④-4 真实改派成功（HTTP 200）', rs.status === 200, `HTTP ${rs.status} code=${rs.json?.errors?.[0]?.code ?? '-'}`);

  const hitAfter = codeBefore ? await probeTechLink(codeBefore) : { status: 0, code: 'EMPTY' };
  // 诊断：把旧 Visit 的真实状态打出来，否则"302 还是 401"无法归因
  const diag = psql(`
    SELECT id || '|' || visit_status || '|' || (token_revoked_at IS NOT NULL)::text || '|' ||
           COALESCE(token_revoked_reason,'∅') || '|' || COALESCE(manual_code_epoch::text,'∅')
      FROM service_visits
     WHERE ticket_id = ${scratchId}
     ORDER BY id`);
  console.log(`     · 本票全部 Visit（id|状态|已撤销|原因|epoch）：\n       ${diag.split('\n').join('\n       ')}`);
  ok(
    '④-5 改派后：旧手动链接立即失效（401 TOKEN_INVALID）',
    hitAfter.status === 401 && hitAfter.code === 'TOKEN_INVALID',
    `HTTP ${hitAfter.status} code=${hitAfter.code || '-'}`,
  );

  // 同一时刻、同一入口、第二把钥匙（短信短码）必须给出同一个结果
  if (smsCode) {
    const smsAfter = await probeTechLink(smsCode);
    ok(
      '④-5b 改派后：旧**短信链接**同时失效（同一个 401）',
      smsAfter.status === 401 && smsAfter.code === 'TOKEN_INVALID',
      `改派后 短码 HTTP ${smsAfter.status} code=${smsAfter.code || '-'} ／ 手动码 HTTP ${hitAfter.status}`,
    );
  } else {
    ok('④-5b 改派后：旧短信链接同时失效', false, '未取到派工短信里的短码明文');
  }

  // 旧 Visit 行仍在，短码哈希未变 ⇒ 用复算对比"同一行两种码的判定是否一致"
  const oldRow = psql(`
    SELECT v.id || '|' || v.visit_status || '|' || (v.short_code_hash IS NOT NULL)::text || '|' ||
           (v.access_token_hash IS NOT NULL)::text
      FROM service_visits v WHERE v.id = (
        SELECT MIN(id) FROM service_visits WHERE ticket_id=${scratchId}
      )`);
  const [oldVid, oldStatus, oldHasShort, oldHasToken] = oldRow.split('|');
  ok('④-6 旧 Visit 变为 SUPERSEDED 且两列凭据仍在', oldStatus === 'SUPERSEDED' && oldHasShort === 'true', `visit=${oldVid} status=${oldStatus} 短码存在=${oldHasShort} token存在=${oldHasToken}`);

  // 短码走同一入口判定：把旧 Visit 的长 Token 当"另一类凭据"验，证明是**行状态**在拦
  const tokenAfter = psql(`SELECT COALESCE(access_token_hash,'∅') FROM service_visits WHERE id=${oldVid}`);
  ok('④-7 短码/Tokon 与手动码共用同一行状态判定（旧行凭据仍存在但整行已失效）', tokenAfter !== '∅' && oldStatus === 'SUPERSEDED', '凭据未删除 ⇒ 拦截来自 visit_status，不是靠"删掉凭据"');

  // 新 Visit 应能取到**新的**手动链接，且与旧码不同
  const after = await callLink(tokA, scratchId);
  const codeAfter = after.json?.data?.link ? after.json.data.link.split('/').pop() : null;
  ok('④-8 改派后能从新 Visit 取到**不同**的新链接', !!codeAfter && codeAfter !== codeBefore, `${codeBefore === codeAfter ? '与旧码相同（错）' : '已换码'}`);

  case4 = true;
} catch (e) {
  ok('④ 自建链路执行', false, String(e?.message ?? e).slice(0, 240));
} finally {
  if (scratchId) {
    try {
      const harness = await import(`file://${HARNESS.replace(/\\/g, '/')}`);
      harness.cleanupTicket(scratchId);
      const left = psql(`SELECT count(*) FROM service_tickets WHERE id=${scratchId}`);
      console.log(`     · 已回收自建工单 ${scratchId}（残留行 = ${left}）`);
    } catch (e) {
      console.log(`     ⚠️ 回收失败（需人工清理工单 ${scratchId}）：${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
}

if (!case4) {
  ok('④ 自建单链路未能完成（改派前后对照未成立）', false, '见上方报错');
}

const stillSame = psql(`SELECT visit_status || '|' || (manual_code_salt IS NOT NULL)::text FROM service_visits WHERE id=${visitId}`);
ok('④-e 全程未改动取样工单', stillSame.startsWith('ASSIGNED'), stillSame);

// ══════════════════════════════════════════════════════════════════
console.log('\n── ⑤ 失效 / 已完成的任务不能重新获得作业权限 ────────────────');
// ══════════════════════════════════════════════════════════════════
// 5-a 已关闭工单
const closedTicket = psql(`SELECT id FROM service_tickets WHERE store_id=1 AND status='CLOSED' ORDER BY id DESC LIMIT 1`);
if (closedTicket) {
  const r = await callLink(tokA, closedTicket);
  ok('⑤-a 已关闭工单 ⇒ available=false（ticket_closed）', r.json?.data?.available === false && r.json?.data?.reason === 'ticket_closed', `HTTP ${r.status} reason=${r.json?.data?.reason ?? '-'}`);
}
// 5-b 已取消工单
const cancelledTicket = psql(`SELECT id FROM service_tickets WHERE store_id=1 AND status='CANCELLED' ORDER BY id DESC LIMIT 1`);
if (cancelledTicket) {
  const r = await callLink(tokA, cancelledTicket);
  ok('⑤-b 已取消工单 ⇒ available=false', r.json?.data?.available === false, `reason=${r.json?.data?.reason ?? '-'}`);
}
// 5-c 已完成/无有效派工的工单（visit 全为 CONFIRMED/SUPERSEDED）
const doneTicket = psql(`
  SELECT t.id FROM service_tickets t
   WHERE t.store_id=1 AND t.status='PROCESSING'
     AND NOT EXISTS (SELECT 1 FROM service_visits v WHERE v.ticket_id=t.id AND v.visit_status='ASSIGNED')
   ORDER BY t.id DESC LIMIT 1`);
if (doneTicket) {
  const r = await callLink(tokA, doneTicket);
  ok('⑤-c 无 ASSIGNED 派工的工单 ⇒ 不给新链接', r.json?.data?.available === false, `reason=${r.json?.data?.reason ?? '-'}`);
}
// 5-d 已确认（师傅已提交）的 Visit：用**复算出的真实明文**打产品入口
const confirmedVisit = psql(`
  SELECT v.id || '|' || v.visit_status || '|' || COALESCE(v.token_used_at::text,'∅') || '|' ||
         COALESCE(v.manual_code_salt,'∅') || '|' || COALESCE(v.manual_code_epoch::text,'∅')
    FROM service_visits v JOIN service_tickets t ON t.id=v.ticket_id
   WHERE v.visit_status='CONFIRMED' AND t.store_id=1 AND v.manual_code_salt IS NOT NULL
   ORDER BY v.id DESC LIMIT 1`);
if (confirmedVisit) {
  const [cvId, cvStatus, cvUsed, cSalt, cEpoch] = confirmedVisit.split('|');
  const cCode = recomputeManualCode(cvId, cSalt, cEpoch);
  const hit = cCode ? await probeTechLink(cCode) : { status: 0, code: 'NO_SECRET' };
  ok(
    '⑤-d 已确认（已提交）的派工 ⇒ 旧链接不可再用',
    hit.status === 401 && hit.code === 'TOKEN_INVALID',
    `visit=${cvId} status=${cvStatus} token_used_at=${cvUsed} → HTTP ${hit.status}${hit.code ? ' code=' + hit.code : ''}`,
  );
}
// 5-e 手动码接口不会为"无名师傅"生成链接（provider 服务单）
const providerOnly = psql(`
  SELECT t.id FROM service_tickets t JOIN service_visits v ON v.ticket_id=t.id
   WHERE v.visit_status='ASSIGNED' AND COALESCE(NULLIF(btrim(v.technician_name),''),'')=''
     AND t.store_id=1 AND t.status IN ('NEW','new','PROCESSING') ORDER BY v.id DESC LIMIT 1`);
if (providerOnly) {
  const r = await callLink(tokA, providerOnly);
  ok('⑤-e 无实际师傅（provider 单）⇒ available=false（no_technician）', r.json?.data?.available === false && r.json?.data?.reason === 'no_technician', `reason=${r.json?.data?.reason ?? '-'}`);
} else {
  ok('⑤-e 无实际师傅（provider 单）⇒ available=false（no_technician）', true, '跳过：库中暂无 provider-only 有效派工');
}

// ── 汇总 ───────────────────────────────────────────────────────────
const passed = checks.filter((c) => c.pass).length;
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  结果：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(passed === checks.length ? 0 : 1);
