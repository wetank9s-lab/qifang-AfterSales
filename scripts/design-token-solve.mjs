/**
 * design-token-solve.mjs —— 求解状态色在指定底色上达到目标对比度的**最小改动值**。
 *
 * 由 `_a11y-danger-solve.mjs` 提升为正式工具（2026-11-14）：
 *   当时它是临时脚本，但 `tokens.ts` / `base.css` 的注释都写着
 *   "解题过程见 scripts/_a11y-danger-solve.mjs" ——
 *   如果删掉它，那些注释就指向一个不存在的文件，
 *   正是本项目批判过的"注释成了一种错觉"（原 `design-consistency.mjs` 就是这么消失的）。
 *   ⇒ 要么删注释、要么留脚本。留脚本——它是**可复跑的证据**，不只是说明。
 *
 * 用法：`node scripts/design-token-solve.mjs`（改下面 ORIG / SOFT / TARGET 三个常量即可复算）。
 * 复核：`node scripts/design-parity.mjs`（门禁会守着结果值，改了会红）。
 *
 * ---------------------------------------------------------------------------
 * 背景：为什么会有 danger 这一笔（用户只点名了 success / warning）
 * ---------------------------------------------------------------------------
 *   2026-11-13 用户裁决："两个状态色在浅色背景上文字对比度目标均 ≥5:1，
 *   不要刚好卡在 4.5:1；保留语义与 iOS 风格，不要改成黑/深灰。"
 *
 *   落地时 `design-parity.mjs` 把**同一批状态色**放进**同一门槛**，结果它红了：
 *     #d0342c on #fdecea = **4.36:1** —— 连 AA 的 4.5 底线都不达。
 *   这不是"门禁写严了"，是真缺陷：`Login.tsx:84` 就是
 *   `bg-svc-danger-soft + text-svc-danger + 13px` 的真实满软底用法，
 *   h5 侧也有 `.svc-error` / `.rv-state-mark` 这类「软底 + 状态色文字」。
 *
 *   归因（不是"擅自扩大范围"）：改的是**一个色值**，不是结构、不是布局、不是新组件；
 *   属用户第 ⑥ 条授权的"**必要的文字可读性问题**"，且与 success/warning
 *   走**同一套 Token、同一门槛**（用户第 ④ 条）。
 *   不修它，第 ④ 条就是假的 —— 同批色里两个达 5:1、一个连 4.5 都不达，那不叫统一。
 *
 * 做法：保持 HSL **色相不变**（≈3°）、**饱和度不变** ⇒ 仍是同一支红，不是黑/灰；
 *       只降明度，求满足目标的**最小改动**，并打印候选点供目视挑选 iOS 观感。
 */
const hex2rgb = (h) => {
  const s = h.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`非法 hex: ${h}`);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const rgb2hex = (a) =>
  '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(hex2rgb(a)), lum(hex2rgb(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const rgb2hsl = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  const d = mx - mn;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s, l };
};
const hsl2rgb = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let p;
  if (h < 60) p = [c, x, 0];
  else if (h < 120) p = [x, c, 0];
  else if (h < 180) p = [0, c, x];
  else if (h < 240) p = [0, x, c];
  else if (h < 300) p = [x, 0, c];
  else p = [c, 0, x];
  return p.map((v) => (v + m) * 255);
};

const ORIG = '#d0342c';
const SOFT = '#fdecea';   // 移动端 danger-soft（= 门禁里的 SOFT_BG.danger）
const WHITE = '#ffffff';
/**
 * ⚠️ 门槛取 5.4 而不是 5.0：
 *   用户第 ① 条是"≥5:1 **不要刚好卡在 4.5:1**"—— 意图是**留余量**，不是压线。
 *   若取 TARGET=5.0，解出的 #bf3029 恰好 5.00:1，同样是"卡线"（只是卡在 5 而不是 4.5）。
 *   而 success/warning 定稿值是 5.45 / 5.52 ⇒ 取 5.4 让**三个色余量一致**，
 *   也符合用户第 ④ 条"统一走 Token、统一标准"。
 */
const TARGET = 5.4;       // 与 success(5.45)/warning(5.52) 留同等余量

const osl = rgb2hsl(hex2rgb(ORIG));
console.log('原值', ORIG);
console.log(`  HSL: H=${osl.h.toFixed(1)}° S=${(osl.s * 100).toFixed(0)}% L=${(osl.l * 100).toFixed(0)}%`);
console.log(`  on soft ${SOFT} = ${contrast(ORIG, SOFT).toFixed(2)}:1`);
console.log(`  on white         = ${contrast(ORIG, WHITE).toFixed(2)}:1`);
console.log('');

// 在合法明度区间内搜索（下界 0.12，防"压成黑"）；保持色相与饱和度
const MIN_L = 0.12;
let best = null;
for (let i = 0; i <= 400; i++) {
  const l = MIN_L + (osl.l - MIN_L) * (i / 400);
  const hex = rgb2hex(hsl2rgb(osl.h, osl.s, l));
  const onSoft = contrast(hex, SOFT);
  const onWhite = contrast(hex, WHITE);
  if (onSoft >= TARGET && onWhite >= TARGET) best = { hex, l, onSoft, onWhite };
}
if (!best) {
  console.error('❌ 区间内无解 —— 需要放开饱和度或调 soft 底');
  process.exit(2);
}
const hsl = rgb2hsl(hex2rgb(best.hex));
console.log('✅ 推荐值（保持色相/饱和度，仅降明度）:', best.hex);
console.log(`   HSL: H=${hsl.h.toFixed(1)}° S=${(hsl.s * 100).toFixed(0)}% L=${(hsl.l * 100).toFixed(0)}%`);
console.log(`   色相差 = ${Math.abs(hsl.h - osl.h).toFixed(2)}°  (须 <3)`);
console.log(`   明度 ${(osl.l * 100).toFixed(0)}% → ${(hsl.l * 100).toFixed(0)}%`);
console.log(`   on soft ${SOFT} = ${best.onSoft.toFixed(2)}:1`);
console.log(`   on white         = ${best.onWhite.toFixed(2)}:1`);
console.log('');
console.log('候选点（供目视挑选 iOS 观感）:');
for (const delta of [0.00, 0.02, 0.04, 0.06, 0.08]) {
  const l = best.l + delta;
  if (l >= osl.l) continue;
  const hex = rgb2hex(hsl2rgb(osl.h, osl.s, l));
  console.log(
    `   L=${(l * 100).toFixed(0)}%  ${hex}  soft ${contrast(hex, SOFT).toFixed(2)}:1  white ${contrast(hex, WHITE).toFixed(2)}:1`
  );
}
