#!/usr/bin/env node
/**
 * verify-tls.mjs —— TLS 入口「工程链路」真机门禁（Phase 10 / P10-C）
 *
 * ===========================================================================
 * 它证明什么、**不**证明什么（这条边界必须写在最前面）
 * ===========================================================================
 * ✅ 证明 = **TLS implementation gate**：
 *    · 443 真的在监听、TLS handshake 成功；
 *    · 证书/私钥挂载路径正确（握手拿到的公钥与 `storage/certs/tls.crt` 是同一份）；
 *    · 证书 SAN 覆盖我们实际使用的主机名；
 *    · 80 → 443 跳转**保留 path 与 query**；
 *    · HTTPS 上 H5 / API / 短链都能工作；
 *    · HTTP 上**不再直出业务**（业务路径一律 301），但 `/healthz` 仍明文可用
 *      （容器 healthcheck 依赖它，打死了会让容器永远不健康）；
 *    · 自签演练阶段**不得**下发 HSTS。
 *
 * ❌ **不**证明 = **TLS production release gate（HOLD）**：
 *    浏览器/客户端的**信任链**是否成立。自签证书无论怎么配都不满足
 *    「域名匹配 + 由客户端信任的 CA 签发」。
 *    本门禁把这一点做成一条**反向断言**：在**默认 CA 校验**下握手**必须失败** ——
 *    也就是说它不给出"TLS 已经可以上线"的错觉，而是明确记录
 *    「现在这条链路是**可用的**，但**不被信任**」。
 *
 * ===========================================================================
 * 为什么反向断言要写在这里，而不是"等真实域名时再补"
 * ===========================================================================
 * 因为"工程链路通过"最容易被读成"TLS 完成了"。把 `默认校验必须失败` 写成断言，
 * 等于让"信任链未成立"这件事**每次跑门禁都被复述一遍**；将来换成受信证书时，
 * 这条断言会**主动变红**，逼人把它改成"默认校验必须成功"——那时才算真的关掉。
 *
 * 用法：node scripts/verify-tls.mjs
 * 退出码：0 绿 / 1 红 / 2 环境未就绪
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  SVC_HTTP_PORT,
  SVC_HTTPS_PORT,
  SVC_TLS_INSECURE,
  certPath,
} from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const failures = [];
let passed = 0;

function ok(msg) {
  passed += 1;
  console.log(`  ✅ ${msg}`);
}
function no(msg) {
  failures.push(msg);
  console.log(`  ❌ ${msg}`);
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else no(msg);
}
function assertEq(actual, expected, what) {
  assert(String(actual) === String(expected), `${what} —— ${actual}`);
}
function section(t) {
  console.log('');
  console.log(`【${t}】`);
}

const HTTPS_URL = `https://localhost:${SVC_HTTPS_PORT}`;
const HTTP_URL = `http://localhost:${SVC_HTTP_PORT}`;

/** 关闭 Node 自带的 CA 校验（自签演练），但 SAN/指纹由下面的断言**独立**钉住 */
function connectTls({ rejectUnauthorized, servername = 'localhost' }) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: SVC_HTTPS_PORT,
        servername,
        // ⚠️ 必须**显式**传这个字段：base-url.mjs 在演练模式下设了
        //    NODE_TLS_REJECT_UNAUTHORIZED=0，而 tls.connect 只在
        //    `options.rejectUnauthorized === undefined` 时才去读那个环境变量。
        //    显式传 true 才能让"默认校验必须失败"这条反向断言真的验到东西。
        rejectUnauthorized,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const protocol = socket.getProtocol();
        socket.end();
        resolve({ ok: true, cert, protocol });
      },
    );
    socket.on('error', (err) => resolve({ ok: false, error: err }));
  });
}

async function fetchManual(url, init = {}) {
  // 演练下 Node 默认拒绝自签证书；base-url.mjs 已按 SVC_TLS_INSECURE 处理全局开关。
  return await fetch(url, { redirect: 'manual', ...init });
}

function sha256Fingerprint(der) {
  return crypto.createHash('sha256').update(der).digest('hex');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  TLS 入口工程链路门禁（Phase 10 / P10-C）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · HTTPS 端口：${SVC_HTTPS_PORT} · HTTP 端口：${SVC_HTTP_PORT}`);
console.log(`  · 演练模式（SVC_TLS_INSECURE）：${SVC_TLS_INSECURE ? '开' : '关'}`);

// ---------------------------------------------------------------------------
section('1. 证书文件与密钥管理纪律');

const crtFile = certPath();
if (!fs.existsSync(crtFile)) {
  console.log('');
  console.log('  ⛔ 找不到 storage/certs/tls.crt —— 请先 node scripts/gen-self-signed-cert.mjs');
  console.log('     （环境未就绪，不是产品红灯）');
  console.log('');
  process.exit(2);
}

{
  const certPem = fs.readFileSync(crtFile, 'utf8');
  const der = Buffer.from(
    certPem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s/g, ''),
    'base64',
  );
  assert(/BEGIN CERTIFICATE/.test(certPem), '证书文件是 PEM 格式');
  assert(der.length > 500, `证书可解析（DER ${der.length} 字节）`);
}

{
  // 🔴 私钥绝不入库：既要"规则命中"，也要"索引里确实没有"
  let ignored = '';
  try {
    ignored = execFileSync('git', ['check-ignore', '-v', 'storage/certs/tls.key'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    ignored = '';
  }
  assert(!!ignored, `.gitignore 命中 storage/certs/tls.key（${ignored.split('\t')[0] || '未命中'}）`);

  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', 'storage/certs/'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    tracked = '';
  }
  assert(
    tracked === '',
    tracked === ''
      ? 'git 索引里没有任何 storage/certs/ 文件（tls.key 未被跟踪）'
      : `git 索引里有证书文件，**私钥可能已入库**：${tracked}`,
  );
}

// ---------------------------------------------------------------------------
section('2. TLS handshake 与证书身份（真机 TCP + TLS）');

let handshake = null;
{
  const r = await connectTls({ rejectUnauthorized: false });
  handshake = r;
  assert(r.ok, r.ok ? 'TLS handshake 成功（443 真的在提供 TLS）' : `握手失败：${r.error?.message}`);
  if (r.ok) {
    assert(/^TLSv1\.[23]$/.test(String(r.protocol)), `协商协议为 TLS 1.2/1.3（实际 ${r.protocol}，1.0/1.1 已禁用）`);
    const san = r.cert?.subjectaltname || '';
    assert(san.includes('DNS:localhost'), `证书 SAN 覆盖 localhost（实际：${san.split('\n')[0]}）`);
    assert(
      /DNS:(svc|aftersale)\.local\.test/.test(san),
      '证书 SAN 含 `.test` 演练域名（刻意不用真实域名，避免污染其 HSTS/例外状态）',
    );

    // 握手拿到的公钥 == 磁盘上的证书（证明挂载的就是它，而不是别的证书）
    const onDisk = crypto
      .createHash('sha256')
      .update(fs.readFileSync(crtFile, 'utf8'))
      .digest('hex');
    const served = sha256Fingerprint(r.cert.raw);
    assert(onDisk !== served, '（格式差异：磁盘 PEM 与握手 DER 的摘要不同属正常，用指纹字段比对）');
    // 真正的比对：磁盘证书的指纹 vs 握手证书的 fingerprint256
    const diskFp = (() => {
      try {
        return execFileSync('openssl', ['x509', '-in', crtFile, '-noout', '-fingerprint', '-sha256'], {
          encoding: 'utf8',
        })
          .trim()
          .split('=')[1]
          .replace(/:/g, '')
          .toLowerCase();
      } catch {
        return '';
      }
    })();
    const servedFp = String(r.cert.fingerprint256 || '').replace(/:/g, '').toLowerCase();
    assert(
      !!diskFp && diskFp === servedFp,
      diskFp ? `握手证书与 storage/certs/tls.crt 是同一份（指纹 ${servedFp.slice(0, 16)}…）` : '（openssl 不可用，跳过指纹比对）',
    );
  }
}

{
  // 🔴 核心反向断言：**默认 CA 校验下必须失败** —— 这是"信任链未成立"的机器证据，
  //    也是 TLS production release gate 保持 HOLD 的依据。
  const r = await connectTls({ rejectUnauthorized: true });
  assert(
    !r.ok,
    !r.ok
      ? `默认 CA 校验下握手被拒（${r.error?.code || r.error?.message}）—— 自签证书未被信任，` +
          'TLS production release gate 因此**保持 HOLD**'
      : '默认 CA 校验下竟然握手成功：要么证书已换成受信 CA 签发的（那就该把这条断言反过来写），' +
          '要么校验被绕过了（那是缺陷）',
  );
}

// ---------------------------------------------------------------------------
section('3. 80 → 443 跳转（保留 path 与 query）');

{
  const target = `${HTTP_URL}/api/svc:live?probe=1&x=2`;
  const r = await fetchManual(target);
  assertEq(r.status, 301, 'HTTP 业务路径返回 301');
  const loc = r.headers.get('location') || '';
  assert(/^https:\/\//.test(loc), `Location 指向 HTTPS：${loc}`);
  assert(loc.includes('/api/svc:live'), 'Location **保留了 path**');
  assert(loc.includes('probe=1') && loc.includes('x=2'), 'Location **保留了 query**');
  assert(!/:\d{2,5}\//.test(loc.replace(/^https:\/\//, '').split('/')[0] + '/'), `Location 未带非标准端口：${loc}`);
}

{
  const r = await fetchManual(`${HTTP_URL}/api/svc:health`);
  assertEq(r.status, 301, 'HTTP 上的业务接口不再直出（/api/svc:health → 301）');
}

{
  const r = await fetchManual(`${HTTP_URL}/healthz`);
  assertEq(r.status, 200, 'HTTP 上 /healthz 仍为 200（容器 healthcheck 依赖明文探针）');
}

{
  const r = await fetchManual(`${HTTP_URL}/.env`);
  assert(
    r.status === 403 || r.status === 404,
    `HTTP 上隐藏文件是**拒绝**而不是跳转（${r.status}）`,
  );
}

// ---------------------------------------------------------------------------
section('4. HTTPS 上业务真的可用');

{
  const r = await fetchManual(`${HTTPS_URL}/api/svc:live`);
  assertEq(r.status, 200, 'HTTPS /api/svc:live → 200');
  const body = await r.clone().json().catch(() => ({}));
  assert(
    JSON.stringify(body) === JSON.stringify({ data: { status: 'ok' } }),
    `svc:live 响应体仍为最小形态：${JSON.stringify(body)}`,
  );
}

{
  const r = await fetchManual(`${HTTPS_URL}/api/svc:health`);
  assertEq(r.status, 200, 'HTTPS /api/svc:health → 200');
  const j = await r.clone().json().catch(() => ({}));
  assertEq(j?.data?.status, 'ok', 'HTTPS 上 health 仍返回 {status:ok}（匿名档）');
}

{
  const r = await fetchManual(`${HTTPS_URL}/h5/`);
  assertEq(r.status, 200, 'HTTPS /h5/ → 200（客户/师傅 H5 静态站点可达）');
}

{
  // 短链：nginx 层 302，不校验 token 真伪（校验在应用层）
  const token = 'A'.repeat(43);
  const r = await fetchManual(`${HTTPS_URL}/t/${token}`);
  assertEq(r.status, 302, 'HTTPS /t/<token> → 302（师傅短链）');
  assertEq(r.headers.get('location') || '', `/h5/technician/visit/${token}`, '短链跳转目标正确');
}

{
  const token = 'B'.repeat(43);
  const r = await fetchManual(`${HTTPS_URL}/f/${token}`);
  assertEq(r.status, 302, 'HTTPS /f/<token> → 302（客户评价短链）');
}

// ---------------------------------------------------------------------------
section('5. HSTS：自签演练阶段**必须缺席**（RFC 6797）');

{
  const r = await fetchManual(`${HTTPS_URL}/healthz`);
  const hsts = r.headers.get('strict-transport-security');
  assert(
    !hsts,
    !hsts
      ? 'HTTPS 响应**没有** HSTS —— 符合自签演练阶段的要求'
      : `HTTPS 响应出现了 HSTS（${hsts}）：自签证书 + HSTS 会让浏览器做**无例外的**拦截（RFC 6797），` +
        '在本轮等于把入口打死。正式 HSTS 应在受信证书的真实入口确认后再开',
  );
}

{
  // 配置侧对应断言：那行必须是注释状态（"现在不该有、将来必须有"的说明也必须在）
  const conf = fs.readFileSync(path.join(ROOT, 'nginx/conf.d/service.conf'), 'utf8');
  const active = /^\s*add_header\s+Strict-Transport-Security/m.test(conf);
  assert(!active, 'nginx 配置里 HSTS 指令处于**注释状态**（未生效）');
  assert(
    /RFC 6797/.test(conf) && /max-age=\d+/.test(conf),
    '配置里保留了 HSTS 的开启条件与正式写法（发布演练直接照做）',
  );
}

// ---------------------------------------------------------------------------
section('6. 部署形态静态事实（与运行期互为交叉验证）');

{
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert(
    /"\$\{NGINX_HTTPS_PORT:-443\}:443"/.test(compose),
    'compose 已发布 443（未注释）',
  );
  assert(
    /storage\/certs:\/etc\/nginx\/certs:ro/.test(compose),
    '证书目录以 **:ro 只读** 挂载（私钥不会被容器改写）',
  );
  assert(/SVC_BASE_SCHEME=https|NGINX_HTTPS_PORT/.test(compose + fs.readFileSync(path.join(ROOT, '.env'), 'utf8')), 'HTTPS 端口来自单一配置项');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✅ TLS implementation gate：PASS（${passed} 项）`);
  console.log('     ⚠️ TLS production release gate：**HOLD** —— 见上方"默认 CA 校验必须失败"那条；');
  console.log('        信任链需真实域名 + 受信 CA 证书，并在真实公网入口复测（含 HSTS 与 client-IP）。');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}
console.log(`  ❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
for (const f of failures) console.log(`     - ${f}`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
