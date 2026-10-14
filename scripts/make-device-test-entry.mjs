/**
 * 生成**真机测试入口**（P11-4 第三批 · 用户第三条）
 *
 *   node scripts/make-device-test-entry.mjs
 *
 * 产出（写到 `storage/tmp/device-test/`）：
 *   · `entry.json`      —— 入口值、URL、门店、生成时间
 *   · `qr-report.png`   —— 报修页二维码（手机扫码直达）
 *   · `qr-progress.png` —— 说明用：进度页需要 Token，二维码只印报修入口
 *
 * ⚠️ 这个脚本**不重写 HMAC**：入口值调产品自己的 `signStoreEntry`
 *    （与门店二维码用的是同一条链路），避免"脚本签的入口产品不认"。
 *
 * ⚠️ 入口值含签名，**不要把这个文件里的 hash 贴到公开渠道**；
 *    `storage/tmp/` 已在 `.gitignore` 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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

/** 容器把 443 映射到宿主 0.0.0.0 —— 手机与电脑同网即可访问 */
function lanIp() {
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync(
      process.execPath,
      ['-e', "const s=require('net').createConnection({host:'10.255.255.255',port:1});s.on('connect',()=>{});console.log(s.address().address)"],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch {
    /* 落到下面的兜底 */
  }
  return '192.168.4.101';
}

/** 载入插件的真实 TS 模块（复用既有做法，不重写产品逻辑） */
function loadRealModule(relPath, exportNames) {
  const esbuildPath = path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js');
  const esbuild = require(esbuildPath);
  const abs = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server', relPath);
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
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  const picked = {};
  for (const n of exportNames) picked[n] = module.exports[n];
  return picked;
}

const { signStoreEntry } = loadRealModule('services/store-entry.ts', ['signStoreEntry']);

// ---------------------------------------------------------------- 入口
const SECRET = envValue('SIGN_SECRET');
if (!SECRET) {
  console.error('  ⛔ .env 缺少 SIGN_SECRET，无法签发入口');
  process.exit(2);
}
const STORE_CODE = process.argv[2] ?? 'S01';
const entry = signStoreEntry(STORE_CODE, SECRET);
const ip = lanIp();
const base = `https://${ip}`;
const url = `${base}/h5/report?k=${encodeURIComponent(entry)}`;

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  真机测试入口（P11-4 第三批）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  门店      : ${STORE_CODE}`);
console.log(`  入口值    : ${entry}`);
console.log(`  局域网 IP : ${ip}`);
console.log(`  报修页    : ${url}`);
console.log('  ⚠️ 证书是自签演练证书 ⇒ 手机首次打开会提示"不安全"，需手动继续');
console.log('  ⚠️ 手机必须与这台电脑**在同一个 Wi-Fi / 局域网**');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'entry.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      storeCode: STORE_CODE,
      entry,
      lanIp: ip,
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

console.log('══════════════════════════════════════════════════════════════');
if (qrOk) console.log('  ✅ 入口与二维码已生成');
process.exit(0);