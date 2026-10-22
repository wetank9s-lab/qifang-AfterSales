/**
 * verify-b29-rate-limit-notice.mjs —— B-29：429 不得再引导客户"重新扫码"
 *
 * 真缺陷（2026-10-19 发现）：门店入口撞 `svc_public` 限流时，页面显示
 * 「请求失败（HTTP 429）」，下面却写"请用手机扫描门店提供的报修二维码进入本页"——
 * 客户会以为二维码坏了，越扫越急。
 *
 * 本门禁分三层，且**不伪造状态码**：
 *   A. 非法签名（非 429）⇒ 仍引导重新扫码，且**不能**出现限流文案（防误报）；
 *   B. 真实打满 `svc_public`（30r/m burst 10）直到出现 **真实 429**；
 *   C. 限流窗口内打开报修页 ⇒ 文案 = "访问人数较多，请稍等"，提示 ="不需要重新扫码"，
 *      并在页面上下文里再发一次真实请求，确认此刻 HTTP 状态确实是 429。
 *
 * ⚠️ 本门禁会**真实消耗**对客限流额度（约 45 次），跑完 1~2 分钟内同 IP 的匿名接口会 429。
 *    这是故意的：不放宽阈值、不伪造响应。请把它排在其它匿名门禁之后运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(process.cwd(), '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  B-29：429 与"二维码无效"必须区分（真实状态码，不放宽限流）');
console.log('══════════════════════════════════════════════════════════════');

const entryQuery = storeEntryQuery('S01');
const goodUrl = `${BASE}/h5/report${entryQuery}`;
const badUrl = `${BASE}/h5/report?k=S01.${'A'.repeat(22)}`;

const session = await launchCdp({ port: 9495, label: 'b29-ratelimit' });
const { cdp } = session;
try {
  // ⚠️ 本门禁上一轮会把 `svc_public` 打空；若立刻重跑，A 组的"非法签名"请求
  //    会先被 429 拦住 ⇒ 页面显示限流文案 ⇒ A 组假红。
  //    nginx 的漏桶对超限请求不累积欠账，桶 10 / 速率 0.5 个每秒 ⇒ 22s 恢复满。
  //    这里固定等 25s，让 A 组一定是"非限流"场景。
  note('等待限流桶恢复', '25s（避免上一轮打空的桶污染 A 组判据）');
  await sleep(25_000);

  // ---------------------------------------------------------------- A. 非法签名
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: badUrl });
  await cdp.waitFor(`!!document.querySelector('[data-testid="entry-error"]')`, { what: '入口错误页', timeout: 40_000 });
  await sleep(300);
  const bad = await cdp.evaluate(`(() => ({
    message: (document.querySelector('[data-testid="entry-error-message"]')?.innerText || '').trim(),
    hint: (document.querySelector('[data-testid="entry-error-hint"]')?.innerText || '').trim(),
    body: document.body.innerText,
  }))()`);
  note('非法签名文案', `${bad.message} | ${bad.hint}`);
  check(bad.message.length > 0, 'A. 非法签名：有明确错误文案（不白屏）', bad.message);
  check(
    !/访问人数较多|稍等 1 分钟|429/.test(bad.message + bad.hint),
    'A. 非法签名**没有**被误报成"限流"',
    `${bad.message} | ${bad.hint}`,
  );
  check(
    /重新扫码|二维码/.test(bad.hint) || /二维码/.test(bad.body),
    'A. 非法签名仍引导重新扫码（这是正确动作）',
    bad.hint,
  );

  // ---------------------------------------------------------------- B. 真实打满
  let real429 = 0;
  let lastStatus = 0;
  const t0 = Date.now();
  for (let i = 0; i < 45; i += 1) {
    const r = await fetch(`${BASE}/api/public/store-entry?k=${encodeURIComponent('S01.' + 'B'.repeat(22))}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => ({ status: 0 }));
    lastStatus = r.status;
    if (r.status === 429) real429 += 1;
  }
  note('限流压测', `45 次请求 · 耗时 ${Date.now() - t0}ms · 429 共 ${real429} 次 · 末次 ${lastStatus}`);
  check(real429 > 0, 'B. 真实出现 HTTP 429（不是伪造的）', `429 × ${real429}`);

  // ---------------------------------------------------------------- C. 429 页面
  await cdp.send('Page.navigate', { url: goodUrl });
  await cdp.waitFor(`!!document.querySelector('[data-testid="entry-error"]')`, { what: '限流错误页', timeout: 40_000 });
  await sleep(300);
  const rl = await cdp.evaluate(`(() => ({
    message: (document.querySelector('[data-testid="entry-error-message"]')?.innerText || '').trim(),
    hint: (document.querySelector('[data-testid="entry-error-hint"]')?.innerText || '').trim(),
    hasStoreCard: !!document.querySelector('[data-testid="store-card"]'),
    retryBtn: !!document.querySelector('[data-testid="entry-retry"]'),
  }))()`);
  note('429 页面', `${rl.message} | ${rl.hint}`);
  check(/访问人数较多|稍等/.test(rl.message), 'C. 429 文案 = "访问人数较多，请稍等"', rl.message);
  check(!/HTTP 429/.test(rl.message), 'C. 不再向客户暴露「HTTP 429」这种技术文案', rl.message);
  check(/不需要重新扫码/.test(rl.hint), 'C. 提示明确"不需要重新扫码"', rl.hint);
  check(
    !/请用手机扫描门店提供的报修二维码进入本页/.test(rl.hint),
    'C. **不再**出现误导性的"请扫描二维码进入本页"',
    rl.hint,
  );
  check(rl.hasStoreCard === false, 'C. 未把限流误渲染成正常门店页', String(rl.hasStoreCard));
  check(rl.retryBtn === true, 'C. 页面提供「重试」（用户主动，不是自动重试）', String(rl.retryBtn));

  // 页面上下文里再发一次真实请求：确认此刻确实是 429（提示与状态码一致）
  const probe = await cdp.evaluate(
    `fetch('/api/public/store-entry?k=${encodeURIComponent('S01.' + 'C'.repeat(22))}').then((r) => r.status).catch(() => 0)`,
  );
  check(Number(probe) === 429, 'C. 此刻页面侧真实 HTTP 状态 = 429（提示不是凭空写的）', String(probe));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'b29-rate-limit-390.png'), Buffer.from(shot.data, 'base64'));
  note('截图', '.tmp-verify/b29-rate-limit-390.png');
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  B-29 门禁：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
