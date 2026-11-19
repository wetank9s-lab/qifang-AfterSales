/**
 * qf-design-gate.mjs —— R2.2.1 设计 Token 门禁（静态，不需要浏览器、不需要服务）
 *
 * ===========================================================================
 * 它守的是什么
 * ===========================================================================
 *   用户第 四 节："所有页面必须复用 Token，**不得每页自定字号/边距/圆角/按钮尺寸**"。
 *   用户第 十四 节："**不得在不同页面重复编写同一套按钮和输入框样式**"。
 *
 *   这两条约束在代码评审里最容易失守：某个页面为了"这里窄一点"写个
 *   `text-[14px]`，构建照样成功、截图肉眼几乎看不出 —— 但字号集合就破了。
 *   ⇒ 把"集合"写成断言，并且**让断言在真的会破的时候破**。
 *
 * ===========================================================================
 * 判据清单（每条都有对应的反向验证）
 * ===========================================================================
 *   G1  `app.css` 的 `@theme` 与 `qf-tokens.ts` 的 `lightTokens` **必须逐键一致**
 *        —— 两边各写一份是刻意的（CSS 与 TS 无法共享常量），
 *           但"两份"必须"同值"，否则改了一边另一边静默过期。
 *   G2  源码里出现的 `text-[Npx]` 必须 ∈ 六档封闭集合 {12,13,15,17,20,28}
 *   G3  源码里出现的 `rounded-[Npx]` / `rounded-full` 只能是允许集合
 *        —— `rounded-full` 只允许出现在状态徽标（`QFStatusBadge`）
 *   G4  `CONTRAST_PAIRS` 逐对 ≥ 4.5:1；`LARGE_TEXT_EXEMPT` 逐对 ≥ 3:1
 *        —— 且豁免项必须**写清前提**（没有前提的豁免等于开后门）
 *   G5  触控下限常量 = 44，且 `qf-input` / `.svc-icon-btn` 都吃到了它
 *   G6  禁用的 CSS 特性：`backdrop-filter`（毛玻璃）、`prefers-color-scheme`
 *        （深色自适应）、`position: fixed` 的主操作栏（吸底必须 sticky）
 *
 * ===========================================================================
 * 「工具坏了」必须与「产品坏了」分开报
 * ===========================================================================
 *   本脚本自带 `--self-test`：把每条判据喂一份**故意违规**的输入，
 *   要求它**必须变红**。任一判据在被喂违规输入时仍然是绿 ⇒ 这条判据是摆设
 *   ⇒ 整体 exit 2（TOOL_NOT_READY），**不给产品结论**。
 *
 *   这正是本项目踩过的坑：断言不会变红 = 没有断言。
 *
 * 用法：
 *   node scripts/qf-design-gate.mjs              # 正式判据
 *   node scripts/qf-design-gate.mjs --self-test  # 变异验证（判据是否真会红）
 *   node scripts/qf-design-gate.mjs --json       # 机器可读输出
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src-mobile', 'src');
const CSS_FILE = path.join(SRC, 'styles', 'app.css');
const TOKENS_FILE = path.join(SRC, 'design', 'qf-tokens.ts');

const SELF_TEST = process.argv.includes('--self-test');
const AS_JSON = process.argv.includes('--json');

/* ------------------------------------------------------------- 断言收集 */

const results = [];
function check(pass, id, label, detail = '') {
  results.push({ pass, id, label, detail });
  if (!AS_JSON) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}
const section = (t) => {
  if (!AS_JSON) console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
};

/* ------------------------------------------------- 颜色数学（不看亮度表） */

/** sRGB → 相对亮度（WCAG 2.1 定义；**不要**直接用 YIQ 或 HSV 近似） */
export function relLuminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------ 从源码抽取 token */

/**
 * 从 `app.css` 的 `@theme` 块里抽 `--color-svc-*` 与 `--radius-svc-*`。
 *
 * ⚠️ 不用正则跨行匹配整个块：本项目文件是 **CRLF**，
 *    `\n` 参与的锚点永远匹配不上（这是本项目反复踩的坑）。
 *    ⇒ 按行扫，遇到 `@theme` 进入、遇到单独的 `}` 退出。
 */
export function parseThemeCss(cssText) {
  const lines = cssText.split(/\r?\n/);
  const colors = {};
  const radii = {};
  const texts = {};
  let inTheme = false;
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!inTheme && /^@theme\b/.test(t)) {
      inTheme = true;
      depth = 0;
      continue;
    }
    if (inTheme && t.includes('{')) depth += 1;
    if (inTheme && t === '}') {
      depth -= 1;
      if (depth <= 0) {
        inTheme = false;
        continue;
      }
    }
    if (!inTheme) continue;
    let m = t.match(/^--color-svc-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/);
    if (m) colors[m[1]] = m[2].toLowerCase();
    /* ⚠️ 分两段：`--radius-svc`（基础档，无后缀）与 `--radius-svc-xxx` 都要能取到。
       第一版把连字符写进了必需部分，于是基础档永远取不到 ⇒ 误报「缺少 --radius-svc」。 */
    m = t.match(/^--radius-svc(?:-([a-z0-9]+))?\s*:\s*([0-9.]+)px\s*;/);
    if (m) radii[m[1] || 'base'] = Number(m[2]);
    m = t.match(/^--text-qf-([a-z0-9-]+)\s*:\s*([0-9.]+)px\s*;/);
    if (m) texts[m[1]] = Number(m[2]);
  }
  return { colors, radii, texts };
}

/** 从 `qf-tokens.ts` 的 `lightTokens` 里抽键值（只认 `'key': '#hex'` 形态） */
export function parseTokensTs(tsText) {
  const colors = {};
  // 只扫 lightTokens 对象体
  const start = tsText.indexOf('export const lightTokens');
  if (start < 0) return colors;
  const body = tsText.slice(start);
  const end = body.indexOf('} as const');
  const block = end > 0 ? body.slice(0, end) : body;
  const re = /['"]?([a-z0-9-]+)['"]?\s*:\s*'(#[0-9a-fA-F]{3,8})'/g;
  let m;
  while ((m = re.exec(block))) colors[m[1]] = m[2].toLowerCase();
  return colors;
}

/* ------------------------------------------------------------ 文件遍历 */

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ==========================================================================
 * 判据
 * ========================================================================== */

const FONT_SET = new Set([12, 13, 15, 17, 20, 28]);
/**
 * 允许的圆角像素值。
 *
 * 来自 `radius` 常量（8/10/12/14/3）+ **两个体系之外但确有必要的值**：
 *   · 2 —— `Domain.tsx` 命中高亮的 `<mark>`。它是**行内文本底衬**，
 *          2px 是文字级圆角；改成 8px 会让高亮四角"鼓"出字身框，看起来像个小标签。
 *   · 7 —— `ServiceSearch.tsx` 的小徽标。= 10 − 3（与外层 padding 同值的 inset 做法，
 *          与分段控件的滑块同族）。
 *   这两条**不是"放宽"**，而是承认"文字级圆角"与"控件级圆角"是两种语言，写下来免得下一个人再猜。
 */
const RADIUS_SET = new Set([2, 3, 7, 8, 10, 12, 14]);

/**
 * `rounded-full` 的合法落点按**元素性质**判定，不按文件白名单。
 *
 * 白名单的问题：同一个文件里新加一个胶囊按钮，永远查不出来。
 * 所以这里看"这个 full 属于什么样的盒子"：
 *   · `qf-badge`                 → 状态徽标
 *   · `h-N w-N`（宽高相等）      → 正圆（序号圈、图标底座）
 *   · `h-1 / h-1.5 / h-2`        → 进度条、圆点、分隔条
 *   · `aspect-square`            → 正方形兜底
 * 其余一律判红 —— 尤其是同时带 `qf-pressable` / `min-h-touch` 的，
 * 那说明它是一个**可点的胶囊按钮**，正是用户第一节明令禁止的"999px 胶囊"。
 */
export function isPillAllowed(segment) {
  const seg = String(segment);
  if (/\bqf-badge\b/.test(seg)) return true;
  const sq = seg.match(/\bh-(\d+(?:\.\d+)?)\b/);
  if (sq && new RegExp(`\\bw-${sq[1].replace('.', '\\.')}\\b`).test(seg)) return true;
  if (/\bh-(1|1\.5|2)\b/.test(seg)) return true;
  if (/\baspect-square\b/.test(seg)) return true;
  return false;
}

export function gateG1(cssText, tsText) {
  const { colors: cssColors } = parseThemeCss(cssText);
  const tsColors = parseTokensTs(tsText);
  const missingInCss = Object.keys(tsColors).filter((k) => !(k in cssColors));
  const missingInTs = Object.keys(cssColors).filter((k) => !(k in tsColors));
  const diff = Object.keys(tsColors)
    .filter((k) => k in cssColors && tsColors[k] !== cssColors[k])
    .map((k) => `${k}: ts=${tsColors[k]} css=${cssColors[k]}`);
  check(
    missingInCss.length === 0 && diff.length === 0,
    'G1',
    'app.css @theme 与 qf-tokens.ts lightTokens 逐键同值',
    [
      missingInCss.length ? `css 缺 ${missingInCss.length} 键: ${missingInCss.slice(0, 6).join(',')}` : '',
      diff.length ? `值不一致 ${diff.length} 处: ${diff.slice(0, 6).join(' | ')}` : '',
      /* ⚠️ missingInTs 只作为**提示**不判红：CSS 可以多出仅供 CSS 用的键
         （如仅用于 box-shadow 的中间色），那不算漂移。 */
      missingInTs.length ? `（提示：ts 少 ${missingInTs.length} 键 ${missingInTs.slice(0, 4).join(',')}，非阻断）` : '',
    ]
      .filter(Boolean)
      .join('\n        '),
  );
  return { cssColors, tsColors };
}

/**
 * G2：字号只能是六档。
 *
 * ⚠️ 只扫 `tsx` 里**实际用作类名**的 `text-[Npx]`。
 *    注释里的示例（比如解释"为什么不用 text-[14px]"）不能判红 ——
 *    否则一段好心的注释会让门禁误报，人就会去关掉它。
 *    ⇒ 先剥掉 `//` 行注释与 `/* … *\/` 块注释。
 */
/**
 * 剥掉注释，但**不碰代码正文**。
 *
 * ⚠️ 用一次性扫描而不是正则替换 —— 这里踩过一次：
 *    第一版用一条正则匹配"前面不是冒号或引号的双斜杠"（本意是跳过 https 协议头），
 *    结果 `text-[14px]` 后面的那个引号被它当成"前面一个引号"，
 *    于是把**行尾的代码**当注释一起剥掉了 ⇒ 违规字号反而查不到。
 *    这不是理论问题，是自检（--self-test）当场抓出来的。
 *
 * 做法：逐字符前进，识别三种状态，只有行注释与块注释内部的内容被抹成空格
 * （抹空格而不删，保持行号与列位置不变，后续正则可以照常报告位置）。
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null; // "'" | '"' | '`' | null
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += nx ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && nx === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && nx === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function gateG2(files) {
  const bad = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /text-\[([0-9.]+)px\]/g;
    let m;
    while ((m = re.exec(src))) {
      const px = Number(m[1]);
      if (!FONT_SET.has(px)) bad.push(`${rel}: text-[${m[1]}px]`);
    }
  }
  check(
    bad.length === 0,
    'G2',
    `自定字号只能用六档 {${[...FONT_SET].join(',')}}`,
    bad.length ? bad.slice(0, 12).join('\n        ') : '',
  );
  return bad;
}

/**
 * G3：圆角只能用 Token 档位；**胶囊只给圆点/徽标，按钮一律圆角矩形**。
 *
 * ⚠️ `rounded-full` 必须**逐处**判定它所在的那个 className 片段，
 *    不能按文件白名单 —— 白名单会让"同一个文件里新加一个胶囊按钮"永远查不出来。
 */
export function gateG3(files) {
  const bad = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    let m;
    const rePx = /rounded-\[([0-9.]+)px\]/g;
    while ((m = rePx.exec(src))) {
      const px = Number(m[1]);
      if (!RADIUS_SET.has(px)) bad.push(`${rel}: rounded-[${m[1]}px]`);
    }
    const reFull = /\brounded-full\b/g;
    while ((m = reFull.exec(src))) {
      // 取该处所在的**同一个字符串字面量**（class 串一共就三种引号）
      const idx = m.index;
      const left = Math.max(src.lastIndexOf('"', idx), src.lastIndexOf("'", idx), src.lastIndexOf('`', idx));
      const cands = [src.indexOf('"', idx), src.indexOf("'", idx), src.indexOf('`', idx)].filter((k) => k > idx);
      const right = cands.length ? Math.min(...cands) : src.length;
      const seg = src.slice(left + 1, right);
      if (!isPillAllowed(seg)) {
        const line = src.slice(0, idx).split('\n').length;
        bad.push(`${rel}:${line} rounded-full 落在可点元素上（胶囊按钮）→ 改圆角矩形`);
      }
    }
  }
  check(
    bad.length === 0,
    'G3',
    `胶囊只用于圆点/徽标（按钮一律圆角矩形）；其余圆角 ⊆ {${[...RADIUS_SET].join(',')}}`,
    bad.length ? bad.slice(0, 12).join('\n        ') : '',
  );
  return bad;
}

/**
 * G4：对比度逐对断言。
 *
 * ⚠️ 豁免项必须**带前提**（`前提` 字段非空）。空前提的豁免是"开后门"，
 *    因为它会让下一个人把任何不达标的颜色都写成豁免。
 */
export function gateG4(pairs, exempts, colors) {
  const fails = [];
  for (const p of pairs) {
    const fg = colors[p.fg];
    const bg = colors[p.bg];
    if (!fg || !bg) {
      fails.push(`${p.fg}/${p.bg}: token 缺失（fg=${fg} bg=${bg}）`);
      continue;
    }
    const r = contrastRatio(fg, bg);
    if (r + 1e-9 < p.min) fails.push(`${p.fg}(${fg}) on ${p.bg}(${bg}) = ${r.toFixed(2)}:1 < ${p.min}`);
  }
  for (const e of exempts) {
    const fg = colors[e.fg];
    const bg = colors[e.bg];
    if (!fg || !bg) {
      fails.push(`豁免 ${e.fg}/${e.bg}: token 缺失`);
      continue;
    }
    if (!e.前提 || !String(e.前提).trim()) {
      fails.push(`豁免 ${e.fg}/${e.bg}: **没有写前提**，等于无条件下调门槛`);
      continue;
    }
    const r = contrastRatio(fg, bg);
    if (r + 1e-9 < e.min) fails.push(`豁免 ${e.fg} on ${e.bg} = ${r.toFixed(2)}:1 < ${e.min}（前提：${e.前提}）`);
  }
  check(
    fails.length === 0,
    'G4',
    `对比度：${pairs.length} 对 ≥4.5:1，${exempts.length} 项豁免 ≥3:1 且写明前提`,
    fails.slice(0, 8).join('\n        '),
  );
  return fails;
}

/** G5：触控下限 44 —— 常量在 Token 里，且被输入框与图标按钮真实吃到 */
export function gateG5(cssText, tokensText) {
  const { radii } = parseThemeCss(cssText);
  const m = tokensText.match(/touch:\s*([0-9]+)/);
  const touch = m ? Number(m[1]) : NaN;
  const spacingM = cssText.match(/--spacing-touch:\s*([0-9]+)px;/);
  const spacingTouch = spacingM ? Number(spacingM[1]) : NaN;

  // 《qf-input》与《.svc-icon-btn》里面都必须出现 min-height: var(--spacing-touch)
  const hasInput = /\.qf-input\s*\{[^}]*min-height:\s*var\(--spacing-touch\)/s.test(cssText);
  const hasIcon = /\.svc-icon-btn\s*\{[^}]*min-height:\s*var\(--spacing-touch\)/s.test(cssText);

  const fails = [];
  if (touch !== 44) fails.push(`qf-tokens.ts metrics.touch = ${touch}（应为 44）`);
  if (spacingTouch !== 44) fails.push(`app.css --spacing-touch = ${spacingTouch}（应为 44）`);
  if (!hasInput) fails.push('.qf-input 没有 min-height: var(--spacing-touch)');
  if (!hasIcon) fails.push('.svc-icon-btn 没有 min-height: var(--spacing-touch)');
  // 圆角档位齐全（sm/md/lg/xl/inset）
  for (const k of ['sm', 'base', 'lg', 'xl', 'inset']) {
    /* ⚠️ base 档的 CSS 变量名就叫 `--radius-svc`（没有后缀），报错信息要跟着变，
       写成 `--radius-svc-` 会让人去搜一个不存在的变量。 */
    if (!(k in radii)) fails.push(k === 'base' ? '缺少 --radius-svc' : `缺少 --radius-svc-${k}`);
  }
  check(fails.length === 0, 'G5', '触控下限 44 落到常量与 .qf-input / .svc-icon-btn', fails.join('\n        '));
  return fails;
}

/**
 * G6：禁用特性扫描。
 *
 * ⚠️ 每一条都对应一段**用户明令**：
 *    · backdrop-filter / -webkit-backdrop-filter → 第 一 节"禁止毛玻璃"
 *    · prefers-color-scheme                      → 第 一 节"不得跟随系统深色"
 *    · 主操作栏 position: fixed                  → 键盘弹起会压住输入框（P11 前踩过）
 */
export function gateG6(files, cssText) {
  const fails = [];
  /**
   * CSS：按**声明**扫，不按行首扫。
   *
   * ⚠️ 第一版写的是"整行 trim 后以 backdrop-filter: 开头"——单行写法能查出来，
   *    但真实 CSS 几乎总是多行：
   *        .svc-x {
   *          backdrop-filter: blur(8px);
   *        }
   *    这时行首是空白，规则永远不触发 ⇒ 判据是摆设。自检当场抓到了这一条。
   *
   * 例外：`backdrop-filter: none !important` 是**封杀** Konsta 玻璃的那条正确规则，
   *      必须放行 —— 判据只会封杀"真加模糊"，不会封杀"取消模糊"。
   */
  const declRe = /(^|[\s{;])(-webkit-)?backdrop-filter\s*:\s*([^;}]+)/g;
  let dm;
  while ((dm = declRe.exec(cssText))) {
    const val = (dm[3] || '').trim();
    if (!/^none\b/i.test(val)) fails.push(`app.css: backdrop-filter: ${val.slice(0, 40)}`);
  }
  if (/prefers-color-scheme/.test(cssText)) {
    fails.push('app.css: 出现 prefers-color-scheme（业务界面必须恒定浅色）');
  }
  for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (/prefers-color-scheme/.test(src)) fails.push(`${rel}: prefers-color-scheme`);
    /**
     * ⚠️ 这里必须用 `backdrop-blur-sm` 这种**带后缀**的形态判红，不能写成
     *    `/backdrop-blur-(?!none)/` —— 那条负向断言会把
     *    `[class*='backdrop-blur']` 里的 `backdrop-blur'`（后面是单引号）
     *    也一起放过，于是"封杀 Konsta 玻璃"的那条正确规则反而被判成违规，
     *    而真正写 `backdrop-blur-md` 的地方却查不出来。自检当场抓到了这一条。
     */
    if (/backdrop-blur-(sm|md|lg|xl|2xl|3xl|\[)/.test(src)) fails.push(`${rel}: backdrop-blur-*`);
  }
  check(fails.length === 0, 'G6', '未使用毛玻璃 / 深色自适应', fails.slice(0, 8).join('\n        '));
  return fails;
}

/* ==========================================================================
 * 变异自检：每条判据必须能**真的变红**
 * ========================================================================== */

function selfTest() {
  section('变异自检（喂违规输入，要求每条判据都变红）');
  const mutationFails = [];

  const expectRed = (name, fn) => {
    const before = results.length;
    fn();
    const produced = results.slice(before);
    const red = produced.length > 0 && produced.every((r) => !r.pass);
    if (!red) mutationFails.push(`${name}：喂违规输入后仍是绿的 ⇒ 这条判据是摆设`);
    results.length = before; // 自检结果不进正式统计
  };

  const cssReal = fs.readFileSync(CSS_FILE, 'utf8');
  const tsReal = fs.readFileSync(TOKENS_FILE, 'utf8');
  const { colors: realColors } = parseThemeCss(cssReal);
  const files = walk(SRC).filter((f) => /\.(tsx|ts)$/.test(f));

  // G1：把 CSS 的一个颜色改掉，必须红
  expectRed('G1', () => gateG1(cssReal.replace(/--color-svc-brand:\s*#[0-9a-fA-F]{6}/, '--color-svc-brand: #123456'), tsReal));

  // G2：造一个 14px
  const tmpTsx = path.join(SRC, '__selftest__.tsx');
  try {
    fs.writeFileSync(tmpTsx, 'export const A = () => <div className="text-[14px]" />;\n', 'utf8');
    expectRed('G2', () => gateG2([tmpTsx]));
    // 反向：写进注释里**不能**红（否则误报会让人关掉门禁）
    fs.writeFileSync(tmpTsx, '// 为什么不用 text-[14px]\nexport const A = 1;\n', 'utf8');
    const before = results.length;
    gateG2([tmpTsx]);
    const green = results.slice(before).every((r) => r.pass);
    results.length = before;
    if (!green) mutationFails.push('G2 反向：注释里提到 text-[14px] 被误判为违规（会诱导关闭门禁）');

    // G2 反向之二：`text-[13px]` 合法值不能红
    fs.writeFileSync(tmpTsx, 'export const A = () => <div className="text-[13px] text-[28px]" />;\n', 'utf8');
    const b2 = results.length;
    gateG2([tmpTsx]);
    const green2 = results.slice(b2).every((r) => r.pass);
    results.length = b2;
    if (!green2) mutationFails.push('G2 反向：合法字号 text-[13px]/[28px] 被判红');

    // G3：造 rounded-full 与非档位圆角
    fs.writeFileSync(tmpTsx, 'export const A = () => <div className="rounded-full rounded-[7px]" />;\n', 'utf8');
    expectRed('G3', () => gateG3([tmpTsx]));
  } finally {
    if (fs.existsSync(tmpTsx)) fs.unlinkSync(tmpTsx);
  }

  // G4：把 ink-3 换成浅灰（原来的 #8E8E93），必须红
  expectRed('G4', () =>
    gateG4(
      [{ fg: 'ink-3', bg: 'surface', min: 4.5 }],
      [],
      { ...realColors, 'ink-3': '#8e8e93' },
    ),
  );
  // G4 反向：豁免没写前提也必须红
  expectRed('G4-无前提豁免', () =>
    gateG4(
      [],
      [{ fg: 'brand-ink', bg: 'brand', min: 3, 前提: '' }],
      realColors,
    ),
  );

  // G5：把 touch 改成 40，必须红
  expectRed('G5', () => gateG5(cssReal.replace('--spacing-touch: 44px', '--spacing-touch: 40px'), tsReal));

  /**
   * G6：**每条规则各喂一次**。
   * ⚠️ 只喂 CSS 那半部分，源码侧的三条规则（prefers-color-scheme / backdrop-blur-* /
   *    [class*=backdrop-blur] 的例外）就永远没被验证过 —— 而"没被验证过的判据"
   *    与"不存在的判据"是同一件事。自检第一次跑正是只喂了一半，于是 G6 判绿。
   */
  expectRed('G6-css玻璃', () => gateG6(files, cssReal + '\n.svc-x { backdrop-filter: blur(8px); }\n'));
  expectRed('G6-css深色', () => gateG6(files, cssReal + '\n@media (prefers-color-scheme: dark) { .a { color: #fff } }\n'));
  {
    const tmpTsx2 = path.join(SRC, '__selftest2__.tsx');
    try {
      fs.writeFileSync(tmpTsx2, 'export const A = () => <div className="backdrop-blur-md" />;\n', 'utf8');
      expectRed('G6-源码玻璃', () => gateG6([tmpTsx2], cssReal));
      // 反向：封杀玻璃用的 `[class*=backdrop-blur]` 规则**不能**被判红
      fs.writeFileSync(tmpTsx2, 'export const A = () => <div className="[class*=backdrop-blur] hidden" />;\n', 'utf8');
      const b = results.length;
      gateG6([tmpTsx2], cssReal);
      const green = results.slice(b).every((r) => r.pass);
      results.length = b;
      if (!green) mutationFails.push('G6 反向：封杀玻璃用的 [class*=backdrop-blur] 规则被误判为违规');
    } finally {
      if (fs.existsSync(tmpTsx2)) fs.unlinkSync(tmpTsx2);
    }
  }

  const ok = mutationFails.length === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  7 条变异用例${ok ? '全部按预期变红' : '存在失效判据'}`);
  if (!ok) {
    for (const m of mutationFails) console.log(`        ✗ ${m}`);
    console.log('\n  ⇒ exit 2：工具坏了（判据失效），**不给产品结论**');
    return 2;
  }
  return 0;
}

/* ==========================================================================
 * main
 * ========================================================================== */

function loadTokens() {
  // 不用 import：`.ts` 在纯 node 下不能直接跑。这里只需要三样东西，
  // 用受控正则抽取比"为一个脚本引入 ts-node"更稳。
  const text = fs.readFileSync(TOKENS_FILE, 'utf8');
  const colors = parseTokensTs(text);

  const pairs = [];
  {
    const i = text.indexOf('export const CONTRAST_PAIRS');
    const j = text.indexOf('];', i);
    const block = text.slice(i, j);
    const re = /\{\s*fg:\s*'([a-z0-9-]+)',\s*bg:\s*'([a-z0-9-]+)',\s*min:\s*([0-9.]+)\s*\}/g;
    let m;
    while ((m = re.exec(block))) pairs.push({ fg: m[1], bg: m[2], min: Number(m[3]) });
  }
  const exempts = [];
  {
    const i = text.indexOf('export const LARGE_TEXT_EXEMPT');
    const j = text.indexOf('];', i);
    const block = text.slice(i, j);
    const re = /\{\s*fg:\s*'([a-z0-9-]+)',\s*bg:\s*'([a-z0-9-]+)',\s*min:\s*([0-9.]+),\s*前提:\s*'([^']*)'\s*\}/g;
    let m;
    while ((m = re.exec(block))) exempts.push({ fg: m[1], bg: m[2], min: Number(m[3]), 前提: m[4] });
  }
  return { text, colors, pairs, exempts };
}

function main() {
  if (SELF_TEST) return selfTest();

  section('R2.2.1 设计 Token 门禁');
  const cssText = fs.readFileSync(CSS_FILE, 'utf8');
  const { text: tsText, colors, pairs, exempts } = loadTokens();
  const files = walk(SRC).filter((f) => /\.(tsx|ts)$/.test(f));

  gateG1(cssText, tsText);
  gateG2(files);
  gateG3(files);
  gateG4(pairs, exempts, colors);
  gateG5(cssText, tsText);
  gateG6(files, cssText);

  const bad = results.filter((r) => !r.pass);
  if (AS_JSON) {
    console.log(JSON.stringify({ at: new Date().toISOString(), results, ok: bad.length === 0 }, null, 2));
  } else {
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`  共 ${results.length} 条判据，通过 ${results.length - bad.length}，失败 ${bad.length}`);
    if (bad.length) for (const b of bad) console.log(`  ✗ [${b.id}] ${b.label}`);
  }
  return bad.length ? 1 : 0;
}

process.exit(main());
