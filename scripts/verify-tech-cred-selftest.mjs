/**
 * verify-tech-cred-selftest.mjs —— `lib/tech-cred.mjs` 的**双向** fixture 自检
 * =============================================================================
 * 为什么必须有这个文件（而不是"看着对就行"）
 * -----------------------------------------------------------------------------
 * 铁律 ⑤：**验证器自己也会错，且错得比产品更隐蔽**。
 * 本轮把"从发件箱取师傅凭据"从 `h5-visual-evidence.mjs` 私有函数提升为
 * `lib/tech-cred.mjs`，成为**两个消费方共用**的实现
 * （证据脚本 + 录屏脚本）。抽公共代码这一步**本身**就是风险：
 * 一旦抽错，两个脚本会**一起**错 —— 那比各错一份更难发现。
 *
 * 所以这里用 fixture 把它钉住，且**必须双向**：
 *   · 正例（必须取到）：短码形态 / 长 Token 形态 / 只有 params.code 形态；
 *   · 反例（必须取不到）：`biz_id` 属于**别的**工单（"取到最新一条"的错单）、
 *     场景不匹配、正文与结构化字段都为空。
 *
 * 🔴 只剩正例 = 没有断言。一个只会 return null 的实现在正例全绿时看不出来，
 *    而它会**只在真实链路**上表现为"产品没发短信"（本项目反复踩过这个形态）。
 *    反例才是这个 fixture 的主要价值。
 *
 * 判据：全部用例通过 ⇒ exit 0；任一不通过 ⇒ exit 1。
 *       本文件**不连数据库、不连网络**，纯函数级，可随时单独跑。
 *
 * 用法：node scripts/verify-tech-cred-selftest.mjs
 */
import { pickTechCred, techCredFromEntry, TECH_ENTRY_RE } from './lib/tech-cred.mjs';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `  —— ${detail}` : ''}`); }
};

console.log('tech-cred.mjs 双向 fixture 自检');
console.log('  被测：scripts/lib/tech-cred.mjs（师傅入口凭据解析，两个脚本共用）\n');

/* =========================================================================
 * 第 1 组 · 正例：真实形态必须取到
 * ========================================================================= */
console.log('=== 第 1 组 · 正例（真实形态，必须取到）===');

/**
 * ⚠️ 这是**实测抄下来的真实形态**（2026-11-13 本机发件箱），不是编的。
 *    短码 22 位 + `params.code`，`params.link` 不存在。
 *    `technician-harness.mjs` 那份过期实现就是死在这里。
 */
const REAL_SHORTCODE = {
  scene: 'technician_task',
  seq: 41,
  biz_id: 'technician_task-1057-2031-8f3a',
  preview: '【服务工单】周师傅您好，有一张上门服务工单待处理，请点击链接查看并处理：https://sh.scqfls.cn/p/t/gYF1M9qsbGhFbSuD4q8nyA',
  params: { code: 'gYF1M9qsbGhFbSuD4q8nyA' },
};
{
  const r = pickTechCred([REAL_SHORTCODE], { ticketId: 1057 });
  ok('① 真实短码形态（preview 带 22 位短码）必须取到',
    r?.token === 'gYF1M9qsbGhFbSuD4q8nyA',
    `实际=${JSON.stringify(r)}`);
}

// 长 Token（43 位）形态 —— nginx 两种入口都接了，实现必须都认
const LONG_TOKEN = 'Kq3vT9wZ2mXc7pLr5nBd8hFs4jGy6aVe1uNt0iQw3oPz';
{
  const it = {
    scene: 'technician_task', seq: 43, biz_id: 'technician_task-1057-2035-aa11',
    preview: `师傅您好，请点击链接查看并处理：https://sh.scqfls.cn/p/t/${LONG_TOKEN}`,
    params: { link: `https://sh.scqfls.cn/p/t/${LONG_TOKEN}` },
  };
  const r = pickTechCred([it], { ticketId: 1057 });
  ok('② 长 Token（43 位）形态也必须取到（两种入口都接）',
    r?.token === LONG_TOKEN, `实际=${JSON.stringify(r)}`);
}

// 正文被脱敏/截断，只有结构化 params.code —— 兜底路径
{
  const it = {
    scene: 'technician_task', seq: 44, biz_id: 'technician_task-1057-2036-bb22',
    preview: '【服务工单】请点击链接查看并处理：https://sh.scqfls.cn/p/t/…',
    params: { code: 'Zx9Qm2Wv7bNp4Rk8' },
  };
  const r = pickTechCred([it], { ticketId: 1057 });
  ok('③ 正文被截断时，兜底读 params.code 也取到',
    r?.token === 'Zx9Qm2Wv7bNp4Rk8', `实际=${JSON.stringify(r)}`);
}

// 多条同工单：必须取**最新**（seq 最大），否则会拿到上一轮的旧凭据
{
  const items = [
    { scene: 'technician_task', seq: 10, biz_id: 'technician_task-1057-2001-x', preview: 'https://a/p/t/OLDOLDOLDOLDOLDOLD' },
    { scene: 'technician_task', seq: 99, biz_id: 'technician_task-1057-2099-x', preview: 'https://a/p/t/NEWNEWNEWNEWNEWNEW' },
  ];
  const r = pickTechCred(items, { ticketId: 1057 });
  ok('④ 同工单多条时取 seq 最大的那条（防拿旧凭据）',
    r?.token === 'NEWNEWNEWNEWNEWNEW', `实际=${JSON.stringify(r)}`);
}

/* =========================================================================
 * 第 2 组 · 反例：必须取不到（这才是 fixture 的主要价值）
 * ========================================================================= */
console.log('\n=== 第 2 组 · 反例（必须取不到）===');

// ① 别的工单的凭据 —— 这是最危险的一种：取到就会用**别人的** Token 去上传
{
  const other = {
    scene: 'technician_task', seq: 50, biz_id: 'technician_task-9999-2033-cc33',
    preview: 'https://sh.scqfls.cn/p/t/SomeOneElsesToken1234',
    params: { code: 'SomeOneElsesToken1234' },
  };
  const r = pickTechCred([other], { ticketId: 1057 });
  ok('⑤ 别的工单的凭据必须取不到（防止拿到别人的 Token）',
    r === null, `实际=${JSON.stringify(r)}`);
}

// ② 场景不匹配
{
  const wrongScene = {
    scene: 'review_invite', seq: 51, biz_id: 'technician_task-1057-2034-dd44',
    preview: 'https://sh.scqfls.cn/p/t/ShouldNotMatchScene1',
  };
  const r = pickTechCred([wrongScene], { ticketId: 1057 });
  ok('⑥ 场景不匹配（review_invite）必须取不到',
    r === null, `实际=${JSON.stringify(r)}`);
}

// ③ biz_id 形态变了（没有 ticketId 段）—— 必须取不到，而不是"碰巧匹配上"
{
  const noId = {
    scene: 'technician_task', seq: 52, biz_id: 'technician_task',
    preview: 'https://sh.scqfls.cn/p/t/NoTicketIdSegment12',
  };
  const r = pickTechCred([noId], { ticketId: 1057 });
  ok('⑦ biz_id 里没有 ticketId 段时必须取不到（不做宽松兜底）',
    r === null, `实际=${JSON.stringify(r)}`);
}

// ④ 正文与结构化字段全空
{
  const empty = { scene: 'technician_task', seq: 53, biz_id: 'technician_task-1057-2037-ee55', preview: '', params: {} };
  const r = pickTechCred([empty], { ticketId: 1057 });
  ok('⑧ 正文与结构化字段都为空时必须取不到', r === null, `实际=${JSON.stringify(r)}`);
}

// ⑤ 空数组 / undefined
{
  ok('⑨ 空数组返回 null', pickTechCred([], { ticketId: 1057 }) === null);
  ok('⑩ undefined 输入返回 null（不抛异常）', pickTechCred(undefined, { ticketId: 1057 }) === null);
}

// ⑥ 太短的串不该被当成凭据（避免把正文里的普通短串吃进来）
{
  const shorty = {
    scene: 'technician_task', seq: 54, biz_id: 'technician_task-1057-2038-ff66',
    preview: 'https://sh.scqfls.cn/p/t/abc',
  };
  ok('⑪ 凭据短于 16 位时必须取不到（防止误吃正文里的短串）',
    techCredFromEntry(shorty) === null, `实际=${techCredFromEntry(shorty)}`);
}

/* =========================================================================
 * 第 3 组 · 形态闸（正则本身）
 * ========================================================================= */
console.log('\n=== 第 3 组 · 入口形态闸 ===');
{
  // ⚠️ 必须**不**匹配师傅入口 `?k=` 那种门店入口，也不匹配 `/p/` 进度链接
  ok('⑫ /p/t/<16+> 之外的路径不吃（/p/<token> 是客户进度页）',
    TECH_ENTRY_RE.exec('https://x/p/AbCdEfGhIjKlMnOpQrSt') === null);
  ok('⑬ /f/<token> 评价链接不吃',
    TECH_ENTRY_RE.exec('https://x/f/AbCdEfGhIjKlMnOpQrSt') === null);
}

/* ========================================================================= */
console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.log('⚠️ 这是**工具自检**失败：说明 lib/tech-cred.mjs 坏了。');
  console.log('   两个消费方（h5-visual-evidence / ux-final-record）会**一起**错，');
  console.log('   必须修 fixture 指出的那条，不得把结果当产品结论。');
  process.exit(1);
}
console.log('✅ tech-cred.mjs 双向 fixture 全绿 —— 两个消费方可以放心共用。');
