/**
 * verify-ux-progress-01.mjs —— 客户进度可视化 + 派单师傅信息（UX-PROGRESS-01）
 *
 * 用**严格隔离夹具**（脚本自建的 4 张工单，跑完按 ID 删除）覆盖 12 个场景：
 *
 *   ① 刚提交未受理      ② 已受理未派工      ③ 已派工（真实师傅姓名）
 *   ④ 师傅处理中        ⑤ 师傅提交回执      ⑥ 门店确认 → 评价 → 关闭
 *   ⑦ 改派（旧师傅立即消失，新师傅正确）    ⑧ 取消（不再显示任何联系方式）
 *   ⑨ 无手机号（安全降级，不伪造号码）      ⑩ 无效/撤销/过期 Token 沿用 401
 *   ⑪ 375/390/420 真实浏览器              ⑫ 无额外工单/短信/媒体会话
 *
 * 反向验证（**本门禁必须会红**）：
 *   把 `progress-stage.currentVisit()` 改成取**最旧**一次派工（= 把历史师傅当现任），
 *   场景 ⑦ 与 ③ 的姓名断言必须变红。命令写在报告里，不在此脚本内自动执行
 *   （变异要重建插件 + 重启容器，属于发布动作，不能藏在验收里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import {
  BASE_URL,
  STORE_CODE,
  acceptAndDispatch,
  cleanupTicket,
  ensureFixtureJpeg,
  envValue,
  http,
  psqlScalar,
  signIn,
  svcPost,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
} from './technician-harness.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';

const ROOT = process.cwd();
const OUT = path.join(ROOT, '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);
const rid = () => crypto.randomUUID();

/** 匿名接口共用 `svc_public`（30r/m burst 10，对客承诺）—— 识别 429 就退避，不放宽阈值 */
async function paced(fn, label) {
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const r = await fn();
    if (r.status !== 429) return r;
    const wait = 5_000 * (attempt + 1);
    note('匿名接口被限流，退避重试', `${label}：第 ${attempt + 1} 次 → 等 ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error(`${label} 持续 429（对客限流被打满）`);
}

const payloadOf = (r) => r?.json?.data ?? r?.json ?? {};
const rawOf = (r) => String(r?.body ?? '');

async function newTicket(tag) {
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const r = await paced(
    () =>
      http(`${BASE_URL}/api/public/tickets${storeEntryQuery(STORE_CODE)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
        body: JSON.stringify({
          store_code: STORE_CODE,
          ticket_type: 'repair',
          content: `[${tag}] 进度阶段夹具（脚本自建，跑完自删）`,
          customer_name: `${tag}验收`,
          customer_mobile: mobile,
          privacy_agreed: true,
        }),
      }),
    '建单',
  );
  const data = payloadOf(r);
  if (!data.ticket_no) throw new Error(`建单失败 HTTP ${r.status} ${rawOf(r).slice(0, 200)}`);
  const ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${data.ticket_no}'`));
  if (!ticketId) throw new Error(`按 ${data.ticket_no} 反查不到 id`);
  const token = String(data.progress_token ?? '');
  if (!token) throw new Error('建单响应没有 progress_token（契约要求当场下发）');
  return { ticketId, ticketNo: data.ticket_no, token, mobile };
}

async function getProgress(token) {
  const r = await paced(
    () => http(`${BASE_URL}/api/public/progress/${encodeURIComponent(token)}`),
    '查进度',
  );
  return { status: r.status, view: payloadOf(r), raw: rawOf(r) };
}

const step = (view, key) => (view?.progress?.steps ?? []).find((s) => s.key === key) ?? null;
const stepStates = (view) => (view?.progress?.steps ?? []).map((s) => `${s.key}:${s.state}`).join(',');

/** 真实浏览器读数（页面自己渲染出来的东西，不是接口字符串） */
async function readPage(cdp, token, w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Page.navigate', {
    url: `${BASE_URL}/h5/customer/progress/${encodeURIComponent(token)}`,
  });
  await cdp.waitFor(
    `!!document.querySelector('[data-testid="progress-steps"]') || !!document.querySelector('[data-testid="progress-error"]')`,
    { what: '进度页', timeout: 40_000 },
  );
  await sleep(500);
  return cdp.evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const stageEl = q('[data-testid="progress-stage-label"]');
    return {
      stage: stageEl ? stageEl.getAttribute('data-stage') : null,
      stageLabel: stageEl ? stageEl.innerText.trim() : null,
      statusText: (q('[data-testid="progress-status-text"]')?.innerText || '').trim(),
      steps: [...document.querySelectorAll('ol[data-testid="progress-steps"] > li')].map((li) => ({
        key: li.getAttribute('data-testid'),
        state: li.getAttribute('data-state'),
        label: (li.innerText || '').trim(),
      })),
      stepTimes: [...document.querySelectorAll('[data-testid="progress-step-times"] li')].map((li) =>
        (li.innerText || '').replace(/\\s+/g, ' ').trim(),
      ),
      hasTechCard: !!q('[data-testid="progress-tech"]'),
      techName: (q('[data-testid="progress-tech-name"]')?.innerText || '').trim() || null,
      techPhone: (q('[data-testid="progress-tech-phone"]')?.innerText || '').trim() || null,
      techHint: (q('[data-testid="progress-tech-hint"]')?.innerText || '').trim() || null,
      telHrefs: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href')),
      times: {
        submitted: (q('[data-testid="time-submitted"]')?.innerText || '').trim(),
        dispatched: (q('[data-testid="time-dispatched"]')?.innerText || '').trim(),
        expected: (q('[data-testid="time-expected"]')?.innerText || '').trim(),
        arrived: (q('[data-testid="time-arrived"]')?.innerText || '').trim(),
        techSubmitted: (q('[data-testid="time-tech-submitted"]')?.innerText || '').trim(),
        storeConfirmed: (q('[data-testid="time-store-confirmed"]')?.innerText || '').trim(),
      },
      timelineRows: [...document.querySelectorAll('[data-testid="progress-timeline"] li')].map((li) => ({
        event: li.getAttribute('data-event'),
        label: ((li.querySelector('.svc-progress-t') || {}).innerText || '').trim(),
        at: ((li.querySelector('.svc-progress-at') || {}).innerText || '').trim(),
      })),
      nextAction: (q('[data-testid="progress-next-action"]')?.innerText || '').trim(),
      body: document.body.innerText,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  })()`);
}

const shots = [];
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  shots.push(file);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-PROGRESS-01：客户进度阶段 + 派单师傅信息');
console.log('══════════════════════════════════════════════════════════════');

const before = {
  tickets: Number(psqlScalar('SELECT count(*) FROM service_tickets') || 0),
  sms: Number(psqlScalar('SELECT count(*) FROM sms_logs') || 0),
  sessions: Number(psqlScalar('SELECT count(*) FROM customer_media_sessions') || 0),
};
const fixtures = [];

try {
  const admin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));

  // ══════════════════════════════════════════════════════ T1 主链
  const t1 = await newTicket('UX-PROGRESS-MAIN');
  fixtures.push(t1);
  note('主链夹具', `${t1.ticketNo}（id=${t1.ticketId}）`);

  // ---- ① 刚提交、未受理 ----
  const p1 = await getProgress(t1.token);
  check(p1.status === 200, '① 刚提交：进度接口 200', `HTTP ${p1.status}`);
  check(p1.view.progress?.stage === 'submitted', '① 阶段=submitted（待门店安排）', JSON.stringify(p1.view.progress?.stage));
  check(p1.view.technician === null, '① 无师傅资料（未派工）', JSON.stringify(p1.view.technician));
  check(step(p1.view, 'submitted')?.state === 'done' && step(p1.view, 'assigned')?.state === 'current', '① 步骤条：已提交已完成、安排师傅进行中', stepStates(p1.view));
  check(
    p1.view.progress?.steps?.filter((s) => s.at).length === 1,
    '① 只有"已提交"带真实时间（其余节点不编时间）',
    JSON.stringify(p1.view.progress?.steps?.map((s) => [s.key, s.at])),
  );
  check(p1.view.progress?.next_action?.owner === 'store', '① 下一步等门店', JSON.stringify(p1.view.progress?.next_action));

  // ---- ② 已受理、未派工 ----
  const acc = await svcPost('accept', t1.ticketId, admin, {}, rid());
  check(acc.status === 200, '② 受理成功（NEW→PROCESSING）', `HTTP ${acc.status}`);
  const p2 = await getProgress(t1.token);
  check(p2.view.progress?.stage === 'store_handling', '② 阶段=store_handling（门店处理中）', JSON.stringify(p2.view.progress?.stage));
  check(/尚未派工/.test(p2.view.progress?.status_text ?? ''), '② 状态文案明确"尚未派工"', p2.view.progress?.status_text);
  check(p2.view.technician === null, '② 仍未显示师傅', JSON.stringify(p2.view.technician));

  // ---- ③ 已派工 ----
  // ⚠️ 这里**不能**用 acceptAndDispatch：上面已经显式 accept 过，
  //    再受理一次会 409（NEW 才能受理）。直接派工（PROCESSING 可派）。
  const dis = await svcPost(
    'dispatch',
    t1.ticketId,
    admin,
    {
      technician_name: '王建国',
      technician_mobile: '13900010001',
      expected_visit_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
    },
    rid(),
  );
  check(dis.status === 200, '③ 派工成功', `HTTP ${dis.status}`);
  const visit1 = Number(psqlScalar(`SELECT id FROM service_visits WHERE ticket_id=${t1.ticketId} ORDER BY visit_no DESC LIMIT 1`) || 0);
  const p3 = await getProgress(t1.token);
  check(p3.view.progress?.stage === 'dispatched', '③ 阶段=dispatched（已派工）', JSON.stringify(p3.view.progress?.stage));
  check(p3.view.progress?.stage_label === '已派工', '③ 阶段名"已派工"', p3.view.progress?.stage_label);
  check(p3.view.technician?.name === '王建国', '③ 显示真实派工师傅姓名', JSON.stringify(p3.view.technician?.name));
  // 2026-10-19 最终业务规则：technician_mobile **就是**对客号码
  check(
    p3.view.technician?.phone === '13900010001' && p3.view.technician?.callable === true,
    '③ 显示当前 Visit 的 technician_mobile（完整、可拨）',
    JSON.stringify({ phone: p3.view.technician?.phone, callable: p3.view.technician?.callable }),
  );
  check(p3.view.technician?.contact_hint === null, '③ 有号码时不再显示"请联系门店"', JSON.stringify(p3.view.technician?.contact_hint));
  const visitMobile = String(psqlScalar(`SELECT technician_mobile FROM service_visits WHERE id=${visit1}`) || '').trim();
  check(p3.view.technician?.phone === visitMobile, '③ 号码确实来自当前 Visit 行（不是工单级冗余）', `api=${p3.view.technician?.phone} visit=${visitMobile}`);
  const ticketMobile = String(psqlScalar(`SELECT coalesce(technician_mobile,'') FROM service_tickets WHERE id=${t1.ticketId}`) || '').trim();
  note('工单级冗余号码', `ticket=${ticketMobile || '(空)'} · visit=${visitMobile}`);
  check(step(p3.view, 'assigned')?.state === 'done' && step(p3.view, 'service')?.state === 'current', '③ 步骤条：安排师傅已完成、上门服务进行中', stepStates(p3.view));
  const assignedAt = step(p3.view, 'assigned')?.at;
  const dbAssignedAt = String(psqlScalar(`SELECT assigned_at FROM service_visits WHERE id=${visit1}`) || '').trim();
  check(
    Boolean(assignedAt) && Math.abs(new Date(assignedAt).getTime() - new Date(dbAssignedAt).getTime()) <= 2000,
    '③ "安排师傅"时间是真实派工时间（与 DB 同刻，容差 2s）',
    `API=${assignedAt} DB=${dbAssignedAt}`,
  );

  // ---- 六项时间必须各自对应真实记录 ----
  const t = p3.view.progress?.times ?? {};
  const dbCreated = String(psqlScalar(`SELECT created_at FROM service_tickets WHERE id=${t1.ticketId}`) || '').trim();
  const dbExpected = String(psqlScalar(`SELECT coalesce(expected_visit_at::text,'') FROM service_visits WHERE id=${visit1}`) || '').trim();
  const near = (a, b, tol = 2000) =>
    Boolean(a) && Boolean(b) && Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= tol;
  check(near(t.submitted_at, dbCreated), '③ 提交时间 = 工单创建时间', `api=${t.submitted_at} db=${dbCreated}`);
  check(near(t.dispatched_at, dbAssignedAt), '③ 派工时间 = 当前 Visit.assigned_at', `api=${t.dispatched_at} db=${dbAssignedAt}`);
  check(Boolean(t.expected_visit_at), '③ 预约上门时间有真实来源（expected_visit_at）', String(t.expected_visit_at));
  check(near(t.expected_visit_at, dbExpected, 60_000), '③ 预约上门时间与 DB 一致', `api=${t.expected_visit_at} db=${dbExpected}`);
  check(t.arrived_at === null, '③ **实际到场时间无来源 ⇒ null**（页面显示"尚未记录"，不拿派工时间冒充）', String(t.arrived_at));
  check(t.tech_submitted_at === null && t.store_confirmed_at === null, '③ 尚未回执/确认时这两项为空（不预填）', JSON.stringify([t.tech_submitted_at, t.store_confirmed_at]));

  // 派工时间**不能**跟着门店更新时间走（反向验证 A 的常驻守卫）
  const dbUpdatedBefore = String(psqlScalar(`SELECT updated_at FROM service_tickets WHERE id=${t1.ticketId}`) || '').trim();
  psqlScalar(`UPDATE service_tickets SET updated_at = now() + interval '3 hours' WHERE id=${t1.ticketId} RETURNING id`);
  const dbUpdatedAfter = String(psqlScalar(`SELECT updated_at FROM service_tickets WHERE id=${t1.ticketId}`) || '').trim();
  const p3b = await getProgress(t1.token);
  const dispAfter = p3b.view.progress?.times?.dispatched_at;
  check(
    near(dispAfter, dbAssignedAt) &&
      Boolean(dispAfter) &&
      Math.abs(new Date(dispAfter).getTime() - new Date(dbUpdatedAfter).getTime()) > 60_000,
    '③ 派工时间**不随** ticket.updated_at 漂移（没用门店更新时间冒充）',
    `before=${dbUpdatedBefore} after=${dbUpdatedAfter} api=${dispAfter} visit.assigned_at=${dbAssignedAt}`,
  );

  // ---- 时间线：按事件渲染，且过滤内部事件 ----
  const tl = Array.isArray(p3.view.timeline) ? p3.view.timeline : [];
  check(tl.length > 0, '③ 时间线非空', `${tl.length} 条`);
  check(
    tl.every((x) => Boolean(x.event_label) && x.event_label !== x.event),
    '③ 时间线每条都有**客户可读事件名**（无空标题、不显示英文枚举）',
    JSON.stringify(tl.map((x) => [x.event, x.event_label])),
  );
  check(
    tl.every((x) => !['sms_sent', 'sms_failed', 'internal_note', 'follow_up', 'metadata_corrected'].includes(String(x.event))),
    '③ 内部事件（短信/内部备注/跟进/元数据更正）**未**出现在客户时间线',
    JSON.stringify(tl.map((x) => x.event)),
  );
  check(tl[0]?.event === 'created', '③ 时间线首条 = 工单已提交', String(tl[0]?.event));
  check(
    new Set(tl.map((x) => x.event_label)).size === tl.length,
    '③ 事件名不重复（不再出现多条"处理中"）',
    JSON.stringify(tl.map((x) => x.event_label)),
  );

  // ④ 师傅处理中（ASSIGNED = 等待上门/回执）
  // 用户定稿文案：「已安排王建国为您服务，请保持电话畅通」——**只说已安排，不说已上门**。
  check(
    /请保持电话畅通/.test(p3.view.progress?.status_text ?? '') &&
      !/已上门|已到场|已完成|已闭环/.test(p3.view.progress?.status_text ?? ''),
    '④ 状态文案=「已安排…请保持电话畅通」（不谎称已上门/已完成）',
    p3.view.progress?.status_text,
  );
  check(p3.view.progress?.next_action?.owner === 'technician', '④ 下一步等师傅', JSON.stringify(p3.view.progress?.next_action));

  // ---- ⑪ 真实浏览器三视口 ----
  const session = await launchCdp({ port: 9492, label: 'ux-progress' });
  const { cdp } = session;
  try {
    const pg390 = await readPage(cdp, t1.token, 390, 844);
    check(pg390.stage === 'dispatched', '⑪ 浏览器：阶段=已派工', `${pg390.stage}/${pg390.stageLabel}`);
    check(pg390.steps.length === 5, '⑪ 浏览器：步骤条 5 个节点', JSON.stringify(pg390.steps.map((s) => s.key)));
    check(pg390.steps.find((s) => s.key === 'progress-step-assigned')?.state === 'done', '⑪ 浏览器：安排师傅=done', JSON.stringify(pg390.steps));
    check(pg390.techName === '王建国', '⑪ 浏览器：师傅姓名正确', String(pg390.techName));
    check(pg390.techPhone === '13900010001', '⑪ 浏览器：师傅号码**完整显示**', String(pg390.techPhone));
    check(
      pg390.telHrefs.length === 1 && pg390.telHrefs[0] === 'tel:13900010001' && pg390.techPhone === '13900010001',
      '⑪ 浏览器：tel: 链接与显示号码**完全一致**',
      JSON.stringify({ tel: pg390.telHrefs, shown: pg390.techPhone }),
    );
    check(pg390.hasTechCard === true, '⑪ 浏览器：师傅卡存在', String(pg390.hasTechCard));
    check(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(pg390.times.dispatched) && pg390.times.arrived === '尚未记录',
      '⑪ 浏览器：时间卡「派工时间」有真实值、「实际到场」如实显示尚未记录',
      JSON.stringify(pg390.times),
    );
    check(
      pg390.timelineRows.length > 0 && pg390.timelineRows.every((r) => Boolean(r.label) && r.label !== r.event),
      '⑪ 浏览器：时间线每条都有事件名（无空标题）',
      JSON.stringify(pg390.timelineRows.slice(0, 6)),
    );
    check(pg390.stepTimes.length >= 2, '⑪ 浏览器：已发生节点显示真实时间', JSON.stringify(pg390.stepTimes));
    await shot(cdp, 'ux-progress-dispatched-390');

    for (const [w, h] of [[375, 812], [420, 900]]) {
      const pg = await readPage(cdp, t1.token, w, h);
      check(
        pg.scrollWidth <= pg.innerWidth && pg.steps.length === 5,
        `⑪ ${w}px：无横向滚动、5 节点不换行`,
        JSON.stringify({ scrollWidth: pg.scrollWidth, innerWidth: pg.innerWidth }),
      );
      await shot(cdp, `ux-progress-dispatched-${w}`);
    }
  } finally {
    session.close();
  }

  // ---- ⑤ 师傅提交回执 ----
  const { token: techToken } = await tokenFromOutbox({ sessionToken: admin, ticketNo: t1.ticketNo });
  const jpeg = ensureFixtureJpeg();
  const up = await technicianUpload(techToken, jpeg, { photoType: 'onsite' });
  // 上传是"创建资源"语义，服务端回 201；断言不该把 201 当失败（这是判据写窄了，不是产品问题）
  check(up.status === 200 || up.status === 201, '⑤ 师傅上传现场照片（提交前置条件）', `HTTP ${up.status}`);
  const sub = await technicianSubmit(techToken, {
    service_result: 'resolved',
    service_note: 'UX-PROGRESS-01 夹具：已处理',
    is_charged: false,
  });
  check(sub.status === 200, '⑤ 师傅提交回执成功', `HTTP ${sub.status} ${String(sub.body ?? '').slice(0, 120)}`);

  const p5 = await getProgress(t1.token);
  const ticketStatus5 = String(psqlScalar(`SELECT status FROM service_tickets WHERE id=${t1.ticketId}`) || '').trim();
  check(p5.view.progress?.stage === 'tech_submitted', '⑤ 阶段=tech_submitted（待门店确认）', JSON.stringify(p5.view.progress?.stage));
  check(p5.view.progress?.stage_label === '待门店确认', '⑤ 阶段名"待门店确认"', p5.view.progress?.stage_label);
  check(/等待门店审核/.test(p5.view.progress?.status_text ?? ''), '⑤ 状态文案"师傅已提交回执，等待门店审核"', p5.view.progress?.status_text);
  check(ticketStatus5 !== 'CLOSED' && p5.view.progress?.stage !== 'completed', '⑤ **不把回执当整单完成**', `ticket=${ticketStatus5} stage=${p5.view.progress?.stage}`);
  check(step(p5.view, 'service')?.state === 'done' && step(p5.view, 'confirm')?.state === 'current', '⑤ 步骤条：上门服务已完成、门店确认进行中', stepStates(p5.view));
  check(p5.view.technician?.role === 'current', '⑤ 师傅仍是"当前服务师傅"（不是已完成）', JSON.stringify(p5.view.technician?.role));
  const dbTechSubmitted = String(psqlScalar(`SELECT submitted_at FROM service_visits WHERE id=${visit1}`) || '').trim();
  check(
    near(p5.view.progress?.times?.tech_submitted_at, dbTechSubmitted),
    '⑤ 回执提交时间 = Visit.submitted_at（真实记录，不是页面现算）',
    `api=${p5.view.progress?.times?.tech_submitted_at} db=${dbTechSubmitted}`,
  );
  check(p5.view.progress?.times?.arrived_at === null, '⑤ 仍然没有"实际到场"记录 ⇒ null（不伪造）', String(p5.view.progress?.times?.arrived_at));

  // ---- ⑥ 门店确认 → 评价 → 关闭 ----
  const conf = await svcPost('visitConfirm', String(visit1), admin, { amount: null }, rid());
  check(conf.status === 200, '⑥ 门店确认成功', `HTTP ${conf.status} ${String(conf.body ?? '').slice(0, 120)}`);
  const p6 = await getProgress(t1.token);
  check(p6.view.progress?.stage === 'store_confirmed', '⑥ 确认后阶段=store_confirmed（待您评价）', JSON.stringify(p6.view.progress?.stage));
  check(step(p6.view, 'confirm')?.state === 'done' && step(p6.view, 'done')?.state === 'current', '⑥ 步骤条：门店确认已完成、最后一步进行中', stepStates(p6.view));
  check(p6.view.technician?.role === 'completed', '⑥ 师傅标记为"本次服务师傅"', JSON.stringify(p6.view.technician?.role));
  const dbConfirmedAt = String(psqlScalar(`SELECT store_confirmed_at FROM service_visits WHERE id=${visit1}`) || '').trim();
  check(
    near(p6.view.progress?.times?.store_confirmed_at, dbConfirmedAt),
    '⑥ 门店确认时间 = Visit.store_confirmed_at（与回执时间分开记）',
    `api=${p6.view.progress?.times?.store_confirmed_at} db=${dbConfirmedAt}`,
  );
  check(
    p6.view.progress?.times?.store_confirmed_at !== p6.view.progress?.times?.tech_submitted_at,
    '⑥ 确认时间与回执时间不是同一个值（没有被合并成一个"处理时间"）',
    JSON.stringify([p6.view.progress?.times?.tech_submitted_at, p6.view.progress?.times?.store_confirmed_at]),
  );

  const { token: reviewToken } = await tokenFromOutbox({
    sessionToken: admin,
    ticketNo: t1.ticketNo,
    scene: 'review_invite',
  }).catch(() => ({ token: '' }));
  if (reviewToken) {
    const rev = await paced(
      () =>
        http(`${BASE_URL}/api/public/reviews/${encodeURIComponent(reviewToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
          // 本夹具 `is_charged=false` ⇒ 收费核对只能选 not_applicable（服务端会 422 拒绝 match）
          body: JSON.stringify({ rating: 5, comment: 'UX-PROGRESS-01 夹具评价', charge_match: 'not_applicable' }),
        }),
      '提交评价',
    );
    check(rev.status === 200, '⑥ 客户评价提交成功（触发 CLOSED）', `HTTP ${rev.status} ${String(rev.body ?? '').slice(0, 120)}`);
    const p7 = await getProgress(t1.token);
    check(p7.view.progress?.stage === 'completed', '⑥ 评价后阶段=completed（已完成）', JSON.stringify(p7.view.progress?.stage));
    check((p7.view.progress?.steps ?? []).every((s) => s.state === 'done'), '⑥ 五个节点全部完成', stepStates(p7.view));
  } else {
    check(false, '⑥ 拿到评价邀请链接（review_invite 短信）', '发件箱里没有该工单的 review_invite');
  }

  // ══════════════════════════════════════════════════════ T2 改派
  const t2 = await newTicket('UX-PROGRESS-REASSIGN');
  fixtures.push(t2);
  note('改派夹具', `${t2.ticketNo}（id=${t2.ticketId}）`);
  await acceptAndDispatch(t2.ticketId, admin, {
    technician_name: '李国强',
    technician_mobile: '13900020002',
  });
  const pBefore = await getProgress(t2.token);
  check(pBefore.view.technician?.name === '李国强', '⑦ 改派前显示李国强', String(pBefore.view.technician?.name));

  const re = await svcPost(
    'reassign',
    t2.ticketId,
    admin,
    {
      technician_name: '赵永强',
      technician_mobile: '13900030003',
      expected_visit_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
      reason: 'UX-PROGRESS-01 夹具：改派给另一位师傅',
    },
    rid(),
  );
  check(re.status === 200, '⑦ 改派成功', `HTTP ${re.status} ${String(re.body ?? '').slice(0, 120)}`);

  const pRe = await getProgress(t2.token);
  check(pRe.view.technician?.name === '赵永强', '⑦ 改派后只显示**新**师傅', String(pRe.view.technician?.name));
  check(pRe.view.technician?.phone === '13900030003', '⑦ 改派后电话=**新**师傅号码', String(pRe.view.technician?.phone));
  check(pRe.view.technician?.visit_no === 2, '⑦ 标注第 2 次上门', String(pRe.view.technician?.visit_no));
  check(!JSON.stringify(pRe.view).includes('李国强'), '⑦ 改派后响应里**没有**旧师傅姓名');
  check(!JSON.stringify(pRe.view).includes('13900020002'), '⑦ 改派后响应里**没有**旧师傅手机号');
  check(!JSON.stringify(pRe.view).includes('13900010001'), '⑦ 不返回**其它工单**师傅的号码（跨单隔离）');
  check(pRe.view.progress?.stage === 'dispatched', '⑦ 阶段仍是已派工（未误报完成）', JSON.stringify(pRe.view.progress?.stage));

  // ══════════════════════════════════════════════════════ T3 取消
  const t3 = await newTicket('UX-PROGRESS-CANCEL');
  fixtures.push(t3);
  note('取消夹具', `${t3.ticketNo}（id=${t3.ticketId}）`);
  await acceptAndDispatch(t3.ticketId, admin, {
    technician_name: '孙志强',
    technician_mobile: '13900040004',
  });
  const pCancelBefore = await getProgress(t3.token);
  check(pCancelBefore.view.technician?.name === '孙志强', '⑧ 取消前有师傅信息', String(pCancelBefore.view.technician?.name));

  const can = await svcPost('cancel', t3.ticketId, admin, { reason: 'UX-PROGRESS-01 夹具：客户取消' }, rid());
  check(can.status === 200, '⑧ 取消成功', `HTTP ${can.status} ${String(can.body ?? '').slice(0, 120)}`);
  const pCancel = await getProgress(t3.token);
  check(pCancel.view.progress?.stage === 'cancelled', '⑧ 阶段=cancelled', JSON.stringify(pCancel.view.progress?.stage));
  check(pCancel.view.technician === null, '⑧ 取消后**不再显示**任何师傅联系方式', JSON.stringify(pCancel.view.technician));
  check(!JSON.stringify(pCancel.view).includes('13900040004'), '⑧ 取消后响应里没有师傅手机号');
  check(step(pCancel.view, 'assigned')?.state === 'todo', '⑧ 取消后未完成节点保持灰态（不假装走完）', stepStates(pCancel.view));

  // ══════════════════════════════════════════════════════ T4 无手机号（provider-only）
  const t4 = await newTicket('UX-PROGRESS-NOPHONE');
  fixtures.push(t4);
  note('无号码夹具', `${t4.ticketNo}（id=${t4.ticketId}）`);
  const dis4 = await svcPost(
    'dispatch',
    t4.ticketId,
    admin,
    {
      service_mode: 'manufacturer',
      provider_name: '海尔售后',
      expected_visit_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    },
    rid(),
  );
  check(dis4.status === 200, '⑨ 厂家代处理派工成功（无具体师傅/无手机号）', `HTTP ${dis4.status}`);
  const p9 = await getProgress(t4.token);
  check(p9.view.progress?.stage === 'dispatched', '⑨ 阶段仍是已派工', JSON.stringify(p9.view.progress?.stage));
  check(
    p9.view.technician === null || p9.view.technician?.phone === null,
    '⑨ 无手机号 ⇒ 不返回号码（安全降级）',
    JSON.stringify(p9.view.technician),
  );
  check(
    p9.view.technician === null || /请联系门店/.test(p9.view.technician?.contact_hint ?? ''),
    '⑨ 降级文案指向门店',
    JSON.stringify(p9.view.technician?.contact_hint),
  );
  check(!/\b1[3-9]\d{9}\b/.test(JSON.stringify(p9.view)), '⑨ 响应中**没有任何手机号**');

  // ══════════════════════════════════════════════════════ ⑩ Token 拒绝语义
  const bogus = 'A'.repeat(43);
  const bad = await getProgress(bogus);
  check(bad.status === 401, '⑩ 伪造 Token ⇒ 401', `HTTP ${bad.status}`);
  check(!/王建国|孙志强|李国强|赵永强|13900010001/.test(bad.raw), '⑩ 拒绝响应不泄露任何师傅资料');

  const revoke = await svcPost('revokeProgress', String(t3.ticketId), admin, { reason: 'UX-PROGRESS-01 夹具撤销' }, rid()).catch(() => null);
  if (revoke && revoke.status === 200) {
    const afterRevoke = await getProgress(t3.token);
    check(afterRevoke.status === 401, '⑩ 撤销后 Token ⇒ 401', `HTTP ${afterRevoke.status}`);
    check(!/孙志强|13900040004/.test(afterRevoke.raw), '⑩ 撤销后不泄露师傅资料');
  } else {
    // 没有该动作就退回到直接用受控 DB 写入夹具的撤销时间（只动脚本自建的这张单）
    psqlScalar(
      `UPDATE service_tickets SET progress_token_revoked_at = now() WHERE id = ${t3.ticketId} RETURNING id`,
    );
    const afterRevoke = await getProgress(t3.token);
    check(afterRevoke.status === 401, '⑩ 撤销（夹具置 revoked_at）后 Token ⇒ 401', `HTTP ${afterRevoke.status}`);
  }

  psqlScalar(
    `UPDATE service_tickets SET progress_token_expires_at = now() - interval '1 hour' WHERE id = ${t4.ticketId} RETURNING id`,
  );
  const expired = await getProgress(t4.token);
  check(expired.status === 401, '⑩ 过期 Token ⇒ 401', `HTTP ${expired.status}`);
  check(!/139000|海尔/.test(expired.raw), '⑩ 过期响应不泄露派工信息');

  // ══════════════════════════════════════════════════════ ⑫ 副作用
  const after = {
    tickets: Number(psqlScalar('SELECT count(*) FROM service_tickets') || 0),
    sms: Number(psqlScalar('SELECT count(*) FROM sms_logs') || 0),
    sessions: Number(psqlScalar('SELECT count(*) FROM customer_media_sessions') || 0),
  };
  check(
    after.tickets === before.tickets + fixtures.length,
    '⑫ 只新增了本门禁的 4 张夹具工单',
    `${before.tickets} → ${after.tickets}（+${fixtures.length}）`,
  );
  check(after.sessions === before.sessions, '⑫ 未产生媒体会话', `${before.sessions} → ${after.sessions}`);
  // "短信只增不减"等于没断言。真正要守的不变量是：**没有重复派工通知** ——
  // 每张夹具的 technician_task 条数不得超过"有手机号的派工次数"。
  const dupSms = fixtures.filter((f) => {
    const sent = Number(
      psqlScalar(`SELECT count(*) FROM sms_logs WHERE ticket_id=${f.ticketId} AND scene='technician_task'`) || 0,
    );
    const dispatches = Number(
      psqlScalar(
        `SELECT count(*) FROM service_visits WHERE ticket_id=${f.ticketId} AND technician_mobile IS NOT NULL`,
      ) || 0,
    );
    return sent > dispatches;
  });
  check(
    dupSms.length === 0,
    '⑫ 派工短信数不超过派工次数（无重复通知）',
    dupSms.map((f) => f.ticketNo).join(',') || `总短信 ${before.sms} → ${after.sms}`,
  );
} finally {
  for (const f of fixtures) {
    try {
      cleanupTicket(f.ticketId);
    } catch (error) {
      console.log(`  ⚠️ 清理 ${f.ticketNo} 失败：${error.message}`);
    }
  }
  const left = fixtures.filter(
    (f) => Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id=${f.ticketId}`) || 0) !== 0,
  );
  check(left.length === 0, '夹具按 ID 清理干净', left.map((f) => f.ticketNo).join(',') || '0 残留');
  note('截图', shots.map((s) => path.basename(s)).join(' · '));
}

// ⚠️ 汇总必须在 try/finally 之外：写在 finally 里的话，异常时也会打印"全部通过"。
const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  UX-PROGRESS-01：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
