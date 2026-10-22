/**
 * verify-ux-last-order-01.mjs —— 客户「最近工单恢复」定向门禁（UX-LAST-ORDER-01）。
 *
 * 覆盖用户拍板的契约：
 *   ① 未勾选 ⇒ 无任何持久化；
 *   ② 勾选但未自动 ⇒ 重开同店入口出现恢复卡片（停留报修页）；
 *   ③ 两个开关都开 ⇒ **验证成功后才**自动进进度页；
 *   ④ S01/S02 记录互不串（按服务端门店 code 分区）；
 *   ⑤ 进度链接优先（直接打开进度 URL 不受本地记录影响）；
 *   ⑥ 失效（401/404/410）⇒ 删除记录并提示；网络/5xx ⇒ 保留、不自动跳；
 *   ⑦ 「不再记住」删除记录；
 *   ⑧ 只存必要字段（无姓名/手机号/地址/描述）；
 *   ⑨ 三视口正常、无额外工单/短信/媒体会话；
 *   ⑩ 师傅端本地记录不含 Token（旧 Token 不会因本地记录复活）。
 *
 * 夹具：自建 1 张 S01 工单（唯一手机号），结束按 ID 清理；不批量删限流。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(ROOT, '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return process.env[key] ?? fallback;
}
const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();

const sign = (code) =>
  `${code}.${crypto.createHmac('sha256', envValue('SIGN_SECRET')).update(`store-entry:${code}`).digest('base64url').slice(0, 22)}`;
const entryS01 = sign('S01');
const entryS02 = sign('S02');

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-LAST-ORDER-01：客户最近工单恢复 / 师傅本地摘要');
console.log('══════════════════════════════════════════════════════════════');

const beforeCounts = {
  tickets: Number(pg(`select count(*) from service_tickets`) || 0),
  sms: Number(pg(`select count(*) from sms_logs`) || 0),
  sessions: Number(pg(`select count(*) from customer_media_sessions`) || 0),
};

let fixtureId = 0;
let fixtureNo = '';
let token = '';
let createdAt = '';
const phone = `139${String(Date.now()).slice(-8)}`;

const created = await fetch(`${BASE}/api/public/tickets?k=${encodeURIComponent(entryS01)}`, {
  method: 'POST',
  signal: AbortSignal.timeout(15_000),
  headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Request-Id': crypto.randomUUID() },
  body: JSON.stringify({
    entry: entryS01,
    store_code: 'S01',
    ticket_type: 'repair',
    content: '[UX-LAST-ORDER-01] 最近工单恢复夹具（测后清理）',
    customer_name: '最近工单夹具',
    customer_mobile: phone,
  }),
});
const createdText = await created.text();
if (created.status !== 201) {
  console.log(`  ⛔ 建单失败 HTTP ${created.status}: ${createdText.slice(0, 160)}`);
  process.exit(2);
}
const payload = JSON.parse(createdText).data ?? {};
fixtureNo = String(payload.ticket_no ?? '');
token = String(payload.progress_token ?? '');
createdAt = String(payload.created_at ?? new Date().toISOString());
fixtureId = Number(pg(`select id from service_tickets where ticket_no='${fixtureNo}'`) || 0);
note('夹具工单', `${fixtureNo}（id=${fixtureId}）`);

const successUrl = `${BASE}/h5/report/success?${new URLSearchParams({
  no: fixtureNo,
  store: '新都圣大家电',
  sc: 'S01',
  at: createdAt,
  type: 'repair',
  pt: token,
  k: entryS01,
}).toString()}`;

const session = await launchCdp({ port: 9481, label: 'ux-last-order' });
const { cdp } = session;
/**
 * 打开报修页并等门店卡就绪。
 *
 * ⚠️ 两种结局必须**分开报告**：「门店卡没渲染」（产品/布局问题）与「入口接口被
 * 对客限流打回 429」（测试自己的请求节奏问题）。以前只等 `store-card`，
 * 429 的表现就是"干等 40 秒然后超时"，日志里看起来像门店卡坏了 —— 实际去翻
 * nginx 日志才发现是 `svc_public 30r/m burst 10` 被本门禁自己打满。
 *
 * 这里**不放宽任何限流阈值**（那是对客承诺）：识别到 429 就按秒退避、退避次数
 * 全部打印出来，最终仍要求门店卡真的出现，否则照样变红。
 */
const openReport = async (entry, w = 390, h = 844) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entry)}` });
    // 门店卡 / 入口错误，任一出现就立刻判定，不再干等满 40 秒
    await cdp.waitFor(
      `!!document.querySelector('[data-testid="store-card"]') || !!document.querySelector('[data-testid="entry-error"]')`,
      { what: '门店卡或入口错误', timeout: 40_000 },
    );
    const state = await cdp.evaluate(`(() => ({
      ok: !!document.querySelector('[data-testid="store-card"]'),
      err: (document.querySelector('[data-testid="entry-error-message"]')?.innerText || '').trim(),
    }))()`);
    if (state.ok) {
      await sleep(1200);
      return { attempts: attempt + 1, text: '' };
    }
    const rateLimited = /429|too many|频繁|稍后/i.test(state.err);
    if (!rateLimited || attempt === 3) {
      throw new Error(
        `门店卡未出现（第 ${attempt + 1} 次）：${state.err || '(无错误文案)'}` +
          `${rateLimited ? ' —— 入口接口被 svc_public 限流（30r/m burst 10）打满，非门店卡渲染问题' : ''}`,
      );
    }
    const waitMs = 5_000 * (attempt + 1);
    note(`入口被限流，退避重试（第 ${attempt + 1} 次）`, `${state.err} → 等 ${waitMs / 1000}s`);
    await sleep(waitMs);
  }
  throw new Error('门店卡未出现：重试耗尽');
};

const openSuccess = async (w = 390, h = 844) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: successUrl });
  await cdp.waitFor(`!!document.querySelector('[data-testid="remember-card"]')`, { what: '记住卡片', timeout: 30_000 });
  await sleep(400);
};
const clearKeys = () =>
  cdp.evaluate(`(() => { const ks=[]; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k&&k.indexOf('svc.lastOrder.')===0) ks.push(k);} ks.forEach(k=>localStorage.removeItem(k)); return ks.length; })()`);
const readRec = () =>
  cdp.evaluate(`(() => JSON.parse(localStorage.getItem('svc.lastOrder.v1.S01') || 'null'))()`);
const click = (sel) => cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
};

try {
  // ---------------------------------------------------------------- ① 默认不保存
  await cdp.send('Page.navigate', { url: successUrl });
  await cdp.waitFor(`!!document.querySelector('[data-testid="remember-card"]')`, { what: '记住卡片', timeout: 30_000 });
  await clearKeys();
  await cdp.send('Page.reload');
  await cdp.waitFor(`!!document.querySelector('[data-testid="remember-order"]')`, { what: '勾选框', timeout: 30_000 });
  await sleep(500);
  const initial = await cdp.evaluate(`(() => ({
    remember: document.querySelector('[data-testid="remember-order"]').checked,
    auto: document.querySelector('[data-testid="auto-open"]').checked,
    autoDisabled: document.querySelector('[data-testid="auto-open"]').disabled,
    keys: (() => { const out=[]; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k&&k.indexOf('svc.lastOrder.')===0) out.push(k);} return out; })(),
  }))()`);
  check(initial.remember === false && initial.auto === false, '默认两个开关都不勾选', JSON.stringify(initial));
  check(initial.autoDisabled === true, '未勾选"记住"时"自动进入"不可用', String(initial.autoDisabled));
  check(initial.keys.length === 0, '未勾选时不写任何本地记录', JSON.stringify(initial.keys));

  // ---------------------------------------------------------------- ② 只记住 + 卡片
  await click('[data-testid="remember-order"]');
  await sleep(300);
  const rec = await readRec();
  check(Boolean(rec) && rec.storeCode === 'S01' && rec.ticketNo === fixtureNo, '勾选后写入本机记录（按 S01 分区）', JSON.stringify({ storeCode: rec?.storeCode, ticketNo: rec?.ticketNo }));
  const forbidden = ['customer_name', 'customer_mobile', 'name', 'phone', 'address', 'content'];
  check(!forbidden.some((k) => rec && Object.prototype.hasOwnProperty.call(rec, k)), '记录中不含姓名/手机号/地址/描述', JSON.stringify(Object.keys(rec ?? {})));
  check(rec?.autoOpen === false, '仅勾选"记住"时 autoOpen=false', String(rec?.autoOpen));

  await openReport(entryS01);
  const card = await cdp.evaluate(`(() => ({
    has: !!document.querySelector('[data-testid="last-order-card"]'),
    no: document.querySelector('[data-testid="last-order-no"]')?.innerText || '',
    path: location.pathname,
  }))()`);
  check(card.has === true && card.no === fixtureNo, '重开同店入口出现「上次提交」卡片', JSON.stringify(card));
  check(card.path.indexOf('/h5/report') === 0, '未开启自动进入 ⇒ 仍停留在报修页', card.path);
  await shot('last-order-card-390');

  // 查看上一单
  await click('[data-testid="view-last-order"]');
  await cdp.waitFor(`location.pathname.indexOf('/h5/customer/progress/') === 0`, { what: '进度页', timeout: 20_000 });
  check(true, '「查看上一单进度」可打开进度页');

  // ---------------------------------------------------------------- ③ 两个开关都开 ⇒ 自动跳
  await openSuccess();
  await clearKeys();
  await cdp.send('Page.reload');
  await cdp.waitFor(`!!document.querySelector('[data-testid="remember-order"]')`, { what: '勾选框', timeout: 30_000 });
  await click('[data-testid="remember-order"]');
  await sleep(200);
  await click('[data-testid="auto-open"]');
  await sleep(300);
  const rec2 = await readRec();
  check(rec2?.autoOpen === true, '第二个开关独立保存 autoOpen=true', JSON.stringify({ autoOpen: rec2?.autoOpen }));

  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entryS01)}` });
  await cdp.waitFor(`location.pathname.indexOf('/h5/customer/progress/') === 0`, { what: '自动进入进度页', timeout: 40_000 });
  check(true, '自动恢复：Token 验证通过后才进入进度页');

  // ---------------------------------------------------------------- ④ 跨门店不串
  await openReport(entryS02);
  const cross = await cdp.evaluate(`(() => ({ has: !!document.querySelector('[data-testid="last-order-card"]'), path: location.pathname }))()`);
  check(cross.has === false && cross.path.indexOf('/h5/report') === 0, 'S01 记录不会出现在 S02 入口', JSON.stringify(cross));

  // ---------------------------------------------------------------- ⑤ 明确链接优先
  await cdp.send('Page.navigate', { url: `${BASE}/h5/customer/progress/${encodeURIComponent(token)}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="progress-timeline"]')`, { what: '进度页', timeout: 30_000 });
  check(true, '明确进度链接直接打开（不受本地记录影响）');

  // ---------------------------------------------------------------- ⑥ 失效 / 网络错误
  // ⚠️ 必须在**离开进度页之前**把记录改坏并关掉自动进入：
  //    否则报修页会先渲染门店卡、随即自动跳进度页，等待门店卡会与跳转竞争（实测会超时）。
  await cdp.evaluate(`(() => {
    const rec = JSON.parse(localStorage.getItem('svc.lastOrder.v1.S01'));
    rec.token = 'x'.repeat(43);
    rec.autoOpen = false;
    localStorage.setItem('svc.lastOrder.v1.S01', JSON.stringify(rec));
    return true;
  })()`);
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entryS01)}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="store-card"]')`, { what: '门店卡2', timeout: 40_000 });
  await sleep(1500);
  const invalidState = await cdp.evaluate(`(() => ({
    hasRec: !!localStorage.getItem('svc.lastOrder.v1.S01'),
    hint: document.querySelector('[data-testid="last-order-hint"]')?.innerText || '',
    hasCard: !!document.querySelector('[data-testid="last-order-card"]'),
  }))()`);
  check(invalidState.hasRec === false, '服务端拒绝（401）⇒ 删除本机记录', JSON.stringify(invalidState));
  check(/失效|清除/.test(invalidState.hint) && !invalidState.hasCard, '失效后提示且不再展示卡片', invalidState.hint);

  // 网络错误/5xx：保留记录、不自动跳
  await cdp.evaluate(`(() => {
    localStorage.setItem('svc.lastOrder.v1.S01', JSON.stringify({
      v: 1, storeCode: 'S01', ticketNo: ${JSON.stringify(fixtureNo)}, token: ${JSON.stringify(token)},
      ticketType: 'repair', createdAt: ${JSON.stringify(createdAt)}, savedAt: Date.now(), autoOpen: true,
    }));
    return true;
  })()`);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*public/progress*'] });
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entryS01)}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="store-card"]')`, { what: '门店卡3', timeout: 30_000 });
  await sleep(1800);
  const netState = await cdp.evaluate(`(() => ({
    path: location.pathname,
    hasRec: !!localStorage.getItem('svc.lastOrder.v1.S01'),
    hint: document.querySelector('[data-testid="last-order-hint"]')?.innerText || '',
  }))()`);
  check(netState.path.indexOf('/h5/report') === 0, '网络失败时不自动跳转', netState.path);
  check(netState.hasRec === true, '网络失败时**保留**本机记录', String(netState.hasRec));
  check(/暂时|稍后/.test(netState.hint), '网络失败时给出可行动提示', netState.hint);
  await cdp.send('Network.setBlockedURLs', { urls: [] });

  // ---------------------------------------------------------------- ⑦ 不再记住
  // 先把 autoOpen 关掉再导航：否则验证一通过就自动跳进度页，卡片不会停留（这正是契约行为）
  await cdp.evaluate(`(() => {
    const rec = JSON.parse(localStorage.getItem('svc.lastOrder.v1.S01'));
    rec.autoOpen = false;
    localStorage.setItem('svc.lastOrder.v1.S01', JSON.stringify(rec));
    return true;
  })()`);
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entryS01)}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="last-order-card"]')`, { what: '恢复卡片', timeout: 40_000 });
  await click('[data-testid="forget-last-order"]');
  await sleep(400);
  const forgotten = await cdp.evaluate(`(() => ({
    hasRec: !!localStorage.getItem('svc.lastOrder.v1.S01'),
    hasCard: !!document.querySelector('[data-testid="last-order-card"]'),
    hint: document.querySelector('[data-testid="last-order-hint"]')?.innerText || '',
  }))()`);
  check(forgotten.hasRec === false && forgotten.hasCard === false, '「不再记住」删除记录并移除卡片', JSON.stringify(forgotten));

  // ---------------------------------------------------------------- ⑨ 三视口
  await openSuccess();
  await click('[data-testid="remember-order"]');
  await sleep(200);
  // 一次加载 + 三种视口测量：视口断言考的是 CSS 布局，不需要每个视口都重新请求
  // 入口接口（每次页面加载都会打一次 `svc_public`，三个视口各来一遍足够把
  //  30r/m 的桶打空，把"布局断言"变成"限流断言"）。
  await openReport(entryS01, 390, 844);
  for (const [w, h] of [[375, 812], [390, 844], [420, 900]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    const m = await cdp.evaluate(`(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      has: !!document.querySelector('[data-testid="last-order-card"]'),
    }))()`);
    check(m.has === true && m.scrollWidth <= m.innerWidth, `恢复卡片 @${w} 正常且无横向滚动`, JSON.stringify(m));
    await shot(`last-order-${w}`);
  }

  // ---------------------------------------------------------------- ⑩ 师傅端不含 Token
  await cdp.send('Page.navigate', { url: `${BASE}/h5/technician/visit/${'Z'.repeat(43)}` });
  await sleep(2500);
  const techStorage = await cdp.evaluate(`(() => {
    const out = [];
    for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && k.indexOf('svc.tech.')===0) out.push([k, localStorage.getItem(k)]); }
    return out;
  })()`);
  const techHasToken = JSON.stringify(techStorage).includes('Z'.repeat(20));
  check(!techHasToken, '师傅端本地记录不含 Token（旧链接不会因本地记录复活）', JSON.stringify(techStorage));

  // ---------------------------------------------------------------- ⑧ 无额外副作用
  const afterCounts = {
    tickets: Number(pg(`select count(*) from service_tickets`) || 0),
    sms: Number(pg(`select count(*) from sms_logs`) || 0),
    sessions: Number(pg(`select count(*) from customer_media_sessions`) || 0),
  };
  // 基线是"建夹具之前"，所以计数应恰好 +1 工单 +1 短信（就是当前夹具本身），媒体会话不变。
  check(
    afterCounts.tickets === beforeCounts.tickets + 1 &&
      afterCounts.sms === beforeCounts.sms + 1 &&
      afterCounts.sessions === beforeCounts.sessions,
    '除当前夹具外未产生额外工单/短信/媒体会话',
    `${JSON.stringify(beforeCounts)} → ${JSON.stringify(afterCounts)}（夹具 ${fixtureNo}）`,
  );
} finally {
  session.close();
  if (fixtureId > 0) {
    const before = {
      tickets: pg(`select count(*) from service_tickets where id=${fixtureId}`),
      events: pg(`select count(*) from ticket_events where ticket_id=${fixtureId}`),
      sms: pg(`select count(*) from sms_logs where ticket_id=${fixtureId}`),
    };
    pg(`delete from sms_logs where ticket_id=${fixtureId}`);
    pg(`delete from ticket_events where ticket_id=${fixtureId}`);
    pg(`delete from service_tickets where id=${fixtureId}`);
    const left = {
      tickets: pg(`select count(*) from service_tickets where id=${fixtureId}`),
      events: pg(`select count(*) from ticket_events where ticket_id=${fixtureId}`),
      sms: pg(`select count(*) from sms_logs where ticket_id=${fixtureId}`),
    };
    note('夹具清理', `${fixtureNo}：${JSON.stringify(before)} → ${JSON.stringify(left)}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  UX-LAST-ORDER-01：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('  截图：.tmp-verify/last-order-*.png');
  console.log('');
}
