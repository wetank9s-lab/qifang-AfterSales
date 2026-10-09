#!/usr/bin/env node
/**
 * verify-outbox-review-token-selftest.mjs —— **取评价 Token 这条判据**的 checker 自检
 * =============================================================================
 *
 * 为什么单开一份自检（而不是"改完就跑一遍验收脚本看它绿了"）
 * -----------------------------------------------------------------------------
 * 2026-10-09：`verify-store-ui-primary-action.mjs` 的"从 mock 发件箱取评价链接"红了。
 * 查下去发现**产品没错，是判据自己错了** —— 内联版本读
 * `it.content ?? it.body ?? it.text`，而发件箱条目给的是 `preview` 与 `params.link`，
 * 三个字段一个都不存在 ⇒ 恒定取到 `''` ⇒ 这条断言**永远绿不了**。
 *
 * 这正好是铁律 ⑤ 那一类：**验证器自己也会错，且错得比产品更隐蔽**。
 * 它危险在两点：
 *   ① 它长得像"产品没发评价短信"，把排障方向整个带偏；
 *   ② 只看"跑一遍绿了"是无法发现 ① 的 —— 修完当然是绿的。
 * ⇒ 所以按 DEV-76~79 之后定下的规矩，把它变成**机器免疫**：判据抽到
 *   `scripts/lib/review-token.mjs` 作为唯一实现，用**双向 fixture** 在这里钉住。
 *
 * -----------------------------------------------------------------------------
 * fixture 形态：**双向 + 真实样本 + 变异**
 * -----------------------------------------------------------------------------
 *   accept  → reviewTokenFromOutbox 必须取到 Token（应通过）
 *   reject  → 必须返回 null（应拒绝）
 *   真实样本 → 用**当天从 `svc:smsOutbox` 真抓回来**的那一整条条目（不是手编的）
 *   变异     → 用**旧的那条错误判据**去喂同一份真实样本，断言它**必然取不到**
 *             （证明这条 fixture 有牙：它真的能抓住那次错误，不是事后补的装饰）
 *   真实源码 → 断言消费方 `verify-store-ui-primary-action.mjs` **import 了共享实现**，
 *             没有再内联一份（防止"两份判据、一份在漂"）
 *
 * 为什么强制双向：只跑一边的话，"永远返回 null" 或 "永远返回某个串" 的判据
 * 都能全绿 —— 那正是假绿的标准形态（铁律 10）。
 *
 * -----------------------------------------------------------------------------
 * 用法 / 退出码
 * -----------------------------------------------------------------------------
 *   node scripts/verify-outbox-review-token-selftest.mjs
 *     → 0 全绿 / 1 有 fixture 红（**这是"验证器坏了"，不给产品结论**）
 *
 * ⚠️ 本脚本红时的读法：**先怀疑验证器，不是产品**。
 *    它证明的是"判据能不能分辨"，不是"评价短信有没有发出去"。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  REVIEW_INVITE_SCENE,
  explainMissingReviewToken,
  reviewTokenFromOutbox,
} from './lib/review-token.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 真实样本：2026-10-09 从 `GET /api/svc:smsOutbox` 真抓回来的**整条**条目
// （工单 #4111 / visit 1625 / ticket_no FW20261009-0263；**字段名与结构原样保留**）
//
// 🔴 Token **值**一律用合成串，不得把抓包里的真 Token 贴进来。
//    理由是它**不是日志，是凭据**：43 位评价 Token = 客户评价链接的明文，
//    写进这个公开仓库等于把"代该客户提交/改评价"的能力发出去
//    （`scan-commit-secrets --all` 第一轮就把我贴的真值抓出来了）。
//    而这条 fixture 需要的本来就是**形态**（字段名 + URL 形状 + 长度），不是值 ——
//    ⇒ 下面用 `'f'.repeat(43)` 构造，文件里不出现任何 43 位字面量。
//    ⚠️ 后来人不要为了"更真实"把真 Token 贴回来：那会同时破坏本文件与密钥门禁。
const SYNTHETIC_TOKEN = 'f'.repeat(43);
const REAL_OUTBOX_ITEM = {
  seq: 1,
  at: '2026-10-09T10:39:01.156Z',
  scene: 'review_invite',
  recipient_kind: 'customer',
  recipient_masked: '133****0000',
  template_code: null,
  preview:
    '【模拟通道】您的报修（FW20261009-0263）已处理完成，请点击评价：' +
    `http://localhost:8080/f/${SYNTHETIC_TOKEN}`,
  params: {
    store: '圣大家电新都店',
    label: '报修',
    ticket_no: 'FW20261009-0263',
    link: `http://localhost:8080/f/${SYNTHETIC_TOKEN}`,
  },
  accepted: true,
  biz_id: 'review_invite-4111-1625-10a91256',
};
const REAL_TOKEN = SYNTHETIC_TOKEN;

// ---------------------------------------------------------------------------
// accept / reject
// ---------------------------------------------------------------------------
const accept = [
  {
    name: '真实抓包条目（preview + params.link 都有）',
    items: [REAL_OUTBOX_ITEM],
    expect: REAL_TOKEN,
  },
  {
    name: '只有 params.link（preview 字段缺失）',
    items: [{ scene: REVIEW_INVITE_SCENE, params: { link: `https://x.cn/f/${'a'.repeat(43)}` } }],
    expect: 'a'.repeat(43),
  },
  {
    name: '只有 preview（params 字段缺失）—— 这是客户真正收到的正文',
    items: [{ scene: REVIEW_INVITE_SCENE, preview: `评价：https://x.cn/f/${'b'.repeat(43)}` }],
    expect: 'b'.repeat(43),
  },
  {
    name: '前面夹一条别的场景（正文里也有 /f/）⇒ 必须跳过，取到 review_invite 那条',
    items: [
      { scene: 'dispatch_customer', preview: `上门：https://x.cn/f/${'z'.repeat(43)}` },
      { scene: REVIEW_INVITE_SCENE, preview: `评价：https://x.cn/f/${'c'.repeat(43)}` },
    ],
    expect: 'c'.repeat(43),
  },
  {
    name: '第一条 review_invite 没链接、第二条有 ⇒ 继续往下找而不是直接判红',
    items: [
      { scene: REVIEW_INVITE_SCENE, preview: '您的报修已处理完成' },
      { scene: REVIEW_INVITE_SCENE, preview: `评价：https://x.cn/f/${'d'.repeat(43)}` },
    ],
    expect: 'd'.repeat(43),
  },
  {
    name: '兜底仍认 content/body/text（旧字段名若哪天回归，不至于再次静默恒红）',
    items: [{ scene: REVIEW_INVITE_SCENE, content: `https://x.cn/f/${'e'.repeat(43)}` }],
    expect: 'e'.repeat(43),
  },
  // ---- 按工单号认领（发件箱是**累积**的，取第一条会拿到上一次那枚 Token）----
  {
    name: '指定工单号：发件箱里有多张工单的邀请 ⇒ 只认领本工单那枚',
    items: [
      { scene: REVIEW_INVITE_SCENE, params: { ticket_no: 'FW-OLD', link: `https://x.cn/f/${'z'.repeat(43)}` } },
      { scene: REVIEW_INVITE_SCENE, params: { ticket_no: 'FW-NEW', link: `https://x.cn/f/${'g'.repeat(43)}` } },
    ],
    options: { ticketNo: 'FW-NEW' },
    expect: 'g'.repeat(43),
  },
];

const reject = [
  { name: '发件箱为空', items: [], why: '没有 review_invite' },
  { name: 'items 为 undefined（接口缺字段）', items: undefined, why: '没有 review_invite' },
  {
    name: 'review_invite 但正文与 params.link 里都没有 /f/',
    items: [{ scene: REVIEW_INVITE_SCENE, preview: '您的报修已处理完成，感谢', params: { link: '' } }],
    why: '有 invite 但无链接',
  },
  {
    name: '只有非 review_invite 场景含 /f/ ⇒ 不得拿它的 Token',
    items: [{ scene: 'dispatch_customer', preview: `上门：https://x.cn/f/${'z'.repeat(43)}` }],
    why: '只有别的场景',
  },
  {
    name: '/f/ 后只有 8 位（形态下界 20 位）⇒ 不得放行',
    items: [{ scene: REVIEW_INVITE_SCENE, preview: 'https://x.cn/f/abcd1234' }],
    why: '有 invite 但无链接',
  },
  // ---- 按工单号认领的反向侧 ----
  {
    name: '指定工单号，但发件箱里只有**别的工单**的邀请 ⇒ 不得拿走它的 Token',
    items: [
      { scene: REVIEW_INVITE_SCENE, params: { ticket_no: 'FW-OLD', link: `https://x.cn/f/${'z'.repeat(43)}` } },
    ],
    options: { ticketNo: 'FW-NEW' },
    why: '拿错工单 = 评价提交 404，而现象看起来像"产品没发短信"',
  },
  {
    name: '指定工单号，但条目**没有** ticket_no 字段 ⇒ fail-closed，不得放行',
    items: [{ scene: REVIEW_INVITE_SCENE, preview: `https://x.cn/f/${'h'.repeat(43)}` }],
    options: { ticketNo: 'FW-NEW' },
    why: '无法证明这枚 Token 属于本工单',
  },
];

// ---------------------------------------------------------------------------
// 变异：旧判据（只读 content/body/text）—— 必须证明它在真实样本上**取不到**
// ---------------------------------------------------------------------------
function legacyExtract(items) {
  for (const it of items ?? []) {
    const body = String(it?.content ?? it?.body ?? it?.text ?? '');
    const m = /\/f\/([A-Za-z0-9_-]{20,})/.exec(body);
    if (m) return m[1];
  }
  return null;
}

let failed = 0;
const lines = [];
/**
 * ⚠️ **必须即时打印**，不能先攒进数组最后统一输出。
 *    本脚本第一版就是这么写的：16 条全绿，但屏幕上一条明细都没有 ——
 *    一份"只报结论不报证据"的自检，和没有自检的差别只在于它更会让人放心。
 */
const ok = (name, detail = '') => {
  const line = `  ✓ ${name}${detail ? ` —— ${detail}` : ''}`;
  lines.push(line);
  console.log(line);
};
const no = (name, detail = '') => {
  const line = `  ✗ ${name}${detail ? ` —— ${detail}` : ''}`;
  lines.push(line);
  console.log(line);
  failed += 1;
};

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  "从发件箱取评价 Token" 判据 · checker 自检（双向 fixture）');
console.log('══════════════════════════════════════════════════════════════');

console.log('\n──── accept：必须取到 Token（判据不得"永远红"）────');
for (const c of accept) {
  const got = reviewTokenFromOutbox(c.items, c.options);
  if (got === c.expect) ok(c.name, `${String(got).slice(0, 10)}…`);
  else no(c.name, `期望 ${c.expect.slice(0, 10)}… 实得 ${got === null ? 'null' : String(got).slice(0, 10) + '…'}`);
}

console.log('\n──── reject：必须返回 null（判据不得"永远绿"）────');
for (const c of reject) {
  const got = reviewTokenFromOutbox(c.items, c.options);
  if (got === null) ok(c.name, 'null');
  else no(c.name, `期望 null，实得 ${String(got).slice(0, 10)}…`);
}

console.log('\n──── 失败原因：两种失败必须**分开报**（否则又是那句猜谜）────');
const whyNoInvite = explainMissingReviewToken([{ scene: 'dispatch_customer', preview: 'x' }]);
if (whyNoInvite.includes('没有 scene=review_invite') && whyNoInvite.includes('dispatch_customer')) {
  ok('没有 review_invite 时报出"出现的场景"', whyNoInvite);
} else {
  no('没有 review_invite 时报出"出现的场景"', whyNoInvite);
}
const whyNoLink = explainMissingReviewToken([{ scene: REVIEW_INVITE_SCENE, preview: '感谢', params: {} }]);
if (whyNoLink.includes('都没有 /f/<token>') && whyNoLink.includes('preview')) {
  ok('有 invite 但无链接时报出"条目实际字段"', whyNoLink);
} else {
  no('有 invite 但无链接时报出"条目实际字段"', whyNoLink);
}
const whyOtherTicket = explainMissingReviewToken(
  [{ scene: REVIEW_INVITE_SCENE, params: { ticket_no: 'FW-OLD', link: 'https://x.cn/f/' + 'z'.repeat(43) } }],
  { ticketNo: 'FW-NEW' },
);
if (whyOtherTicket.includes('FW-OLD') && whyOtherTicket.includes('FW-NEW')) {
  ok('按工单号取不到时报出"发件箱里有的邀请属于哪些工单"', whyOtherTicket);
} else {
  no('按工单号取不到时报出"发件箱里有的邀请属于哪些工单"', whyOtherTicket);
}

console.log('\n──── 变异：旧判据喂**真实抓包样本**，必须取不到（证明 fixture 有牙）────');
const legacyGot = legacyExtract([REAL_OUTBOX_ITEM]);
if (legacyGot === null) {
  ok(
    '旧判据（只读 content/body/text）在真实样本上取不到 Token',
    '⇒ 2026-10-09 那次红的是验证器，不是产品',
  );
} else {
  no(
    '旧判据（只读 content/body/text）在真实样本上取不到 Token',
    `实得 ${String(legacyGot).slice(0, 10)}… ⇒ 变异未生效，本条 fixture 没有牙`,
  );
}
const newGot = reviewTokenFromOutbox([REAL_OUTBOX_ITEM]);
if (newGot === REAL_TOKEN) ok('新判据在同一份真实样本上取到 Token', `${REAL_TOKEN.slice(0, 10)}…`);
else no('新判据在同一份真实样本上取到 Token', `实得 ${newGot === null ? 'null' : String(newGot).slice(0, 10) + '…'}`);

console.log('\n──── 真实源码：消费方不得再内联一份判据（防止两份实现各自漂移）────');
const consumer = path.join(ROOT, 'scripts', 'verify-store-ui-primary-action.mjs');
const src = fs.existsSync(consumer) ? fs.readFileSync(consumer, 'utf8') : '';
if (!src) {
  no('消费方存在且可读', `找不到 ${consumer}`);
} else if (src.includes("from './lib/review-token.mjs'") && src.includes('reviewTokenFromOutbox(')) {
  ok('verify-store-ui-primary-action.mjs 用的是共享实现', "import { reviewTokenFromOutbox }");
} else {
  no(
    'verify-store-ui-primary-action.mjs 用的是共享实现',
    '未 import ./lib/review-token.mjs —— 它若自己内联一份，本自检就管不住它了',
  );
}
// 内联正则是最容易复发的形态：脚本里不应再出现 /f/ 的 token 正则
const inlineRe = /\/f\/\[A-Za-z0-9_-\]\{\d+,\}/.exec(src);
if (inlineRe) {
  no('消费方没有内联 /f/ 正则', `发现 ${inlineRe[0]} —— 应改用 REVIEW_LINK_TOKEN_RE`);
} else {
  ok('消费方没有内联 /f/ 正则', '判据只有一份');
}

console.log('══════════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ✅ 通过（${accept.length + reject.length + 6} 条 fixture 全绿）`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(0);
}
console.log(`  ❌ 失败 ${failed} 条 —— **这是验证器坏了，不是产品坏了**（勿据此给产品结论）`);
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(1);
