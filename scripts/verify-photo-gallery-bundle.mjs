/**
 * 产物验证：确认后台照片预览组件真的打进了 client bundle。
 *
 * ⚠️ esbuild 会把中文字面量转成 **大写 hex 的 \uXXXX 转义**（如 施 -> \u65BD），
 *    只 grep 原文会 0 命中并误判「没打进去」。这里两种形态都找。
 */
import fs from 'node:fs';

const F = 'storage/plugins/@local/service-ticket/dist/client/index.js';
const s = fs.readFileSync(F, 'utf8');
const esc = (w) => [...w].map((c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');

const cases = [
  ['旧占位文案（应 0 次）', '后台不内嵌原图', false],
  ['旧占位文案（应 0 次）', '按需开私有预览', false],
  ['分组容器 testid', 'sa2-photo-gallery', true],
  ['大图查看器 testid', 'sa2-photo-viewer', true],
  ['缩略图 testid 前缀', 'sa2-photo-', true],
  ['暖通标题', '施工照片', true],
  ['普通标题', '现场照片', true],
  ['未分类分组', '未分类', true],
  ['翻页按钮', '上一张', true],
  ['翻页按钮', '下一张', true],
  ['缩放按钮', '放大', true],
  ['重试按钮', '重试', true],
  ['未发布角标', '未发布', true],
  ['照片接口参数名', 'photo_id=', true],
];

let pass = 0;
let fail = 0;
for (const [label, word, want] of cases) {
  const raw = s.split(word).length - 1;
  const hex = s.split(esc(word)).length - 1;
  const total = raw + hex;
  const ok = want ? total > 0 : total === 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(22)} 「${word}」 原文=${raw} 转义=${hex} 合计=${total} 期望=${want ? '>0' : '=0'}`);
}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
