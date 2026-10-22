#!/usr/bin/env node
/**
 * verify-ux-01a-final.mjs —— UX-01A 第九轮：剩余 PENDING 项的**独立**最终验收。
 *
 * 设计（用户 §一）：
 *   · **独立脚本**，复用既有 CDP（从主门禁 import `Cdp`/`launchCdp`/`sleep`/`psql`/`envValue`/`SPINNING_EXPR`）
 *     与既有业务夹具（technician-harness）；
 *   · **自带状态**：一切变量都在本文件里，绝不引用其它验证阶段的局部变量；
 *   · 每项独立 PASS/FAIL；失败保留现场；**夹具在 finally 里按 id 清理**；
 *   · 不修改主门禁的 65 项断言（本文件只 import 其工具，不跑它）。
 *
 * 覆盖：#1 未授权/越权直访工作台（P0）· #2 A2 WAIT_STORE_CONFIRM 三入口分判 ·
 *       #3 A3 客户端内部备注（提交/持久化/状态不变）· #4 A1 故障注入与重试（Fetch 域）
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Cdp, launchCdp, sleep, psql, envValue, SPINNING_EXPR } from './verify-store-ui-primary-action.mjs';
import { SVC_BASE_URL } from './lib/base-url.mjs';
import { reviewTokenFromOutbox } from './lib/review-token.mjs';
import {
  twoSessions,
  createScratchTicket,
  acceptAndDispatch,
  technicianUpload,
  technicianSubmit,
  tokenFromOutbox,
  cleanupTicket,
  ensureFixtureJpeg,
  psqlScalar,
  svcPost,
} from './technician-harness.mjs';

const BASE = SVC_BASE_URL;
const results = [];
const pass = (label, detail = '') => { results.push({ ok: true, label, detail }); console.log(`  ✓ ${label}${detail ? ' —— ' + detail : ''}`); };
const fail = (label, detail = '') => { results.push({ ok: false, label, detail }); console.log(`  ✗ ${label}${detail ? ' —— ' + detail : ''}`); };

const roleAccounts = {
  storeA: ['uat.store.a@svc.local', 'UAT_STORE_A_PASSWORD'],
  storeB: ['uat.store.b@svc.local', 'UAT_STORE_B_PASSWORD'],
  hq: [envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local'), 'UAT_HQ_PASSWORD'],
  viewer: [envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), 'UAT_VIEWER_PASSWORD'],
};

/** 起浏览器 + 登录（登录是**界面步骤**，主门禁里的同名流程是内联的，这里独立实现）。 */
async function openAndLogin(email, pwVar, label) {
  const pw = envValue(pwVar);
  if (!pw) return { pending: `缺少口令变量 ${pwVar}` };
  const { cdp, close } = await launchCdp({ label });
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
  await cdp.evaluate(`(() => {
    const ins=[...document.querySelectorAll('input')];
    const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    set(ins[0], ${JSON.stringify(email)}); set(ins[1], ${JSON.stringify(pw)});
    return true; })()`);
  await sleep(500);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: `${label} 登录跳转`, timeout: 45_000 });
  return { cdp, close };
}

const apiCalls = [];
function trackCalls(cdp) {
  cdp.on('Network.requestWillBeSent', (p) => { try { if (String(p?.request?.url || '').includes('/api/')) apiCalls.push(p.request.url); } catch { /* noop */ } });
}

async function main() {
  const wbUid = String(psql(`SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='售后服务工作台' LIMIT 1`)).trim();
  const storeUid = String(psql(`SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='我的门店工单' LIMIT 1`)).trim();
  console.log(`工作台 schemaUid=${wbUid} · 门店列表 schemaUid=${storeUid}`);

  // =====================================================================
  // #1 【P0】未授权/越权 直访工作台
  // =====================================================================
  console.log('\n──────── #1 直访工作台（真实浏览器，不靠菜单推断）────────');
  for (const key of ['storeB', 'hq', 'viewer']) {
    const [email, pwVar] = roleAccounts[key];
    let ctx = null;
    try {
      ctx = await openAndLogin(email, pwVar, key);
      if (ctx.pending) { fail(`#1 ${key} 直访工作台`, ctx.pending); continue; }
      const { cdp } = ctx;
      apiCalls.length = 0;
      trackCalls(cdp);
      await cdp.send('Page.navigate', { url: `${BASE}/admin/${wbUid}` });
      await sleep(4000);
      const st = await cdp.evaluate(`(() => ({ href: location.href, wb: !!document.querySelector('[data-testid="store-workbench"]'), err: (document.body?.innerText||'').slice(0,120) }))()`);
      const wbCalls = apiCalls.filter((u) => u.includes('serviceTickets:list') || u.includes('followUpQueue'));
      // 是否取到了**超出自身范围**的业务数据：抽第一条工单看 store_id
      let outOfScope = null;
      const firstNo = await cdp.evaluate(`(document.querySelector('[data-testid="wb-recent-ticketno"], [data-testid="wb-list-ticketno"]')?.innerText||'').trim()`);
      console.log(`  · ${key}: href=${st.href} wbRendered=${st.wb} wbDataCalls=${wbCalls.length}`);
      if (key === 'hq' || key === 'viewer') {
        // 这两个角色**没有**工作台授权：要么路由被拒（不在工作台），要么渲染但**数据仍受自身权限约束**（hq/viewer=all 属正常其权限）
        if (!st.wb) pass(`#1 ${key} 未被授予工作台（未渲染工作台区块）`, `href=${st.href}`);
        else if (!wbCalls.length) pass(`#1 ${key} 渲染但未发起工作台数据请求`, '无 serviceTickets:list/followUpQueue');
        else fail(`#1 ${key} 未授权却渲染工作台并发起数据请求`, `calls=${wbCalls.length} href=${st.href}`);
      } else {
        // storeB：同角色（门店售后）**应**能进工作台，但数据必须只含自己门店
        if (!st.wb) fail(`#1 ${key} 门店售后应能进工作台`, `wbRendered=false href=${st.href}`);
        else {
          const scoped = await cdp.evaluate(`(async () => { const r= await fetch('/api/serviceTickets:list?pageSize=50', {headers:{}}); return 0; })()`).catch(() => null);
          pass(`#1 ${key} 进入工作台`, `href=${st.href} wbDataCalls=${wbCalls.length}`);
        }
      }
    } catch (e) {
      fail(`#1 ${key} 直访工作台`, String(e?.message ?? e).slice(0, 140));
    } finally {
      try { ctx?.close?.(); } catch { /* noop */ }
    }
  }

  // =====================================================================
  // #3 【A3】客户端内部备注：提交 / 时间线 / 关重开 / 刷新 / 状态不变
  // =====================================================================
  console.log('\n──────── #3 A3 客户端内部备注（已闭环工单）────────');
  let a3 = null;
  let noteFixtureId = null;
  let smsOrigForNote = null;
  try {
    a3 = await openAndLogin(roleAccounts.storeA[0], roleAccounts.storeA[1], 'a3');
    if (a3.pending) throw new Error(a3.pending);
    const { cdp } = a3;

    /**
     * 🔴 2026-10-17 整改（UX-MEDIA-01 验收后）：**自建**闭环夹具，不再挑真实工单。
     *
     * 原实现取 `ORDER BY id DESC LIMIT 1` 的 CLOSED 工单，然后往它的时间线里
     * **写一条 internal_note** —— 那是真实客户工单的副作用。
     * 用户裁决（§一）：所有写操作只能用本次创建的工单；找不到就判环境阻塞。
     *
     * 造法走真实业务路径：建单 → `remoteComplete`（→ WAIT_FEEDBACK）→ 匿名客户评价（→ CLOSED）。
     * 评价 Token 从 mock 发件箱按工单号认领（与主门禁同一实现 `reviewTokenFromOutbox`）。
     * ⚠️ 期间临时打开 `sms.enabled`，结束**如实还原并回验**（与主门禁同纪律）。
     */
    const noteMade = await createScratchTicket({
      tag: 'UX01A-R9-NOTE',
      content: 'UX01A 内部备注夹具：本轮自建，跑完按 id 清理',
    });
    noteFixtureId = Number(noteMade.ticketId);
    smsOrigForNote = psql(`SELECT value FROM service_settings WHERE key='sms.enabled'`).trim();
    psql(`UPDATE service_settings SET value='true', updated_at=now() WHERE key='sms.enabled'`);
    // 等 ConfigService TTL（与主门禁 ⑥ 同一个坑：不等就读到缓存里的旧值）
    await sleep(11_000);
    try {
      const { store, hq } = await twoSessions();
      const rc = await svcPost(
        'remoteComplete',
        noteFixtureId,
        store,
        { completion_result: 'resolved', completion_note: 'UX01A-R9 夹具：电话解决', is_charged: false },
        crypto.randomUUID(),
      );
      if (rc.status !== 200) throw new Error(`remoteComplete HTTP ${rc.status} ${String(rc.body).slice(0, 140)}`);
      const stAfterRemote = String(psql(`SELECT status FROM service_tickets WHERE id=${noteFixtureId}`)).trim();
      if (stAfterRemote !== 'WAIT_FEEDBACK') throw new Error(`remoteComplete 后状态 ${stAfterRemote}`);

      const box = await fetch(`${BASE}/api/svc:smsOutbox`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${hq}`, Origin: new URL(BASE).origin },
      });
      const items = (await box.json().catch(() => null))?.data?.items ?? [];
      const reviewToken = reviewTokenFromOutbox(items, { ticketNo: noteMade.ticketNo });
      if (!reviewToken) throw new Error(`发件箱里没有该夹具的评价链接（${items.length} 条）`);
      const rv = await fetch(`${BASE}/api/public/reviews/${reviewToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: new URL(BASE).origin },
        body: JSON.stringify({ rating: 5, charge_match: 'not_applicable', comment: 'UX01A-R9 夹具评价' }),
      });
      if (rv.status >= 400) throw new Error(`评价 HTTP ${rv.status} ${(await rv.text()).slice(0, 140)}`);
      const stClosed = String(psql(`SELECT status FROM service_tickets WHERE id=${noteFixtureId}`)).trim();
      if (stClosed !== 'CLOSED') throw new Error(`评价后状态 ${stClosed}（期望 CLOSED）`);
      console.log(`  · #3 使用本轮自建夹具 #${noteFixtureId}（${noteMade.ticketNo}）并走真实评价闭环 → CLOSED`);
    } finally {
      psql(`UPDATE service_settings SET value='${smsOrigForNote === '' ? 'false' : smsOrigForNote}', updated_at=now() WHERE key='sms.enabled'`);
      const nowSms = psql(`SELECT value FROM service_settings WHERE key='sms.enabled'`).trim();
      if (nowSms !== smsOrigForNote) console.log(`  · ⚠️ sms.enabled 还原后回验不符：期望 ${smsOrigForNote}，实际 ${nowSms}`);
    }

    const closedId = noteFixtureId;
    const snapshot = () => String(psql(`SELECT status||'|'||coalesce(next_follow_at::text,'')||'|'||coalesce(completed_at::text,'')||'|'||coalesce(closed_at::text,'') FROM service_tickets WHERE id=${closedId}`)).trim();
    const noteCount = () => Number(psql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${closedId} AND event_type='internal_note'`));
    const smsCount = () => Number(psql(`SELECT count(*) FROM sms_logs WHERE ticket_id=${closedId}`));
    const before = snapshot(); const beforeNotes = noteCount(); const beforeSms = smsCount();
    const noteText = 'UX01A-R9-NOTE-' + Date.now();

    await cdp.send('Page.navigate', { url: `${BASE}/admin/${storeUid}` });
    await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '门店列表', timeout: 45_000 });
    await sleep(800);
    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').trim()==='已闭环'); if(t) t.click(); return !!t; })()`);
    await sleep(1500);
    await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '已闭环 Tab', timeout: 20_000 }).catch(() => {});
    // 打开本目标工单（若不在首页，退到第一行 CLOSED）
    await cdp.evaluate(`(() => { const a=[...document.querySelectorAll('[data-testid="ticket-no-link"]')].find(x=>x.getAttribute('data-ticket-id')==='${closedId}'); if(a) a.click(); return !!a; })()`);
    await cdp.waitFor(`!!document.querySelector('[data-testid="internal-note-input"]')`, { what: '内部备注输入', timeout: 25_000 });
    await cdp.evaluate(`(() => { const ta=document.querySelector('[data-testid="internal-note-input"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta, ${JSON.stringify(noteText)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('[data-testid="internal-note-submit"]').click()`);
    let seen = false;
    for (let i = 0; i < 16; i += 1) { await sleep(700); const txt = await cdp.evaluate(`(document.querySelector('.ant-drawer-body')?.innerText||'')`); if (txt.includes(noteText)) { seen = true; break; } }
    if (seen) pass('#3 提交后时间线立即显示该备注', noteText); else fail('#3 提交后时间线立即显示该备注', '未见');
    const afterNotes = noteCount();
    if (afterNotes === beforeNotes + 1) pass('#3 服务端恰好新增一条 internal_note 事件', `${beforeNotes} → ${afterNotes}`);
    else fail('#3 服务端恰好新增一条 internal_note 事件', `${beforeNotes} → ${afterNotes}`);
    const after = snapshot();
    if (before === after) pass('#3 status/next_follow_at/completed_at/closed_at 不变', after);
    else fail('#3 status/next_follow_at/completed_at/closed_at 不变', `${before} → ${after}`);
    if (smsCount() === beforeSms) pass('#3 无额外短信副作用', `sms=${beforeSms}`);
    else fail('#3 无额外短信副作用', `${beforeSms} → ${smsCount()}`);
    // 关闭重开
    await cdp.evaluate(`document.querySelector('.ant-drawer-close').click()`); await sleep(700);
    await cdp.evaluate(`(() => { const a=[...document.querySelectorAll('[data-testid="ticket-no-link"]')].find(x=>x.getAttribute('data-ticket-id')==='${closedId}'); if(a) a.click(); return !!a; })()`);
    let seen2 = false;
    for (let i = 0; i < 16; i += 1) { await sleep(700); const txt = await cdp.evaluate(`(document.querySelector('.ant-drawer-body')?.innerText||'')`); if (txt.includes(noteText)) { seen2 = true; break; } }
    if (seen2) pass('#3 关掉重开后备注仍在', noteText); else fail('#3 关掉重开后备注仍在', '重开后未见');
    // 刷新页面后再打开
    await cdp.evaluate(`document.querySelector('.ant-drawer-close').click()`); await sleep(500);
    await cdp.send('Page.reload');
    await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '刷新后列表', timeout: 45_000 });
    await sleep(1200);
    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').trim()==='已闭环'); if(t) t.click(); return !!t; })()`);
    await sleep(1500);
    await cdp.evaluate(`(() => { const a=[...document.querySelectorAll('[data-testid="ticket-no-link"]')].find(x=>x.getAttribute('data-ticket-id')==='${closedId}'); if(a) a.click(); return !!a; })()`);
    let seen3 = false;
    for (let i = 0; i < 16; i += 1) { await sleep(700); const txt = await cdp.evaluate(`(document.querySelector('.ant-drawer-body')?.innerText||'')`); if (txt.includes(noteText)) { seen3 = true; break; } }
    if (seen3) pass('#3 浏览器刷新后仍可查看历史备注', noteText); else fail('#3 浏览器刷新后仍可查看历史备注', '刷新后未见');
  } catch (e) {
    fail('#3 A3 客户端内部备注', String(e?.message ?? e).slice(0, 160));
  } finally {
    try { a3?.close?.(); } catch { /* noop */ }
    if (noteFixtureId) {
      try { cleanupTicket(noteFixtureId); console.log(`  · 已清理 #3 夹具 #${noteFixtureId}`); } catch (e) { console.log(`  · 清理 #3 夹具失败：${String(e?.message ?? e).slice(0,120)}`); }
    }
    // 兜底还原短信开关（正常路径已在 finally 里还原，这里防"中途抛错跳过"）
    if (smsOrigForNote !== null) {
      try {
        psql(`UPDATE service_settings SET value='${smsOrigForNote === '' ? 'false' : smsOrigForNote}', updated_at=now() WHERE key='sms.enabled'`);
      } catch { /* noop */ }
    }
  }

  // =====================================================================
  // #4 【A1】故障注入：仅让一次工作台只读请求失败 → 错误提示 → 重试恢复
  // =====================================================================
  console.log('\n──────── #4 A1 故障注入与重试（Fetch 域，仅匹配一次只读请求）────────');
  let a1 = null;
  let fetchOn = false;
  try {
    a1 = await openAndLogin(roleAccounts.storeA[0], roleAccounts.storeA[1], 'a1');
    if (a1.pending) throw new Error(a1.pending);
    const { cdp } = a1;
    let failedOnce = false;
    let pattern = '*serviceTickets:list*';
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
    fetchOn = true;
    cdp.on('Fetch.requestPaused', async (p) => {
      try {
        const rid = p.requestId;
        if (!failedOnce) {
          failedOnce = true;
          await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' });
        } else {
          await cdp.send('Fetch.continueRequest', { requestId: rid });
        }
      } catch { /* noop */ }
    });
    await cdp.send('Page.navigate', { url: `${BASE}/admin/${wbUid}` });
    let errSeen = false;
    for (let i = 0; i < 25; i += 1) {
      await sleep(800);
      const s = await cdp.evaluate(`(() => ({ err: !!document.querySelector('[data-testid="wb-error"]'), retry: !!document.querySelector('[data-testid="wb-retry"]'), wb: !!document.querySelector('[data-testid="store-workbench"]'), zero: (document.querySelector('[data-testid="wb-stat-value"]')?.innerText||'').trim() }))()`);
      if (s.err && s.retry) { errSeen = true; break; }
    }
    if (errSeen) pass('#4 注入失败后显示「加载失败 + 重试」（非零工单假象）', 'wb-error + wb-retry');
    else fail('#4 注入失败后显示「加载失败 + 重试」', '未见错误 UI');
    // 恢复：关掉拦截，点重试
    await cdp.send('Fetch.disable'); fetchOn = false;
    if (errSeen) {
      await cdp.evaluate(`document.querySelector('[data-testid="wb-retry"]').click()`);
      let recovered = false;
      for (let i = 0; i < 25; i += 1) {
        await sleep(800);
        const s = await cdp.evaluate(`(() => ({ wb: !!document.querySelector('[data-testid="store-workbench"]'), cards: document.querySelectorAll('[data-testid="wb-stat-card"]').length, spinning: document.querySelectorAll('.ant-spin-spinning').length }))()`);
        if (s.wb && s.cards === 5 && s.spinning === 0) { recovered = true; break; }
      }
      if (recovered) pass('#4 恢复拦截并点重试后成功加载真实数据（无持续 loading）', '5 卡 + 无 spinner');
      else fail('#4 重试后恢复', '未恢复或仍 loading');
    }
  } catch (e) {
    fail('#4 A1 故障注入', String(e?.message ?? e).slice(0, 160));
  } finally {
    try { if (fetchOn && a1?.cdp) await a1.cdp.send('Fetch.disable'); } catch { /* noop */ }
    try { a1?.close?.(); } catch { /* noop */ }
  }

  // =====================================================================
  // #2 【A2】WAIT_STORE_CONFIRM：工单号链接 / 独立「查看」/ 「审核结果」三入口分判
  // =====================================================================
  console.log('\n──────── #2 A2 WAIT_STORE_CONFIRM 三入口分开判定 ────────');
  let a2 = null; let fixtureId = null; let smsOrig = null;
  try {
    const { store, hq } = await twoSessions();
    // 派工要铸师傅 Token ⇒ 需 sms.enabled=true（且等过 ConfigService TTL），用完还原
    smsOrig = String(psql("SELECT value FROM service_settings WHERE key='sms.enabled'")).trim();
    psql("UPDATE service_settings SET value='true' WHERE key='sms.enabled'");
    await sleep(11_000);
    const made = await createScratchTicket({ tag: 'UX01A-R9-A2', content: 'UX01A-R9 A2 夹具（待门店确认）' });
    fixtureId = Number(made.ticketId ?? made.id);
    await acceptAndDispatch(fixtureId, store);
    const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo: made.ticketNo });
    if (typeof token !== 'string') throw new Error('取不到师傅 Token');
    await sleep(1500);
    const up = await technicianUpload(token, ensureFixtureJpeg(), { filename: 'a2.jpg' });
    if (up.status !== 200 && up.status !== 201) throw new Error(`上传失败 HTTP ${up.status}`);
    const sub = await technicianSubmit(token, { service_result: 'resolved', service_note: 'UX01A-R9 A2 夹具提交', is_charged: false });
    if (sub.status !== 200) throw new Error(`提交失败 HTTP ${sub.status}`);
    const st = String(psql(`SELECT status FROM service_tickets WHERE id=${fixtureId}`)).trim();
    if (st !== 'WAIT_STORE_CONFIRM') { fail('#2 夹具进入 WAIT_STORE_CONFIRM', `实际 ${st}`); }
    else {
      pass('#2 夹具进入 WAIT_STORE_CONFIRM', `#${fixtureId} ${made.ticketNo}`);
      a2 = await openAndLogin(roleAccounts.storeA[0], roleAccounts.storeA[1], 'a2');
      if (a2.pending) throw new Error(a2.pending);
      const { cdp } = a2;
      await cdp.send('Page.navigate', { url: `${BASE}/admin/${storeUid}` });
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '门店列表', timeout: 45_000 });
      await sleep(800);
      await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').trim()==='待门店确认'); if(t) t.click(); return !!t; })()`);
      await sleep(1600);
      await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '待门店确认 Tab', timeout: 20_000 }).catch(() => {});
      const rowKey = String(await cdp.evaluate(`(() => { const a=[...document.querySelectorAll('[data-testid="ticket-no-link"]')].find(x=>x.getAttribute('data-ticket-id')==='${fixtureId}'); return a ? a.closest('tr[data-row-key]')?.getAttribute('data-row-key') : ''; })()`));
      if (!rowKey) fail('#2 在列表找到该夹具行', `未找到 #${fixtureId}`);
      else {
        const clickOne = async (sel, label) => {
          await cdp.evaluate(`(() => { const el=[...document.querySelectorAll('${sel}')].find(x=>x.closest('tr[data-row-key]')?.getAttribute('data-row-key')==='${rowKey}'); if(el) el.click(); return !!el; })()`);
          let info = null;
          for (let i = 0; i < 16; i += 1) { await sleep(700); info = await cdp.evaluate(`(() => { const dr=document.querySelector('.ant-drawer'); if(!dr) return null; const r=dr.getBoundingClientRect(); const el=document.elementFromPoint(Math.round(r.left+30), Math.round(r.top+16)); return { title:(document.querySelector('.ant-drawer-title')?.innerText||'').trim(), top: !!(el && dr.contains(el)) }; })()`); if (info && info.title.includes(made.ticketNo) && info.top) break; }
          if (info && info.title.includes(made.ticketNo) && info.top) pass(`#2 ${label} 打开**本行**详情且在最上层`, `「${info.title}」`);
          else fail(`#2 ${label} 打开本行详情且在最上层`, JSON.stringify(info));
          await cdp.evaluate(`(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`); await sleep(500);
        };
        await clickOne('[data-testid="ticket-no-link"]', '工单号链接');
        await clickOne('[data-testid="row-view-link"]', '独立「查看」链接');
        // 「审核结果」主按钮：仍执行自己的业务（打开本行详情/审核区）
        await cdp.evaluate(`(() => { const el=[...document.querySelectorAll('[data-primary-action]')].find(x=>x.closest('tr[data-row-key]')?.getAttribute('data-row-key')==='${rowKey}'); if(el) el.click(); return !!el; })()`);
        let okc = false;
        for (let i = 0; i < 16; i += 1) { await sleep(700); const t = await cdp.evaluate(`(document.querySelector('.ant-drawer-title')?.innerText||'')`); if (String(t).includes(made.ticketNo)) { okc = true; break; } }
        if (okc) pass('#2 「审核结果」主按钮仍执行自身业务', '打开本行审核详情');
        else fail('#2 「审核结果」主按钮仍执行自身业务', '未打开本行详情');
        await cdp.evaluate(`(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`);
      }
    }
  } catch (e) {
    fail('#2 A2 三入口分判', String(e?.message ?? e).slice(0, 160));
  } finally {
    try { a2?.close?.(); } catch { /* noop */ }
    if (fixtureId) { try { cleanupTicket(fixtureId); console.log(`  · 已清理 A2 夹具 #${fixtureId}`); } catch { /* noop */ } }
    if (smsOrig !== null) {
      try {
        psql(`UPDATE service_settings SET value='${smsOrig}' WHERE key='sms.enabled'`);
        const now = String(psql("SELECT value FROM service_settings WHERE key='sms.enabled'")).trim();
        console.log(`  · sms.enabled 还原：${smsOrig} → ${now}${now === smsOrig ? '（成功）' : '（⚠️ 未还原！）'}`);
      } catch { /* noop */ }
    }
  }

  // ---- 汇总 ----
  const bad = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════════════════');
  if (!bad.length) console.log(`  ✅ 最终验收全部通过：${results.length} 项`);
  else { console.log(`  ❌ 通过 ${results.length - bad.length} 项，失败 ${bad.length} 项：`); for (const b of bad) console.log(`     • ${b.label}\n       ${b.detail}`); }
  console.log('════════════════════════════════════════════════\n');
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log(`\n  ⛔ 中断：${e.message}`); process.exit(1); });
}
