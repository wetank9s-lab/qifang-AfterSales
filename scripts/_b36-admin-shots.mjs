/**
 * _b36-admin-shots.mjs —— B-36 **后台配置区真实界面**截图（§七 交付物之一）
 *
 * =============================================================================
 * 为什么单开一支（而不是复用 `_b36-browser-scenarios.mjs`）
 * =============================================================================
 *   后者验的是**客户侧**（匿名 H5，手机视口 390）。这一支验的是**后台侧**
 *   （已登录管理员，桌面视口）—— 两个页面、两套视口、两种会话，混在一起
 *   会让"哪张图对应哪个视口"变得说不清，而截图**视口必须写在证据里**。
 *
 * =============================================================================
 * 🔴 判据：后台"看得到"必须是**真渲染**，不是"接口通了"
 * =============================================================================
 *   本脚本打开 `/admin/222b0i1wl2i`（客户页面装修），等 Banner 区块自己
 *   打完 `svc:bannerList` 后，从 **DOM** 里读：
 *     · `top-banner` 区的存在与文案（"已有横幅（N 张）"）
 *     · 门店下拉的**可选项**（这是本轮修掉的那个缺陷的正面证据 ——
 *       缺陷形态是"下拉静默为空"，所以这里必须**数出选项个数**）
 *     · 每行 Banner 的预览 `<img>` 是否**真的加载出来**（naturalWidth>0）
 *     · "发布 / 下架"按钮是否只出现**当前状态合法**的那一个
 *
 *   ⚠️ 反例（本项目踩过的假绿）：只看"页面标题渲染出来了"就判通过 ——
 *      标题渲染不代表它下面那个自定义区块加载成功。
 *      `PageThemeModel` 是一个 React 区块，`svc:bannerList` 失败时
 *      页面**照样是好的**，只是区块里显示错误文案。
 *
 * 用法：node scripts/_b36-admin-shots.mjs
 * 退出码：0 全绿 / 1 产品红 / 2 环境未就绪
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  createRateLimitGate,
  purgeBanners,
  readEnv,
  signIn,
  uuid,
  sha16,
  FIX,
} from './_b36-lib.mjs';

const BASE = 'https://127.0.0.1';
const PAGE_UID = '222b0i1wl2i';   // 「客户页面装修」（由 desktopRoutes:listAccessible 实测得到）
const OUT = path.resolve('storage/tmp/b36-admin');
const VW = 1440;
const VH = 1000;
const env = readEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* noop */ } }
  throw new Error('未找到 chrome.exe');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    // CDP 的**事件**（无 id）走这里；订阅用 on(method, fn)。命令响应仍走 pending。
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method) {
        const fns = this.listeners.get(m.method);
        if (fns) for (const fn of fns) { try { fn(m.params); } catch { /* noop */ } }
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log(`  ✅ ${m}`); };
const no = (m) => { fails.push(m); console.log(`  ❌ ${m}`); };
const chk = (c, m) => (c ? ok(m) : no(m));

console.log('\n══════════════════════════════════════════════════════════');
console.log('  B-36 后台配置区真实界面（§七 交付物）');
console.log('══════════════════════════════════════════════════════════');

const gate = createRateLimitGate();
const api = (token, p, opt = {}) => fetch(BASE + p, {
  method: opt.method || 'GET',
  headers: {
    ...(opt.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opt.headers || {}),
  },
  ...(opt.json !== undefined ? { body: JSON.stringify(opt.json) } : {}),
});
let child = null;
let profile = null;

try {
  const clean = await purgeBanners([1, 4], 'admin-shots 前置');
  if (!clean) throw new Error('前置清理未归零 ⇒ 环境未就绪');

  const hq = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
  ok('总部管理员登录成功');

  // 用既有素材（`.tmp-media/b36-fixtures/banner-b.png`）。
  // ⚠️ 更正：这张是 **蓝/蓝灰 + 一段红** 的三色带，**不是**橙红系（我上一轮这么写过，是错的，
  //    并且据此写了一条按橙色采样的断言，实测 0/40000 —— 判据错、产品无辜）。
  // ⚠️ 刻意与客户侧那张（蓝紫系）**色系不同** —— 这样后台截图与客户截图
  //    放在一起时，人能一眼看出"后台配的哪张、客户看到的是哪张"，
  //    而不是靠读哈希去自证。
  const pngPath = path.join(FIX, 'banner-b.png');
  if (!fs.existsSync(pngPath)) throw new Error(`素材缺失：${pngPath}（先跑 node scripts/_b36-make-fixtures.mjs）`);
  const png = fs.readFileSync(pngPath);
  const fp = sha16(png);
  const fd = new FormData();
  fd.append('banner', new Blob([png], { type: 'image/png' }), 'admin-shot.png');
  const upRes = await fetch(`${BASE}/api/svc:bannerUpload?store_id=1&alt_text=${encodeURIComponent('门店1横幅')}`, {
    method: 'POST', headers: { Authorization: `Bearer ${hq}`, 'X-Request-Id': uuid() }, body: fd,
  });
  const upJson = await upRes.json().catch(() => null);
  chk(upRes.status === 200, `上传 Banner HTTP 200（实际 ${upRes.status}）`);
  const idA = upJson?.data?.id;
  const pub = await api(hq, '/api/svc:bannerPublish', {
    method: 'POST', json: { banner_id: idA }, headers: { 'X-Request-Id': uuid() },
  });
  chk(pub.status === 200, `发布 Banner HTTP 200（实际 ${pub.status}）`);

  // ---- 起浏览器
  const port = 9900 + Math.floor(Math.random() * 90);
  profile = path.join(os.tmpdir(), `b36admin-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  child = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--ignore-certificate-errors', `--window-size=${VW},${VH}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('浏览器未就绪');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 桌面视口（后台是桌面界面）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  // ---- 登录：直接在页面里种 token（与 _r2-five-state-shots 同法）
  await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
  await sleep(2500);
  const seeded = await evaluate(`(() => {
    try {
      localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(hq)});
      localStorage.setItem('nocobase-token', ${JSON.stringify(hq)});
      return true;
    } catch (e) { return String(e); }
  })()`);
  chk(seeded === true, '已把管理员会话写入页面存储');

  // ★ 归因 "No permissions" 来源（BACKLOG B-17，**既有**缺陷，非本轮引入）
  //   ⚠️ 这是必须写进报告的一条：后台截图右上角会有一条红色 "No permissions" toast，
  //      它来自基线 SPA 每次加载都请求 `environmentVariables:list`、被 B-8 守卫 403
  //      （.workbuddy/memory/2026-10-17.md 有原始记录，BACKLOG 记为 P1）。
  //   ⇒ 不能只说"这是已知问题"就完事：要**当场把那个 403 抓出来**，证据在手才不会
  //      被误认为是 Banner 功能没权限。文件里它没有开关可关，但至少要说清它是什么。
  const authDenials = [];
  cdp.on('Network.responseReceived', (p) => {
    const s = p?.response?.status;
    const u = String(p?.response?.url ?? '');
    // 只收本应用的 401/403，排除浏览器扩展/字体等噪声
    if ((s === 401 || s === 403) && u.includes('/api/')) authDenials.push({ s, u: u.replace(BASE, '') });
  });
  await cdp.send('Network.enable');

  // ---- 打开装修页
  await cdp.send('Page.navigate', { url: `${BASE}/admin/${PAGE_UID}` });
  // 等自定义区块把 svc:bannerList 打完并渲染
  let read = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    read = await evaluate(`(() => {
      const root = document.body;
      const txt = root ? (root.innerText || '') : '';
      const imgs = [...document.querySelectorAll('img')].filter((im) => (im.getAttribute('src')||'').includes('/api/public/banner/'));
      // ⚠️ 按钮文案判据**必须容忍字间空格**：antd 的 Button 对两个汉字会自动插一个
      //    空格（实测 DOM 文本是「下 架」而不是「下架」）⇒ 严格相等比较永远匹配不到。
      //    这类"判据比产品严"的写法会把**正常产品**报成缺陷（本仓库最忌的假红）：
      //    首跑就是这样 —— 按钮明明在，断言读到 0 个。
      //    ⇒ 统一"去空白后比较"。
      // ⚠️ 两条编写陷阱（都踩过，记在这里）：
      //    ① 这个 helper 必须声明在**对象字面量之外**（写在 return { … } 里面不是合法 JS）；
      //    ② 本段是**模板字符串**，注释里**不许出现反引号** —— 一个反引号就会提前结束
      //       模板，后面半句变成真的 JS 被求值。表现是一个**指向错误方向**的报错
      //       （我当时看到的是 "下架" is not a function），差点让我去查一个不存在的变量。
      //       与 DEV-254 同型：模板字符串注释里的反引号。
      const btnText = (b) => (b.textContent || '').replace(/\\s+/g, '');
      // ⚠️ 按钮计数**必须限定在 Banner 行内**，不能全页数。
      //    装修页自己还有一组"保存草稿 / 刷新预览 / 发布"（那是**文案文档**的发布），
      //    全页数「发布」会数到它 ⇒ 于是"已发布行不该有发布按钮"这条**恒红**。
      //    我第一版就是这么写的：把页面级的按钮算进了 Banner 行的账上（超范围判定）。
      //    ⇒ 用行内 data-testid（pt-banner-row-* / pt-banner-publish-* / pt-banner-revoke-*）精确取。
      //
      // ⚠️ 又一个编写陷阱：这些都是**语句**，必须放在 return 之前。
      //    我第一次把它们塞进了 return 的**对象字面量**里（把 const rows = … 当属性写），
      //    那不是合法 JS ⇒ 整个表达式求值失败 ⇒ evaluate 返回 undefined ⇒
      //    **所有**断言一起变红（16 条），看起来像"产品全崩了"。
      //    分辨方法：看失败项是不是"整片 undefined"。整片 = **工具坏了**，不是产品。
      const rows = [...document.querySelectorAll('[data-testid^="pt-banner-row-"]')];
      const rowPublish = [...document.querySelectorAll('[data-testid^="pt-banner-publish-"]')];
      const rowRevoke = [...document.querySelectorAll('[data-testid^="pt-banner-revoke-"]')];
      return {
        url: location.pathname,
        redirectedToSignin: /signin/i.test(location.pathname),
        hasThemeTitle: txt.includes('客户页面装修'),
        hasBannerSection: txt.includes('客户横幅') || txt.includes('横幅'),
        listLine: (/已有横幅（\\d+\\s*张）/.exec(txt) || [null])[0],
        bannerImgs: imgs.map((im) => ({ src: im.getAttribute('src'), natW: im.naturalWidth, w: Math.round(im.getBoundingClientRect().width), h: Math.round(im.getBoundingClientRect().height) })),
        selectOptions: [...document.querySelectorAll('select option')].map((o) => (o.textContent || '').trim()),
        bannerRowCount: rows.length,
        publishButtons: rowPublish.length,
        revokeButtons: rowRevoke.length,
        // 全页的"发布"按钮数（含装修文档那个）——单独记，便于人工分辨
        pagePublishButtons: [...document.querySelectorAll('button')].filter((b) => btnText(b) === '发布').length,
        bannerRowText: (() => {
          const r = rows[0];
          return r ? (r.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : null;
        })(),
        // ★ 几何信息：Banner 区块在**哪一列**、离视口顶部多远、渲染高度多少。
        //   这是我要补的坑：上一版断言全绿、截图却只拍到左栏（Banner 在**右列**、
        //   且落在折叠线以下）⇒ 证据图里根本看不到被验收的东西。
        //   "断言绿了"和"截图证明了它"是两件事，必须让脚本自己确认后者（同铁律 ①）。
        bannerRect: (() => {
          const el = document.querySelector('[data-testid^="pt-banner-row-"]')
            || [...document.querySelectorAll('*')].find((e) => (e.textContent || '').includes('已有横幅（'));
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
        bannerColLeft: (() => {
          const el = document.querySelector('[data-testid^="pt-banner-row-"]');
          if (!el) return null;
          // 一直往上找到"跨到右半屏"的那层容器，取它的左边界（用来判定 Banner 在右列）
          let p = el;
          while (p && p.parentElement) {
            const r = p.getBoundingClientRect();
            if (r.width > 0 && r.left > window.innerWidth * 0.45) return Math.round(r.left);
            p = p.parentElement;
          }
          return Math.round(el.getBoundingClientRect().left);
        })(),
        viewportW: window.innerWidth,
        scrollH: document.documentElement.scrollHeight,
        excerpt: txt.slice(0, 400),
      };
    })()`);
    if (read?.hasBannerSection && read.listLine) break;
  }

  console.log('\n【后台渲染】`/admin/' + PAGE_UID + '` —— 客户页面装修页');
  chk(read && !read.redirectedToSignin, `没有被重定向到登录页（当前 ${read?.url}）`);
  chk(read?.hasThemeTitle, '装修页标题渲染出来了');
  chk(read?.hasBannerSection, 'Banner 区块出现在装修页里（不是只标题在、区块加载失败）');
  chk(/已有横幅（\d+\s*张）/.test(read?.listLine ?? ''), `横幅列表真的加载了（读到「${read?.listLine}」）`);

  // ★ 本轮修复的正面证据：门店下拉**不能是空的**
  const opts = read?.selectOptions ?? [];
  chk(opts.length > 0, `「指定适用门店」下拉**有 ${opts.length} 个选项**（缺陷形态就是这里静默为空）`);
  chk(opts.some((o) => o.includes('总部通用')), '下拉里有「总部通用」（总部默认回退项）');
  chk(opts.some((o) => /S\d+|新都|金堂|崇州|电器/.test(o)), `下拉里有具体门店（示例：${opts.slice(0, 4).join(' / ')}）`);

  // ★ 行内预览必须**真的加载出图**
  const imgs = read?.bannerImgs ?? [];
  chk(imgs.length > 0, `列表里有 ${imgs.length} 张预览图（走的是**客户那条公开路径**）`);
  chk(imgs.some((i) => i.natW > 0), `预览图**真实加载成功**（naturalWidth=${imgs.map((i) => i.natW).join(',')}）`);
  chk(imgs.some((i) => i.w > 0 && i.h > 0), '预览图有非零渲染尺寸');

  // 状态与该出现的按钮（**限定在 Banner 行内**，见上面 bannerRowCount 的注释）
  chk(read?.bannerRowCount >= 1, `列表里渲染出 ${read?.bannerRowCount} 个 Banner 行（含 testid，可精确定位）`);
  chk(read?.revokeButtons >= 1, `已发布行内出现「下架」按钮（${read?.revokeButtons} 个）`);
  // 反向：同一个已发布行内**不该**同时出现「发布」按钮（状态机只暴露合法动作）
  chk(read?.publishButtons === 0, `已发布行内**没有**「发布」按钮（行内 ${read?.publishButtons} 个）—— 只暴露状态合法的动作`);
  chk(read?.pagePublishButtons >= 1, `页面级「发布」（装修文档的）仍在（${read?.pagePublishButtons} 个）—— 与 Banner 的发布是两件事`);
  // 行内文案必须体现"这是已发布、且属于哪家店"
  chk(/已发布/.test(read?.bannerRowText ?? ''), `行内显示「已发布」状态（读到「${String(read?.bannerRowText ?? '').slice(0, 70)}」）`);
  chk(/新都圣大家电|S01/.test(read?.bannerRowText ?? ''), '行内显示**归属门店**（不是只显示 id）');

  // ★ 归因那条红 toast：**它不能是本轮 Banner 功能造成的**
  //   判据分两半，缺一不可：
  //     (a) 现场确实存在 /api 的 403（否则说明 toast 另有来源，我的归因就是编的）；
  //     (b) 这些 403 **一条都不涉及 svc:banner***（否则就是 Banner 自己没权限，必须修）。
  const bannerDenials = authDenials.filter((d) => /svc%3Abanner|svc:banner/i.test(d.u));
  const envDenials = authDenials.filter((d) => /environmentVariables/i.test(d.u));
  console.log(`\n【403 归因】本轮页面加载共 ${authDenials.length} 条 /api 拒绝：`);
  for (const d of authDenials.slice(0, 6)) console.log(`    ${d.s} ${d.u}`);
  chk(authDenials.length >= 1, `现场确实抓到 /api 的 401/403（${authDenials.length} 条）—— 红色 toast 有实物来源，不是我凭印象说的`);
  chk(envDenials.length >= 1, `其中含 environmentVariables（${envDenials.length} 条）⇒ toast 来自 BACKLOG **B-17**，与 Banner 无关`);
  chk(bannerDenials.length === 0, `Banner 自己**零** 403（svc:banner* 拒绝 ${bannerDenials.length} 条）—— 页面里那 1 张横幅确实由管理员正常读到`);

  // ---- 截图
  // ⚠️ 上一版直接 captureScreenshot 就交差了：断言全绿，但证据图里**看不到 Banner**
  //    （区块落在折叠线以下）—— 等于拿一张证明不了结论的图去交付。
  //    ⇒ 先滚动到 Banner 行，再截；并断言"它真的完整落在视口内"。
  // ⚠️ 这里还有一次**我自己的错判**：我从截图上以为 Banner 在**右列**（截图里它确实在右半边），
  //    于是写了 `left > vw*0.4` 这条断言 —— 实测 **left=231 / vw=1440（16%）**。
  //    真相：不是"配置区在右列"，而是**左列被滚动/收缩**，整个内容区横跨到底，
  //    Banner 区块本身就在左列主栏里。这条断言只证明了"我的眼判错了位置"。
  //    ⇒ 已删。留在这里的教训是：**位置类断言必须先量坐标再写阈值，不能从截图目测反推**。
  fs.mkdirSync(OUT, { recursive: true });

  const scrolled = await evaluate(`(() => {
    const row = document.querySelector('[data-testid^="pt-banner-row-"]');
    const anchor = row || [...document.querySelectorAll('*')].find((e) => (e.textContent || '').includes('已有横幅（'));
    if (!anchor) return { ok: false, reason: '找不到 Banner 行' };
    anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
    window.scrollBy(0, -120); // 留上文（「客户页面装修」标题 / 「模块展示」），便于人工确认这是哪一块
    const r = anchor.getBoundingClientRect();
    return { ok: true, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), vh: window.innerHeight, vw: window.innerWidth };
  })()`);
  chk(scrolled?.ok === true, `已滚动到 Banner 行（${scrolled?.reason ?? `top=${scrolled?.top}`}）`);
  chk(
    scrolled?.ok && scrolled.top >= 0 && scrolled.bottom <= scrolled.vh,
    `Banner 行**完整落在视口内**（top=${scrolled?.top} bottom=${scrolled?.bottom} vh=${scrolled?.vh}）—— 截图能拍到它，不是只靠断言`,
  );
  // 反向自查：截图必须真的含 Banner（否则就是又交付了一张证明不了的图）。
  //   判据取**像素里出现了列表里那张海报的主色**，而不是"文件大小 > 5000"这种谁都能过的门槛。
  await sleep(500); // 等滚动带来的重绘稳定（NocoBase 折叠/懒渲染）

  const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shotRes.data, 'base64');
  const file = path.join(OUT, 'admin-banner-config.png');
  fs.writeFileSync(file, buf);
  chk(buf.length > 5000, `后台截图有内容（${buf.length}B, sha=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}）`);
  chk(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '截图是合法 PNG（改了截图方式，重新校验文件头）');

  // ★ 像素级反查：后台那张预览图里必须**真的有图**，而不是一个空框 / 断图。
  //   ⚠️ 这一版是我第二次写错同一个判据，记清楚：
  //     第一次的错：我拿**截图 PNG 的文件大小**当"截到了 Banner"的证据 —— 一张只拍到左栏的
  //       白页同样 > 5000B，判据恒绿（假绿）。
  //     第二次的错：我按"橙红系"去数橙色像素，结果 **0/40000**。原因不是产品没显示，
  //       而是 fixture 根本不是橙红 —— `_b36-make-fixtures.mjs` 的 `makePng` 是三段色带
  //       (220,60,50) / (30,150,220) / (90,90,160)，只有第一段偏红，另两段一蓝一灰蓝。
  //       **我把"我以为的颜色"写成了断言阈值。** 这与"位置类断言从截图目测反推"是同一个病。
  //   ⇒ 现在的判据不猜颜色：**数非灰阶像素**（max-min > 20）。
  //     后台 UI 是白/灰/浅紫、且预览图本来就画在"走公开路径"的 <img> 上 ——
  //     只要它真把图画出来了，非灰阶像素必然成片出现。
  const px = await evaluate(`(async () => {
    const el = [...document.querySelectorAll('img')].find((im) => (im.getAttribute('src')||'').includes('/api/public/banner/'));
    if (!el) return { ok: false, reason: '没有 Banner 图元素' };
    if (!el.complete || !el.naturalWidth) return { ok: false, reason: 'Banner 图未加载完成' };
    const c = document.createElement('canvas');
    c.width = Math.min(el.naturalWidth, 200); c.height = Math.min(el.naturalHeight, 200);
    const g = c.getContext('2d');
    g.drawImage(el, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let color = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], bb = d[i + 2];
      if (Math.max(r, gg, bb) - Math.min(r, gg, bb) > 20) color += 1;
    }
    const total = d.length / 4;
    return { ok: true, color, total, ratio: +(color / total).toFixed(3) };
  })()`).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  chk(px?.ok === true, `能对预览图取像素（${px?.reason ?? 'ok'}）`);
  chk(px?.ok && px.ratio > 0.2, `预览图**真的有彩图**（非灰阶像素 ${px?.color}/${px?.total}，占比 ${px?.ratio}）—— 不是空框/断图`);
  console.log(`  📸 ${file}`);

  cdp.close();
} catch (error) {
  console.log(`\n  ⚠️ 中断：${String(error?.message ?? error)}`);
  fails.push(`中断：${String(error?.message ?? error)}`);
} finally {
  try { if (child) child.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(500);
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* noop */ }
  try { await purgeBanners([1, 4], 'admin-shots 收尾'); } catch { /* noop */ }
}

console.log('\n══════════════════════════════════════════════════════════');
if (gate.state.sawRateLimit) { console.log('  ⚠️ 环境未就绪（撞限流）'); process.exit(2); }
if (fails.length) {
  console.log(`  ❌ 后台界面验证：通过 ${pass} / 失败 ${fails.length}`);
  console.log('  失败项：');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
console.log(`  ✅ 后台配置区真实界面通过：${pass} 项`);
process.exit(0);
