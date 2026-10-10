#!/usr/bin/env node
/**
 * verify-technician-routing.mjs —— **Phase 5 P5-0 · Routing & Environment Gate**
 * =============================================================================
 *
 * 只回答两个问题（不碰任何业务逻辑）：
 *
 *   ① 短信里的那条链接，**真的能把师傅送到本系统**吗？
 *      `{PUBLIC_BASE_URL}/t/{token}` → 302 → H5 路由
 *      —— 含"PUBLIC_BASE_URL 指向的是**本实例**"这一条（见闸门 ④）。
 *
 *   ② 匿名师傅接口**真的能穿过 nginx 到达我们的 handler** 吗？
 *      `/api/technician/visits/{任意token}` → **401 TOKEN_INVALID**（而不是 resourcer 的 404）
 *
 * ---------------------------------------------------------------------------
 * 为什么闸门 ② 是"漂亮的"：**不需要造合法 Token 就能证明路由是通的**
 * ---------------------------------------------------------------------------
 * 路由没配好（裸 proxy_pass，DEV-18 同型）与配好了的表现**完全不同**：
 *   · 没配 → NocoBase 把 `technician` 当资源名 → `getResource` 抛错 →
 *            resourcerMiddleware `catch { console.log; return next() }` → **404**；
 *   · 配好 → 请求进到我们的 handler → 第一步就是 Token 认证 → **401 TOKEN_INVALID**。
 * 所以只要断言"随机 token 得到的是 **401 且错误码是 TOKEN_INVALID**"，
 * 就已经同时证明了：nginx 重写生效、资源已注册、ACL 已放行、handler 真的被执行。
 * 反之若得到 404，则说明请求根本没到我们的代码 —— **与 token 是否有效无关**。
 *
 * ⚠️ 因此**不能**把"返回 401"写成"返回非 200"：404 也满足"非 200"。
 *    必须精确断言 status === 401 **且** `errors[0].code === 'TOKEN_INVALID'`。
 *
 * ---------------------------------------------------------------------------
 * 闸门 ④ 为什么必须"真的发一次请求"
 * ---------------------------------------------------------------------------
 * `PUBLIC_BASE_URL` 与 `NGINX_HTTP_PORT` 的静态一致性已由 `verify-config.mjs` 覆盖，
 * 但那只证明"两个数字相等"。真正要证明的是：**这个基址背后就是本系统**。
 * 做法：取 `PUBLIC_BASE_URL + /t/<probe>` 请求一次，要求它返回
 * **我们特有的那个 302 与 Location**（`/h5/technician/visit/<probe>`）。
 * 若基址指向了别的服务（本机 80 上是另一个项目），几乎不可能恰好回出同样的 Location。
 * 这正是"Token 正确、短信发出去了、师傅点进去是另一个系统"那类缺陷的**唯一自动判据**。
 *
 * ---------------------------------------------------------------------------
 * 反向验证（--reverse）
 * ---------------------------------------------------------------------------
 * 铁律 8：断言不会变红 = 没有断言。`--reverse` 会对**两条关键闸门各注入一次缺陷**，
 * 一次只改一处、要求"缺陷真的生效"（轮询，不假设 reload 立即生效）后判红，
 * 随后在 `finally` 里还原配置 + reload + 要求回到全绿：
 *   · 删掉 nginx 的三条 rewrite        → 闸门 ③ 必须如实变红（请求退回 404）
 *   · 把 absolute_redirect 改回默认 on → 闸门 ① 必须如实变红（Location 变绝对地址）
 * 这是唯一能证明"闸门真的在观测它声称观测的东西"的手段 ——
 * 否则它可能只是碰巧因为别的原因返回 401 / 302。
 *
 * 用法：
 *   node scripts/verify-technician-routing.mjs            # 正常校验
 *   node scripts/verify-technician-routing.mjs --reverse   # 反向验证（会临时改 nginx）
 *   node scripts/verify-technician-routing.mjs --verbose
 *
 * 退出码：0 = 全绿；1 = 真红灯；2 = 环境未就绪（nginx/docker 不可达等）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SVC_SCHEME, SVC_BASE_URL_PORT, SVC_BASE_URL } from './lib/base-url.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');
const VIA_CONTAINER = 'svc-nginx';
const REVERSE = process.argv.includes('--reverse');
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// 从配置读出门牌号与短链前缀 —— 不在脚本里硬编码
// ---------------------------------------------------------------------------
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValueOf = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(envText)?.[1]?.trim();

const PUBLIC_BASE_URL = envValueOf('PUBLIC_BASE_URL');
const NGINX_HTTP_PORT = envValueOf('NGINX_HTTP_PORT');
if (!PUBLIC_BASE_URL || !NGINX_HTTP_PORT) {
  console.error('✗ .env 缺少 PUBLIC_BASE_URL 或 NGINX_HTTP_PORT —— 环境未就绪');
  process.exit(2);
}
// ---------------------------------------------------------------------------
// ⚠️ 两个端口不能混用（本脚本第一版的真实缺陷）
// ---------------------------------------------------------------------------
//   · 宿主机视角：nginx 发布在 `NGINX_HTTP_PORT`（本地 8080），PUBLIC_BASE_URL 写的就是它；
//   · 容器内视角：nginx 监听的是 `listen 80`（见 nginx/conf.d/service.conf）。
// 用 `docker exec svc-nginx curl 127.0.0.1:8080` 会**必然连不上**（容器里 8080 无人监听），
// 表现为"环境未就绪"，最容易把人误导去查容器是不是挂了。
// 所以：容器内探测一律打 `CONTAINER_ORIGIN`；宿主机视角的探测（闸门 ⑤）另走 `hostProbe`。
const siteConfText = fs.readFileSync(SITE_CONF, 'utf8');
/** 80 段监听的端口（只用于错误提示；**它不再承载业务**，见下面的说明） */
const containerListenPort =
  Number(/^[ \t]*listen\s+(?:\[::\]:)?(\d+)(?!\s*ssl)/m.exec(siteConfText)?.[1]) || 80;
/**
 * 🔴 **443 段**（`listen <port> ssl`）—— 业务真正的入口。
 *
 * 2026-10-10 修正 **DEV-133**：本文件原先探的是 `http://127.0.0.1:${containerListenPort}`
 * （= 80 段）。而 **P10-C 之后 80 段只做三件事**：`/healthz`、ACME 校验路径、**其余一律 301 到 HTTPS**。
 * 于是①②③④几条"路由闸门"实际观测到的**全是那个 301**
 * （`❌ ① 短链必须 302 —— 实际 301`），而它**既不是产品缺陷、也不在验证路由** ——
 * 一整段红灯全部打在 P10-C 的**预期行为**上。
 * ⇒ 判据必须打在**承载业务的端口**上；80 段的那一跳由闸门 ⑤ 单独、显式地验。
 */
const containerTlsPort =
  Number(/^[ \t]*listen\s+(?:\[::\]:)?(\d+)\s+ssl/m.exec(siteConfText)?.[1]) || 443;
/** 容器内探测用的 origin（与"真人经过 nginx"同一条路径：同一张网卡、同一套 location 匹配） */
const ORIGIN = `https://127.0.0.1:${containerTlsPort}`;
/** 写进错误提示里，避免下次又拿宿主机端口去 docker exec */
const HOST_ORIGIN = new URL(`${SVC_SCHEME}://127.0.0.1:${SVC_BASE_URL_PORT}`).origin;

const constantsTs = fs.readFileSync(
  path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
  'utf8',
);
const tokenBlock = constantsTs.slice(
  constantsTs.indexOf('export const TECHNICIAN_TOKEN = {'),
  constantsTs.indexOf('} as const;', constantsTs.indexOf('export const TECHNICIAN_TOKEN = {')),
);
const TOKEN_LENGTH = Number(/LENGTH:\s*(\d+)/.exec(tokenBlock)?.[1]);
const LINK_PATH = /LINK_PATH:\s*'([^']+)'/.exec(tokenBlock)?.[1];

const H5_PREFIX = /H5_PATH_PREFIX:\s*'([^']+)'/.exec(constantsTs)?.[1];
if (!TOKEN_LENGTH || !LINK_PATH || !H5_PREFIX) {
  console.error('✗ 无法从 constants.ts 解析 TECHNICIAN_TOKEN / TECHNICIAN_LINK —— 环境未就绪');
  process.exit(2);
}

const results = [];
const failures = [];
let envNotReady = null;

const log = (s) => console.log(s);

const pass = (label, detail = '') => {
  results.push({ ok: true, label, detail });
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
};
const fail = (label, detail) => {
  results.push({ ok: false, label, detail });
  failures.push({ label, detail });
  console.log(`  ❌ ${label}\n       ${detail}`);
};

// ---------------------------------------------------------------------------
// HTTP 探测：**走容器内的 curl**
// ---------------------------------------------------------------------------
// 为什么不用本机 fetch：
//   · 本机可能有代理环境变量（HTTPS_PROXY）把 127.0.0.1 之外的请求劫走；
//   · 走容器 curl 与"真人经过 nginx"的路径完全一致（同一张网卡、同一个 location 匹配）。
// 为什么每次 `-H 'Connection: close'`：
//   · 反向验证会 reload nginx，keep-alive 复用会让旧 worker 继续服务 → 读到上一版配置
//     （dev 手册里那两条"缺陷态读到好配置"的坑，这里同样适用）。
const curlProbe = ({ url, method = 'GET', body = null, headers = [] }) => {
  const args = [
    'exec',
    VIA_CONTAINER,
    'curl',
    // 🔴 `-k`：**只因为本实例挂的是自签演练证书**（容器内没有系统 CA 认得它）。
    //    这不等于"不校验对端" —— 证书指纹与 SAN 由 `scripts/verify-tls.mjs` **独立**钉死。
    //    ⚠️ 绝不为了让它通过而去改生产 TLS 配置（用户 2026-10-10 明令）。
    '-k',
    '-sS',
    '-o',
    '-',
    '-D',
    '-',
    '-X',
    method,
    '-H',
    'Connection: close',
    ...headers.flatMap((h) => ['-H', h]),
    '--max-time',
    '20',
  ];
  if (body !== null) args.push('--data-binary', body);
  args.push(url);

  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 40000 });
  const raw = `${r.stdout || ''}`;
  // 头与体之间是空行；先切出状态行/响应头，剩下的是 body
  const sep = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const idx = raw.indexOf(sep);
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const rest = idx >= 0 ? raw.slice(idx + sep.length) : '';

  const status = Number(/^HTTP\/[\d.]+\s+(\d+)/m.exec(head)?.[1] ?? 0);
  const headerOf = (name) => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
    return m ? m[1].trim() : null;
  };
  const bodyText = rest.trim();
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    /* 非 JSON（例如 nginx 的 404 页面）保持 null */
  }
  return {
    status,
    location: headerOf('location'),
    bodyRaw: bodyText,
    json,
    stderr: (r.stderr || '').trim(),
    spawnError: r.error ? String(r.error.message) : null,
  };
};

// ---------------------------------------------------------------------------
// 宿主机视角探测（**闸门 ⑤ 专用**）
// ---------------------------------------------------------------------------
// `PUBLIC_BASE_URL` 描述的是**外部/宿主机**看到的地址（本地 `http://localhost:8080`）。
// 在容器里探测它必然失败 —— 容器内的 `localhost` 是容器自己，8080 无人监听。
// 而且这里刻意**不用 curl**：本机 bash 环境有 `HTTPS_PROXY=http://127.0.0.1:7897`，
// curl 会把 `localhost` 之外的请求劫走；Node 内置 fetch（undici）默认不读代理环境变量。
const hostProbe = async (url) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ac.signal });
    const bodyRaw = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(bodyRaw);
    } catch {
      /* 非 JSON 保持 null */
    }
    return {
      status: res.status,
      location: res.headers.get('location'),
      bodyRaw,
      json,
      stderr: null,
      spawnError: null,
    };
  } catch (e) {
    return {
      status: 0,
      location: null,
      bodyRaw: '',
      json: null,
      stderr: String(e?.cause?.message || e?.message || e),
      spawnError: null,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** 基址是否指向本机（决定闸门 ⑤ 用宿主机探测还是容器探测） */
const isLoopbackUrl = (u) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:/]|$)/i.test(u);

/** 生成一个**格式合法**但几乎不可能存在的 token（base64url、指定长度） */
const randomToken = () =>
  crypto
    .randomBytes(48)
    .toString('base64')
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=/g, '')
    .slice(0, TOKEN_LENGTH);

// ---------------------------------------------------------------------------
// 前置：服务可达（区分"环境未就绪"与"真红灯"—— 铁律 4）
// ---------------------------------------------------------------------------
console.log('══ Phase 5 P5-0 · 路由与环境闸门 ══\n');
console.log(
  `  容器内端点：${ORIGIN}（nginx listen ${containerListenPort}）` +
    `   宿主机映射：${HOST_ORIGIN}\n` +
    `  基址：${PUBLIC_BASE_URL}   短链：${LINK_PATH}{${TOKEN_LENGTH}}\n`,
);

{
  const health = curlProbe({ url: `${ORIGIN}/healthz` });
  if (health.status === 0 || health.spawnError) {
    console.error(
      `✗ 环境未就绪：容器内 ${ORIGIN}/healthz 不可达（${health.stderr || health.spawnError || 'docker exec 失败'}）\n` +
        `  提示：容器里 nginx 监听的是 listen ${containerListenPort}，**不是**宿主机端口 ${NGINX_HTTP_PORT}。\n` +
        '  请先确认容器在跑：docker compose ps',
    );
    process.exit(2);
  }
  console.log(`  · 前置：/healthz → ${health.status}\n`);
}

// ---------------------------------------------------------------------------
// 闸门 ①：短链 302 到 H5（合法形态）
// ---------------------------------------------------------------------------
{
  const token = randomToken();
  const r = curlProbe({ url: `${ORIGIN}${LINK_PATH}${token}` });
  const expected = `${H5_PREFIX}${token}`;
  if (r.status !== 302) {
    fail('① 短链 /t/{token} 必须 302', `实际 ${r.status}（期望 302）body=${r.bodyRaw.slice(0, 120)}`);
  } else if (r.location !== expected) {
    fail('① 短链 302 的 Location 必须指向 H5 师傅页', `实际 Location=${r.location}，期望 ${expected}`);
  } else {
    pass('① 短链 /t/{token} → 302 → H5 师傅页', `Location: ${r.location}`);
  }
  // 302 而非 301：301 会被客户端长期缓存，H5 路径将来就改不动了
  if (r.status === 301) {
    fail('① 短链不得使用 301', '301 会被浏览器/中间层长期缓存 —— 将来改 H5 路径时无法生效');
  }
}

// ---------------------------------------------------------------------------
// 闸门 ②：畸形短链不得跳进 H5
// ---------------------------------------------------------------------------
for (const bad of ['abc', 'x'.repeat(TOKEN_LENGTH - 1), 'y'.repeat(TOKEN_LENGTH + 1), `${'z'.repeat(42)}!`]) {
  const r = curlProbe({ url: `${ORIGIN}${LINK_PATH}${bad}` });
  const shown = bad.length > 14 ? `${bad.slice(0, 8)}…(${bad.length})` : bad;
  if (r.status === 302 || r.status === 200) {
    fail(`② 畸形短链必须被拒（"${shown}"）`, `实际 ${r.status} —— 不该被跳转或渲染（Location=${r.location}）`);
  } else {
    pass(`② 畸形短链被拒（"${shown}"）`, `HTTP ${r.status}`);
  }
}

// ---------------------------------------------------------------------------
// 闸门 ③：/api/technician/* 到达我们的 handler（随机 token → 401 TOKEN_INVALID）
// ---------------------------------------------------------------------------
//
// 这是本脚本的**核心断言**。三个 action 都要打 —— 只测 get 的话，
// "files/submit 的 rewrite 写没写对"就完全没有覆盖（而它们更容易被漏）。
const ROUTE_PROBES = [
  { name: 'get', method: 'GET', path: (t) => `/api/technician/visits/${t}` },
  { name: 'upload', method: 'POST', path: (t) => `/api/technician/visits/${t}/files` },
  { name: 'submit', method: 'POST', path: (t) => `/api/technician/visits/${t}/submit` },
];

/** 统一的 401 判据：**状态码 + 错误码**（只看状态会把 404 也当成通过） */
const isTokenInvalid = (r) =>
  r.status === 401 && r.json?.errors?.[0]?.code === 'TOKEN_INVALID';

const routeBodies = [];
for (const probe of ROUTE_PROBES) {
  const token = randomToken();
  const r = curlProbe({
    url: `${ORIGIN}${probe.path(token)}`,
    method: probe.method,
    body: probe.method === 'POST' ? '{}' : null,
    headers: probe.method === 'POST' ? ['Content-Type: application/json'] : [],
  });
  routeBodies.push({ probe: probe.name, token, r });

  if (r.status === 404) {
    fail(
      `③ ${probe.name}：匿名师傅接口必须到达我们的 handler`,
      `得到 404 —— 请求**没有**进到我们的代码（nginx 的 /api/technician/ 重写缺失？` +
        `见 DEV-18 同型缺陷与 nginx/conf.d/service.conf 该段注释）。body=${r.bodyRaw.slice(0, 140)}`,
    );
  } else if (!isTokenInvalid(r)) {
    fail(
      `③ ${probe.name}：随机 token 必须得到 401 TOKEN_INVALID`,
      `实际 ${r.status} / code=${r.json?.errors?.[0]?.code ?? '(非 JSON)'} body=${r.bodyRaw.slice(0, 140)}`,
    );
  } else {
    pass(`③ ${probe.name}：随机 token → 401 TOKEN_INVALID`, '证明已穿过 nginx 到达 handler');
  }
}

// ---------------------------------------------------------------------------
// 闸门 ④：失败响应体**逐字节一致**（防枚举）
// ---------------------------------------------------------------------------
//
// 六种失效原因（不存在/过期/已用/被改派/Visit 非活跃/工单非活跃）对外必须**同一种表现**，
// 否则"这个链接是过期还是不存在"本身就是一条枚举侧信道。
// 这里用"同一个随机 token 打三个 action"做**同质可比**的比对
// （不同 token 之间必然不同——body 里不该出现 token；出现了就是泄露，见下一条）。
{
  const bodies = routeBodies.filter((b) => isTokenInvalid(b.r)).map((b) => b.r.bodyRaw);
  if (bodies.length < 2) {
    fail('④ 失败响应体一致性', `可比的 401 响应不足（只有 ${bodies.length} 个），无法判定`);
  } else {
    const uniq = new Set(bodies);
    if (uniq.size !== 1) {
      fail(
        '④ 三种失效响应的 body 必须逐字节一致',
        `出现了 ${uniq.size} 种不同 body：\n       ${[...uniq]
          .map((b) => b.slice(0, 160))
          .join('\n       ')}`,
      );
    } else {
      pass('④ 三种失效响应的 body 逐字节一致（防枚举）', bodies[0].slice(0, 90));
    }
    // 反向确认 body 里**没有**出现请求用的 token（否则等于把凭证回显了）
    const leaked = routeBodies.filter((b) => b.r.bodyRaw.includes(b.token ?? '\u0000')).length;
    if (leaked > 0) {
      fail('④ 失败响应体不得回显 token', `有 ${leaked} 个响应体包含请求所用的 token`);
    }
  }
  // 明确断言：body 里不得出现任何"失效原因"字样（内部 reason 只进日志）
  const REASON_WORDS = ['EXPIRED', 'ALREADY_USED', 'REVOKED', 'NOT_FOUND', 'MALFORMED', 'VISIT_NOT_ACTIVE'];
  const leakedReasons = routeBodies.flatMap((b) =>
    REASON_WORDS.filter((w) => b.r.bodyRaw.includes(w)).map((w) => `${b.probe}:${w}`),
  );
  if (leakedReasons.length > 0) {
    fail('④ 失败响应体不得暴露失效原因', `出现了：${leakedReasons.join(', ')}（原因只应进服务端日志）`);
  } else {
    pass('④ 失败响应体未暴露失效原因（EXPIRED / REVOKED / ALREADY_USED … 均未出现）');
  }
}

// ---------------------------------------------------------------------------
// 闸门 ⑤：PUBLIC_BASE_URL 指向**本实例**（真发一次请求）
// ---------------------------------------------------------------------------
{
  const probe = randomToken();
  const target = `${PUBLIC_BASE_URL}${LINK_PATH}${probe}`;
  const expected = `${H5_PREFIX}${probe}`;
  // 基址是本机 → 必须从**宿主机**发（容器里 localhost 指向容器自己）；
  // 基址是公网域名 → 从容器发（本机 curl 会被代理劫走）。
  const fromHost = isLoopbackUrl(PUBLIC_BASE_URL);

  /**
   * 🔴 本闸门必须走**两步**，且最终判据落在 **HTTPS** 上（DEV-133）。
   *
   * 为什么不能"看请求基址回了 302 就算过"：
   *   · 本演练环境的 `PUBLIC_BASE_URL` **刻意**是 `http://localhost:8080`
   *     （80 已被别的项目占用；production profile 另有"必须 https 非 localhost"的校验）；
   *   · P10-C 之后这一跳是 **301 → HTTPS**。
   *   ⇒ 于是有两个**完全不同**的结论都能拿到"非 200"：
   *      「基址指向了别的服务」 vs 「基址指向本实例、只是先跳一次 https」。
   *     只断言"不是 200"分不出这两者；只断言"回了 301"更是把**没验任何路由**当成通过。
   *   所以：
   *     第 1 步：把 http→https 的**一跳**显式记下来（只允许 301/302 且 Location 必须是 https）；
   *     第 2 步：**请求那个 https 地址**，要求**最终**响应是本系统特有的那个 302 与 Location。
   */
  const first = fromHost ? await hostProbe(target) : curlProbe({ url: target });
  const how = fromHost ? '宿主机' : '容器';

  if (first.status === 0 || first.spawnError) {
    envNotReady = `PUBLIC_BASE_URL（${PUBLIC_BASE_URL}）不可达：${first.stderr || first.spawnError}`;
    fail('⑤ PUBLIC_BASE_URL 必须可达', envNotReady);
  } else if (first.status === 302) {
    // 部署形态 B：基址本身就是 https（正式环境应当长这样）—— 一步到位
    if (first.location === expected) {
      pass('⑤ PUBLIC_BASE_URL 指向本实例', `${PUBLIC_BASE_URL}${LINK_PATH}… → 302 ${expected}（${how}）`);
    } else {
      fail(
        '⑤ PUBLIC_BASE_URL 必须指向本实例',
        `取 ${target} 得到 302 但 Location=${first.location}，期望 ${expected}`,
      );
    }
  } else if (first.status === 301) {
    // 部署形态 A（本演练环境）：http → https 一跳
    const loc = String(first.location ?? '');
    if (!/^https:\/\//i.test(loc)) {
      fail(
        '⑤ 基址的 301 必须跳到 https',
        `Location=${JSON.stringify(loc)} 不是 https —— 短信链接会落到明文段（P10-C 要求 HTTP 无业务直出）`,
      );
    } else {
      const httpsTarget = new URL(loc).toString();
      const second = fromHost ? await hostProbe(httpsTarget) : curlProbe({ url: httpsTarget });
      if (second.status === 302 && second.location === expected) {
        pass(
          '⑤ PUBLIC_BASE_URL 指向本实例（经 http→https 一跳后验最终响应）',
          `${target} → 301 ${loc} → **302 ${expected}**（${how}探测；判据落在最终响应上）`,
        );
      } else {
        fail(
          '⑤ 跟随 http→https 后的最终响应不是本系统的短链 302',
          `https 地址 ${httpsTarget} 得到 ${second.status}` +
            `${second.location ? ` / Location=${second.location}` : ''}，期望 302 → ${expected}。\n` +
            '       基址很可能指向了别的服务 —— 短信链接会把师傅送到错的系统，' +
            '而 Token 与短信都是"成功"的。',
        );
      }
    }
  } else {
    fail(
      '⑤ PUBLIC_BASE_URL 必须指向本实例',
      `取 ${target} 得到 ${first.status}（期望 302，或 301 → https 后再 302）` +
        `${first.location ? ` / Location=${first.location}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const summarize = (title) => {
  console.log(`\n${title}`);
  console.log(`  通过 ${results.filter((r) => r.ok).length} 项，失败 ${failures.length} 项`);
};

if (!REVERSE) {
  summarize('══════════════════════════════════════════');
  if (failures.length > 0) {
    console.log('\n❌ 路由与环境闸门未通过');
    process.exit(1);
  }
  if (envNotReady) {
    console.log('\n⚠️  有环境项未就绪（见上），闸门判定可能不完整');
    process.exit(2);
  }
  console.log('\n✅ 路由与环境闸门全部通过');
  process.exit(0);
}

// ===========================================================================
//  反向验证（--reverse）
// ===========================================================================
// 铁律 8：断言不会变红 = 没有断言。这里对**两条关键闸门**各注入一次缺陷，
// 一次只改一处、改完必须**轮询到缺陷真的生效**再判定，最后统一还原并轮询回绿。
//
//   · 缺陷 A：删掉 /api/technician/ 的三条 rewrite  → 闸门 ③ 必须变红（404）
//   · 缺陷 B：把 absolute_redirect 改回 on（nginx 默认值）→ 闸门 ① 必须变红（Location 变绝对）
//
// 缺陷 B 尤其重要：闸门 ① 的"Location 必须是 `/h5/...` 这个相对路径"很容易被写成
// `endsWith(...)` 之类的宽松断言 —— 那种断言**永远抓不到** absolute_redirect 这个缺陷。
const original = fs.readFileSync(SITE_CONF, 'utf8');
const REWRITE_RE = /^[ \t]*rewrite "?\^\/api\/technician\/visits\/.*$/gm;

const reload = () => {
  execFileSync('docker', ['exec', VIA_CONTAINER, 'nginx', '-s', 'reload'], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const ABSOLUTE_REDIRECT_RE = /^([ \t]*)absolute_redirect off;[ \t]*$/m;

const DEFECTS = [
  {
    // ⚠️ 2026-10-10（DEV-133 收口）：文案与前置条件都跟着 nginx 的实际形态走。
    //    原先写死"**三条** rewrite、数量必须 === 3" —— 而 nginx 后来加了照片的两条
    //    （`.../photos/{ref}`），于是**前置条件不成立 ⇒ 整条反向验证被 SKIP**。
    //    🔴 而用户明令"**不得把 SKIP 计为 PASS**"：一次 SKIP 等于"这一层没验"，
    //    但报告上很容易被读成"反向验证通过了"。
    //    ⇒ 改成"至少三条"（真正的判据是"这些重写存在且在起作用"，不是"恰好三条"），
    //      注入时**全部**删掉 —— 删干净才能证明"路由靠的是重写"。
    label: '删掉 /api/technician/visits/ 的全部 rewrite',
    precondition: () => (original.match(REWRITE_RE) || []).length >= 3,
    preconditionMsg: 'nginx 里少于 3 条 /api/technician/visits/ rewrite',
    mutate: (t) => {
      const n = (t.match(REWRITE_RE) || []).length;
      if (n < 3) return t;
      return t.replace(REWRITE_RE, '');
    },
    probe: () => {
      const r = curlProbe({ url: `${ORIGIN}/api/technician/visits/${randomToken()}` });
      return { red: r.status === 404, last: `HTTP ${r.status}` };
    },
    /**
     * 额外自证：注入后 nginx 里**确实一条 rewrite 都不剩**。
     *
     * ⚠️ 没有这一步时，"注入没生效"与"闸门没观测到"会长得一模一样 ——
     *    而 reload 是异步的、keep-alive 又会复用旧 worker（本项目的老坑）。
     */
    assertMutated: (t) => (t.match(REWRITE_RE) || []).length === 0,
    explain: [
      '  ✅ 反向验证成立：闸门 ③ 观测的确实是 nginx 重写 ——',
      '     删掉重写后请求退回 404（resourcer 的"资源不存在"），正是 DEV-18 同型的缺陷形态。',
      '     ⇒ 若没有这条闸门，"路由没配好"会被误读成"接口不存在"，排查时会先入为主地怀疑应用代码。',
    ],
  },
  {
    label: '把短链段的 absolute_redirect 改回 on（即 nginx 默认值）',
    precondition: () => ABSOLUTE_REDIRECT_RE.test(original),
    preconditionMsg: '短链段里找不到 `absolute_redirect off;`',
    mutate: (t) => t.replace(ABSOLUTE_REDIRECT_RE, '$1absolute_redirect on;'),
    probe: () => {
      const r = curlProbe({ url: `${ORIGIN}${LINK_PATH}${randomToken()}` });
      const isAbsolute = !!r.location && /^https?:\/\//i.test(r.location);
      return { red: isAbsolute, last: `HTTP ${r.status}${r.location ? ` Location=${r.location}` : ''}` };
    },
    explain: [
      '  ✅ 反向验证成立：闸门 ① 观测的确实是 Location 的**相对形态** ——',
      '     打开 absolute_redirect 后，同一条短链回出的 Location 变成 `http://<Host>/h5/...`，',
      '     主机名与端口取自**请求的 Host 头**，而不是我们写死的那段路径。',
      '     ⇒ 这正是"短信链接把师傅送去别处 / 上 HTTPS 后被判降级"这类缺陷的形态。',
    ],
  },
];

/** 轮询直到探针报红（reload 不是同步生效的，不能假设立即生效） */
const pollUntil = async (probe, wantRed, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = probe();
    last = r.last ?? null;
    if (r.red === wantRed) return { hit: true, last };
    if (Date.now() >= deadline) return { hit: false, last };
    await sleep(700);
  }
};

/** "环境已回到全绿"的探针：匿名接口 401 **且** 短链 Location 是相对路径 */
const greenProbe = () => {
  const a = curlProbe({ url: `${ORIGIN}/api/technician/visits/${randomToken()}` });
  const b = curlProbe({ url: `${ORIGIN}${LINK_PATH}${randomToken()}` });
  const okA = a.status === 401;
  const okB = b.status === 302 && !!b.location && !/^https?:\/\//i.test(b.location);
  return {
    red: okA && okB,
    last: `api=${a.status} / t=${b.status}${b.location ? ` Loc=${b.location}` : ''}`,
  };
};

let aborted = false;
let unobserved = false;
let healthy = false;
const verified = [];

try {
  for (const d of DEFECTS) {
    console.log(`\n══ 反向验证：${d.label} ══`);
    if (!d.precondition()) {
      aborted = true;
      console.log(`  ⚠️  前置条件不成立：${d.preconditionMsg} —— 跳过，不做判定`);
      continue;
    }
    fs.writeFileSync(SITE_CONF, d.mutate(original), 'utf8');
    // 🔴 回读自证：**注入必须真的落到配置文件上**。
    //    没有这一步时，"注入没生效"与"闸门没观测到"长得一模一样 ——
    //    而 reload 是异步的、keep-alive 会复用旧 worker（本项目的老坑）。
    if (typeof d.assertMutated === 'function') {
      const written = fs.readFileSync(SITE_CONF, 'utf8');
      if (!d.assertMutated(written)) {
        unobserved = true;
        console.log('  ❌ 注入缺陷**没有真正落到配置文件上**（写回后回读不满足预期）—— 这一次不做判定');
        continue;
      }
      console.log('  · 注入已回读确认');
    }
    reload();
    console.log('  · 已注入缺陷并 reload nginx');

    const res = await pollUntil(d.probe, true);
    if (!res.hit) {
      unobserved = true;
      console.log(`  ❌ 注入缺陷后等了 30s 仍未变红（最后 ${res.last}）—— **断言没有观测到它声称观测的东西**`);
      continue;
    }
    console.log(`  · 缺陷已生效：${res.last}`);
    for (const line of d.explain) console.log(line);
    verified.push(d.label);
  }
} finally {
  if (fs.readFileSync(SITE_CONF, 'utf8') !== original) {
    fs.writeFileSync(SITE_CONF, original, 'utf8');
    console.log('\n── 已还原 nginx 配置 ──');
  }
  try {
    reload();
    const res = await pollUntil(greenProbe, true);
    healthy = res.hit;
    console.log(`  · 还原后状态：${res.last}（应为 api=401 且 Location 相对）${healthy ? ' ✅' : ' ✗'}`);
    if (!healthy) {
      console.error('  ✗ 还原后仍未回到全绿 —— **请手工确认 nginx 配置并 reload**');
    }
  } catch (e) {
    console.error(`✗ 还原后 reload 失败：${e.message} —— **请手工确认 nginx 配置并 reload**`);
  }
}

if (!healthy) process.exit(1);
if (unobserved) {
  console.error('\n❌ 反向验证失败：有缺陷注入后闸门没变红 —— 该断言是假绿（配置已还原）');
  process.exit(1);
}
if (aborted) {
  console.error('\n❌ 反向验证未能完整执行（前置条件不成立，已还原，未做判定）');
  process.exit(2);
}
console.log(`\n✅ 反向验证通过：${verified.length} 条闸门都能变红，且环境已干净还原。`);
process.exit(0);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
