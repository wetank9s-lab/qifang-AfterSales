/**
 * verify-ux-last-order-tech-submit.mjs —— UX-LAST-ORDER-01 师傅端**真实提交闭环**门禁。
 *
 * 用严格隔离夹具走完整链路：建单 → 受理/派工（产生 technician_task 短信）→ 取师傅 Token →
 * 真实浏览器打开作业页 → 填回执并提交 → 验证完成页的本地摘要 → 旧链接失效页仍显示摘要。
 *
 * 断言：
 *   ① 提交成功后写入 `{ticketNo, completedAt}`，**不含 Token**；
 *   ② 页面「上一单已完成」摘要正确，且**不提供详情入口**；
 *   ③ 本地存储不含 Token（旧 Token 不会因本地记录复活）；
 *   ④ 无重复提交/重复短信/多余媒体会话；
 *   ⑤ 夹具仅按自身 ID 清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import {
  acceptAndDispatch,
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  envValue,
  inApp,
  PRIVATE_DIR,
  psqlRows,
  psqlScalar,
  signIn,
  tokenFromOutbox,
} from './technician-harness.mjs';

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

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-LAST-ORDER-01：师傅真实提交 → 完成摘要 → 旧链接失效页');
console.log('══════════════════════════════════════════════════════════════');

const sessionsBefore = Number(psqlScalar(`select count(*) from customer_media_sessions`) || 0);
let ticketId = 0;
let ticketNo = '';
let visitId = 0;

try {
  const admin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
  const scratch = await createScratchTicket({ tag: 'LAST-ORDER-TECH', content: '师傅完成摘要真实提交夹具' });
  ticketId = scratch.ticketId;
  ticketNo = scratch.ticketNo;
  note('夹具工单', `${ticketNo}（id=${ticketId}）`);

  await acceptAndDispatch(ticketId, admin);
  const { token } = await tokenFromOutbox({ sessionToken: admin, ticketNo });
  visitId = Number(psqlScalar(`select id from service_visits where ticket_id=${ticketId} order by id desc limit 1`) || 0);
  const smsCount0 = Number(psqlScalar(`select count(*) from sms_logs where ticket_id=${ticketId}`) || 0);
  note('visit / 派工短信', `visit=${visitId} · sms=${smsCount0}`);
  check(Boolean(token) && token.length === 43, '拿到师傅 Token（43 字符）', `${String(token).slice(0, 8)}…`);

  const session = await launchCdp({ port: 9491, label: 'ux-last-tech' });
  const { cdp } = session;
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: `https://127.0.0.1/h5/technician/visit/${encodeURIComponent(token)}` });
    await cdp.waitFor(`!!document.querySelector('form.svc-card button[type="submit"]')`, { what: '作业页', timeout: 40_000 });
    await sleep(600);

    // ── 现场照片（必填 1～3 张）────────────────────────────────────────────
    // 走**真实前端上传链路**：file input → change → POST /api/technician/visits/:token/files。
    // 不做 API 直传后刷新页面，否则"页面自己能不能传照片"就没被观测到。
    const jpegPath = path.join(OUT, 'tech-submit-scene.jpg');
    fs.writeFileSync(jpegPath, ensureFixtureJpeg());
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const found = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '.svc-photo-add input[type="file"]',
    });
    check(found.nodeId > 0, '作业页存在现场照片上传控件', `nodeId=${found.nodeId}`);
    await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [jpegPath] });

    const photoCountText = () =>
      cdp.evaluate(`(document.querySelector('.svc-count')?.innerText || '').trim()`);
    const waitPhotos = async (rounds) => {
      for (let i = 0; i < rounds; i += 1) {
        await sleep(500);
        const t = String(await photoCountText());
        if (/^[1-9]/.test(t)) return t;
      }
      return String(await photoCountText());
    };
    let countText = await waitPhotos(16);
    if (!/^[1-9]/.test(countText)) {
      // 个别 Chrome 版本 setFileInputFiles 不派发 change：手动补一次（文件已挂在 input.files 上）
      await cdp.evaluate(`(() => {
        const el = document.querySelector('.svc-photo-add input[type="file"]');
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      countText = await waitPhotos(16);
    }
    check(/^[1-9]/.test(countText), '现场照片上传成功（照片计数 ≥ 1）', `计数显示「${countText}」`);

    // 上传后确认照片确实落库（不是只有前端本地预览）
    const photoRows = Number(psqlScalar(`select count(*) from service_visit_photos where visit_id=${visitId}`) || 0);
    note('照片落库', `service_visit_photos=${photoRows}（visit=${visitId}）`);
    check(photoRows === 1, '照片真实写入 service_visit_photos（1 张）', String(photoRows));

    // 处理结果：选第一个枚举（通常是"已解决"）；处理说明按需填
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('.svc-segment.is-wrap button');
      if (btn) btn.click();
      const note = document.querySelector('#f-note');
      if (note) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(note), 'value').set;
        setter.call(note, '师傅完成摘要门禁：已处理');
        note.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
    // 是否收费是必选项（默认未选）；选「未收费」后再提交
    await cdp.evaluate(`(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const b = [...document.querySelectorAll('.svc-segment button')].find((x) => norm(x.innerText) === '未收费');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(300);
    const preSubmit = await cdp.evaluate(`document.querySelector('form.svc-card button[type="submit"]').disabled`);
    note('提交按钮是否禁用', String(preSubmit));
    await cdp.evaluate(`document.querySelector('form.svc-card button[type="submit"]').click()`);
    try {
      await cdp.waitFor(`document.body.innerText.includes('已提交') || !!document.querySelector('.svc-success')`, { what: '提交成功页', timeout: 30_000 });
    } catch (e) {
      const after = await cdp.evaluate(`document.body.innerText.slice(0, 300).split(String.fromCharCode(10)).join(' ')`);
      check(false, '提交后进入完成页', after);
      throw e;
    }
    await sleep(800);

    const done = await cdp.evaluate(`(() => {
      const raw = localStorage.getItem('svc.tech.lastDone.v1');
      return {
        raw,
        parsed: raw ? JSON.parse(raw) : null,
        successHint: !!document.querySelector('[data-testid="tech-last-done-success"]'),
        tokenInStorage: raw ? raw.indexOf(${JSON.stringify(token)}) >= 0 : false,
      };
    })()`);
    check(Boolean(done.parsed), '提交成功后写入本地完成摘要', String(done.raw).slice(0, 160));
    check(done.parsed?.ticketNo === ticketNo && Number(done.parsed?.completedAt) > 0, '摘要含 {ticketNo, completedAt}', JSON.stringify(done.parsed));
    check(
      JSON.stringify(Object.keys(done.parsed ?? {}).sort()) === '["completedAt","ticketNo"]',
      '本地存储**只有** {ticketNo, completedAt} 两个字段（无 Token/客户资料/详情响应）',
      JSON.stringify(Object.keys(done.parsed ?? {})),
    );
    check(!done.tokenInStorage, '本地存储**不含 Token**', String(done.raw).slice(0, 120));
    check(done.successHint === true, '完成页显示「上一单已完成」摘要', String(done.successHint));

    // ── 旧链接失效页 ─────────────────────────────────────────────────────
    // ⚠️ 必须**换一个浏览会话**再开旧链接。
    //    同一标签页里 `sessionStorage` 还留着 `svc.tech.submitted.<token>`
    //    （见 Visit.vue 的 load()：链接失效 + 本设备记着提交成功 ⇒ 显示"已提交"页），
    //    那是产品有意的行为，不是失效页。这里要验的是**换设备 / 新开浏览器**看旧链接。
    //    先跳到 about:blank 让 sessionStorage 随导航清掉（localStorage 仍按源保留）。
    const visitUrl = `https://127.0.0.1/h5/technician/visit/${encodeURIComponent(token)}`;
    const sameTab = await (async () => {
      await cdp.send('Page.navigate', { url: visitUrl });
      await sleep(2_500);
      return cdp.evaluate(
        `(() => ({ success: !!document.querySelector('.svc-success'), invalid: !!document.querySelector('.svc-alert.danger'), hint: !!document.querySelector('[data-testid="tech-last-done"]') }))()`,
      );
    })();
    note('同标签页重开旧链接', JSON.stringify(sameTab));
    check(
      sameTab.success === true && sameTab.hint === false,
      '同标签页重开旧链接走"已提交"页（不是失效页，也不出现失效摘要）',
      JSON.stringify(sameTab),
    );
    check(
      (await cdp.evaluate(`document.body.innerText.indexOf(${JSON.stringify(token)})`)) === -1,
      '同标签页"已提交"页不显示 Token',
    );

    // sessionStorage 是**按标签页**存活的，导航（含 about:blank）都不会清它；
    // 只有关掉标签页/换设备才会。这里显式清掉，等价于"另一台手机打开旧链接"。
    await cdp.evaluate(`(() => { sessionStorage.clear(); return true; })()`);
    const cleared = await cdp.evaluate(`sessionStorage.length`);
    check(cleared === 0, '已清空 sessionStorage（模拟换设备 / 新开浏览器）', `length=${cleared}`);

    await cdp.send('Page.navigate', { url: visitUrl });
    await cdp.waitFor(`!!document.querySelector('[data-testid="tech-last-done"]')`, { what: '失效页摘要', timeout: 30_000 });
    await sleep(500);
    const invalid = await cdp.evaluate(`(() => ({
      text: document.querySelector('[data-testid="tech-last-done"]').innerText.replace(/[ \\n\\t]+/g,' '),
      hasDetailLink: /查看详情|打开详情|历史工单详情/.test(document.body.innerText),
      tokenInStorage: (localStorage.getItem('svc.tech.lastDone.v1') || '').indexOf(${JSON.stringify(token)}) >= 0,
      tokenOnPage: document.body.innerText.indexOf(${JSON.stringify(token)}) >= 0,
      // 失效页上不能有任何"凭摘要重新进入作业/回执"的入口
      retryEntry: [...document.querySelectorAll('a,button')]
        .map((el) => (el.innerText || '').replace(/\\s+/g, ''))
        .filter((t) => /再次打开|重新进入|继续作业|查看回执|打开回执/.test(t)),
    }))()`);
    // B-30 起文案为「不提供工单详情」（纵向块布局）；正则放宽到"不提供…详情"，不绑死措辞
    check(/不提供[^。]*详情/.test(invalid.text), '新会话打开旧链接 → 失效页说明不提供详情', invalid.text.slice(0, 120));
    check(invalid.text.includes(ticketNo), '摘要显示的是本次夹具工单号', invalid.text.slice(0, 120));
    check(invalid.hasDetailLink === false, '失效页**没有**详情入口', String(invalid.hasDetailLink));
    check(invalid.tokenInStorage === false, '失效页仍未把 Token 写入本地', String(invalid.tokenInStorage));
    check(invalid.tokenOnPage === false, '失效页正文不出现 Token', String(invalid.tokenOnPage));
    check(invalid.retryEntry.length === 0, '失效页没有凭摘要"重新进入作业"的入口', JSON.stringify(invalid.retryEntry));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'tech-last-done.png'), Buffer.from(shot.data, 'base64'));
    note('截图', '.tmp-verify/tech-last-done.png');
  } finally {
    session.close();
  }

  // 副作用：只应有 1 个 visit、1 条 technician_task 短信、0 个媒体会话；无重复提交
  const smsCount = Number(psqlScalar(`select count(*) from sms_logs where ticket_id=${ticketId}`) || 0);
  const visitCount = Number(psqlScalar(`select count(*) from service_visits where ticket_id=${ticketId}`) || 0);
  const ticketStatus = String(psqlScalar(`select status from service_tickets where id=${ticketId}`) || '').trim();
  const smsAfter = Number(psqlScalar(`select count(*) from customer_media_sessions`) || 0);
  // 「无重复提交」的直接证据：提交事件本身只有 1 条（前面 visit=1/短信不增只是间接旁证）
  const submitEvents = Number(
    psqlScalar(`select count(*) from ticket_events where ticket_id=${ticketId} and event_type='technician_submitted'`) || 0,
  );
  check(submitEvents === 1, '只有 1 条 technician_submitted 事件（无重复提交）', String(submitEvents));
  check(visitCount === 1, '未产生重复派工（visit=1）', String(visitCount));
  check(smsCount === smsCount0, '未产生重复短信', `${smsCount0} → ${smsCount}`);
  check(smsAfter === sessionsBefore, '未产生媒体会话', `${sessionsBefore} → ${smsAfter}`);
  check(['WAIT_STORE_CONFIRM', 'PROCESSING'].includes(ticketStatus), '提交推进了工单状态（未破坏状态机）', ticketStatus);
} finally {
  if (ticketId > 0) {
    const snap = () => ({
      tickets: psqlScalar(`select count(*) from service_tickets where id=${ticketId}`),
      visits: psqlScalar(`select count(*) from service_visits where ticket_id=${ticketId}`),
      events: psqlScalar(`select count(*) from ticket_events where ticket_id=${ticketId}`),
      sms: psqlScalar(`select count(*) from sms_logs where ticket_id=${ticketId}`),
      photos: psqlScalar(
        `select count(*) from service_visit_photos p join service_visits v on v.id=p.visit_id where v.ticket_id=${ticketId}`,
      ),
    });
    const before = snap();
    // 清理前把照片磁盘路径抓出来，清完直接验文件也不在了（否则库里干净、盘上留垃圾）
    const keys = psqlRows(
      `select p.storage_key from service_visit_photos p join service_visits v on v.id=p.visit_id where v.ticket_id=${ticketId}`,
    ).map((r) => String(r[0]));
    cleanupTicket(ticketId);
    const left = snap();
    note('夹具清理', `${ticketNo}：${JSON.stringify(before)} → ${JSON.stringify(left)}`);
    check(
      JSON.stringify(left) === '{"tickets":"0","visits":"0","events":"0","sms":"0","photos":"0"}',
      '夹具按 ID 清理干净',
      JSON.stringify(left),
    );
    if (keys.length) {
      const still = keys.filter((k) => String(inApp(`test -f ${PRIVATE_DIR}/${k} && echo yes || echo no`).out).trim() === 'yes');
      check(still.length === 0, '夹具照片磁盘文件一并删除', `残留 ${still.length} 个`);
    }
  }
}

// ⚠️ 汇总必须留在 try/finally **之外**。
//    写在 finally 里的话，try 抛异常时它会照常打印"全部通过"——
//    看起来是绿的、退出码也可能被后面的 throw 覆盖成 1，日志却已把人骗过去了。
const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  师傅真实提交闭环：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
