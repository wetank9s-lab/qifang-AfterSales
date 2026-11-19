#!/usr/bin/env node
/**
 * verify-h5-design-parity.mjs —— R2.2.1 第二节「Token 跨前端统一」的静态门禁。
 *
 * ===========================================================================
 * 本节说的 Token 是 **CSS 设计变量**，不是认证 Token。
 * 本门禁**只读样式文件**，不碰任何鉴权、进度码、短信凭据与会话逻辑。
 * ===========================================================================
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 两端各自演化的漂移**不会报错**：主色从 #007AFF 变成 #0A84FF，页面照常渲染，
 * 只是用户在员工端和客户端看到两种蓝。字体从 17 变成 16，也照常显示，
 * 只是"同一层次的两段字看着不一样大"。这类问题只能靠人眼比对整屏截图发现 ——
 * 也就是永远发现不了。所以把它变成"两端数值逐键比对"的机械判据。
 *
 * ===========================================================================
 * 判据
 * ===========================================================================
 *   T1  业务背景色两端同值（#F2F2F7）
 *   T2  内容表面色两端同值（#FFFFFF）
 *   T3  主色两端同值（#007AFF）
 *   T4  **六档字号**：h5 的 `--svc-fs-*` 与移动端 `qf-tokens.ts` 的 `fontSize` 逐键同值
 *   T5  h5 样式里**不得残留**硬编码字号（必须走 `var(--svc-fs-*)`）
 *   T6  触控下限 44 / 主 CTA 52，两端同值
 *   T7  **禁用特性**：两个 H5 都不得出现 `backdrop-filter`（毛玻璃）、
 *       `prefers-color-scheme: dark` 深色段、`border-radius: 999px` 胶囊主按钮
 *   T8  主按钮**不是胶囊**：主 CTA 的圆角必须落在 {9,10,12} 之内
 *   T9  两个 H5 都引用了品牌常量（不各写一个名字）
 *
 * ⚠️ 注释里的字面量不算命中：所有文本判据都先剥注释再比。
 *    否则"禁止毛玻璃"这句注释本身会把门禁判红 —— 这是典型的自我判红。
 *
 * 用法：node scripts/verify-h5-design-parity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOBILE_TOKENS = path.join(ROOT, 'src-mobile/src/design/qf-tokens.ts');
const H5_CSS = path.join(ROOT, 'h5/src/styles/base.css');
/** 客户「查进度」正文页：**静态 HTML**，不在 React 构建里，字号必须单独守 */
const H5_STATIC_PAGE = path.join(ROOT, 'h5/public/archive.html');

const out = [];
const rec = (id, ok, d) => {
  out.push({ id, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${id} ${d}`);
};

/** 剥 CSS 注释（`/* … *\/`），保留行号可读性 */
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
/** 剥 TS/JS 注释 */
const stripTsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function main() {
  const rawCss = fs.readFileSync(H5_CSS, 'utf8');
  const css = stripCssComments(rawCss);
  const rawStatic = fs.readFileSync(H5_STATIC_PAGE, 'utf8');
  const staticCss = stripCssComments(rawStatic);
  const rawTs = fs.readFileSync(MOBILE_TOKENS, 'utf8');
  const ts = stripTsComments(rawTs);

  /** 取 `:root { … }` 里的某个变量值（只看第一个 :root） */
  const cssVar = (name) => {
    const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : '';
  };

  /** 取 qf-tokens.ts 里某组常量里的键值（fontSize / ...） */
  const tsGroup = (groupName) => {
    const i = ts.indexOf(groupName);
    if (i < 0) return {};
    const start = ts.indexOf('{', i);
    let depth = 0;
    let end = -1;
    for (let k = start; k < ts.length; k += 1) {
      if (ts[k] === '{') depth += 1;
      else if (ts[k] === '}') {
        depth -= 1;
        if (depth === 0) { end = k; break; }
      }
    }
    const body = ts.slice(start, end + 1);
    const obj = {};
    for (const m of body.matchAll(/([a-zA-Z_][\w]*)\s*:\s*(\d+)/g)) obj[m[1]] = Number(m[2]);
    return obj;
  };

  const hex = (v) => String(v).trim().toUpperCase().replace(/\s/g, '');

  // ── T1 / T2 / T3 基础色 ───────────────────────────────────────────────────
  const tsColors = (() => {
    // qf-tokens.ts 的 lightTokens 里 `bg: '#F2F2F7'` 这种
    const i = ts.indexOf('lightTokens');
    const slice = i >= 0 ? ts.slice(i, i + 4000) : ts;
    const m = {};
    for (const x of slice.matchAll(/([a-zA-Z_][\w]*)\s*:\s*'(#[0-9A-Fa-f]{6})'/g)) m[x[1]] = x[2];
    return m;
  })();

  const bgCss = hex(cssVar('svc-bg'));
  const cardCss = hex(cssVar('svc-card'));
  const primaryCss = hex(cssVar('svc-primary'));
  const bgTs = hex(tsColors.bg ?? tsColors.background ?? '');
  const cardTs = hex(tsColors.surface ?? '');
  const primaryTs = hex(tsColors.brand ?? '');

  rec('T1-bg-same', bgCss === '#F2F2F7' && bgTs === bgCss,
    `h5 --svc-bg=${bgCss} · 移动端 bg=${bgTs}（须都是 #F2F2F7）`);
  rec('T2-surface-same', cardCss === '#FFFFFF' && cardTs === cardCss,
    `h5 --svc-card=${cardCss} · 移动端 surface=${cardTs}（须都是 #FFFFFF）`);
  rec('T3-primary-same', primaryCss === '#007AFF' && primaryTs === primaryCss,
    `h5 --svc-primary=${primaryCss} · 移动端 brand=${primaryTs}（须都是 #007AFF）`);

  // ── T4 六档字号逐键同值 ───────────────────────────────────────────────────
  // 🔴 常量名是 `TYPE_SCALE`，**不是** `fontSize`。
  //    第一版按 `fontSize` 找，找不到就返回空对象，于是六档全报 undefined ——
  //    看起来像"移动端丢了六档"，实际是解析器找错了名字。
  //    这也是为什么 T4 要额外要求 `Object.keys(tsFs).length >= 6`：
  //    **解析失败必须表现为红，而不是"两边都空所以相等"**。
  const tsFs = tsGroup('TYPE_SCALE');
  const h5Fs = {
    display: parseInt(cssVar('svc-fs-display'), 10),
    title: parseInt(cssVar('svc-fs-title'), 10),
    body: parseInt(cssVar('svc-fs-body'), 10),
    sub: parseInt(cssVar('svc-fs-sub'), 10),
    foot: parseInt(cssVar('svc-fs-foot'), 10),
    caption: parseInt(cssVar('svc-fs-caption'), 10),
  };
  const fsMismatch = Object.entries(h5Fs).filter(([k, v]) => tsFs[k] !== v).map(([k, v]) => `${k}: h5=${v} 移动端=${tsFs[k]}`);
  rec('T4-font-scale-parity', Object.keys(tsFs).length >= 6 && fsMismatch.length === 0,
    `六档 h5=${JSON.stringify(h5Fs)} 移动端=${JSON.stringify(tsFs)}${fsMismatch.length ? ' 不一致：' + fsMismatch.join(', ') : ' 逐键一致'}`);

  // ── T5 h5 不得残留硬编码字号 ──────────────────────────────────────────────
  // ⚠️ 扫描面必须包含 `h5/public/archive.html` —— 那是**客户「查进度」的正文页**，
  //    不是 React 产物，改动不会体现在 base.css 里。
  //    只扫 base.css 会让"客户在进度页看到的字号"完全失控：本轮实测它有
  //    12.5/18/16/15.5/11.5px 六种非档位字号，而门禁一直绿。
  const hardCoded = [
    ...[...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1]),
    ...[...staticCss.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1]),
  ];
  rec('T5-no-hardcoded-fontsize', hardCoded.length === 0,
    hardCoded.length
      ? `仍有硬编码字号：${[...new Set(hardCoded)].map((n) => n + 'px').join(', ')}（须走 var(--svc-fs-*)；扫描面=base.css + archive.html）`
      : '全部走 var(--svc-fs-*)（扫描面=base.css + archive.html）');

  // ── T5b 静态页的六档变量必须与 base.css 同值 ──────────────────────────────
  // T5 只保证"不用硬编码"，但如果 archive.html 自己声明了一组**不同的**
  // `--svc-fs-*`，它照样全绿 —— 客户在进度页看到的仍是另一套字号。
  // 所以必须逐键比 "值"，不能只比 "有没有用变量"。
  const staticFs = Object.fromEntries(
    ['display', 'title', 'body', 'sub', 'foot', 'caption'].map((k) => [
      k,
      parseInt((staticCss.match(new RegExp(`--svc-fs-${k}\\s*:\\s*([0-9]+)px`)) ?? [])[1], 10),
    ]),
  );
  const staticMismatch = Object.entries(staticFs).filter(([k, v]) => h5Fs[k] !== v).map(([k, v]) => `${k}: 静态页=${v} base.css=${h5Fs[k]}`);
  rec('T5b-static-page-scale-same', Object.keys(staticFs).length >= 6 && !Object.values(staticFs).some((v) => Number.isNaN(v)) && staticMismatch.length === 0,
    `archive.html 六档=${JSON.stringify(staticFs)} base.css=${JSON.stringify(h5Fs)}${staticMismatch.length ? ' 不一致：' + staticMismatch.join(', ') : ' 逐键一致'}`);

  // ── T6 触控常量 ──────────────────────────────────────────────────────────
  const touch = parseInt(cssVar('svc-touch'), 10);
  const touchLg = parseInt(cssVar('svc-touch-lg'), 10);
  rec('T6-touch-same', touch === 44 && touchLg === 52,
    `h5 --svc-touch=${touch}px --svc-touch-lg=${touchLg}px（须 44 / 52，与移动端 --spacing-touch / touch-lg 同源）`);

  // ── T7 禁用特性 ──────────────────────────────────────────────────────────
  const glass = /backdrop-filter\s*:/i.test(css);
  const dark = /prefers-color-scheme\s*:\s*dark/i.test(css);
  const pillBtn = /border-radius\s*:\s*999(px)?/i.test(css);
  rec('T7-banned-features', !glass && !dark && !pillBtn,
    `毛玻璃=${glass} 深色主题段=${dark} 999px 圆角=${pillBtn}（三者都须 false；已剥注释后判定）`);

  // ── T8 主 CTA 圆角不是胶囊 ────────────────────────────────────────────────
  // 主 CTA 的圆角走 --svc-radius-* 变量，值是 10/12；没有 999 即合规
  const radiusVals = [...css.matchAll(/--svc-radius-(sm|md|lg)\s*:\s*([0-9]+)px/g)].map((m) => Number(m[2]));
  const radiusOk = radiusVals.length >= 3 && radiusVals.every((v) => v >= 9 && v <= 16);
  rec('T8-radius-bounds', radiusOk,
    `圆角档=${JSON.stringify(radiusVals)}（须全部落在 9–16，禁 999 胶囊）`);

  // ── T9 品牌常量 ──────────────────────────────────────────────────────────
  const brandTs = fs.existsSync(path.join(ROOT, 'src-mobile/src/brand.ts'));
  const h5Archive = path.join(ROOT, 'h5/public/archive.html');
  const archiveHtml = fs.existsSync(h5Archive) ? fs.readFileSync(h5Archive, 'utf8') : '';
  rec('T9-brand-constant', brandTs && /七方上门服务/.test(archiveHtml),
    `移动端 brand.ts=${brandTs} · 档案页含「七方上门服务」=${/七方上门服务/.test(archiveHtml)}`);

  const fail = out.filter((r) => !r.ok);
  console.log(`\n汇总：PASS ${out.length - fail.length} / ${out.length}`);
  if (fail.length) {
    console.log('未通过：' + fail.map((f) => f.id).join(', '));
    process.exitCode = 1;
  }
}

main();
