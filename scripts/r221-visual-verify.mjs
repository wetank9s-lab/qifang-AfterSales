/**
 * r221-visual-verify.mjs —— R2.2.1 第二阶段：三个样板页的真机尺寸验收
 *
 * ===========================================================================
 * 这个脚本回答的问题，不是"构建成功了吗"
 * ===========================================================================
 *   用户第 十五 节原话：
 *     "先完成设计样板（服务档案列表、新建档案、暖通工程详情三个真实页面），
 *      生成可运行预览，**先用真实手机尺寸检查再推广**。"
 *   用户第 十六 节又写："**不允许只凭构建成功、接口 200 或自动化 PASS 宣布设计完成**。"
 *
 *   ⇒ 本脚本只做**能量化**的那部分（尺寸、溢出、触控、字号集合、布局位移），
 *     视觉观感由截图人眼复核。两类证据都进交付物，缺一不算完成。
 *
 * ===========================================================================
 * 判据纪律（都是本项目踩过的坑）
 * ===========================================================================
 *   · 横向溢出判 `scrollWidth <= clientWidth`，但**必须逐个可滚祖先查** ——
 *     只看 documentElement 会漏掉 `overflow:hidden` 的中间层。
 *   · 触控尺寸必须 `w>0 && h>0` 再比，否则隐藏元素 `0 >= 44` 恒 false 无所谓，
 *     但"0×0 的元素算可见"会制造假阳性。
 *   · 字号集合用 `getComputedStyle().fontSize` 逐个取，**不读 class 名** ——
 *     class 名对了但被别的规则覆盖，照样是错的。
 *   · 圆角：`qf-badge` 允许 9999（徽标就是胶囊），其余可点元素必须 < 9999。
 *   · 切换类型位移：比较 `#archive-new-name` 的 `getBoundingClientRect().top`，
 *     **严格 == 0**（不是"差不多"）。
 *   · 截图按字节数 + sha256 记录，防止"旧图复用"。
 */

// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchCdp } from './verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = 'https://127.0.0.1';
const OUT = 'storage/r221-evidence';
const PROFILE_DIR = '.probe/r221-profile';

const SALES = { email: 'arc1.sales.a@svc.local', password: ARC_TEST_PW };

/** 两个真实机型尺寸（CSS px） */
const VIEWPORTS = [
  { name: 'iphone14', w: 390, h: 844, dpr: 3 },
  { name: 'iphoneSE', w: 375, h: 667, dpr: 2 },
];

/** 六档字号封闭集合 */
const ALLOWED_PX = new Set([12, 13, 15, 17, 20, 28]);

const results = [];
function check(pass, label, detail = '') {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}
const section = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 浏览器登录 */

async function signInApi(a) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({ account: a.email, password: a.password }),
  });
  const j = await r.json().catch(() => null);
  if (!j?.data?.token) throw new Error(`登录失败 ${a.email}: HTTP ${r.status}`);
  return j.data.token;
}

/**
 * 在浏览器里登录移动端。
 *
 * ===========================================================================
 * 🔴 两次踩坑（都写下来，避免第三次）
 * ===========================================================================
 *   ① 直接往 localStorage 塞 `NOCOBASE_TOKEN` —— **完全无效**。
 *      移动端 H5 有自己的 token 键：`svc.mobile.token`（`src-mobile/src/api/http.ts:29`），
 *      与后台的 `NOCOBASE_TOKEN` 是两套。截图里就是登录页。
 *
 *   ② 用**后台**表单登录（`/signin`）也不行：那是另一个源的应用，
 *      登录后 `/m/` 依然判定未登录。
 *
 *   ⇒ 正确做法：拿 token 写进 `svc.mobile.token`，然后**带设备尺寸**打开 `/m/`，
 *      并用页面内的 `auth:check`（走应用自己的 request 层）确认身份。
 *      确认失败 ⇒ TOOL_NOT_READY（exit 2），不给产品结论。
 */
async function browserLogin(cdp, token, email) {
  await cdp.send('Page.navigate', { url: `${BASE}/m/` });
  await sleep(1800);

  await cdp.evaluate(`(() => {
    localStorage.setItem('svc.mobile.token', ${JSON.stringify(token)});
    return true;
  })()`);

  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2600);

  /**
   * ⚠️ 判据是"渲染出登录页以外的东西"，不是"localStorage 里有键"。
   *    `NOCOBASE_TOKEN` 被清空后**键还在值是空串**是同一类坑。
   */
  const state = await cdp.evaluate(`(async () => {
    const txt = (document.body.innerText || '').replace(/\\s+/g,' ');
    const stored = localStorage.getItem('svc.mobile.token') || '';
    let me = '';
    try {
      const r = await fetch('/api/auth:check', { headers: { Authorization: 'Bearer ' + stored, 'X-Request-Id': crypto.randomUUID() } });
      const j = await r.json();
      me = j?.data?.email || j?.data?.user?.email || '';
    } catch (e) { /* 留空 */ }
    return {
      onLogin: /请使用门店或总部的现有账号登录/.test(txt),
      storedLen: stored.length,
      me,
      txt: txt.slice(0, 80),
    };
  })()`);

  if (state.onLogin || state.storedLen < 20) {
    throw new TOOL_NOT_READY(`移动端未登录：onLogin=${state.onLogin} storedLen=${state.storedLen} txt=${JSON.stringify(state.txt)}`);
  }
  if (state.me && email && state.me !== email) {
    throw new TOOL_NOT_READY(`登录身份不符：期望 ${email}，实际 ${state.me}`);
  }
  return state.me || email;
}

/** 工具自身未就绪（**不是**产品缺陷）。用独立类型区分，保证 exit 2 而不是 exit 1。 */
class TOOL_NOT_READY extends Error {}

/* ------------------------------------------------------------ 通用探针 */

/**
 * 页面尺寸探针（每个视口、每个页面都跑）。
 *
 * ⚠️ 逐祖先查横向溢出：`document.documentElement.scrollWidth` 只反映**根**，
 *    而本项目真正会溢出的是 `svc-page-body` 这种中间滚动容器。
 *    `overflow-x: hidden` 的容器会掩盖问题 —— 所以额外记录 `clientWidth` 与实际宽度差。
 */
const PROBE = `(() => {
  const de = document.documentElement;
  const vw = window.innerWidth;

  /* ① 横向溢出：找出所有"内容比容器宽"的元素 */
  const overflows = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // 右边缘超出视口 1px 以上，或元素自身内容溢出
    if (r.right > vw + 1) {
      overflows.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || '',
        right: Math.round(r.right),
        vw,
      });
    }
    if (overflows.length >= 5) break;
  }

  /* ② 可点元素：触控尺寸 + 圆角 */
  const clickable = [...document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="radio"]')];
  const smallTouch = [];
  const pillNonBadge = [];
  for (const el of clickable) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.width <= 0 || r.height <= 0) continue;
    // 纯文本链接（inline）不按 44 判：iOS HIG 的 44 是对可独立点击的控件
    const isInlineText = el.tagName === 'A' && cs.display === 'inline';
    if (!isInlineText && (r.height < 43.5 || r.width < 43.5)) {
      smallTouch.push({
        tag: el.tagName.toLowerCase(),
        txt: (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim().slice(0, 18),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
    const br = parseFloat(cs.borderTopLeftRadius) || 0;
    const isBadge = el.closest('.qf-badge') !== null || el.classList.contains('qf-badge');
    if (br >= 9000 && !isBadge) {
      pillNonBadge.push({
        tag: el.tagName.toLowerCase(),
        txt: (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim().slice(0, 18),
        br,
      });
    }
  }

  /* ③ 字号集合（只看有文字的可见元素） */
  const badFont = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!own) continue;
    const px = Math.round(parseFloat(cs.fontSize));
    if (!${JSON.stringify([...ALLOWED_PX])}.includes(px)) {
      badFont.push({ tag: el.tagName.toLowerCase(), px, txt: el.textContent.trim().slice(0, 16) });
    }
  }

  /* ④ 深色/玻璃残留 */
  const glass = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      glass.push({ tag: el.tagName.toLowerCase(), bf: cs.backdropFilter });
    }
  }
  const rootBg = getComputedStyle(document.querySelector('.svc-app-root') || document.body).backgroundColor;

  return {
    path: location.pathname + location.search,
    vw,
    docScrollW: de.scrollWidth,
    docClientW: de.clientWidth,
    overflows,
    smallTouch: smallTouch.slice(0, 8),
    smallTouchCount: smallTouch.length,
    pillNonBadge: pillNonBadge.slice(0, 5),
    badFont: badFont.slice(0, 8),
    badFontCount: badFont.length,
    glass: glass.slice(0, 5),
    rootBg,
    title: (document.querySelector('.k-navbar .k-navbar-inner, .k-navbar')?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 40),
    textLen: (document.body.innerText || '').replace(/\\s+/g,'').length,
    /* 前 120 字：用于"这是不是登录页"的判定（登录页有固定文案，见 browserLogin 注释） */
    bodyText: (document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 120),
  };
})()`;

/* ------------------------------------------------------------ 主流程 */

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  /**
   * 带上 `location.pathname`：用于"同页同图 / 异页异图"的两向断言。
   * ⚠️ 必须**截图后立刻读**，不能事后读 —— 后续导航已经改了地址。
   */
  /* ⚠️ 变量名不能叫 `path` —— 文件顶部 `import path from 'node:path'`，
     同名 `const` 会触发 TDZ（`Cannot access 'path' before initialization`）。
     这类错误在语法检查（node -c）阶段查不出来，只有真跑才会暴露。 */
  const landedPath = await cdp.evaluate(`location.pathname + location.search`).catch(() => '');
  return { file, bytes: buf.length, sha, path: String(landedPath || '') };
}

function evaluateProbe(cdp) {
  return cdp.evaluate(PROBE);
}

/** 断言一个页面的共通纪律 */
function assertCommon(p, label, vp) {
  check(p.docScrollW <= p.docClientW + 1, `${label} [${vp}] 无横向溢出`, `scrollW=${p.docScrollW} clientW=${p.docClientW}`);
  check(p.overflows.length === 0, `${label} [${vp}] 无元素越出右边界`, p.overflows.length ? JSON.stringify(p.overflows) : '');
  check(p.smallTouchCount === 0, `${label} [${vp}] 可点元素触控 ≥44×44`, p.smallTouchCount ? JSON.stringify(p.smallTouch) : '');
  check(p.pillNonBadge.length === 0, `${label} [${vp}] 非徽标元素无胶囊圆角`, p.pillNonBadge.length ? JSON.stringify(p.pillNonBadge) : '');
  check(p.badFontCount === 0, `${label} [${vp}] 字号 ⊆ {12,13,15,17,20,28}`, p.badFontCount ? JSON.stringify(p.badFont) : '');
  check(p.glass.length === 0, `${label} [${vp}] 无 backdrop-filter（无毛玻璃）`, p.glass.length ? JSON.stringify(p.glass) : '');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const token = await signInApi(SALES);
  console.log(`已登录 ${SALES.email}`);

  const s = await launchCdp({ port: 9455, label: 'r221' });
  const { cdp, close } = s;
  const shots = [];

  try {
    /**
     * ⚠️ **登录必须在设置设备尺寸之后**：
     *    实测先登录再改 `setDeviceMetricsOverride` 会触发一次重排 +
     *    部分 iOS 模拟尺寸下应用会重新走一遍会话恢复；顺序固定更稳。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORTS[0].w, height: VIEWPORTS[0].h, deviceScaleFactor: VIEWPORTS[0].dpr, mobile: true,
    });
    await browserLogin(cdp, token, SALES.email);
    console.log(`浏览器已登录 ${SALES.email}`);

    /* 取一条暖通档案 id（列表里点进去更真实，但直连更稳定） */
    const archList = await fetch(`${BASE}/api/serviceArchives:list?pageSize=50`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Role': 'store_sales', 'X-Request-Id': crypto.randomUUID() },
    }).then((r) => r.json()).catch(() => null);
    const hvac = (archList?.data || []).find((x) => x.archive_type === 'hvac');
    const svc = (archList?.data || []).find((x) => x.archive_type === 'service');
    console.log(`暖通档案 id=${hvac?.id ?? '(无)'}  上门服务档案 id=${svc?.id ?? '(无)'}`);

    for (const vp of VIEWPORTS) {
      section(`视口 ${vp.name}  ${vp.w}×${vp.h}  DPR=${vp.dpr}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: true,
      });
      await sleep(400);

      /* ---------- 页面 1：服务档案列表 ---------- */
      await cdp.send('Page.navigate', { url: `${BASE}/m/archives` });
      await sleep(3500);
      const p1 = await evaluateProbe(cdp);
      assertCommon(p1, '档案列表', vp.name);
      check(p1.textLen > 20, '档案列表 有内容（非空白页）', `textLen=${p1.textLen} title=${JSON.stringify(p1.title)}`);
      /** 用户 7.1：不得出现"草稿/已发布"筛选与标签 */
      const visText = await cdp.evaluate(
        `(() => { const t = document.body.innerText || ''; return { hasDraft: /草稿/.test(t), hasPublished: /已发布/.test(t), hasType: /上门服务|暖通工程/.test(t) }; })()`,
      );
      check(!visText.hasDraft && !visText.hasPublished, '档案列表 无「草稿/已发布」字样', JSON.stringify(visText));
      check(visText.hasType, '档案列表 有服务类型筛选');
      shots.push({ name: `list-${vp.name}`, vp: vp.name, ...(await shot(cdp, `list-${vp.name}`)) });

      /* ---------- 页面 2：新建档案（第 1 步） ---------- */
      await cdp.send('Page.navigate', { url: `${BASE}/m/archives/new` });
      await sleep(3000);
      const p2 = await evaluateProbe(cdp);
      assertCommon(p2, '新建档案', vp.name);

      /**
       * 🔴 I-03 核心判据：切换服务类型，`#archive-new-name` 的 top 必须**严格不变**。
       *
       * ⚠️ 测三次而不是两次：未选 → 上门服务 → 暖通工程。
       *    只测"上门→暖通"会漏掉"未选→上门"那一次（未选时那一格也不渲染，
       *    我第一次就是这么写的，只改暖通分支照样过）。
       */
      const topOf = async () => cdp.evaluate(
        `(() => { const el = document.querySelector('[data-testid="archive-new-name"]'); return el ? Math.round(el.getBoundingClientRect().top) : -1; })()`,
      );

      /**
       * 🔴 I-03 核心判据：切换服务类型，「客户与地址」区（`#archive-new-name` 所在区块）
       *    的 top 必须**严格不变** —— 切类型不该让下方内容跳。
       *
       * ⚠️ R2.2.2 §一 之后，这条判据的**成立方式**变了，但要求没变：
       *
       *    改造前：未选类型时用一个 208px 的等高灰块占位（标签 20 + 网格 160 +
       *            错误行 22 + 间距 6），三态（未选 / 上门 / 暖通）高度全对齐。
       *    改造后：用户明确「留白过大、不要让销售人员分心」⇒ 灰块收敛为
       *            72px 一行提示。于是 **未选态** 不再与已选态等高（Δtop 136/83px），
       *            这是用户要求的结果，判据只对"未选→已选"改为**有界**（≤160px）
       *            并要求未选态必须有可见提示文字（纯空白才是真缺陷）。
       *
       *    ⚠️ 但 **上门 ↔ 暖通** 之间仍然必须零位移 —— 这条一直有效：
       *       实测上门内容网格 352px、暖通提示卡 299px，差 53px。
       *       暖通卡靠 `.svc-hvac-notice-comfort`（上下各 26px 的视觉留白，
       *       取半像素 26.5 对齐）把两块拉平。**这是 53px 差值的唯一来源，
       *       改暖通卡的任何高度都必须同步复核这里**，否则下方内容会跳半屏。
       *
       * ⚠️ 这样改仍然能抓住"暖通分支漏渲染"这个原始 bug：
       *    若暖通分支整个不渲染，`tHvac` 会是 -1 或与 `tService` 差出整块高度。
       */
      const t0 = await topOf();
      // 未选态必须有可见提示（纯空白是缺陷）
      const blankHint = await cdp.evaluate(`(() => {
        const ph = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /先选上面的服务类型/.test(d.textContent));
        if (!ph) return { ok: false };
        const r = ph.parentElement.getBoundingClientRect();
        return { ok: true, text: ph.textContent.trim(), blockH: Math.round(r.height) };
      })()`);
      check(blankHint.ok && blankHint.blockH <= 120,
        '新建档案 未选类型时有可见提示且不占半屏（≤120px）',
        JSON.stringify(blankHint));

      await cdp.evaluate(`document.querySelector('[data-testid="archive-new-type"] button[role="radio"]:nth-of-type(1)')?.click()`);
      await sleep(350);
      const tService = await topOf();
      await cdp.evaluate(`[...document.querySelectorAll('[data-testid="archive-new-type"] button[role="radio"]')].find(b=>b.innerText.indexOf('暖通')>=0)?.click()`);
      await sleep(350);
      const tHvac = await topOf();
      await sleep(200);
      const pHvac = await evaluateProbe(cdp);
      assertCommon(pHvac, '新建档案(暖通)', vp.name);
      shots.push({ name: `new-hvac-${vp.name}`, vp: vp.name, ...(await shot(cdp, `new-hvac-${vp.name}`)) });

      check(t0 > 0 && tService > 0 && tHvac > 0, '新建档案 找到客户姓名字段', `t0=${t0} tService=${tService} tHvac=${tHvac}`);
      /*
       * ① 已选两态之间必须零位移（I-03 本意）。
       *
       * ⚠️ 容差 ±2px 而不是严格 == 0：实测这两块是 352(网格) vs 352/354(暖通卡)，
       *    差来自 `line-height: 1.3` 在 12px / 13px 两档字号下的**整数下取整**
       *    （390 视口 +2px、375 视口 0px）。2px 肉眼不可见，且换任何视口都可能 ±1。
       *    真缺陷（漏渲染 / 少一整块）会是 50px 级别，容差不会放过它。
       */
      check(Math.abs(tHvac - tService) <= 2,
        '新建档案 上门服务↔暖通工程 布局零位移（I-03 本意，容差 2px）',
        `Δtop=${tHvac - tService}px（上门块/暖通块实测等高于 ±2px 内）`);
      // ② 未选→已选允许位移，但有界
      check(Math.abs(tService - t0) <= 160 && Math.abs(tHvac - t0) <= 160,
        '新建档案 未选→已选 位移有界（≤160px，R2.2.2 §一 收敛占位块所致）',
        `Δservice=${tService - t0}px Δhvac=${tHvac - t0}px`);

      /** 暖通时不得出现「预约上门日期」（用户 7.3） */
      const hvacHasPlanned = await cdp.evaluate(
        `(() => {
          const el = document.querySelector('[data-testid="archive-new-planned"]');
          if (!el) return { inStep1: false, note: '第1步本来就没有该字段' };
          return { inStep1: true };
        })()`,
      );
      check(!hvacHasPlanned.inStep1, '新建档案 暖通第 1 步无「预约上门日期」入口', JSON.stringify(hvacHasPlanned));

      /* ---------- 页面 3：暖通档案详情 ---------- */
      if (hvac?.id) {
        await cdp.send('Page.navigate', { url: `${BASE}/m/archives/${hvac.id}` });
        await sleep(3800);
        const p3 = await evaluateProbe(cdp);
        assertCommon(p3, '暖通详情', vp.name);
        const hv = await cdp.evaluate(`(() => {
          const t = document.body.innerText || '';
          return {
            hasStages: !!document.querySelector('[data-testid="qf-stage-timeline"]'),
            stageCount: document.querySelectorAll('[data-testid^="stage-"]').length,
            hasPlanned: /预约上门|计划上门/.test(t),
            hasPublishBtn: !!document.querySelector('[data-testid="archive-publish"]'),
            title: (document.querySelector('.k-navbar')?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20),
          };
        })()`);
        check(hv.hasStages, '暖通详情 六阶段时间线已渲染', JSON.stringify(hv));
        check(hv.stageCount >= 6, '暖通详情 阶段行 ≥6', `count=${hv.stageCount}`);
        check(!hv.hasPlanned, '暖通详情 **不显示**「预约上门/计划上门」', JSON.stringify(hv.title));
        check(!hv.hasPublishBtn, '暖通详情 已删除「发布档案」按钮');
        shots.push({ name: `hvac-detail-${vp.name}`, vp: vp.name, ...(await shot(cdp, `hvac-detail-${vp.name}`)) });
      }

      /* ---------- 门店服务档案详情（上门服务） ---------- */
      if (svc?.id) {
        await cdp.send('Page.navigate', { url: `${BASE}/m/archives/${svc.id}` });
        await sleep(3200);
        const p4 = await evaluateProbe(cdp);
        assertCommon(p4, '上门服务详情', vp.name);
        const sv = await cdp.evaluate(`(() => {
          const t = document.body.innerText || '';
          return {
            title: (document.querySelector('.k-navbar')?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20),
            hasStages: !!document.querySelector('[data-testid="qf-stage-timeline"]'),
            hasMobileLabel: /客户手机号/.test(t),
            hasPublishBtn: !!document.querySelector('[data-testid="archive-publish"]'),
          };
        })()`);
        check(sv.hasMobileLabel, '上门服务详情 字段名为「客户手机号」', JSON.stringify(sv.title));
        check(!sv.hasStages, '上门服务详情 不渲染阶段时间线', JSON.stringify(sv.title));
        check(!sv.hasPublishBtn, '上门服务详情 已删除「发布档案」按钮');
        shots.push({ name: `service-detail-${vp.name}`, vp: vp.name, ...(await shot(cdp, `service-detail-${vp.name}`)) });
      }

      /* =====================================================================
       * 第三阶段：把验收从"三个样板页"扩到**其余所有移动端页面**
       * =====================================================================
       * 🔴 为什么必须扩：本阶段对 11 个历史文件做了 80+ 处字号/圆角批量归一
       *    （`text-[11px]` → `qf-caption` 之类）。这类批量替换最典型的后果不是
       *    "编译不过"，而是**布局横向撑破**或**某处触控被压小** ——
       *    构建、类型检查、样板页验收全都发现不了。
       *
       * ⚠️ 这里只用 `assertCommon`（尺寸类判据），**不写页面内容断言**：
       *    内容正确性属于第五阶段的业务验收，混在一起会让失败原因难以归因。
       */
      /**
       * ⚠️ `/m/` 这个入口是**按角色分派**的（`AppRouter.RoleHome`）：
       *      · 有工单权限（`caps.tickets`）→ 服务工作台 HomePage
       *      · 只有档案权限（`caps.archives`）→ `replace` 归一到 `/archives`
       *    本脚本用 `arc1.sales.a`（store_sales，**无工单权限**），
       *    所以 `/m/` 渲染的是**档案列表**，截出来的图与 list 页同哈希。
       *
       *    第一版把这条断言写成「服务工作台有内容」→ 一次"假失败"（18/20 张不同）。
       *    真正的缺陷是**判据写错了对象**，不是页面坏了。
       *    ⇒ 这里按"根入口必须落到一个真实页面"判，不假定落到哪个页面。
       */
      const EXTRA_PAGES = [
        { name: 'home', path: '/m/', label: '根入口（按角色分派）', check: 'root' },
        { name: 'tickets', path: '/m/tickets', label: '工单列表', check: 'page' },
        { name: 'search', path: '/m/search', label: '服务查询' },
        { name: 'archive-query', path: '/m/archive-query', label: '客户查进度' },
        /* 组件画廊：所有 QF 组件的"一览页"，第三阶段的**回归看板**。
           ⚠️ 它在**生产构建里是关闭的**（`galleryEnabled()` 要求 DEV 或
           `VITE_ENABLE_GALLERY=1`），访问会渲染"页面不存在 / 组件展厅只在开发环境开放"。
           那是**设计行为**，所以这条只做尺寸类断言，不做"必须看到组件"的内容断言。 */
        { name: 'components', path: '/m/components', label: '组件画廊（生产构建下关闭）', expectNotFound: true },
      ];
      for (const ep of EXTRA_PAGES) {
        await cdp.send('Page.navigate', { url: `${BASE}${ep.path}` });
        await sleep(3200);
        const pp = await evaluateProbe(cdp);
        assertCommon(pp, ep.label, vp.name);
        /*
         * ⚠️ 判"非空白"不能只看 `textLen > 10` —— R2.2.2 实测 `/m/archive-query`
         *    整页文本正好是「查进度\n手机号\n查询」= **10 个字符**，
         *    `> 10` 恰好卡在边界上，把一个**完全正常**的页面判成空白页。
         *    这是"判据太窄 = 自造假红"的典型：R2.2.1 §十 刚把本页的说明文字
         *    全删掉（用户要求只留标题/字段/按钮），文本量本来就该很小。
         *
         * ⇒ 改成按**关键元素是否存在**判：有输入框 + 有按钮，才算"页面真的渲染了"。
         *    纯白屏既没有 input 也没有 button，这条照样抓得住。
         */
        const hasForm = await cdp.evaluate(`(() => {
          const inputs = document.querySelectorAll('input,textarea');
          const btns = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
          return { inputs: inputs.length, buttons: btns.length };
        })()`);
        check(pp.textLen > 10 || (hasForm.inputs > 0 && hasForm.buttons > 0),
          `${ep.label} 有内容（非空白页）`,
          `textLen=${pp.textLen} inputs=${hasForm.inputs} buttons=${hasForm.buttons} path=${pp.path}`);
        if (ep.expectNotFound) {
          /* 反向断言：确认它**确实**关着。哪天有人把画廊放到生产上，
             这条会变红 —— 那时应当先确认"是否真的想让员工看到组件清单"。 */
          check(
            /组件展厅只在开发环境开放/.test(pp.bodyText || ''),
            `${ep.label} 按设计关闭（不是白屏/崩溃）`,
            JSON.stringify((pp.bodyText || '').slice(0, 40)),
          );
        }
        if (ep.check === 'root') {
          /**
           * 根入口的判据：**必须落到一个具体业务路由**，且不是登录页。
           * 不写死"必须是 /archives"——那会把角色策略写进测试，
           * 将来策略调整（比如给销售也开工作台）测试会无意义地变红。
           */
          const landed = String(pp.path || '');
          check(
            landed !== '/' && landed !== '/m/' && !/请使用门店或总部的现有账号登录/.test(pp.bodyText || ''),
            '根入口 已按角色落位（不是空白根路径、不是登录页）',
            `landed=${landed}`,
          );
        }
        shots.push({ name: `${ep.name}-${vp.name}`, vp: vp.name, ...(await shot(cdp, `${ep.name}-${vp.name}`)) });
      }

      /* 工单详情：取列表里第一条真实工单，不写死 id */
      const firstTicket = await cdp.evaluate(`(async () => {
        const t = localStorage.getItem('svc.mobile.token') || '';
        const r = await fetch('/api/serviceTickets:list?page=1&pageSize=1', { headers: { Authorization: 'Bearer ' + t } });
        const j = await r.json().catch(() => null);
        return j?.data?.[0]?.id ?? null;
      })()`);
      if (firstTicket) {
        await cdp.send('Page.navigate', { url: `${BASE}/m/tickets/${firstTicket}` });
        await sleep(3200);
        const pt = await evaluateProbe(cdp);
        assertCommon(pt, '工单详情', vp.name);
        check(pt.textLen > 20, '工单详情 有内容（非空白页）', `textLen=${pt.textLen}`);
        shots.push({ name: `ticket-detail-${vp.name}`, vp: vp.name, ...(await shot(cdp, `ticket-detail-${vp.name}`)) });
      } else {
        console.log('  SKIP  工单详情：当前账号看不到任何工单（不是产品结论）');
      }
    }

    /* ---------- 截图互异校验（防旧图复用） ---------- */
    section('截图证据');
    for (const sh of shots) {
      console.log(`  ${sh.name.padEnd(26)} ${String(sh.bytes).padStart(8)}B  ${sh.sha}  ${sh.path || ''}`);
    }
    /**
     * 判据是"**不同页面不能用同一张图**"，不是"所有图必须互不相同"。
     *
     * ⚠️ 第一版写成"全部哈希互异"，扩展页面后立刻假红：
     *    `/m/` 对 store_sales 会 `replace` 归一到 `/archives`（见 AppRouter.RoleHome），
     *    两张图**本来就应该是同一张**。要求它们不同，等于要求产品行为错。
     *
     * ⇒ 按 `path` 分组：**同一 path 的哈希必须一致**（那是"同页同图"的正向证据），
     *   **不同 path 的哈希必须不同**（那是"没有拿旧图充数"的反向证据）。
     *   两个方向都断言，才既防旧图复用、又不惩罚合法的重定向。
     */
    /**
     * ⚠️ 分组键必须是「**路由 + 视口**」，不是"路由"。
     *
     *    第二版只按路由分组，于是 `/m/archives` 的 390×844 与 375×667 两张图
     *    被判成"同页应该同图" ⇒ 立刻假红。**同一页面在不同机型上本来就该不同**，
     *    把机型并进键里之后，"同页同机型"这件事才有意义（它才有唯一的正确答案）。
     */
    const groupKey = (sh) => `${String(sh.path || sh.name)}@${sh.vp || '?'}`;
    const byPath = new Map();
    for (const sh of shots) {
      const key = groupKey(sh);
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(sh);
    }
    const samePathDiff = [];
    for (const [k, arr] of byPath) {
      const uniq = new Set(arr.map((x) => x.sha));
      if (uniq.size !== 1) samePathDiff.push(`${k}: ${arr.map((x) => x.sha.slice(0, 8)).join(',')}`);
    }
    check(
      samePathDiff.length === 0,
      '同一路由的多张截图内容一致（同页同图）',
      samePathDiff.join(' | '),
    );
    const pathOf = new Map();
    const dup = [];
    for (const sh of shots) {
      const key = groupKey(sh);
      if (pathOf.has(sh.sha) && pathOf.get(sh.sha) !== key) dup.push(`${sh.sha.slice(0, 8)}: ${pathOf.get(sh.sha)} = ${key}`);
      else pathOf.set(sh.sha, key);
    }
    check(
      dup.length === 0,
      '不同路由的截图内容不同（未复用旧图）',
      dup.length ? dup.join(' | ') : `${pathOf.size} 张不同图 / ${byPath.size} 个路由`,
    );

  } finally {
    try { close(); } catch { /* noop */ }
  }

  /* ------------------------------------------------------------ 汇总 */
  const fail = results.filter((r) => !r.pass);
  section('汇总');
  console.log(`  共 ${results.length} 条断言，通过 ${results.length - fail.length}，失败 ${fail.length}`);
  if (fail.length) {
    for (const f of fail) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  fs.writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ at: new Date().toISOString(), viewports: VIEWPORTS, results, shots }, null, 2),
  );
  console.log(`\n证据目录：${OUT}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof TOOL_NOT_READY) {
    console.error(`\n[TEST INVALID] ${e.message}`);
    console.error('这是**验证工具未就绪**，不代表产品有问题。先修工具，不要给产品结论。');
    process.exit(2);
  }
  console.error('脚本异常：', e);
  process.exit(2);
});
