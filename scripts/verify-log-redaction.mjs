#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-log-redaction.mjs —— Phase 10 / RB-1「请求日志接管」门禁
 * =============================================================================
 *
 * 只回答一个问题：**明文凭证还会不会落进日志？**
 * 并且必须证明这是**接管**（换掉了唯一那条写入通路），而不是"旁边又加了一层安全日志"。
 *
 * ---------------------------------------------------------------------------
 * 为什么这条门禁必须存在
 * ---------------------------------------------------------------------------
 * 泄漏的失败方式是**完全静默**的：接口全绿、功能正常、状态码正确，
 * 只是明文手机号 / 姓名 / 匿名 Token 悄悄落进磁盘。
 * 没有任何运行期症状 ⇒ 只能靠"拿唯一 canary 打进去、再同时扫所有落点"来证明。
 *
 * 实测到的三处真实泄漏（2026-09-26，均为既有缺陷，非本阶段引入）：
 *   ① `request_*.log`：框架 request-logger 把**整个请求体**（`action.params.values`）
 *      与 4xx/5xx 的**整个响应体**（`res`）写进日志；评价 Token 另在
 *      `.action.params.filterByTk` / `.resourceIndex` 出现两份。
 *      实测 6 个文件共 **13,386** 处 43 位 Token。
 *   ② `system_*.log`：**同一中间件的另一句代码**（`request-logger.js:57-58`）
 *      从 `ctx.path` 派生 `{module, submodule}` 造 child logger 挂到 `ctx.log`，
 *      于是 `submodule` = `get/<43 位 Token>`；任何用 `ctx.log` 的代码
 *      （实测触发者是 NocoBase 自己的工作流前置钩子）都会写出去。实测 **345** 条。
 *   ③ nginx access log / `docker logs svc-nginx`：`$request` 里带 Token 明文，
 *      **且 query 形态（`?token=`）无法用 location 匹配拦住**。
 *
 * ---------------------------------------------------------------------------
 * 关键设计：正向白名单，而不是"先记全量再删敏感字段"
 * ---------------------------------------------------------------------------
 *   · 应用侧：`sanitizeRequestLogPayload()` 的输出**从零构造**，
 *     只复制 `REQUEST_LOG_SAFE_KEYS` 里的键 —— 新增字段默认**不被记录**。
 *   · nginx 侧：`log_format` 里**彻底没有** `$request`/`$uri`/`$request_uri`/`$args`，
 *     改用 `$svc_log_route`，而它由 `map` 产出、**取值恒为字面量**
 *     （连 `default` 也是字面量 `other`）⇒ 任何将来新增的 URL 都不可能把自身写进日志。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须做「反假绿」断言（§5）
 * ---------------------------------------------------------------------------
 * "扫不到 canary" 有三个完全不同的原因，必须区分开：
 *   (a) 真的接管了  ✅ 我们要的
 *   (b) 日志根本没在写（把日志关了 / 断链）           ❌ 更坏，排障能力被一起删掉
 *   (c) 扫错了文件 / 扫错了时间窗                    ❌ 门禁自己骗自己
 * 所以本门禁同时断言：
 *   · 新窗口**确实有**新增日志行（排除 b）；
 *   · 新增行里**仍然有**可审计字段（route / method / status）与归一化路由（排除 b）；
 *   · 框架的旧形态字段（`path`/`req`/`res`/`action`、message 里的 URL）**一处都不许有**
 *     —— 这一条正是"旧 logger 没有在旁边继续漏"的证据；
 *   · `--reverse` 模式下把 `$request` 放回 log_format，门禁**必须变红**
 *     （排除 c：证明这条扫描真的看得见泄漏）。
 *
 * ---------------------------------------------------------------------------
 * 取证材料不是凭证副本（工程纪律）
 * ---------------------------------------------------------------------------
 *   · canary 每次运行随机生成；
 *   · 证据文件里**只写**掩码 / 长度 / sha256 前缀 / 命中数，**不写明文**；
 *   · 本文件与 `docs/` 任何文档都不得出现真实 Token 明文。
 *
 * 用法：
 *   node scripts/verify-log-redaction.mjs             # 正常校验
 *   node scripts/verify-log-redaction.mjs --verbose
 *   node scripts/verify-log-redaction.mjs --reverse   # 反向：把 $request 放回去，断言门禁变红
 *
 * 退出码：0 = 全绿；1 = 真红灯；2 = 环境未就绪
 * =============================================================================
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NGINX_CONF = path.join(ROOT, 'nginx/nginx.conf');
const SITE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');
const APP_MIDDLEWARE = path.join(
  ROOT,
  'nocobase/plugins/service-ticket/src/server/middleware/request-log-redaction.ts',
);
const LOG_DIR = path.join(ROOT, 'storage/logs');
const TMP_DIR = path.join(ROOT, '.tmp-verify');

const APP_CONTAINER = 'svc-app';
const NGINX_CONTAINER = 'svc-nginx';

// 🔴 compose 子命令要的是**服务名**，不是 `container_name`。
//    实测踩到：`docker compose restart svc-nginx` 报 "no such service"，
//    而 `run()` 把错误吞成 `{ok:false, out}` ⇒ **静默空操作** ⇒
//    反向模式"改回泄漏配置"和"还原"两步**都没生效**，
//    反向之所以还能通过，凭的是上一次手工 `restart nginx` 留下的旧内存配置。
//    ⇒ 服务名/容器名必须分开，且关键命令必须检查 `ok`。
const APP_SERVICE = 'app';
const NGINX_SERVICE = 'nginx';
const NGINX_PORT = process.env.NGINX_HTTP_PORT || '8080';
const BASE = `http://127.0.0.1:${NGINX_PORT}`;

const VERBOSE = process.argv.includes('--verbose');
const REVERSE = process.argv.includes('--reverse');

/** 反向模式的取证结果（只存掩码与条数，供证据文件写入） */
let REVERSE_EVIDENCE = null;

const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------------------
// 计数与输出
// ---------------------------------------------------------------------------
let passCount = 0;
const failures = [];

function pass(msg, detail) {
  passCount += 1;
  console.log(`  ✅ ${msg}${detail && VERBOSE ? `\n       ${detail}` : ''}`);
}

function fail(msg, detail) {
  failures.push({ msg, detail });
  console.log(`  ❌ ${msg}`);
  if (detail) console.log(`       ${String(detail).slice(0, 800)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function isRed(label = '断言') {
  return failures.some((f) => f.msg === label);
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 执行命令并把 stdout+stderr 都收回来（`docker logs` 会往 stderr 写） */
function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      }),
    };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

function dockerAvailable() {
  const r = run('docker', ['ps', '--format', '{{.Names}}']);
  if (!r.ok) return null;
  const names = r.out.split('\n').map((s) => s.trim());
  if (!names.includes(APP_CONTAINER) || !names.includes(NGINX_CONTAINER)) return null;
  return names;
}

/** 应用容器当前进程的启动时间（用作 docker logs 的下界，避免读到上一个进程的历史） */
function appStartedAt() {
  const r = run('docker', ['inspect', '--format', '{{.State.StartedAt}}', APP_CONTAINER]);
  return r.ok ? r.out.trim() : '1h';
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 记录 storage/logs 下每个文件的字节数 */
function snapshotLogs() {
  const snap = new Map();
  for (const f of walk(LOG_DIR)) {
    try {
      snap.set(f, fs.statSync(f).size);
    } catch {
      /* 忽略瞬态 */
    }
  }
  return snap;
}

/**
 * 读出快照之后**新增**的内容。
 * 返回 { text, lines } —— 只要新内容，避免把历史泄漏混进本次判定。
 */
function readNewLogs(snapshot) {
  let text = '';
  for (const f of walk(LOG_DIR)) {
    let size;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    const from = snapshot.get(f) ?? 0;
    if (size <= from) continue;
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text += `\n${buf.toString('utf8')}`;
    } finally {
      fs.closeSync(fd);
    }
  }
  return { text, lines: text.split('\n').filter((l) => l.trim().length > 0) };
}

/**
 * 模拟 nginx access log 的存活探测。
 *
 * ⚠️ 用 Node 原生 http 而不是调用 curl：curl 不可用时会把"请求根本没发出去"
 *    伪装成"没扫到泄漏"（假绿）。
 */
async function httpRequest(method, urlPath, { headers = {}, body = null } = {}) {
  const url = `${BASE}${urlPath}`;
  const init = { method, headers: { ...headers } };
  if (body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text };
}

function sha8(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function mask(s) {
  return `${s.slice(0, 4)}…${s.slice(-2)}(len=${s.length},sha=${sha8(s)})`;
}

/**
 * 执行一条**关键**命令：失败即计入失败项，绝不静默。
 *
 * ⚠️ `run()` 为了"读日志时不抛错"而吞掉了退出码。但"重载配置 / 重建容器"
 *    这类步骤一旦静默失败，整个反向断言就会变成**凭旧状态的假绿** ——
 *    本门禁实测发生过（服务名写成了容器名，restart 一直是 no-op）。
 */
function runChecked(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (!r.ok) {
    fail(`★ 关键命令执行失败：${cmd} ${args.join(' ')}`, String(r.out).slice(0, 500));
  }
  return r;
}

// ---------------------------------------------------------------------------
// §1 静态断言（配置 / 源码层）
// ---------------------------------------------------------------------------
/**
 * `$request` 家族里哪些变量**绝对不能**出现在 log_format 里。
 *
 * ⚠️ 必须用精确 token 匹配：`$request_time` / `$request_method` 是**允许**的
 *    （它们不含凭证），而 `/\$request/` 这种松写法会把它们一起判红。
 */
const FORBIDDEN_LOG_VARS = [
  { name: '$request', re: /\$request(?!\w)/g },
  { name: '$uri', re: /\$uri(?!\w)/g },
  { name: '$document_uri', re: /\$document_uri/g },
  { name: '$request_uri', re: /\$request_uri/g },
  { name: '$args', re: /\$args(?!\w)/g },
  { name: '$query_string', re: /\$query_string/g },
];

/**
 * 去掉 nginx 的**行注释**（引号感知：`'…#…'` 里的 `#` 不算注释）。
 *
 * 🔴 这一步**必须**做，否则门禁会被自己的注释判红：
 *    `nginx.conf` 里到处是解释性注释，而它们**逐字提到了** `log_format`
 *    与 `` `$request` `` / `` `$request_uri` `` / `` `$args` `` 这些变量名。
 *    首跑实测：`/log_format\s+(\S+)([\s\S]*?);/` 从**注释**里的 "log_format"
 *    开始匹配，非贪婪地一路吞到下一个 `;` —— 跨过了真正的 `log_format safe`
 *    和整段 `map`，于是 `map` 键里的 `$request_uri` 被算成
 *    "log_format 含 $request_uri"，一口气报出 4 条自相矛盾的失败。
 *    **假红的代价是让人去改本来正确的配置**，所以这里必须先把注释剥掉。
 */
function stripNginxComments(conf) {
  let out = '';
  let quote = null;
  for (let i = 0; i < conf.length; i += 1) {
    const ch = conf[i];
    if (quote) {
      if (ch === '\\') {
        out += ch + (conf[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') {
      // 跳到行尾（保留换行）
      while (i < conf.length && conf[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function extractLogFormats(conf) {
  const out = [];
  const re = /log_format\s+(\S+)([\s\S]*?);/g;
  let m;
  while ((m = re.exec(conf))) out.push({ name: m[1], body: m[2] });
  return out;
}

function staticChecks() {
  section('【1】静态断言：日志格式与白名单');

  const nginxConf = fs.readFileSync(NGINX_CONF, 'utf8');
  const formats = extractLogFormats(stripNginxComments(nginxConf));

  if (formats.length === 0) {
    fail('nginx.conf 里没找到 log_format');
  } else {
    let dirty = [];
    for (const f of formats) {
      for (const v of FORBIDDEN_LOG_VARS) {
        const hits = f.body.match(v.re) || [];
        if (hits.length) dirty.push(`log_format ${f.name} 含 ${v.name} × ${hits.length}`);
      }
    }
    if (dirty.length === 0) {
      pass(
        `nginx：${formats.length} 个 log_format 均不含 ${FORBIDDEN_LOG_VARS.map((v) => v.name).join('/')}`,
      );
    } else {
      fail('★ nginx log_format 里出现了原始请求行变量 —— 凭证会重新落盘', dirty.join('；'));
    }
  }

  // 归一化变量必须真的被用起来（否则"安全"只是关掉了日志）
  if (/\$svc_log_route/.test(nginxConf) && /\$request_method/.test(nginxConf)) {
    pass('nginx：access log 使用 `$request_method` + `$svc_log_route` 记录归一化路由');
  } else {
    fail('★ nginx access log 没有使用归一化路由变量（`$svc_log_route`）');
  }

  if (/access_log\s+\/var\/log\/nginx\/access\.log\s+safe\s*;/.test(nginxConf)) {
    pass('nginx：默认 access_log 使用 `safe` 格式');
  } else {
    fail('★ 默认 access_log 未指向 `safe` 格式');
  }

  // map 的**值**必须是字面量：出现 `$` 就意味着"把原始 URL 写回日志"的退路还在
  const mapMatch = /map\s+"\$request_method\s+\$request_uri"\s+\$svc_log_route\s*\{([\s\S]*?)\n\s*\}/.exec(
    nginxConf,
  );
  if (!mapMatch) {
    fail('★ 找不到 `map "$request_method $request_uri" $svc_log_route { … }`');
  } else {
    const body = mapMatch[1];
    const entries = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      // 值 = 行尾的那个带引号字面量
      .map((l) => /"\s*([^"]*)"\s*;?\s*$/.exec(l)?.[1])
      .filter((v) => v !== undefined);

    const withVar = entries.filter((v) => v.includes('$'));
    if (withVar.length === 0 && entries.length > 0) {
      pass(`nginx：map 的 ${entries.length} 个取值全部是字面量（无 \`$\`）`);
    } else if (entries.length === 0) {
      fail('★ map 里解析不出任何取值条目（正则或格式变了？）');
    } else {
      fail('★ map 的取值里含变量 —— 原始 URL 可能被写回日志', withVar.join('；'));
    }

    if (/default\s+"[^"$]*"\s*;/.test(body)) {
      pass('nginx：map 的 `default` 是字面量（未登记的 URL 不会回落成原始路径）');
    } else {
      fail('★ map 的 `default` 缺失或含变量');
    }
  }

  // 短链 location 的 access_log off 必须还在（Phase 7 冻结语义）
  const siteConf = fs.readFileSync(SITE_CONF, 'utf8');
  for (const [label, marker] of [
    ['`/t/`', /location\s+~\s+"\^\/t\/[\s\S]{0,400}?access_log\s+off;/],
    ['`/f/`', /location\s+~\s+"\^\/f\/[\s\S]{0,400}?access_log\s+off;/],
  ]) {
    if (marker.test(siteConf)) pass(`nginx：${label} 短链仍 \`access_log off\``);
    else fail(`★ ${label} 短链丢失了 \`access_log off\``);
  }

  // 应用侧白名单源码断言
  const src = fs.readFileSync(APP_MIDDLEWARE, 'utf8');
  const keysBlock = /REQUEST_LOG_SAFE_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(src);
  if (!keysBlock) {
    fail('★ 找不到 REQUEST_LOG_SAFE_KEYS 定义');
  } else {
    const keys = [...keysBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const forbidden = ['path', 'req', 'res', 'action', 'url', 'params', 'values', 'query'];
    const bad = keys.filter((k) => forbidden.includes(k));
    if (bad.length === 0) {
      pass(`应用：白名单 ${keys.length} 个键（${keys.join(', ')}）不含任何泄漏路径键名`);
    } else {
      fail('★ REQUEST_LOG_SAFE_KEYS 混入了泄漏路径键名', bad.join('；'));
    }
  }

  // "从零构造" 是这套白名单成立的前提：一旦出现 `...src` 展开，白名单立刻失效
  if (/\.\.\.\s*(src|payload|source)\b/.test(src)) {
    fail('★ sanitize 里出现了对原始 payload 的展开（`...src`）—— 白名单已失效');
  } else {
    pass('应用：sanitize 未展开原始 payload（保持"从零构造"）');
  }
}

// ---------------------------------------------------------------------------
// §2 驱动唯一 canary（跨 2xx / 4xx / 5xx / 两种 Token 形态 / 手机号 / 姓名）
// ---------------------------------------------------------------------------
function buildCanaries() {
  const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
  const canary = `RB1CANARY${hex}`;
  const phone = `139${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
  const name = `RB1姓名${hex.slice(0, 6)}`;
  // 43 位（= REVIEW_TOKEN/TECHNICIAN_TOKEN 长度），带 canary 前缀便于定位
  const token43 = `${canary}${'X'.repeat(60)}`.slice(0, 43);
  if (token43.length !== 43) throw new Error('token43 长度构造失败');
  return { canary, phone, name, token43 };
}

async function drive(c) {
  section('【2】驱动唯一 canary（全部经 nginx 入口，覆盖两层日志）');

  const requestId = crypto.randomUUID();
  const cases = [
    {
      label: '2xx  匿名门店列表（query 带 canary）',
      expect: [200],
      run: () => httpRequest('GET', `/api/public/stores?rb1=${encodeURIComponent(c.canary)}`),
    },
    {
      label: '4xx  匿名建单（body 带 canary/姓名/手机号 → 422 且错误消息回显）',
      expect: [422],
      run: () =>
        httpRequest('POST', '/api/public/tickets', {
          headers: { 'X-Request-Id': requestId },
          body: {
            privacy_agreed: true,
            store_code: c.canary,
            customer_name: c.name,
            customer_mobile: c.phone,
            content: c.canary,
            source: 'h5',
          },
        }),
    },
    {
      label: '5xx  非法 X-Data-Source（错误响应体回显 canary）',
      expect: [500],
      run: () => httpRequest('GET', '/api/app:getInfo', { headers: { 'X-Data-Source': c.canary } }),
    },
    {
      label: '评价 Token 在 path（nginx rewrite 后的正常形态）',
      expect: [404],
      run: () => httpRequest('GET', `/api/public/reviews/${c.token43}`),
    },
    {
      label: '评价 Token 在 path（绕过 rewrite 的原始资源形态）',
      expect: [404],
      run: () => httpRequest('GET', `/api/publicReview:get/${c.token43}`),
    },
    {
      label: '师傅 Token 在 path（nginx rewrite 形态；Token 是合成的，故预期非 2xx）',
      expect: [401, 403, 404, 410],
      run: () => httpRequest('GET', `/api/technician/visits/${c.token43}`),
    },
    {
      label: '师傅 Token 在 query（绕过 rewrite 形态）',
      expect: [401, 404],
      run: () => httpRequest('GET', `/api/technicianVisit:get?token=${c.token43}`),
    },
    {
      label: 'H5 评价落地页（Token 在 path，匿名可达）',
      expect: [200],
      run: () => httpRequest('GET', `/h5/customer/review/${c.token43}`),
    },
    {
      label: '师傅照片读取（Token + ref 都在 URL）',
      expect: [401, 404],
      run: () => httpRequest('GET', `/api/technician/visits/${c.token43}/photos/AAAAAAAAAAAAAAAAAAAAAA`),
    },
  ];

  const results = [];
  for (const t of cases) {
    let status = 'ERR';
    let text = '';
    try {
      const r = await t.run();
      status = r.status;
      text = r.text;
    } catch (e) {
      text = String(e);
    }
    const ok = t.expect.includes(status);
    results.push({ label: t.label, status, expect: t.expect, ok, bodySample: text.slice(0, 120) });
    if (ok) pass(`${t.label} → ${status}`);
    else fail(`${t.label} → ${status}（期望 ${t.expect.join('/')}）`, text.slice(0, 200));
  }

  // 5xx 与 4xx 的**响应体**里必须真的带 canary，否则这一路"响应体泄漏"根本没被验证
  const five = results.find((r) => r.label.startsWith('5xx'));
  if (five && five.bodySample.includes(c.canary)) {
    pass('5xx 分支：错误响应体确实回显了 canary（该路径的有效性前提成立）');
  } else {
    fail('★ 5xx 响应体里没有 canary —— 这一路没验证到"响应体泄漏"', five?.bodySample);
  }
  const four = results.find((r) => r.label.startsWith('4xx'));
  if (four && four.ok) {
    pass('4xx 分支：请求体（含手机号/姓名）已被服务端接收并处理');
  }

  return results;
}

// ---------------------------------------------------------------------------
// §3 同时扫描所有落点
// ---------------------------------------------------------------------------
function scanSinks(snapshot, sinceApp, secrets) {
  section('【3】同时扫描全部落点（应用日志 / system 日志 / docker 日志 / nginx）');

  const newApp = readNewLogs(snapshot);

  const dockerApp = run('docker', ['logs', APP_CONTAINER, '--since', sinceApp]).out;
  const dockerNginx = run('docker', ['logs', NGINX_CONTAINER, '--since', '5m']).out;

  const sinks = [
    { name: '应用 storage/logs 新增内容（request_*.log / system_*.log / 其它）', text: newApp.text, lines: newApp.lines },
    { name: 'docker logs svc-app（本进程启动以来）', text: dockerApp, lines: dockerApp.split('\n') },
    { name: 'docker logs svc-nginx（近 5 分钟）', text: dockerNginx, lines: dockerNginx.split('\n') },
  ];

  const report = [];
  for (const sink of sinks) {
    for (const [label, value] of Object.entries(secrets)) {
      const hits = sink.lines.filter((l) => l.includes(value));
      report.push({ sink: sink.name, secret: label, hits: hits.length, sample: hits[0]?.slice(0, 160) });
      if (hits.length === 0) {
        pass(`${sink.name} · ${label} 零命中`, mask(value));
      } else {
        fail(`★ ${sink.name} 里出现 ${label}（${hits.length} 处）`, hits[0]?.slice(0, 300));
      }
    }
  }

  return { report, newApp, dockerApp, dockerNginx };
}

// ---------------------------------------------------------------------------
// §4 防「干脆不记日志」假绿 + 防「旧 logger 仍在旁边漏」
// ---------------------------------------------------------------------------
function antiFalseGreen(newApp, dockerApp, dockerNginx, driven) {
  section('【4】反假绿：证明"接管"而不是"把日志关掉"');

  const requestLines = newApp.lines.filter((l) => l.includes('"route"'));
  if (requestLines.length >= driven) {
    pass(`应用 request 日志新增 ${requestLines.length} 行（≥ 驱动请求数 ${driven}）—— 日志仍在写`);
  } else {
    fail(
      `★ request 日志只新增 ${requestLines.length} 行（驱动了 ${driven} 个请求）` +
        ' —— 可能是"把日志关掉了"而不是"接管"',
    );
  }

  // 可审计字段必须还在
  const withRoute = requestLines.filter((l) => /"route"\s*:/.test(l) && /"method"\s*:/.test(l));
  const responseLines = requestLines.filter((l) => /"status"\s*:/.test(l));
  if (withRoute.length > 0 && responseLines.length > 0) {
    pass(
      `审计字段仍在：${withRoute.length} 行含 route+method，${responseLines.length} 行含 status`,
    );
  } else {
    fail('★ 新增日志行缺 route/method/status —— 排障能力被一起删掉了');
  }

  // 旧形态字段一处都不许有（这就是"旧 logger 没有在旁边继续漏"的判据）
  const forbiddenKeys = ['"path"', '"req"', '"res"', '"action"'];
  const legacy = requestLines.filter((l) => forbiddenKeys.some((k) => l.includes(k)));
  if (legacy.length === 0) {
    pass('新增行**没有**任何框架旧形态字段（`path`/`req`/`res`/`action`）');
  } else {
    fail('★ 新增行里出现框架旧形态字段 —— 说明还有一路未接管的写入', legacy[0]?.slice(0, 300));
  }

  const urlInMessage = requestLines.filter((l) => /"message"\s*:\s*"[^"]*(\?|https?:)/.test(l));
  if (urlInMessage.length === 0) {
    pass('新增行的 `message` 里没有 URL / query');
  } else {
    fail('★ 新增行的 `message` 里仍带 URL/query', urlInMessage[0]?.slice(0, 300));
  }

  // nginx 侧的归一化路由必须真的落盘
  const nginxLines = dockerNginx.split('\n').filter((l) => l.includes('rt='));
  const wanted = ['publicReview:get', 'technicianVisit:get', 'h5:customerReview', 'public-api'];
  const missing = wanted.filter((w) => !nginxLines.some((l) => l.includes(`"GET ${w}"`) || l.includes(`"POST ${w}"`)));
  if (missing.length === 0) {
    pass(`nginx access log 出现归一化路由：${wanted.join('、')}`);
  } else {
    fail('★ nginx access log 缺少归一化路由', `缺：${missing.join('、')}`);
  }

  // nginx 日志里不得再出现任何"原始请求行"形态（含 query 或 http 版本号）
  const rawRequestLine = nginxLines.filter((l) => /"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \S+ HTTP\/1\.[01]"/.test(l));
  if (rawRequestLine.length === 0) {
    pass('nginx access log 里没有任何原始请求行（`… HTTP/1.1`）');
  } else {
    fail('★ nginx access log 里仍有原始请求行', rawRequestLine[0]?.slice(0, 220));
  }

  // ctx.log 元数据归一化：system 日志里必须出现归一化后的 submodule，且不得含 Token
  const sysLines = newApp.lines.filter((l) => l.includes('"submodule"'));
  const normalized = sysLines.filter((l) => /"submodule"\s*:\s*"(get|submit)"/.test(l));
  if (normalized.length > 0) {
    pass(`system 日志出现归一化 submodule（${normalized.length} 行，submodule=get|submit）`);
  } else if (sysLines.length > 0) {
    fail('★ system 日志有 submodule 行，但没有一行是归一化形态', sysLines[0]?.slice(0, 240));
  } else {
    fail('★ 本窗口内 system 日志没有 submodule 行 —— 无法证明 ctx.log 归一化生效');
  }

  // 启动期接管证据（限定本进程）
  const booted = dockerApp.includes('请求日志已接管');
  if (booted) pass('本进程启动日志含「请求日志已接管」');
  else fail('★ 本进程启动日志里没有接管痕迹');

  // -------------------------------------------------------------------------
  // 🔴 第三处泄漏面（`ctx.log` 的**消息实参**）的反假绿判据
  //
  // 这条最容易自己骗自己：把 error-handler 的错误日志**整条关掉**，
  // canary 当然也"零命中"。所以必须反过来证明**错误日志还在写**。
  // `"method":"error-handler"` 是框架 `plugin-error-handler/.../error-handler.js:76`
  // 固定的审计形状，它还在 ⇒ 是脱敏而不是静音。
  // -------------------------------------------------------------------------
  const errHandlerLines = dockerApp.split('\n').filter((l) => l.includes('"method":"error-handler"'));
  if (errHandlerLines.length > 0) {
    pass(
      `框架 error-handler 的错误日志**仍在写**（${errHandlerLines.length} 行带 ` +
        '`"method":"error-handler"` 审计形状）—— 是脱敏，不是把错误日志关掉',
    );
  } else {
    fail(
      '★ 本窗口内没有框架 error-handler 的错误日志行 —— 无法区分"脱敏"与"静音"，' +
        'canary 零命中可能是后者造成的',
    );
  }

  // 脱敏**确实发生过**（不是"配了个开关但从没触发"）
  const scrubEvidence = dockerApp.split('\n').filter((l) => l.includes('ctx.log 消息脱敏已生效'));
  if (scrubEvidence.length > 0) {
    pass('运行期证据：本进程出现过「ctx.log 消息脱敏已生效」');
  } else {
    fail('★ 没有观察到"脱敏确实触发过"的运行期证据 —— 可能根本没走到脱敏分支');
  }

  // 静态守卫：自检不能被悄悄摘掉
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/plugin.ts'), 'utf8');
  if (pluginSrc.includes('assertContextLogScrubbing()')) {
    pass('插件启动期仍调用 `assertContextLogScrubbing()`（消息脱敏自检未被摘掉）');
  } else {
    fail('★ plugin.ts 不再调用 `assertContextLogScrubbing()` —— 消息脱敏自检被移除了');
  }
}

// ---------------------------------------------------------------------------
// §5 反向：历史泄漏确实存在（证明消除的是真缺陷）
// ---------------------------------------------------------------------------
function historicalBaseline(secrets) {
  section('【5】反证：历史日志里确实曾有明文 Token（消除的是真实缺陷）');

  const tokenRe = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
  let requestHits = 0;
  let systemHits = 0;
  // 第三处通路（`ctx.log` 消息实参）的**历史存在性**计数。
  // 🔴 没有这一条，"canary 零命中"就可能是"这条通路本来就没人走"造成的空转 ——
  //    即：我关掉了一个从未被使用的写日志点，然后宣称自己修好了泄漏。
  let errorHandlerSinkHits = 0;

  for (const f of walk(LOG_DIR)) {
    const base = path.basename(f);
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const n = (text.match(tokenRe) || []).filter((t) => !t.toLowerCase().startsWith('mock')).length;
    if (base.startsWith('request_')) requestHits += n;
    else if (base.startsWith('system')) systemHits += n;
    errorHandlerSinkHits += (text.match(/"method":"error-handler"/g) || []).length;
  }

  if (requestHits > 0) {
    pass(`历史 request 日志里确有 ${requestHits} 处 43 位 Token 形态（既有泄漏，已被接管消除）`);
  } else {
    fail('★ 历史 request 日志里一处 Token 都没有 —— 这个反证失效了（样本被清空？）');
  }
  if (systemHits > 0) {
    pass(`历史 system 日志里确有 ${systemHits} 处 43 位 Token 形态（ctx.log 泄漏，已被归一化消除）`);
  } else {
    fail('★ 历史 system 日志里一处 Token 都没有 —— 这个反证失效了');
  }

  // 第三处通路的历史存在性：这条 sink 一直在写，不是"修好了一个没人用的地方"
  if (errorHandlerSinkHits > 0) {
    pass(
      `历史日志里确有 ${errorHandlerSinkHits} 行 ` +
        '`"method":"error-handler"`（该 sink 一直在写 ⇒ 本次"canary 零命中"不是因为通路没人走）',
    );
  } else {
    fail(
      '★ 历史日志里一行 `"method":"error-handler"` 都没有 —— 第三处通路的反证是空的，' +
        '"零命中"无法区分"已脱敏"与"这条路本来就不写"',
    );
  }

  // 本次 canary 不得出现在历史累计里（它只可能在本次窗口）
  void secrets;
}

// ---------------------------------------------------------------------------
// 反向模式：把 $request 放回 log_format，门禁**必须**变红
// ---------------------------------------------------------------------------
async function reverseRun() {
  section('【R】反向模式：把 `$request` 放回 log_format，断言门禁会变红');

  const original = fs.readFileSync(NGINX_CONF, 'utf8');
  const patched = original.replace(
    `'"$request_method $svc_log_route" '`,
    `'"$request" '`,
  );

  if (patched === original) {
    fail('★ 反向模式：找不到可替换的日志格式片段（格式已改？）');
    return;
  }

  /**
   * 收尾：还原安全配置，并**重建** nginx 容器（不是 restart）。
   *
   * 🔴 为什么要重建：`--since 5m` 的正向扫描窗口会被本反向模式**故意污染** ——
   *    反向会把带明文 Token 的原始请求行写进 `docker logs svc-nginx`。
   *    实测后果：紧接着再跑一次正向，会在 5 分钟窗口内扫到那些行而**假红**
   *    （13:16 的手工探测 + 13:19 的反向泄漏都真实发生过）。
   *    ⇒ 一个会污染下一次运行的"自检"迟早会被当成噪声忽略，必须自己收拾干净。
   *
   * ⚠️ `restart` **不**清空 `docker logs`（日志属于容器，重建才换新容器）；
   *    且必须带 `--no-deps`，否则 nginx 的 depends_on 会让 app / postgres 一起被重建。
   *    ⇒ 泄漏证据在重建前先落进证据文件（只留掩码与条数），不丢失可追溯性。
   */
  const restore = () => {
    fs.writeFileSync(NGINX_CONF, original);
    runChecked('docker', ['compose', 'up', '-d', '--force-recreate', '--no-deps', NGINX_SERVICE], {
      cwd: ROOT,
    });
  };
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });

  fs.writeFileSync(NGINX_CONF, patched);
  runChecked('docker', ['compose', 'restart', NGINX_SERVICE], { cwd: ROOT });

  // 等 nginx 起来
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      await fetch(`${BASE}/healthz`);
      break;
    } catch {
      /* 继续等 */
    }
  }

  const c = buildCanaries();

  // 🔴 为什么要有界轮询，而不是"发一次 + 等 1.2s"：
  //    首跑实测**假红**了一次 —— 刚 `restart` 完 nginx，端口映射可能瞬时重置，
  //    这时那一次 `httpRequest` 会抛连接错误，而它被 `catch {}` 吞掉 ⇒
  //    **请求根本没发出去**，日志里当然扫不到 Token ⇒ 反向被误判为失败。
  //    反向断言一旦会假红，人就会开始忽略它，这比没有反向断言更糟。
  //    ⇒ 改为最长 15s 内反复驱动 + 反复扫描，直到观察到泄漏为止。
  let leaked = [];
  let attempts = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && leaked.length === 0) {
    attempts += 1;
    try {
      await httpRequest('GET', `/api/public/reviews/${c.token43}`);
    } catch {
      /* 连接还没就绪：不算失败，下一轮重试 */
    }
    await new Promise((r) => setTimeout(r, 1200));

    const logs = run('docker', ['logs', NGINX_CONTAINER, '--since', '2m']).out;
    leaked = logs.split('\n').filter((l) => l.includes(c.token43));
  }

  if (leaked.length > 0) {
    // 证据里只留掩码：即使本 Token 是合成的，也保持"取证材料不带明文凭证"的一致性
    const masked = mask(c.token43);
    pass(
      `反向验证成功：放回 \`$request\` 后 Token 立刻出现在 nginx 日志里` +
        `（第 ${attempts} 次驱动后扫到 ${leaked.length} 处）—— 正向扫描并非空转`,
      leaked[0].split(c.token43).join(masked),
    );
    REVERSE_EVIDENCE = { leakedCount: leaked.length, attempts, sampleMasked: masked };
  } else {
    fail(
      `★ 反向验证失败：放回 \`$request\` 后（驱动 ${attempts} 次、共 15s）仍扫不到 Token ` +
        '—— 正向的"零命中"不可信',
    );
  }

  restore();
  await new Promise((r) => setTimeout(r, 2500));
  console.log('  ↩️  已还原 nginx.conf 并**重建** nginx 容器（清空被本模式污染的日志窗口）');

  // -------------------------------------------------------------------------
  // 🔴 还原必须**自证生效**（本门禁实测踩到的坑，代价很大）
  //
  // 曾发生：`restore()` 里的 compose 命令因为**服务名写成容器名**而静默失败
  // （`no such service: svc-nginx`），于是反向跑完后 nginx **仍然在泄漏** ——
  // 磁盘配置是安全的、内存里的配置是泄漏的，两边不一致。
  // 这种状态下：紧接着跑正向会假绿或假红，而且**没有任何症状**。
  // ⇒ 还原动作必须自己发一个探针、看落盘形态，证明配置真的换了。
  // -------------------------------------------------------------------------
  const after = buildCanaries();
  let restoredOk = false;
  let normalizedSeen = 0;
  let leakedAfter = 0;
  for (let i = 0; i < 8 && !restoredOk; i += 1) {
    try {
      await httpRequest('GET', `/api/public/reviews/${after.token43}`);
    } catch {
      /* 重建后连接可能还没就绪，下一轮重试 */
    }
    await new Promise((r) => setTimeout(r, 1000));

    const lines = run('docker', ['logs', NGINX_CONTAINER, '--since', '2m']).out.split('\n');
    leakedAfter = lines.filter((l) => l.includes(after.token43)).length;
    normalizedSeen = lines.filter((l) => l.includes('"GET publicReview:get"')).length;
    restoredOk = leakedAfter === 0 && normalizedSeen > 0;
  }

  if (restoredOk) {
    pass(
      `还原自证：还原后同一形态的请求已落成归一化 route（${normalizedSeen} 行），` +
        '明文 Token 零命中 —— 环境不会以泄漏状态移交下一次运行',
    );
  } else {
    fail(
      '★ 还原未自证生效：还原后仍扫到明文 Token 或看不到归一化 route ' +
        `（明文 ${leakedAfter} 处 / 归一化 ${normalizedSeen} 行）。` +
        '此时 nginx 内存配置与磁盘配置不一致，后续正向运行的结果都不可信。',
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(78));
  console.log(' verify-log-redaction —— Phase 10 / RB-1 请求日志接管门禁');
  console.log(` run_id = ${RUN_ID}${REVERSE ? '（反向模式）' : ''}`);
  console.log('='.repeat(78));

  if (!dockerAvailable()) {
    console.error('\n❌ 环境未就绪：svc-app / svc-nginx 容器未运行');
    process.exit(2);
  }
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {
    /* ignore */
  }

  staticChecks();

  if (REVERSE) {
    await reverseRun();
    // 反向模式同样落证据（只留掩码/条数）——否则"反向跑过了"这件事无从追溯
    fs.writeFileSync(
      path.join(TMP_DIR, `log-redaction-reverse-${RUN_ID}.json`),
      JSON.stringify(
        { runId: RUN_ID, mode: 'reverse', reverse: REVERSE_EVIDENCE, pass: passCount, failures: failures.map((f) => f.msg) },
        null,
        2,
      ),
      'utf8',
    );
  } else {
    const sinceApp = appStartedAt();
    const snapshot = snapshotLogs();
    const canaries = buildCanaries();

    const results = await drive(canaries);
    await new Promise((r) => setTimeout(r, 2500));

    const secrets = {
      canary: canaries.canary,
      token43: canaries.token43,
      phone: canaries.phone,
      name: canaries.name,
    };

    const { report, newApp, dockerApp, dockerNginx } = scanSinks(snapshot, sinceApp, secrets);
    antiFalseGreen(newApp, dockerApp, dockerNginx, results.filter((r) => r.ok).length);
    historicalBaseline(secrets);

    fs.writeFileSync(
      path.join(TMP_DIR, `log-redaction-${RUN_ID}.json`),
      JSON.stringify(
        {
          runId: RUN_ID,
          // ⚠️ 只写掩码/长度/哈希：证据文件不是凭证副本
          secrets: Object.fromEntries(
            Object.entries(secrets).map(([k, v]) => [k, { masked: mask(v), sha8: sha8(v) }]),
          ),
          requests: results.map((r) => ({ label: r.label, status: r.status, ok: r.ok })),
          scan: report.map((r) => ({ sink: r.sink, secret: r.secret, hits: r.hits })),
          newRequestLogLines: newApp.lines.filter((l) => l.includes('"route"')).length,
          pass: passCount,
          failures: failures.map((f) => f.msg),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\n  证据已落盘：.tmp-verify/log-redaction-${RUN_ID}.json（仅掩码/哈希，无明文）`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(` 通过 ${passCount} 项，失败 ${failures.length} 项`);
  console.log('='.repeat(78));

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ 门禁自身异常：', e);
  process.exit(1);
});
