#!/usr/bin/env node
/**
 * verify-bundle-delivery.mjs —— **产物交付链**断言（唯一事实来源）
 * =============================================================================
 *
 * 回答的问题：**"代码改对了"之后，浏览器到底拿不拿得到？**
 *
 * 为什么这是独立的一条（Phase 4-I 第三轮「详情 404」的真结论，DEV-74）：
 *   那一轮的僵局是「自动化全绿 + 真人仍 404」。请求 URL 早就修好了，
 *   问题出在**另一端** —— 交付：
 *     · 插件产物 URL 形如 `/static/plugins/<pkg>/dist/client/index.js?hash=b77ddccc`；
 *     · 那个 `?hash=` **不是内容哈希**：实测"改了源码 → 产物 md5 变化 → hash 不变"，
 *       于是**等价于 URL 里没有内容哈希**；
 *     · 而 nginx 当时对它发 `Cache-Control: public, max-age=604800`（7 天，且无 ETag）。
 *   ⇒ 浏览器请求的是**同一个 URL**，却被明确告知"7 天内不用回源"
 *   ⇒ 重建产物后，**真人浏览器仍在跑旧代码**；探针每次全新 profile 所以永远绿。
 *
 * 三条断言（都可反向验证）：
 *   ① 服务端实际返回的产物字节数 == 刚构建的产物字节数（防"部署漂移"）
 *   ② 静态产物的缓存策略**不得长缓存**（否则"修了但真人还是旧行为"）
 *   ③ 产物里带得走"构建标记"（让浏览器能自证跑的是哪一版）
 *
 * 退出码：0 = 全部达标；1 = 真红灯；2 = 环境未就绪（产物没构建 / 服务不可达）
 *
 * 用法：node scripts/verify-bundle-delivery.mjs
 *
 * 人工取证（需要时）：登录后 `GET /api/pm:listEnabled`，即可看到服务端下发给浏览器的
 * 产物 URL 与 `?hash=` —— 就是本脚本要守的那个缓存键（见 docs/DEVIATIONS.md DEV-74）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.NGINX_HTTP_PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const BUNDLE_PATH = 'storage/plugins/@local/service-ticket/dist/client/index.js';
const BUNDLE_URL = '/static/plugins/@local/service-ticket/dist/client/index.js';

const LOCAL = path.join(ROOT, BUNDLE_PATH);

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

/** 长缓存的判据：超过 5 分钟的 max-age 就算"长"（本项目的产物 URL 不是内容寻址的） */
const LONG_CACHE_SECONDS = 300;

let hardFail = 0;

if (!fs.existsSync(LOCAL)) {
  console.log(`  ⚠️  找不到刚构建的客户端产物：${BUNDLE_PATH}`);
  console.log('      → 先跑 `node scripts/build-plugin.mjs`（这属于"环境未就绪"，不是缺陷）');
  process.exit(2);
}

const localSize = fs.statSync(LOCAL).size;
const localText = fs.readFileSync(LOCAL, 'utf8');

// ① 服务端发的 == 刚构建的
// ⚠️ 必须显式 identity：默认的 gzip 协商会让 nginx 转成 chunked、**不带 Content-Length**
//    （第一版用 Content-Length 判等，读到 0 字节 → 报出"部署漂移"的**假红**）。
let res;
let servedBuf;
try {
  res = await fetch(`${BASE}${BUNDLE_URL}`, { headers: { 'accept-encoding': 'identity' } });
  servedBuf = Buffer.from(await res.arrayBuffer());
} catch (e) {
  console.log(`  ⚠️  无法访问 ${BASE}${BUNDLE_URL}：${e.message}（环境未就绪）`);
  process.exit(2);
}

if (res.status !== 200) {
  bad(`${BUNDLE_URL} 返回 ${res.status} —— 后台会整页 App error`);
  hardFail++;
} else if (servedBuf.length !== localSize) {
  bad(
    `服务端实际返回 ${servedBuf.length} 字节 ≠ 刚构建的 ${localSize} 字节 —— ` +
      '**部署漂移**：浏览器拿到的不是这一版产物',
  );
  hardFail++;
} else {
  ok(`服务端实际返回的产物与刚构建的一致（${localSize} 字节）`);
}

// ② 缓存策略
const cacheControl = String(res.headers.get('cache-control') || '');
const m = /max-age=(\d+)/i.exec(cacheControl);
const maxAge = m ? Number(m[1]) : 0;
if (/no-store|no-cache/i.test(cacheControl)) {
  ok(`缓存策略正确：Cache-Control: ${cacheControl}（每次回源校验，未变则 304）`);
} else if (maxAge > LONG_CACHE_SECONDS) {
  bad(
    `Cache-Control = "${cacheControl}" —— **长缓存**。产物 URL 的 ?hash= 不随内容变化 ` +
      '（实测：产物 md5 变了、hash 没变），等价于没有内容哈希 ⇒ 浏览器会一直跑旧产物（DEV-74）',
  );
  hardFail++;
} else {
  warn(`缓存策略偏宽松：Cache-Control: ${cacheControl || '（缺失）'}（建议 no-cache）`);
}

// ③ 构建标记（浏览器自证用）
// ⚠️ 不要拿中文当锚点：esbuild 默认 charset=ascii，会把中文串转义成 \uXXXX，
//    所以在产物里搜「客户端产物构建」**永远搜不到**（实测踩过）。
//    改搜 ISO 时间戳本身 —— 实测它在整个产物里唯一出现。
const stamps = [...new Set(localText.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/g) || [])];
if (stamps.length === 1) {
  ok(`客户端产物构建标记：${stamps[0]} —— 走查时浏览器 Console 里应出现同一串`);
} else if (stamps.length === 0) {
  warn('产物里找不到客户端构建标记 —— 浏览器将无法自证跑的是哪一版产物');
} else {
  warn(`产物里有 ${stamps.length} 个 ISO 时间戳（${stamps.join(', ')}）—— 无法确定哪个是构建标记`);
}

console.log('');
if (hardFail) {
  console.log(`  ❌ 产物交付链不合格：${hardFail} 项（退出码 1）`);
  process.exit(1);
}
console.log('  ✅ 产物交付链达标');
process.exit(0);
