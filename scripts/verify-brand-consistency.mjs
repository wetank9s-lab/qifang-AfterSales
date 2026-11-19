#!/usr/bin/env node
/**
 * verify-brand-consistency.mjs —— **品牌名与页面标题的一致性门禁**（R2.2.1 第十二条）
 *
 * ===========================================================================
 * 为什么需要这条门禁
 * ===========================================================================
 * 品牌名散落在两类地方，**改动方式完全不同**：
 *   ① 代码里（`src-mobile/src/brand.ts` 的 `MOBILE_BRAND`）—— 可 import，改一处
 *   ② 静态 HTML / manifest 里（`src-mobile/index.html`、`manifest.webmanifest`、
 *      `h5/public/archive.html`）—— **没法 import**，只能写字面量
 *
 * 第 ② 类的漂移**不会报错**：页面照样能开，只是浏览器标签、iOS 主屏快捷方式名、
 * PWA 安装名会显示旧名字。这种问题只在"用户把网页加到主屏"时才被发现，
 * 而那时早已上线。⇒ 必须由机器钉住。
 *
 * ===========================================================================
 * 判据
 * ===========================================================================
 *   B1  `brand.ts` 的 `MOBILE_BRAND` 必须是「七方上门服务」
 *   B2  `src-mobile/index.html` 的 `<title>` == `MOBILE_BRAND`
 *   B3  `src-mobile/index.html` 含 `apple-mobile-web-app-title` 且值 == `MOBILE_BRAND`
 *   B4  `manifest.webmanifest` 的 `name` 与 `short_name` 都 == `MOBILE_BRAND`
 *   B5  `manifest.webmanifest` 的 `start_url` / `scope` 都在 `/m/` 下（否则装到主屏会开错站）
 *   B6  `manifest.webmanifest` 的图标路径指向存在的文件
 *   B7  档案页 `<title>` 是「服务档案 · 七方上门服务」，且 `<h1>` 是「服务档案」
 *   B8  移动端**不再残留**旧文案「服务工作台」（除本文件与被检测文件自身的注释外）
 *   B9  `index.html` 显式声明 favicon 且文件存在（缺了会让"资源全部 200"恒红）
 *   B10 暖通页标题为「暖通工程记录」（`ArchiveDetail.tsx` 的 hvac 分支）
 *
 * ⚠️ B8 的边界：注释里出现旧名不算违规（那是历史说明）。只查**会渲染的字符串**。
 *    本项目已踩过「grep 到注释给假绿/假红」的坑 —— 所以按渲染位置取，不整文件搜。
 *
 * 用法：node scripts/verify-brand-consistency.mjs
 * 退出码：0 全绿 / 1 有未达标项 / 2 环境问题（文件缺失）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAND = '七方上门服务';

const checks = [];
const chk = (id, ok, detail) => {
  checks.push({ id, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${id} ${detail}`);
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let hit = 0;
let miss = 0;

// ── B1 brand.ts 常量 ────────────────────────────────────────────────────────
const brandTs = read('src-mobile/src/brand.ts');
const mBrand = /export const MOBILE_BRAND = '([^']+)'/.exec(brandTs);
chk('B1-brand-const', mBrand?.[1] === BRAND, `MOBILE_BRAND="${mBrand?.[1] ?? '(未找到)'}" 期望 "${BRAND}"`);

// ── B2/B3/B9 index.html ─────────────────────────────────────────────────────
const indexHtml = read('src-mobile/index.html');
const mTitle = /<title>([^<]*)<\/title>/.exec(indexHtml);
chk('B2-title', mTitle?.[1] === BRAND, `<title>=${JSON.stringify(mTitle?.[1] ?? '')} 期望 "${BRAND}"`);

const mApple = /<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/.exec(indexHtml);
chk('B3-apple-title', mApple?.[1] === BRAND, `apple-mobile-web-app-title=${JSON.stringify(mApple?.[1] ?? '缺失')}`);

const mIcon = /<link\s+rel="icon"[^>]*href="([^"]+)"/.exec(indexHtml);
const iconPath = mIcon?.[1]?.replace(/^\/m\//, 'src-mobile/public/');
chk('B9-favicon', !!iconPath && exists(iconPath), `favicon href=${mIcon?.[1] ?? '缺失'} → 文件存在=${iconPath ? exists(iconPath) : false}`);

// ── B4/B5/B6 manifest ───────────────────────────────────────────────────────
const mfPath = 'src-mobile/public/manifest.webmanifest';
if (!exists(mfPath)) {
  chk('B4-manifest', false, `${mfPath} 缺失`);
} else {
  let mf = null;
  try {
    mf = JSON.parse(read(mfPath));
  } catch (e) {
    chk('B4-manifest', false, `JSON 解析失败：${e.message}`);
  }
  if (mf) {
    chk('B4-manifest', mf.name === BRAND && mf.short_name === BRAND,
      `name=${JSON.stringify(mf.name)} short_name=${JSON.stringify(mf.short_name)}`);
    chk('B5-manifest-scope', /^\/m\//.test(mf.start_url ?? '') && /^\/m\//.test(mf.scope ?? ''),
      `start_url=${mf.start_url} scope=${mf.scope}（都须在 /m/ 下）`);
    const icons = Array.isArray(mf.icons) ? mf.icons : [];
    const iconFiles = icons.map((i) => String(i.src ?? '').replace(/^\/m\//, 'src-mobile/public/'));
    const allExist = iconFiles.length > 0 && iconFiles.every((f) => exists(f));
    chk('B6-manifest-icons', allExist, `icons=${JSON.stringify(icons.map((i) => i.src))} 全部存在=${allExist}`);
  }
}

// ── B7 档案页标题 ───────────────────────────────────────────────────────────
if (exists('h5/public/archive.html')) {
  const arc = read('h5/public/archive.html');
  const t = /<title>([^<]*)<\/title>/.exec(arc)?.[1] ?? '';
  const h1 = /<h1 id="pageTitle">([^<]*)<\/h1>/.exec(arc)?.[1] ?? '';
  chk('B7-archive-title', t === `服务档案 · ${BRAND}` && h1 === '服务档案',
    `<title>=${JSON.stringify(t)} <h1>=${JSON.stringify(h1)}`);
}

// ── B8 移动端不残留旧文案（只查会渲染的字符串位置）──────────────────────────
// 规则：扫 src-mobile/src 下 .tsx/.ts，**去掉块注释与行注释**之后再看旧名。
const OLD = '服务工作台';
const walk = (dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
};
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const offenders = [];
for (const f of walk(path.join(ROOT, 'src-mobile/src'))) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  if (code.includes(OLD)) offenders.push(path.relative(ROOT, f));
}
chk('B8-no-old-copy', offenders.length === 0,
  offenders.length ? `仍残留「${OLD}」于：${offenders.join(', ')}` : `代码中已无「${OLD}」（注释除外）`);

// ── B10 暖通页标题 ──────────────────────────────────────────────────────────
const detail = read('src-mobile/src/pages/ArchiveDetail.tsx');
chk('B10-hvac-title', detail.includes("'暖通工程记录'") && detail.includes("'服务档案'"),
  `ArchiveDetail 含「暖通工程记录」=${detail.includes("'暖通工程记录'")} 含「服务档案」=${detail.includes("'服务档案'")}`);

for (const c of checks) c.ok ? (hit += 1) : (miss += 1);
console.log(`\n汇总：PASS ${hit} / ${checks.length}`);
if (miss) {
  console.log('未通过：' + checks.filter((c) => !c.ok).map((c) => c.id).join(', '));
  process.exitCode = 1;
}
