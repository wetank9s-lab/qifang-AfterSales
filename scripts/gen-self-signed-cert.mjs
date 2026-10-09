#!/usr/bin/env node
/**
 * gen-self-signed-cert.mjs —— 生成**自签演练用** TLS 证书（Phase 10 / P10-C）
 *
 * ===========================================================================
 * 🔴 这个脚本产出的是**演练件**，不是生产证书
 * ===========================================================================
 * 它能证明的：443 真的在监听、证书/私钥挂载路径正确、TLS handshake 成功、
 *              80→443 跳转保留 path/query、HTTPS 下 H5/API 都能工作。
 * 它**不能**证明的：浏览器信任链成立。
 *   server authentication 需要「域名匹配 + 由客户端信任的 CA 签发」两个条件，
 *   自签证书两条都不满足 —— 所以刻意**不启用 HSTS**（见 nginx 443 段的注释）：
 *   RFC 6797 指出自建/不受信任证书与 HSTS 组合会导致安全连接失败，
 *   在将来可能复用的域名上留下 HSTS 记录会直接把那个域名打挂。
 *
 * ===========================================================================
 * 域名选择：**刻意不用真实域名**
 * ===========================================================================
 * SAN 里放的是 `.test`（RFC 6761 保留给测试用途、永不会被注册）与 `localhost`。
 * 这样即使有人在浏览器里打开并接受了自签证书，也不会污染任何真实域名的
 * HSTS / 证书例外状态。正式域名到位时**只需替换挂载内容**，不改任何配置或代码
 * （443 server 块用 `server_name _`）。
 *
 * 用法：
 *   node scripts/gen-self-signed-cert.mjs                 # 默认写到 storage/certs/
 *   node scripts/gen-self-signed-cert.mjs --days 30
 *   node scripts/gen-self-signed-cert.mjs --force         # 已存在时覆盖
 *
 * 产物（**全部被 .gitignore 忽略**）：
 *   storage/certs/tls.key   私钥（0600，绝不入库/进镜像/进证据文档）
 *   storage/certs/tls.crt   证书（可公开，但同样忽略 —— 见 .gitignore 的理由）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'storage', 'certs');
const KEY = path.join(OUT_DIR, 'tls.key');
const CRT = path.join(OUT_DIR, 'tls.crt');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const daysIdx = argv.indexOf('--days');
const DAYS = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 365;

/**
 * SAN 清单。全部是**保留/本地**名字：
 *   · `.test` —— RFC 6761 保留，永不注册，绝不会与真实域名撞上；
 *   · `localhost` / `127.0.0.1` —— 本机演练用。
 * ⚠️ 不要把任何真实域名写进来（会污染该域名的 HSTS / 证书例外状态）。
 */
const SAN = [
  'DNS:localhost',
  'DNS:svc.local.test',
  'DNS:aftersale.local.test',
  'IP:127.0.0.1',
];

function fail(msg) {
  console.error(`\n  ❌ ${msg}\n`);
  process.exit(1);
}

if (fs.existsSync(KEY) && !FORCE) {
  console.log('');
  console.log('  ℹ️  已存在证书，未覆盖：');
  console.log(`      ${path.relative(ROOT, KEY)}`);
  console.log(`      ${path.relative(ROOT, CRT)}`);
  console.log('      需要重建请加 --force（**会换掉私钥**，重签会打断已有 TLS 会话）');
  console.log('');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const opensslConfig = [
  '[req]',
  'distinguished_name = dn',
  'x509_extensions = v3_req',
  'prompt = no',
  '[dn]',
  'CN = svc.local.test',
  'O = Service Ticket (self-signed rehearsal)',
  '[v3_req]',
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  `subjectAltName = ${SAN.join(',')}`,
  '',
].join('\n');

const cfgPath = path.join(OUT_DIR, '.openssl.cnf');
fs.writeFileSync(cfgPath, opensslConfig, 'utf8');

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-nodes',
      '-newkey', 'rsa:2048',
      '-keyout', KEY,
      '-out', CRT,
      '-days', String(DAYS),
      '-config', cfgPath,
      '-sha256',
    ],
    { stdio: 'pipe' },
  );
} catch (err) {
  fs.rmSync(cfgPath, { force: true });
  fail(
    `openssl 生成失败：${(err.stderr || err.message || '').toString().split('\n')[0]}\n` +
      '     本机需要可用的 openssl（Git for Windows 自带）。',
  );
} finally {
  fs.rmSync(cfgPath, { force: true });
}

// 私钥收紧权限（Windows 上 chmod 语义有限，但 Linux 部署时这一步是有效的）
try {
  fs.chmodSync(KEY, 0o600);
} catch {
  /* Windows 上可能不支持，忽略 */
}

// 回读证书，把关键事实打出来 —— 门禁要断言的正是这些
let info = '';
try {
  info = execFileSync('openssl', ['x509', '-in', CRT, '-noout', '-subject', '-dates', '-ext', 'subjectAltName'], {
    encoding: 'utf8',
  });
} catch {
  /* 回读失败不影响生成，下面的输出会明显缺失 */
}

console.log('');
console.log('  ✅ 自签演练证书已生成');
console.log(`     私钥：${path.relative(ROOT, KEY)}（已 chmod 600，**绝不入库**）`);
console.log(`     证书：${path.relative(ROOT, CRT)}（有效期 ${DAYS} 天）`);
console.log('     SAN ：' + SAN.join(' · '));
if (info.trim()) {
  console.log('     ---- openssl 回读 ----');
  for (const line of info.trim().split('\n')) console.log('     ' + line.trim());
}
console.log('');
console.log('  ⚠️ 这是**演练件**：浏览器不会信任它（自签且无受信 CA 链）。');
console.log('     ⇒ 刻意不启用 HSTS（RFC 6797：不受信任证书 + HSTS = 安全连接失败）。');
console.log('     ⇒ 正式域名到位时**只替换挂载内容**，不改配置、不改代码。');
console.log('');
console.log('  下一步：docker compose up -d nginx');
console.log('  复核：node scripts/verify-tls.mjs');
console.log('');
