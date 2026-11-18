/**
 * R2.1.2 产物复核（一次性脚本）
 *
 * 判据设计说明（为什么会写这个文件而不是 grep）：
 *  esbuild 会把中文字面量写成 \uXXXX 转义形态，同时又**原样保留源码注释**里的中文。
 *  ⇒ 只搜原文字面量会命中注释而给出假绿（DEV 已记过一次：搜「供应商标识」命中注释）。
 *  ⇒ 因此这里**同时统计两种形态**，并额外统计「键值对形态」：
 *      label:"处理" / hint:"处理工单" —— 这些只可能出现在真实的运行期数据上。
 */
import fs from 'node:fs';

/**
 * 用法：node scripts/_r212_bundle_probe.mjs [bundlePath]
 *   可选参数供变异测试指向**副本**；默认检查真实产物。
 */
const P = process.argv[2] || 'storage/plugins/@local/service-ticket/dist/client/index.js';
const s = fs.readFileSync(P, 'utf8');
console.log(`[probe] 目标产物：${P}`);

/** 中文 → esbuild 的转义形态
 *
 * ⚠️ **必须用大写 hex**。本轮在这上面连续误判三次：
 *    我按 toString(16) 的小写形态（\u65e5）去搜，结果除了「处」这种恰好大小写
 *    相同的字符之外，全部报 0 —— 一度以为"标签没进产物"。
 *    实测 esbuild 2.x 输出的是 **大写**（\u65E5）；大小写不同，搜索就是 0。
 */
function escForm(zh) {
  let out = '';
  for (const ch of zh) out += '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return out;
}

function countAll(zh) {
  const raw = s.split(zh).length - 1;
  const esc = s.split(escForm(zh)).length - 1;
  return { raw, esc, total: raw + esc };
}

/**
 * 键值对形态：label:"X" / hint:"X"（两种字符串形态都算）
 *
 * ⚠️ 这里踩过一个坑，记下来别再犯：转义形态里的反斜杠是**正文的一部分**，
 *    进正则前必须再转义一次。第一次写的时候没转义，`\u5904` 被正则当成
 *    「u5904 字面量」，于是 6 项全报 0 —— 差点把"探测脚本坏了"报成"产品坏了"。
 */
function countPair(key, zh) {
  const e = escForm(zh);
  const forms = [`"${zh}"`, `'${zh}'`, `"${e}"`, `'${e}'`];
  let n = 0;
  for (const f of forms) {
    const reSrc = `${key}\\s*:\\s*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    const re = new RegExp(reSrc, 'g');
    n += (s.match(re) || []).length;
  }
  return n;
}

/** CSS 声明计数 —— 产物里冒号后**有空格**（width: 64px），不能按无空格形态搜 */
function countDecl(decl) {
  const re = new RegExp(decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:/, '\\s*:\\s*'), 'g');
  return (s.match(re) || []).length;
}

const R = [];
function row(name, val, ok) {
  R.push({ name, val, ok });
}

console.log('=== A. 运行期数据（键值对形态，排除注释干扰）===');
row('label:"处理"', countPair('label', '处理'), countPair('label', '处理') >= 1);
row('label:"跟进"', countPair('label', '跟进'), countPair('label', '跟进') >= 1);
row('label:"审核"', countPair('label', '审核'), countPair('label', '审核') >= 1);
row('label:"详情"', countPair('label', '详情'), countPair('label', '详情') >= 1);
row('hint:"处理工单"', countPair('hint', '处理工单'), countPair('hint', '处理工单') >= 1);
row('hint:"审核师傅回执"', countPair('hint', '审核师傅回执'), countPair('hint', '审核师傅回执') >= 1);

console.log('\n=== B. 反向验证：旧 label 必须**不存在** ===');
const old1 = countPair('label', '处理工单');
const old2 = countPair('label', '审核回执');
row('label:"处理工单"（应为 0）', old1, old1 === 0);
row('label:"审核回执"（应为 0）', old2, old2 === 0);

console.log('\n=== C. CSS 等宽规则 ===');
const w64 = countDecl('width:64px');
const w64i = countDecl('min-width:64px');
const tdc = countDecl('text-align:center');
row('width: 64px', w64, w64 >= 1);
row('min-width: 64px', w64i, w64i >= 1);
row('text-align: center', tdc, tdc >= 1);
row('选择器 td [data-primary-action]', (s.split('td [data-primary-action]').length - 1), true);
// 反向：不得出现**裸**的 .ant-table-tbody .ant-btn 定宽（会波及第三方按钮）
const bare = (s.match(/\.ant-table-tbody\s+\.ant-btn\s*\{[^}]*width:\s*64px/g) || []).length;
row('裸 .ant-table-tbody .ant-btn 定宽（应为 0）', bare, bare === 0);

console.log('\n=== D. 菜单分组（两种形态合并）===');
for (const t of ['日常业务', '管理与设置', '派工记录', '工单事件时间线', '门店报修入口', '历史售后档案', '售后服务工作台', '总部售后工作台']) {
  const c = countAll(t);
  row(t, JSON.stringify(c), c.total >= 1);
}
// 4+10 的成员数必须**恰好**对得上（反向：不能把页悄悄丢出分组）
function groupSize(key) {
  // 产物里形如 { key: "daily", title: "\u65E5...", pages: [...] }
  const re = new RegExp(`key:\\s*"${key}"[\\s\\S]{0,80}?pages:\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = s.match(re);
  if (!m) return -1;
  return (m[1].match(/"/g) || []).length / 2;
}
row('daily.pages 长度 = 4', groupSize('daily'), groupSize('daily') === 4);
row('admin.pages 长度 = 10', groupSize('admin'), groupSize('admin') === 10);

console.log('\n=== E. 保护项（R2.1.1 成果不得回退）===');
for (const t of ['data-svc-col', 'data-svc-ticket-list', 'store-review']) {
  const n = s.split(t).length - 1;
  row(t, n, n >= 1);
}
const nth = s.split('nth-child(2)').length - 1;
row('nth-child(2) 工单号列旧写法（应为 0）', nth, nth === 0);

// ---- 汇总 ----
console.log('\n=== 结果 ===');
let bad = 0;
for (const r of R) {
  const tag = r.ok ? '✅' : '❌';
  if (!r.ok) bad += 1;
  const v = typeof r.val === 'object' ? JSON.stringify(r.val) : String(r.val);
  console.log(`${tag} ${r.name}  = ${v}`);
}
console.log(`\n合计 ${R.length} 项，失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
