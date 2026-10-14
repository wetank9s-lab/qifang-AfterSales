/**
 * 生成**真机测试入口**（P11-4 第三批 · 用户第三条）
 *
 *   node scripts/make-device-test-entry.mjs                        # 自动挑真实局域网 IP
 *   node scripts/make-device-test-entry.mjs S02                    # 指定门店
 *   node scripts/make-device-test-entry.mjs S01 192.168.0.167      # 手动指定 IP
 *
 * 产出（写到 `storage/tmp/device-test/`）：
 *   · `entry.json`      —— 入口值、URL、门店、本机 IP、生成时间
 *   · `qr-report.png`   —— 报修页二维码（手机扫码直达）
 *
 * ⚠️ 这个脚本**不重写 HMAC**：入口值调产品自己的 `signStoreEntry`
 *    （与门店二维码用的是同一条链路），避免"脚本签的入口产品不认"。
 *
 * 🔴 **必须挑到真实局域网 IP**：本机同时存在 Docker/WSL（172.x）与 VMware（192.168.190/110.1）
 *    的虚拟网卡，第一版用 "connect 10.255.255.255 取第一个地址" 的办法**挑中了虚拟网卡**
 *    ⇒ 生成的二维码在手机上根本打不开（DEV-189）。这里改为**按网卡名排除虚拟设备**。
 *
 * ⚠️ 入口值含签名，**不要把这个文件里的 hash 贴到公开渠道**；
 *    `storage/tmp/` 已在 `.gitignore` 里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_WORKSPACE = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace';
const OUT = path.join(ROOT, 'storage/tmp/device-test');

// ---------------------------------------------------------------- 环境
function envValue(key) {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * 列出**候选的局域网地址**（真实网卡优先；虚拟网卡排在最后并明确标注）。
 *
 * 排除依据（本机实测踩过的）：
 *   · `vEthernet (WSL …)` / `vEthernet (Default Switch)` —— Docker / WSL 虚拟交换机（172.x）
 *   · `VMware Network Adapter VMnet*` —— VMware 宿主网络（192.168.190.1 / 192.168.110.1）
 *   · `169.254.*` —— APIPA（网线没过 DHCP 时系统自己编的地址，实际不通）
 *   · 蓝牙 / Loopback / 各类 VPN 虚拟网卡
 */
function candidateAddresses() {
  const VIRTUAL = /VMware|VirtualBox|vEthernet|Hyper-V|Loopback|Bluetooth|蓝牙|TAP|Tailscale|ZeroTier/i;
  const REAL = /WLAN|Wi-?Fi|以太网|Ethernet|eth\d|en\d|wlan\d/i;
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // APIPA：能"看到"但不通
      const isVirtual = VIRTUAL.test(name);
      const isReal = REAL.test(name);
      out.push({
        name,
        address: a.address,
        kind: isVirtual ? 'virtual' : isReal ? 'real' : 'other',
        weight: isVirtual ? 2 : isReal ? 0 : 1, // 真实 0 < 未知 1 < 虚拟 2
      });
    }
  }
  return out.sort((x, y) => x.weight - y.weight);
}

/** 是否有东西真在 listen 443（容器映射到宿主 0.0.0.0） */
function port443Listening() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return /(^|\s)0\.0\.0\.0:443\s/.test(out);
  } catch {
    return false;
  }
}

/** 只读地看一眼网络档案（Public 档下 Windows 防火墙默认拦入站） */
function networkProfiles() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-NetConnectionProfile | Select-Object -First 5 InterfaceAlias, NetworkCategory | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 20000 },
    ).trim();
    if (!out) return null;
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 载入产品的入口签发
function loadSignStoreEntry() {
  const esbuild = require(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js'));
  const abs = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/store-entry.ts');
  const result = esbuild.buildSync({
    entryPoints: [abs],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@nocobase/*', 'knex', 'sequelize'],
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports.signStoreEntry;
}

const SECRET = envValue('SIGN_SECRET');
if (!SECRET) {
  console.error('  ⛔ .env 缺少 SIGN_SECRET，无法签发入口');
  process.exit(2);
}

const args = process.argv.slice(2);
const explicitHost = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
const STORE_CODE =
  args.find((a) => !/^\d+\.\d+\.\d+\.\d+$/.test(a) && /^[A-Za-z0-9_-]{2,16}$/.test(a)) ?? 'S01';

const candidates = candidateAddresses();
const host = explicitHost ?? (candidates.find((c) => c.kind !== 'virtual') ?? candidates[0])?.address ?? null;
if (!host) {
  console.error('  ⛔ 找不到任何可用的局域网 IPv4 地址');
  process.exit(2);
}
const picked = candidates.find((c) => c.address === host);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  真机测试入口（P11-4 第三批）');
console.log('══════════════════════════════════════════════════════════════');
if (picked?.kind === 'virtual') {
  console.log('  ⚠️⚠️ 挑到的是**虚拟网卡**地址，手机通常**访问不了**：');
  console.log(`       ${picked.address}（网卡「${picked.name}」—— Docker / WSL / VMware 的内部网络）`);
  console.log('     请接上真实 Wi-Fi/网线后重跑，或手动指定：');
  console.log(`       node scripts/make-device-test-entry.mjs ${STORE_CODE} <你的局域网IP>`);
  console.log('');
}

const entry = loadSignStoreEntry()(STORE_CODE, SECRET);
const url = `https://${host}/h5/report?k=${encodeURIComponent(entry)}`;

console.log(`  门店      : ${STORE_CODE}`);
console.log(`  入口值    : ${entry}`);
console.log(
  `  选定 IP   : ${host}${picked ? `  （网卡「${picked.name}」，${picked.kind === 'virtual' ? '⚠️ 虚拟' : '真实网卡'}）` : '  （手动指定）'}`,
);
console.log(`  报修页    : ${url}`);

// ---- 连通性自检（**只读**，不改系统配置）----
console.log('');
console.log('  ── 连通性自检 ────────────────────────────────────────────');
console.log(`  443 监听  : ${port443Listening() ? '✅ 0.0.0.0:443 在监听' : '❌ 未见 0.0.0.0:443（容器没起？）'}`);
const profiles = networkProfiles();
if (profiles) {
  for (const p of profiles) {
    // ⚠️ ConvertTo-Json 把 NetworkCategory 序列化成**数字**（0=Public / 1=Private /
    //    2=DomainAuthenticated），不是名字 —— 直接拿 'Public' 比较会永远为 false，
    //    于是"Public 档会拦入站"这条最关键的提示**永远不显示**。
    const CATEGORY_NAMES = { 0: 'Public', 1: 'Private', 2: 'DomainAuthenticated' };
    const category = CATEGORY_NAMES[p.NetworkCategory] ?? String(p.NetworkCategory);
    const risky = category === 'Public';
    console.log(
      `  网络档案  : ${p.InterfaceAlias} = ${category}` +
        (risky ? '  ⚠️ Public 档 ⇒ Windows 防火墙**默认拦入站**，手机可能连不上' : ''),
    );
  }
}
const others = candidates.filter((c) => c.address !== host);
console.log(`  其他网卡  : ${others.map((c) => `${c.address}(${c.name})`).join(' · ') || '无'}`);
console.log('');
console.log('  ⚠️ 若手机仍然打不开，按顺序排查：');
console.log('     ① 手机与电脑连的是**同一个 Wi-Fi**（网段要一致，例如都是 192.168.0.x）；');
console.log('     ② 放行入站 443（管理员 PowerShell，只跑一次）：');
console.log('        New-NetFirewallRule -DisplayName "svc-ticket 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Any');
console.log('     ③ 证书是**自签演练证书** ⇒ 手机上要手动点「继续访问」；');
console.log('     ④ 短信里的进度链接基址仍是 `.env` 的 `PUBLIC_BASE_URL`，见 docs/P11-4-DEVICE-TEST-GUIDE.md。');
console.log('══════════════════════════════════════════════════════════════');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'entry.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      storeCode: STORE_CODE,
      entry,
      lanIp: host,
      nicName: picked?.name ?? '(手动指定)',
      nicKind: picked?.kind ?? 'manual',
      url,
      reportUrl: url,
      note: '入口值由产品自身的 signStoreEntry 签发；证书为自签演练证书',
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------- 二维码
let qrOk = false;
try {
  const QRCode = require(path.join(NODE_WORKSPACE, 'node_modules', 'qrcode'));
  await QRCode.toFile(path.join(OUT, 'qr-report.png'), url, {
    width: 480,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  qrOk = true;
  console.log(`  二维码    : ${path.join(OUT, 'qr-report.png')}`);
} catch (e) {
  console.log(`  ⚠️ 二维码生成失败（${e.message}）—— 可直接手输上面的 URL`);
}

if (qrOk) console.log('  ✅ 入口与二维码已生成');
process.exit(0);