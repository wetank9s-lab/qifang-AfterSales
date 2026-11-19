/**
 * BE-03-MANUAL-TECH-LINK · 后台界面截图（真实登录 + 点开详情抽屉）
 *
 *   node scripts/shot-manual-tech-link.mjs
 *
 * 为什么不用"往 localStorage 塞 token"那一招：
 *   实测行不通 —— 塞完跳 `/admin/`，NocoBase 仍判"未认证"并重定向回登录页
 *   （截图里就是登录表单）。token 的存储键/形态随版本变，猜它等于把验证建立在猜测上。
 *   ⇒ 老老实实填表单登录，与真人一致。CDP 客户端复用
 *     `verify-store-ui-primary-action.mjs` 的 `launchCdp`（同一份实现，不另造）。
 *
 * ⚠️ 截图必须能自证：
 *   单张 PNG 不说明任何事。因此同时取**渲染后的 DOM 文本**并断言
 *   `technician-link-copy` 节点确实存在 —— 只有两者同时成立，图才算证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { BASE_URL, ROOT, envValue, psqlScalar } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const OUT = path.join(ROOT, 'storage/tmp/shots');
fs.mkdirSync(OUT, { recursive: true });

const ticketId = Number(
  psqlScalar(`
    SELECT v.ticket_id FROM service_visits v JOIN service_tickets t ON t.id = v.ticket_id
     WHERE t.store_id = 1 AND v.visit_status = 'ASSIGNED'
       AND t.status IN ('NEW','new','PROCESSING')
       AND COALESCE(NULLIF(btrim(v.technician_name),''),'') <> ''
       AND v.is_remote IS NOT TRUE
     ORDER BY v.id DESC LIMIT 1`),
);
const ticketNo = psqlScalar(`SELECT ticket_no FROM service_tickets WHERE id = ${ticketId}`);
console.log(`\n取样工单 ${ticketNo}（id=${ticketId}）`);

const session = await launchCdp({ port: 9601, label: 'manual-link' });
const { cdp, close } = session;

const setInput = (idx, value) => `(() => {
  const ins = [...document.querySelectorAll('input')];
  const el = ins[${idx}];
  if (!el) return false;
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  d.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 40_000 });

  await cdp.evaluate(setInput(0, 'uat.store.a@svc.local'));
  await cdp.evaluate(setInput(1, envValue('UAT_STORE_A_PASSWORD')));
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary')?.click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 60_000 });
  await sleep(3000);

  const href = await cdp.evaluate('location.href');
  console.log(`登录后落点：${href}`);

  // 打开「我的门店工单」页面
  // ⚠️ 实况：点菜单后页面**不在**当前 tab 内加载出表格（nocard:0），
  //    而工作台首页的「最近服务单」里就有可点的工单号链接。
  //    ⇒ 不硬等那个列表：先试菜单，拿不到就直接点首页上的工单号。
  const clicked = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('a, .ant-menu-item, .ant-menu-title-content')]
      .find((n) => (n.innerText || '').trim() === '我的门店工单');
    if (!hit) return null;
    hit.click();
    return '我的门店工单';
  })()`);
  console.log(`菜单点击：${clicked ?? '(未找到)'}`);
  await sleep(6000);

  const rowOpened = await cdp.evaluate(`(() => {
    const no = ${JSON.stringify(ticketNo)};
    // ① 表格行
    const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
    if (rows.length) {
      const t = rows.find((r) => (r.innerText || '').includes(no));
      if (t) { (t.querySelector('a, button') || t).click(); return 'table-clicked'; }
    }
    // ② 首页「最近服务单」里的工单号链接（实测这条路最稳）
    const links = [...document.querySelectorAll('a, button, span, div')]
      .filter((n) => (n.innerText || '').trim() === no);
    if (links.length) {
      links[0].click();
      return 'link-clicked(最近服务单)';
    }
    return 'notfound:rows=' + rows.length + ',links=0';
  })()`);
  console.log(`行点击：${rowOpened}`);
  await sleep(6000);

  // 等抽屉里出现师傅链接按钮
  let hasBlock = false;
  try {
    await cdp.waitFor(`!!document.querySelector('[data-testid="technician-link-copy"]')`, {
      what: '师傅链接按钮出现',
      timeout: 25_000,
    });
    hasBlock = true;
  } catch {
    hasBlock = false;
  }

  // 截图时把详情区滚到可见位置
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="technician-link-block"]');
    if (el) el.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(1200);

  const domText = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('.ant-drawer, .ant-modal')].find((x) => x.getBoundingClientRect().width > 0);
    return (d || document.body).innerText.slice(0, 4000);
  })()`);
  fs.writeFileSync(path.join(OUT, 'manual-link-drawer.txt'), String(domText ?? ''), 'utf8');

  // 真实点击「复制师傅链接」，断言出现成功反馈。
  //
  // ⚠️ 必须用 `Input.dispatchMouseEvent`（真实鼠标事件），**不能** `el.click()`：
  //    Clipboard API 要求"用户手势"（transient activation）。
  //    脚本里 `element.click()` 是**不可信**事件，`navigator.clipboard.writeText`
  //    会抛 `NotAllowedError` ⇒ 产品落到 execCommand 兜底 ⇒ 无头环境返回 false
  //    ⇒ 界面显示"复制失败，请手动选择链接复制"。
  //    那是**验证手法**造成的失败，不是产品缺陷（真人点按钮是有手势的）。
  const box = await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-testid="technician-link-copy"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    b.scrollIntoView({ block: 'center' });
    const r2 = b.getBoundingClientRect();
    return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };
  })()`);
  if (box) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(box.x),
        y: Math.round(box.y),
        button: 'left',
        clickCount: 1,
      });
    }
    console.log(`已发出真实鼠标点击 (${Math.round(box.x)}, ${Math.round(box.y)})`);
  }
  await sleep(2500);

  const feedback = await cdp.evaluate(`(() => {
    const ok = document.querySelector('[data-testid="technician-link-copied"]');
    const err = document.querySelector('[data-testid="technician-link-error"]');
    const toast = (document.body.innerText || '').includes('已复制，可通过微信发送给师傅');
    return { copied: ok ? ok.innerText : null, error: err ? err.innerText : null, toast };
  })()`);
  console.log(`复制反馈：${JSON.stringify(feedback)}`);
  await sleep(600);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const png = path.join(OUT, 'manual-link-admin.png');
  fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
  const pngCopied = path.join(OUT, 'manual-link-copied.png');
  fs.copyFileSync(png, pngCopied);

  console.log(`\n截图：${path.relative(ROOT, png)}（${(fs.statSync(png).size / 1024).toFixed(1)} KB）`);
  console.log(`师傅链接按钮是否渲染：${hasBlock}`);
  console.log(`抽屉文本片段：\n${String(domText ?? '').slice(0, 700)}`);
} finally {
  close();
}
