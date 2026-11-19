#!/usr/bin/env node
/**
 * gen-lan-dev-cert.mjs —— 生成**开发专用 CA + 兼容性服务器证书**（A5-D 真机 HTTPS）
 *
 * ===========================================================================
 * 为什么重签，而不是用已有的候选证书
 * ===========================================================================
 * `.tmp-verify/a5d/lan-cert/lan-leaf.crt` 的 SAN 只有
 *   `IP:192.168.0.167, DNS:svc.local.test`
 * 直接拿它覆盖 `storage/certs/tls.crt` 会让 **localhost / 127.0.0.1 /
 * aftersale.local.test 全部失效** —— 而这三者是当前桌面端、自动化脚本
 * (`https://127.0.0.1`) 和既有验收基线赖以工作的入口。
 * 用户 §一.3 明确禁止这种覆盖，§一.4 要求"兼容原有名称与 LAN IP"。所以重签。
 *
 * ===========================================================================
 * 产物与边界
 * ===========================================================================
 *   storage/certs/dev-ca.crt       开发 CA 公共证书 —— **可以**装到测试设备
 *   storage/certs/dev-ca.key       开发 CA 私钥     —— **绝不**离开本机（0600）
 *   storage/certs/tls.crt          服务器证书（含 CA 链，fullchain）
 *   storage/certs/tls.key          服务器私钥
 *   storage/certs/chain.pem        仅中间/根（供 verify-tls 独立核对）
 *
 * ⚠️ 私钥生成在本机 `storage/certs/`（已被 .gitignore 忽略），**不复制到 .tmp-verify、
 *    不写进任何文档、不进镜像、不进发布包、不传手机**。
 *
 * 用法：node scripts/gen-lan-dev-cert.mjs [--force]
 * 退出码：0 成功 / 1 失败（含"CA 私钥已存在但未加 --force"）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'storage', 'certs');
/** CA 私钥目录：**刻意不在 storage/certs 下**，因为它不会被挂进任何容器 */
const CA_DIR = path.join(ROOT, 'storage', 'ca-private');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CA_DIR, { recursive: true });

const FORCE = process.argv.includes('--force');
const LAN_IP = process.env.SVC_LAN_IP || '192.168.0.167';
const DAYS = Number(process.env.SVC_CERT_DAYS || 90);

const P = {
  /**
   * ⚠️ CA 私钥**不能放在 `storage/certs/`**：
   *    该目录整个被只读挂进 `svc-nginx` 的 `/etc/nginx/certs`（`storage/certs -> /etc/nginx/certs, RW=false`）。
   *    实测踩过：`dev-ca.key` 以 **0777** 出现在容器内 —— 因为 nginx 以固定 uid 运行，
   *    而该用户与宿主文件属主不同，bind mount 的目录位生效 ⇒ **任何能进这只容器的进程都能读 CA 私钥**。
   *    nginx 只需要「服务器私钥」，完全不需要 CA 私钥。
   * ⇒ CA 私钥单独放 `storage/ca-private/`（**不挂进任何容器**），
   *    并在生成后立刻用 icacls 收紧。
   */
  caKey: path.join(CA_DIR, 'dev-ca.key'),
  caCrt: path.join(OUT, 'dev-ca.crt'),
  srvKey: path.join(OUT, 'tls.key'),
  srvCrt: path.join(OUT, 'tls.crt'),
  chain: path.join(OUT, 'chain.pem'),
};

/**
 * SAN 清单 —— **必须是原有 SAN 的超集**，否则会把已通过验收的入口打挂。
 *   localhost / 127.0.0.1  → 自动化脚本（CDP、curl、verify-* 全部走 127.0.0.1）
 *   svc.local.test         → 开发域名（RFC 6761 保留，永不注册）
 *   aftersale.local.test   → 同上，历史命名
 *   LAN_IP                 → 真机验收（本轮新增的唯一一项）
 */
const SAN = [
  'DNS:localhost',
  'DNS:svc.local.test',
  'DNS:aftersale.local.test',
  'IP:127.0.0.1',
  `IP:${LAN_IP}`,
];

const run = (args) => execFileSync('openssl', args, { stdio: 'pipe' });
const sh = (cmd) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim();

if (fs.existsSync(P.caKey) && !FORCE) {
  console.error(`\n  ❌ ${path.relative(ROOT, P.caKey)} 已存在。覆盖会**换掉 CA**，`);
  console.error('     已装到测试设备的旧 CA 将立即失效。确认要重来请加 --force。\n');
  process.exit(1);
}

const EXT_DIR = CA_DIR;
const cfg = path.join(EXT_DIR, '.gen-ca.cnf');
fs.writeFileSync(cfg, [
  '[req]',
  'distinguished_name = dn',
  'prompt = no',
  '[dn]',
  'CN = Service Ticket LAN Dev CA',
  'O = Service Ticket (dev LAN only)',
  '',
].join('\n'), 'utf8');

// ---- 1. 开发专用 CA ----
run(['req', '-x509', '-nodes', '-newkey', 'rsa:3072',
  '-keyout', P.caKey, '-out', P.caCrt, '-days', String(DAYS), '-sha256',
  '-config', cfg,
  '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  '-addext', `subjectKeyIdentifier=hash`,
]);
fs.rmSync(cfg, { force: true });

// ---- 2. 服务器私钥 + CSR ----
run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', P.srvKey, '-out', path.join(OUT, '.srv.csr'),
  '-subj', '/CN=svc.local.test/O=Service Ticket (dev LAN server)']);

// ---- 3. 用 CA 签服务器证书（带 SAN + serverAuth）----
const ext = path.join(OUT, '.srv.ext');
fs.writeFileSync(ext, [
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  `subjectAltName = ${SAN.join(', ')}`,
  'subjectKeyIdentifier = hash',
  'authorityKeyIdentifier = keyid,issuer',
  '',
].join('\n'), 'utf8');

run(['x509', '-req', '-in', path.join(OUT, '.srv.csr'),
  '-CA', P.caCrt, '-CAkey', P.caKey, '-CAcreateserial',
  '-out', path.join(OUT, '.srv.only.crt'),
  '-days', String(Math.min(DAYS, 90)), '-sha256', '-extfile', ext]);

fs.rmSync(ext, { force: true });
fs.rmSync(path.join(OUT, '.srv.csr'), { force: true });

// ---- 4. fullchain：nginx 的 ssl_certificate 必须是"服务器证书在前 + CA 在后"----
fs.writeFileSync(P.srvCrt, fs.readFileSync(path.join(OUT, '.srv.only.crt'), 'utf8').trim() + '\n' + fs.readFileSync(P.caCrt, 'utf8').trim() + '\n', 'utf8');
fs.copyFileSync(P.caCrt, P.chain);
fs.rmSync(path.join(OUT, '.srv.only.crt'), { force: true });

try { fs.chmodSync(P.caKey, 0o600); fs.chmodSync(P.srvKey, 0o600); } catch { /* Windows 上限 */ }

/**
 * ⚠️ Windows 上 `chmod 600` **不生效**：NTFS 权限由 ACL 决定，`fs.chmodSync` 只改
 *    只读位。实测生成后仍是 `-rw-r--r--`，且继承了父目录的沙箱用户
 *    （`CodexSandboxUsers:(I)(RX)`）—— 那意味着**同机其他进程能读 CA 私钥**。
 * ⇒ 必须用 `icacls` 移除继承并只授给当前用户与 SYSTEM。
 * 失败不中止（可能没有 icacls 权限），但要**把失败打出来**，绝不静默。
 */
function tightenAcl(file) {
  if (process.platform !== 'win32') return 'chmod 600（非 Windows，已生效）';
  const user = `${process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant', `${user}:(F)`, '/grant', 'SYSTEM:(F)'], { stdio: 'pipe' });
    const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
    const leaked = /Everyone|Users:|Authenticated|CodexSandbox/i.test(acl);
    return leaked ? `⚠️ ACL 仍有宽泛主体：${acl.trim()}` : 'ACL 已收紧（仅当前用户 + SYSTEM）';
  } catch (e) {
    return `⚠️ ACL 收紧失败，请手工执行 icacls：${String(e.message).slice(0, 120)}`;
  }
}


console.log('');
console.log('  ✅ 开发专用 CA 与服务器证书已生成');
console.log(`     CA 公共证书（**可**装到测试设备）：${path.relative(ROOT, P.caCrt)}`);
console.log(`     CA 私钥（**绝不外传/不挂容器**）  ：${path.relative(ROOT, P.caKey)}`);
console.log(`       → ${tightenAcl(P.caKey)}`);
console.log(`       → 目录 ${tightenAcl(CA_DIR)}`);
console.log(`     服务器 fullchain（含 CA 链）      ：${path.relative(ROOT, P.srvCrt)}`);
console.log(`     服务器私钥                        ：${path.relative(ROOT, P.srvKey)}`);
console.log(`       → ${tightenAcl(P.srvKey)}`);
console.log('     SAN: ' + SAN.join(' · '));
console.log('');
console.log('  ⚠️ 本脚本**不**把 CA 私钥放进 storage/certs/ ——');
console.log('     那个目录整个只读挂进 nginx(/etc/nginx/certs)，实测会以 0777 暴露。');
console.log('     重签后请确认：docker exec svc-nginx ls /etc/nginx/certs | grep dev-ca.key 应为空。');
console.log('');
