/**
 * design-parity.mjs —— 量化 h5/ 与 src-mobile/ 两套设计体系的**真实**差距。
 *
 * 用户第一节要求：把两者统一到同一套设计体系，但
 *   ① 允许保留独立构建；② 不得改后端、ACL、短信、Token、数据模型。
 *
 * ⚠️ "统一"不能凭印象做。先量出**具体差在哪些值上**，再决定哪些该合、哪些必须留：
 *   · 品牌主色是**产品可配置项**（门店装修，`page-theme.ts` 的 preset 驱动，
 *     有 `verify-ux-01d-config.mjs` 门禁守着）⇒ 它"不一致"是**功能**，不是漂移；
 *   · 中性灰阶 / 状态色 / 圆角 / 字号 / 触控尺寸 是**设计语言的不变量**
 *     ⇒ 这些不一致才是真的漂移，是本次要合的。
 *
 * 同时算 WCAG 对比度：h5 的 `--svc-text-weak` 有注释写死"提升到 5.80:1（AA 需 ≥4.5）"，
 * 若为了"统一"把它换成移动端的灰，可能反而掉到 AA 以下 —— 必须先算再改。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const H5_CSS = path.join(ROOT, 'h5/src/styles/base.css');
const M_TOKENS = path.join(ROOT, 'src-mobile/src/design/tokens.ts');

/* ------------------------------------------------------------------ 解析 */

/**
 * 从 h5 base.css 里取**浅色** `--svc-*` 变量。
 *
 * ⚠️ 第一版我用 `matchAll` 扫全文，结果把 `@media (prefers-color-scheme: dark)`
 *    里的**深色值**也抓进来了（h5-bg 变成 #17181b、text 变成 #e8e9ec），
 *    还抓到了 `html[data-theme='graphite']` 的 `--svc-primary-disabled: #b6c2d1`。
 *    ⇒ 输出的"对照表"把浅色系统与深色系统混在一起比，**结论会完全错**：
 *      我会按深色值去改移动端的浅色 token。
 *
 *    这是"验证器自己也会错，且错得比产品更隐蔽"的又一例：
 *    数据看起来齐整、格式也对，只有跟源码对一眼才知道取错了块。
 *    ⇒ 修为**只解析首个 `:root { }` 块**（它必须在任何 @media 之前），
 *      并在下面把"抓到的键"打印出来供人工核对。
 */
function parseH5() {
  const css = fs.readFileSync(H5_CSS, 'utf8');
  // 取文件里**第一个** `:root { ... }`（浅色基准），到第一个 `}` 为止
  const first = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (!first) throw new Error('h5 base.css 里找不到 :root 块');
  const out = {};
  for (const m of first[1].matchAll(/--svc-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const v = m[2].trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) out[m[1]] = v.toLowerCase();
  }
  out.__parsedKeys = Object.keys(out).join(',');
  return out;
}

/** 从 TS 里取 `export const lightTokens = { ... }` 的键值 */
function parseMobile() {
  const ts = fs.readFileSync(M_TOKENS, 'utf8');
  const block = /export const lightTokens = \{([\s\S]*?)\n\} as const;/.exec(ts);
  if (!block) throw new Error('找不到 lightTokens');
  const out = {};
  for (const m of block[1].matchAll(/^\s*'?([a-z0-9-]+)'?\s*:\s*'(#[0-9a-fA-F]{3,8})'/gm)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

/* ------------------------------------------------------- WCAG 对比度 */

const hex2rgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const a = lum(hex2rgb(fg)), b = lum(hex2rgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/* ------------------------------------------------------------ 对照表 */

/**
 * 语义位 → { h5 变量名, mobile token 键名 }
 *
 * ⚠️ 品牌主色**刻意列在末尾单独报**：它是产品可配置的，不该被"统一"掉。
 */
const PAIRS = [
  ['正文文字', 'text', 'ink'],
  ['次要文字', 'text-weak', 'ink-2'],
  ['三级文字', null, 'ink-3'],
  ['页面底色', 'bg', 'bg'],
  ['卡片面', 'card', 'surface'],
  ['二级面', null, 'surface-2'],
  ['描边', 'border', null],
  ['描边(强)', null, 'line-strong'],
  ['成功', 'ok', 'success'],
  ['警告', 'warn', 'warning'],
  ['危险', 'danger', 'danger'],
  ['信息', null, 'info'],
  ['中性', null, 'neutral'],
];

/** 只有一方有的语义位 —— 单独列，不硬凑成"差异" */
const ONE_SIDED = [
  ['描边', 'h5 border', 'border'],
  ['中性面(h5)', 'h5 bg/card', null],
];

const h5 = parseH5();
const mo = parseMobile();

console.log('='.repeat(78));
console.log('〇、解析自检（先确认取对了块，再谈对照）');
console.log('='.repeat(78));
console.log('  h5 浅色 :root 抓到的键 : ' + h5.__parsedKeys);
console.log('  mobile lightTokens 键  : ' + Object.keys(mo).join(','));
console.log('  ⚠️ 若 h5 出现 text=#e8e9ec / bg=#17181b，说明误取了深色 @media 块（浅色应为 #1f2329 / #f5f6f8）');
console.log('');

console.log('='.repeat(78));
console.log('一、两套体系重合语义位的逐项对照');
console.log('='.repeat(78));
console.log('语义位'.padEnd(12) + 'h5'.padEnd(24) + 'src-mobile'.padEnd(24) + '一致?');
console.log('-'.repeat(78));

const diffs = [];
for (const [name, h5k, mk] of PAIRS) {
  const a = h5k ? h5[h5k] : null;
  const b = mk ? mo[mk] : null;
  const aTxt = a ? `${h5k} = ${a}` : '（无）';
  const bTxt = b ? `${mk} = ${b}` : '（无）';
  let verdict;
  if (!a || !b) verdict = '— 单侧';
  else if (a === b) verdict = '✅ 一致';
  else {
    verdict = '❌ 不一致';
    diffs.push({ name, h5: a, mobile: b, h5k, mk });
  }
  console.log(name.padEnd(12) + aTxt.padEnd(24) + bTxt.padEnd(24) + verdict);
}

console.log('\n' + '='.repeat(78));
console.log('二、品牌主色（**产品可配置**，不应被统一）');
console.log('='.repeat(78));
console.log(`  h5      : --svc-primary = ${h5.primary}   （由 page-theme.ts preset 驱动）`);
console.log(`  mobile  : brand          = ${mo.brand}`);
console.log(`  h5 三预设: classic-blue=${h5.primary} / brand-red=#c8362c / graphite=#475569`);
console.log('  ⇒ 结论：主色差异是**门店装修功能**，不是设计系统漂移。统一它会改后端契约。');

console.log('\n' + '='.repeat(78));
console.log('三、文字对比度（WCAG AA 正文需 >= 4.5）');
console.log('='.repeat(78));
const h5Bg = h5.bg, moBg = mo.bg;
const checks = [
  ['h5 正文 / h5 底色', h5.text, h5Bg],
  ['h5 次要 / h5 底色', h5['text-weak'], h5Bg],
  ['mobile 正文 / mobile 底色', mo.ink, moBg],
  ['mobile 次要 / mobile 底色', mo['ink-2'], moBg],
  ['mobile 三级 / mobile 底色', mo['ink-3'], moBg],
  // 交叉：若把 h5 换成 mobile 的灰
  ['【假如】h5 次要换成 mobile ink-2', mo['ink-2'], h5Bg],
  ['【假如】mobile 次要换成 h5 text-weak', h5['text-weak'], moBg],
];
for (const [label, fg, bg] of checks) {
  if (!fg || !bg) continue;
  const c = contrast(fg, bg);
  const flag = c >= 4.5 ? 'AA ✅' : c >= 3 ? 'AA ❌（仅大字号可用）' : 'AA ❌❌';
  console.log(`  ${label.padEnd(38)} ${fg} on ${bg} = ${c.toFixed(2)}:1  ${flag}`);
}

console.log('\n' + '='.repeat(78));
console.log('三b、状态色对比度（统一前必须确认不破坏可访问性）');
console.log('='.repeat(78));
console.log('  ⚠️ 状态色用法有两种，门槛不同：');
console.log('     · 作为**文字**出现（如「已闭环」标签）→ AA 正文 4.5:1');
console.log('     · 只作为**大色块/图标** → AA 非文本 3:1');
console.log('  两套体系的状态色语义位一一对应，所以逐对比较"谁更好"再做取舍：');
const pairs = [
  ['成功', h5.ok, mo.success],
  ['警告', h5.warn, mo.warning],
  ['危险', h5.danger, mo.danger],
];
for (const [name, a, b] of pairs) {
  const ca = contrast(a, h5.bg), cb = contrast(b, mo.bg);
  // 也在白底上算一次（状态色常用于白卡片内）
  const caw = contrast(a, '#ffffff'), cbw = contrast(b, '#ffffff');
  console.log(`  ${name}`);
  console.log(`    h5     ${a}  底#f5f6f8=${ca.toFixed(2)}  白底=${caw.toFixed(2)}  ${ca >= 4.5 ? 'AA ✅' : 'AA ❌'}`);
  console.log(`    mobile ${b}  底#f5f7fa=${cb.toFixed(2)}  白底=${cbw.toFixed(2)}  ${cb >= 4.5 ? 'AA ✅' : 'AA ❌'}`);
}

console.log('\n' + '='.repeat(78));
const h5Css = fs.readFileSync(H5_CSS, 'utf8');
const radiusH5 = /--svc-radius\s*:\s*([^;]+);/.exec(h5Css)?.[1]?.trim();
const mobMetrics = /export const metrics = \{([\s\S]*?)\n\} as const;/.exec(
  fs.readFileSync(M_TOKENS, 'utf8'),
)?.[1] ?? '';
const pick = (k) => new RegExp(`${k}\\s*:\\s*'([^']+)'`).exec(mobMetrics)?.[1] ?? '?';
console.log(`  圆角(卡片)   h5 = ${radiusH5}            mobile radius = ${pick('radius')}`);
console.log(`  圆角(小)     h5 = (无)                 mobile radiusSm = ${pick('radiusSm')}`);
console.log(`  触控下限     h5 = 44px（注释声明）      mobile touch = ${pick('touch')}`);
console.log(`  导航高       h5 = (页面各自写)          mobile navHeight = ${pick('navHeight')}`);
console.log(`  底栏高       h5 = (无底栏)              mobile tabHeight = ${pick('tabHeight')}`);
const fonts = [...h5Css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
const uniq = [...new Set(fonts)].sort((a, b) => a - b);
console.log(`  h5 出现的字号: ${uniq.join(' / ')}px（共 ${fonts.length} 处声明，${uniq.length} 种）`);

console.log('\n' + '='.repeat(78));
console.log('五、门禁断言（不是报告 —— 会红才叫门禁）');
console.log('='.repeat(78));

/**
 * ⚠️ 为什么这里必须有**断言**，不能只打印对照表：
 *    打印出来的差异下次只会被"看一眼然后忘记"。
 *    两套体系漂移的本质是**没人守着**（tokens.ts 的注释里引用的
 *    `design-consistency.mjs` 其实根本不存在 —— 注释成了一种错觉）。
 *
 * 守什么（顺序即重要性）：
 *   ① 状态色必须**同源**：浅色三个值两端相等（本次刚刚统一，不能再漂）
 *   ② 状态色必须全部达到 AA 4.5:1（否则"统一"是把可访问性统一掉了）
 *   ③ 品牌主色必须**保持不同**（它是产品可配置项，被"顺手统一"就是改后端契约）
 *   ④ 圆角不得出现刻度外的硬编码值
 *   ④⑤ 深色状态色必须存在且达标（本次发现"浅色改好、深色变差"的坑）
 */
const results = [];
const assert = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

// ① 状态色同源
for (const [name, h5k, mk] of [['危险', 'danger', 'danger'], ['警告', 'warn', 'warning'], ['成功', 'ok', 'success']]) {
  assert(
    h5[h5k] === mo[mk],
    `状态色「${name}」两端同源（h5 --svc-${h5k} = 移动端 ${mk}）`,
    `h5 ${h5[h5k]}  vs  mobile ${mo[mk]}`,
  );
}

// ② 状态色 AA 达标 —— ⚠️ 用户 2026-11-13 裁决的第 ① 条：
//    "两个状态色在实际浅色背景上的文字对比度目标均 ≥5:1，不要刚好卡在 4.5:1"
//    "实际浅色背景" = 徽标底（*-soft），那才是状态色真正被当文字用的地方。
const SOFT_BG = { success: '#e9f8f0', warning: '#fff4e5', danger: '#fdecea', neutral: '#eef0f4', info: '#eaf4fe' };
/**
 * ⚠️ 门槛取 **5.4** 而不是"够 5 就行"：
 *   用户第 ① 条原话是"目标均 ≥5:1，**不要刚好卡在 4.5:1**"——
 *   意图是**留余量**，不是找一条能压线的值。
 *   若门槛写 5.0，danger 会解出恰好 5.00:1 的 `#bf3029` —— 那是"卡在 5"，
 *   与"卡在 4.5"是同一类问题，只是换了个数字。
 *   取 5.4 让三色余量一致（实测 5.41 / 5.45 / 5.52），也给后续微小调色留缓冲。
 */
const USER_TARGET = 5.4;
for (const [name, v, key] of [['成功', mo.success, 'success'], ['警告', mo.warning, 'warning'], ['危险', mo.danger, 'danger']]) {
  const onSoft = contrast(v, SOFT_BG[key]);
  assert(
    onSoft >= USER_TARGET,
    `状态色「${name}」在自己浅色底(${SOFT_BG[key]})上达到用户要求的 >=5:1`,
    `${v} on ${SOFT_BG[key]} = ${onSoft.toFixed(2)}:1`,
  );
  const onWhite = contrast(v, '#ffffff');
  assert(onWhite >= USER_TARGET, `状态色「${name}」在白卡片上同样 >=5:1`, `${onWhite.toFixed(2)}:1`);
}

// ②b 用户第 ② 条："保留原有语义和 iOS 风格，不要简单改成黑色或深灰色"
//    判据：色相必须与原色一致（±3°），且饱和度不得掉到 40% 以下（掉了就是"变灰"）
const HSL = (hex) => {
  const [r, g, b] = hex2rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
};
/**
 * ⚠️ 参考色相取的是**原值**（改色之前的那支色），不是定稿值 ——
 *    否则这条断言就成了"拿结果证明结果"（自己等于自己，永远不会红）。
 *    ④ danger 也纳入：它是同一批状态色、同一门槛；漏掉它 = 门禁有个洞。
 */
const HUE_REF = { success: 153, warning: 35, danger: 3 };
for (const [name, v, key] of [['成功', mo.success, 'success'], ['警告', mo.warning, 'warning'], ['危险', mo.danger, 'danger']]) {
  const [h, s, l] = HSL(v);
  // 色相环绕（红在 0/360 附近会绕回来）
  const dh = Math.min(Math.abs(h - HUE_REF[key]), 360 - Math.abs(h - HUE_REF[key]));
  assert(dh <= 3, `状态色「${name}」保持原色相（没有变成另一种颜色）`,
    `色相 ${h.toFixed(0)}°，参考 ${HUE_REF[key]}°，差 ${dh.toFixed(0)}°`);
  assert(s >= 0.4 && l >= 0.15, `状态色「${name}」仍是有彩度的状态色（未退化成黑/深灰）`,
    `饱和度 ${(s * 100).toFixed(0)}%，明度 ${(l * 100).toFixed(0)}%`);
}

/**
 * ③ 品牌主色**必须相同**（2026-11-14 用户裁决反转了这条判据）
 * ---------------------------------------------------------------------------
 *   旧判据是 `h5.primary !== mo.brand`，理由是"门店装修可配置、不同是功能"。
 *   用户本轮明确取消：
 *     "门店品牌色可以用于门店标识，但不得成为两个前端布局和组件不一致的理由。
 *      取消任何要求两个前端主操作颜色必须不同的测试判据。"
 *
 *   ⇒ 现在要求两端主色**一致**（都取 iOS 系统蓝 #007AFF）。
 *     断言方向反过来，它现在守的是"项目里没有第二套蓝"。
 */
assert(
  h5.primary.toLowerCase() === mo.brand.toLowerCase(),
  '两端主操作色一致（统一为 iOS 系统蓝，不再是两套蓝）',
  `h5 ${h5.primary} vs mobile ${mo.brand}`,
);

// ④ 圆角不得有刻度外硬编码
const radiusLits = [...fs.readFileSync(H5_CSS, 'utf8').matchAll(/border-radius:\s*(\d+)px/g)].map((m) => m[1]);
assert(
  radiusLits.length === 0,
  'h5 圆角全部走刻度变量（没有刻度外的硬编码 px）',
  radiusLits.length ? `仍有 ${radiusLits.length} 处：${[...new Set(radiusLits)].join('/')}px` : '全部为 var(--svc-radius-*)',
);

/* ⑤ 深色模式 —— **已整体移除**（2026-11-14 产品裁决）
 * ---------------------------------------------------------------------------
 *   原先这里有三组断言：深色状态色存在 / 对比度 ≥4.5 / 亮度不刺眼 / 深色提示条达标。
 *   用户本届明确："不再开发深色模式，不提供浅色/深色切换。"
 *
 *   ⇒ 断言方向反过来：现在要守的是"**不要再长出深色覆盖**"。
 *     留着旧断言会产生荒谬局面 —— 产品没有深色，门禁却要求深色变量必须存在。
 */
const h5CssRaw = fs.readFileSync(H5_CSS, "utf8");
/* 先剥掉注释再扫：否则「已删除深色」这类说明文字本身会被当成深色块（实测假阳性 1 处）。
   这与本项目"判据太宽 = 自造假红"是同一类问题。 */
const h5CssNoComment = h5CssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const h5DarkBlocks = (h5CssNoComment.match(/@media \(prefers-color-scheme: dark\)/g) || []).length;
assert(
  h5DarkBlocks === 0,
  "h5 不含深色模式覆盖（产品已锁定浅色，任何深色块都属残留）",
  h5DarkBlocks ? `仍有 ${h5DarkBlocks} 个 @media (prefers-color-scheme: dark)` : "已全部移除",
);

const mobileCssPath = path.join(ROOT, "src-mobile/src/styles/app.css");
const mobileCssRaw = fs.existsSync(mobileCssPath) ? fs.readFileSync(mobileCssPath, "utf8") : "";
const mobileDarkSel = (mobileCssRaw.match(/^\.dark\b|^:root\.dark\b/gm) || []).length;
const mobileTokensRaw = fs.readFileSync(M_TOKENS, "utf8");
const hasDarkTokens = /export const darkTokens/.test(mobileTokensRaw);
assert(
  mobileDarkSel === 0 && !hasDarkTokens,
  "员工端不含深色实现（.dark 作用域与 darkTokens 都已移除）",
  `选择器 ${mobileDarkSel} 处 / darkTokens ${hasDarkTokens ? "仍存在" : "已移除"}`,
);
console.log('\n' + '='.repeat(78));
const fails = results.filter((r) => !r.ok);
console.log(`汇总：PASS ${results.length - fails.length} / FAIL ${fails.length}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  · ${f.label}  ${f.detail}`);
}
console.log('='.repeat(78));
process.exit(fails.length ? 1 : 0);
