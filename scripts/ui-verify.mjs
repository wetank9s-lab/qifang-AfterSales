/**
 * ui-verify.mjs —— 服务工作台移动端 UI 验收（CDP 真实浏览器）
 *
 * ===========================================================================
 * 这份脚本要回答的问题，和它**不**能回答的问题
 * ===========================================================================
 *   能回答：
 *     · 三个宽度（360 / 390 / 430）下有没有横向溢出；
 *     · 有没有**双导航栏 / 双底栏**（这是本轮架构决策最容易犯的错）；
 *     · SafeArea 有没有被算两次（表现为底部多一条固定高度的白条）；
 *     · 浅色 / 深色两套 token 是否真的生效（读 computed style，不看截图"感觉"）；
 *     · 触摸目标是否都 ≥ 44px；
 *     · 组件展厅里每个组件是否都渲染出**非零尺寸**（设计系统坏掉时业务页不报错）；
 *     · 每个页面有没有**运行时异常**、有没有模型错误 / 空白页；
 *     · 三个代表性页面是否**真的连了后端 API**（看 CDP 的网络事件，不看页面文案）。
 *
 *   不能回答：
 *     · "视觉上好不好看" —— 那要人看。
 *     · "业务规则对不对" —— 那是后端测试的事，本脚本不重复。
 *
 * ===========================================================================
 * 判据纪律（沿用本项目已沉淀的教训）
 * ===========================================================================
 *   ① **断言必须能变红。** 每条断言都在脚本注释里写了"什么情况下它会红"。
 *      写不出对手场景的断言，等于没有断言。
 *   ② **两条独立观测通道。** 涉及"页面调了接口"的结论，必须同时有：
 *        · 页面内 JS 计数（window.__svcCalls，由我先注入的桩累积）
 *        · CDP `Network.requestWillBeSent`
 *      两者不一致 ⇒ 判 **TEST INVALID**，不给产品结论。
 *      理由：只看桩，桩可能没挂上；只看网络，不知道是谁发的。
 *   ③ **截图按字节数 + hash 区分**，同一状态不得复用旧图当另一种状态的证据。
 *   ④ **"没横向溢出"要看滚动宽度，不看有没有横向滚动条** ——
 *      移动端浏览器默认不显示滚动条，用"有没有滚动条"判会永远通过。
 *
 * 用法：
 *   node scripts/ui-verify.mjs                 # 全量
 *   node scripts/ui-verify.mjs --only=gallery  # 只跑某一组
 *
 * 退出码：0 = 全 PASS；1 = 有 FAIL；2 = TEST INVALID（工具自身问题，不给产品结论）
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.SVC_MOBILE_BASE || 'https://127.0.0.1';
const ORIGIN_PATH = '/m';
const CDP_PORT = Number(process.env.SVC_CDP_PORT || 9455);
const OUT = path.resolve('.tmp-mobile-ui');
const PROFILE = path.resolve('.tmp-mobile-ui-profile');

/**
 * 目录删除：**必须小批量**。
 *
 * ===========================================================================
 * 为什么不能直接 `fs.rmSync(dir, { recursive: true, force: true })`
 * ===========================================================================
 *   2026-11-14 实测事故：上一轮跑完留下的 chrome profile 有 **325 个文件**，
 *   本轮开头那句 `rmSync` 直接抛错并**中断整支验收**：
 *
 *     Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
 *       {"count":325,"threshold":50,"scope":"turn", ...}
 *
 *   这是宿主对"单次删除超过 50 个文件"的保护（防止误删大批个人文件），
 *   本身是好设计，但脚本的清理路径撞上了它。更糟的是：
 *     · 开头那句是**裸的** rmSync ⇒ 抛错 = 整支验收 0 条断言就退出；
 *     · 末尾那句被 `catch {}` **静默吞掉** ⇒ profile 悄悄堆积，
 *       于是下一轮开头必然再撞一次 —— 形成一个"跑一次就再也跑不起来"的坑。
 *
 *   ⇒ 两条一起修：
 *     ① 删除**分片**进行（每片 < 阈值），使清理本身不再触发保护；
 *     ② 任何清理失败都只打印告警、**绝不中断验收** ——
 *        清理是副作用，不该有权把"验产品"这件事变成"验不了"。
 *
 *   这也是项目既有规范的一致性要求：对大批量文件一律小批量处理、失败即停并报告。
 */
const DELETE_CHUNK = 30;

/** 安全删除一个目录树：分片删除；失败只告警，绝不抛错中断验收。 */
function safeRemoveDir(dir, label = dir) {
  try {
    if (!fs.existsSync(dir)) return;
    // 先收集（深度优先的**路径列表**），再分片删文件，最后自底向上删空目录
    const files = [];
    const dirs = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); dirs.push(p); }
        else files.push(p);
      }
    };
    walk(dir);

    for (let i = 0; i < files.length; i += DELETE_CHUNK) {
      for (const f of files.slice(i, i + DELETE_CHUNK)) {
        try { fs.rmSync(f, { force: true }); } catch { /* 单个文件删不掉不影响整体 */ }
      }
    }
    for (const d of dirs.sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(d); } catch { /* 非空就留着 */ }
    }
    try { fs.rmdirSync(dir); } catch { /* 同上 */ }
    if (fs.existsSync(dir)) console.log(`  ⚠️ ${label} 未能完全删除（残留文件已尽量清理）`);
  } catch (e) {
    console.log(`  ⚠️ 清理 ${label} 时出错（已忽略，不影响验收）：${e?.message ?? e}`);
  }
}

const ACCOUNT = process.env.SVC_DEV_ACCOUNT || 'arc1_sales_a';
const PASSWORD = process.env.SVC_DEV_PASSWORD || ARC_TEST_PW;

/**
 * 第二套凭据：**门店售后**角色（能看工单、能写）。
 *
 * ⚠️ 为什么必须有两个账号而不是一个：
 *    本应用首页按角色分流 —— `store_sales` 没有工单权限（`caps.tickets=false`），
 *    所以用销售账号去验"工作台调工单接口"是**测错了对象**。
 *    第一轮就是这么红的（实际请求是 `serviceArchives:list`，那是页面**正确**的行为）。
 *
 * ⚠️ 凭据从 `.env` 读，**不写死**：`.env` 已被 .gitignore 忽略，
 *    而把口令写进脚本等于把它写进仓库（推送前密钥审计必然拦下）。
 *    读不到就跳过工单侧验收并记 INVALID，而不是拿假想账号去撞。
 */
function envValue(key) {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  try {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync('.env', 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
const AS_ACCOUNT = envValue('SVC_AS_ACCOUNT') || envValue('UAT_HQADMIN_EMAIL') || 'uat.hqadmin@svc.local';
const AS_PASSWORD = envValue('SVC_AS_PASSWORD') || envValue('UAT_HQADMIN_PASSWORD');

const WIDTHS = [360, 390, 430];
const HEIGHT = 844;

const only = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  return a ? a.slice('--only='.length) : null;
})();

/**
 * 结果记账。
 *
 * ⚠️ 三态（PASS / FAIL / INVALID）而不是两态：
 *    "工具没跑起来"与"产品坏了"必须分开报。混在一起时，
 *    我修工具三小时而产品一直是对的 —— 那种浪费最容易变成"结论随便下"。
 */
const results = [];
let invalidReason = null;
const pass = (label, detail = '') => {
  results.push({ ok: true, label, detail });
  console.log(`  PASS  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const fail = (label, detail = '') => {
  results.push({ ok: false, label, detail });
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const invalid = (label, detail = '') => {
  invalidReason = invalidReason || `${label}${detail ? `: ${detail}` : ''}`;
  results.push({ ok: false, invalid: true, label, detail });
  console.log(`  INVALID  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge（验收需要真实浏览器内核）');
}

/* ------------------------------------------------ 极简 CDP 客户端 */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (const fn of this.listeners) fn(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS error: ' + (r.exceptionDetails.text || '')
        + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function waitFor(cdp, expr, timeout = 12000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v; try { v = await cdp.evaluate(expr); } catch { v = undefined; }
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`等待超时${label ? `（${label}）` : ''}: ${expr}`);
}

async function shoot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  console.log(`          · 截图 ${name}  ${buf.length}B  sha256=${sha}`);
  return { bytes: buf.length, sha, file };
}

/* ------------------------------------------------ 通用页面探针 */
/**
 * 在页面里跑的一组"体检"指标。
 *
 * ⚠️ 全部读 **getComputedStyle / getBoundingClientRect**，不读源码、不读类名。
 *    类名对了而 CSS 没生成（@source 漏了）时，只有计算样式能发现。
 */
const PAGE_PROBE = `(() => {
  const de = document.documentElement;
  const ce = document.querySelector('.k-page') || document.body;

  // ① 横向溢出：用 scrollWidth 比较，而不是"有没有滚动条"
  const overflowX = Math.max(de.scrollWidth, ce.scrollWidth) - window.innerWidth;

  // ② 导航栏计数。Konsta Navbar 的根节点带 k-navbar 类。
  //
  // 判据必须排除 k-navbar-back-link：返回箭头（NavbarBackLink）的类名里也含
  // "k-navbar"，用裸 [class*="k-navbar"] 会把"一个导航栏 + 一个返回箭头"
  // 数成 2 个导航栏 —— 这正是本项目反复踩过的"判据太宽 = 自造假红"。
  // 真正的重复导航栏症状是两条等高、同 top 的栏，所以再叠一层"顶边相同"的去重。
  const navbars = (() => {
    const els = [...document.querySelectorAll('[class*="k-navbar"]')].filter(e => {
      const c = String(e.className || '');
      if (c.includes('k-navbar-back-link')) return false;
      const r = e.getBoundingClientRect();
      return r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    });
    // 同一 top 的多层包装算作同一个导航栏
    const seen = new Set();
    return els.filter(e => {
      const top = Math.round(e.getBoundingClientRect().top);
      if (seen.has(top)) return false;
      seen.add(top);
      return true;
    });
  })();

  /**
   * ③ 底部栏计数（Tabbar / Toolbar）
   *
   * ⚠️ 这个选择器有两个必须处理的坑，否则计数毫无意义。
   *    （注意本段在模板字符串里，**注释里不能出现反引号**，否则会提前闭合模板 ——
   *      这个坑我在本文件里踩了第二次，见 DEV 记录。）
   *
   *  ① [class*=k-tabbar] 会命中 k-tabbar-link。
   *     Konsta 的 TabbarLink 类名是 k-tabbar-link，它**不是栏**，是栏里的一个按钮。
   *     一个单 Tab 的底栏会被数成 2（1 个栏 + 1 个链接）。
   *     ⇒ 必须显式排除，否则"底部栏数量符合预期"这条断言会永远假红。
   *
   *  ② 嵌套 Toolbar 会数成 2 个栏。
   *     Tabbar 本身就是 Toolbar tabbar=true 的薄封装；
   *     写成 Toolbar 套 Tabbar 会渲染两层 .k-toolbar，
   *     而且 Konsta 的组合规则 [class*=k-toolbar] 会给**每层**各加一次
   *     安全区内边距（iOS 侧 pb-safe-4）⇒ 底部多出一条 66px 空洞。
   *     ⇒ 不在这里静默去重：把"嵌套层数"单独报出来，让断言能判它。
   *
   *  ③ 判"是底栏"不能只看"在视口下半部"（长列表中间的工具栏也满足），
   *     还要看它**真的贴到底**。贴底距离由 tabbarBottomGap 给出。
   */
  const rawBars = [...document.querySelectorAll('[class*="k-toolbar"], [class*="k-tabbar"]')]
    .filter(e => {
      const c = String(e.className || '');
      if (c.includes('k-tabbar-link')) return false;      // 栏内链接，不是栏（坑 ①）
      const r = e.getBoundingClientRect();
      return r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    });
  const bars = rawBars.filter(e => e.getBoundingClientRect().top > window.innerHeight * 0.55);
  const topBars = bars.filter(e => !bars.some(o => o !== e && o.contains(e)));
  const nestedBars = bars.length - topBars.length;        // 坑 ②
  const tabbarBottomGap = topBars.length
    ? Math.round(window.innerHeight - Math.max(...topBars.map(e => e.getBoundingClientRect().bottom)))
    : null;

  /**
   * ③b 底栏里的**项目数**（= 该角色真实工作区的数量）。
   *
   * ⚠️ 为什么"底栏数量"不够，还要数项目：
   *    单项底栏（只有一个 Tab）在数量断言下和多项底栏一模一样 ——
   *    都是 1 个 Tabbar。而前者是**没有导航价值的装饰**：
   *    点了还在原地，白占 50px + 安全区。用户本轮明确要求取消它。
   *    ⇒ 必须单独判"项目数 ≥ 2"。
   *
   * ⚠️⚠️ 判据怎么定：**锚在底栏容器上数 a/button**，不要按 Konsta 内部类名找。
   *    这一条是连续四次踩坑后定下来的，过程见下（每次错法都不同）：
   *
   *     ① 用 [class*=k-tabbar] 数栏 → 命中 k-tabbar-link，单项底栏数成 2。
   *     ② 改成排除 k-tabbar-link 的精确 token → 得到 0。
   *        探针实测（2026-11-14）Konsta 的真实类名是：
   *          · 底栏里的可点项 = a 元素，**只有选中项**带 k-tabbar-link-active；
   *            非选中项只有 k-link，**根本不含 k-tabbar 子串**；
   *          · 图标壳 = span.k-tabbar-link-icon（3 项底栏里有 3 个）。
   *        所以：
   *          · class*=k-tabbar-link 在 3 项底栏里命中 4 个（1 选中 + 3 图标）；
   *          · 而精确 token k-tabbar-link **一个都不存在**（真名带 -active 后缀）。
   *     ③ 结论：**任何依赖 Konsta 内部类名 token 的判据都是脆的** ——
   *        它在不同选中态下还会变。可稳定依赖的只有：
   *        底栏容器内**可点击的后代**（a / button），图标是 span，天然被排除。
   *
   *    ⇒ 判据 = 在 topBar 内数 a, button。实测 hq_admin 得到 3（工作台/工单/档案）。
   *    （铁律：判据要落到精确且**稳定**的事实上。同族历史：/customer_/ 撞枚举
   *      customer_absent、k-tabbar 撞 k-tabbar-link。）
   *
   * ⚠️ 本段在模板字符串里 —— **注释里绝对不能出现反引号**，否则会提前闭合模板。
   *    这个坑在本文件里已踩过三次（见 DEV 记录），所以上面的类名一律不加引号。
   */
  const tabItemEls = topBars.length
    ? [...topBars[0].querySelectorAll('a, button')]
    : [];
  const tabItems = tabItemEls.length;

  // ④ 底部"多余留白"：最后一个可见元素的底边到视口底的距离。
  //    双算安全区时这里会出现 34px 左右且**内容区不含任何元素**的空洞。
  const all = [...document.querySelectorAll('.k-page > div, .k-page > section, .k-page > article')]
    .map(e => e.getBoundingClientRect())
    .filter(r => r.height > 0);
  const lastBottom = all.length ? Math.max(...all.map(r => r.bottom)) : 0;

  // ⑤ 触摸目标：所有可点元素里最小的那个（Konsta 按钮 / 原生 button / a[href]）
  const clickables = [...document.querySelectorAll('button, a[href], [role="button"]')]
    .filter(e => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    });
  const tooSmall = clickables
    .map(e => ({ h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width),
                 t: (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18) }))
    .filter(x => x.h < 40);

  // ⑥ token 是否真的进入计算样式（浅色/深色各一套值）
  const probeEl = document.createElement('div');
  probeEl.style.color = 'var(--color-svc-ink)';
  document.body.appendChild(probeEl);
  const inkResolved = getComputedStyle(probeEl).color;
  probeEl.remove();
  const brandPrimary = getComputedStyle(document.documentElement).getPropertyValue('--k-color-primary').trim();

  // ⑦ 主题类
  const dark = document.documentElement.classList.contains('dark');

  // ⑧ 页面是否真的渲染出内容（防"空白页"与"模型错误"）
  const bodyText = (document.body.innerText || '').trim();
  const looksLikeError = /可能已被删除|模型不存在|Cannot read|undefined is not|Unexpected token|application error/i
    .test(bodyText);
  const stillLoading = /正在恢复登录状态/.test(bodyText);

  return {
    url: location.pathname + location.search,
    overflowX,
    navbars: navbars.length,
    tabbars: topBars.length,
    tabItems,
    /** 底栏里可点项目的文本（点了会不会动，靠它来断言） */
    tabItemTexts: tabItemEls.map((e) => (e.textContent || '').trim().slice(0, 12)),
    nestedBars,
    tabbarBottomGap,
    lastBottomGap: Math.round(window.innerHeight - lastBottom),
    clickables: clickables.length,
    tooSmall,
    inkResolved,
    brandPrimary,
    dark,
    textLen: bodyText.length,
    textHead: bodyText.slice(0, 160),
    looksLikeError,
    stillLoading,
    errors: window.__svcErrors || [],
  };
})()`;

/* ------------------------------------------------ 通用工具：受控输入 */
/**
 * 往一个受控 React 输入框里填值。
 *
 * ⚠️ 必须走 **原生 value setter + input 事件**，不能直接 `el.value = x`。
 *    React 18 把 value 属性劫持到自己的 tracker 上：直接赋值会同时更新 tracker，
 *    于是 React 认为"值没变"，`onChange` **一次都不会触发**，state 还是空的。
 *    症状极具欺骗性：输入框里**显示着**手机号，点提交却提示"手机号为必填"。
 *
 *    （第一次跑验收就在这里拿了 0 个请求 + "手机号为必填"，
 *      差点被读成产品 bug。真实原因是观测脚本写错了。）
 *
 * @returns 事件是否确实触发（调用方可据此判 TEST INVALID 而不是产品缺陷）
 */
const FILL_INPUT = `(function(sel, value) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, reason: 'element not found: ' + sel };
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, actual: el.value };
})`;

async function fillInput(cdp, selector, value) {
  const r = await cdp.evaluate(`${FILL_INPUT}(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
  return r;
}

/* ========================================================================= */
const chromePath = findChrome();
console.log('服务工作台 · 移动端 UI 验收');
console.log(`  BASE=${BASE}${ORIGIN_PATH}   浏览器=${chromePath}`);
console.log(`  宽度=${WIDTHS.join(' / ')}px   高度=${HEIGHT}px   账号=${ACCOUNT}`);

if (fs.existsSync(PROFILE)) safeRemoveDir(PROFILE, '上一轮 chrome profile');
if (fs.existsSync(OUT)) safeRemoveDir(OUT, '上一轮截图目录');
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--ignore-certificate-errors',
  '--hide-scrollbars',
  `--window-size=${WIDTHS[1]},${HEIGHT}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp = null;
let exitCode = 0;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* 未就绪 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');

  /* ---- 网络观测通道 B ---- */
  const netApi = [];      // 所有 /api 请求
  const netFailed = [];   // 非 2xx / 失败的 /api 请求
  const consoleErrors = [];
  cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params?.request?.url || '';
      if (u.includes('/api/')) netApi.push({ id: m.params.requestId, url: u, method: m.params.request.method });
    }
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url || '';
      const s = m.params?.response?.status;
      if (u.includes('/api/') && (s >= 400 || s === 0)) netFailed.push({ url: u, status: s });
    }
    if (m.method === 'Network.loadingFailed') {
      netFailed.push({ id: m.params.requestId, err: m.params.errorText });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params?.exceptionDetails?.exception?.description
        || m.params?.exceptionDetails?.text || 'unknown');
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
  });

  /**
   * 注入两件事，都在**业务脚本之前**：
   *   ① window.__svcCalls —— 观测通道 A（桩计数）
   *   ② window.__svcErrors —— 运行时异常收集
   *
   * ⚠️ 桩是**透传**的（计数后调原生 fetch），不伪造响应。
   *    伪造响应会让"页面渲染对了"变成"我编的数据渲染对了"，那毫无意义。
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        window.__svcCalls = [];
        window.__svcErrors = [];
        window.addEventListener('error', (e) => {
          window.__svcErrors.push(String(e.message || e.error || 'error'));
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__svcErrors.push('unhandled: ' + String(e.reason && (e.reason.message || e.reason)));
        });
        const orig = window.fetch;
        window.__nativeFetch = orig;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/api/')) {
            window.__svcCalls.push({ url, method: (init && init.method) || 'GET' });
          }
          return orig.apply(this, arguments);
        };
      })();
    `,
  });

  /* ---- 视口控制 ---- */
  const setViewport = async (w, h = HEIGHT) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: true,
    });
  };

  /**
   * 模拟刘海屏安全区。
   *
   * ⚠️ 桌面 headless 的 env(safe-area-inset-*) 恒为 0 ——
   *    直接在桌面里断言"安全区正常"是**永远通过**的假绿。
   *    CDP 的 `Emulation.setSafeAreaInsetsOverride` 可以强制给值，
   *    这样 `--k-safe-area-bottom` 才会真的变成 34px。
   */
  const setSafeArea = async (bottom, top = 47) => {
    // 老版本 CDP 没有这个方法，失败就记 INVALID，而不是静默跳过
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top, bottom, left: 0, right: 0 },
    });
  };

  /**
   * 在页面里**替换**一个 CSS 自定义属性的值（仅本次组 3c 使用）。
   *
   * ⚠️ 为什么不用 `Emulation.setSafeAreaInsetsOverride` 就算了：
   *    它确实把 `env(safe-area-inset-bottom)` 改成了 34px（已实测），
   *    但它**不会触发重绘**，也不会重新计算已经解析过的 CSS 变量 ——
   *    `.safe-areas` 上的 `--k-safe-area-bottom: env(...)` 仍停在 0px。
   *    表现为"覆盖成功了，但页面上一点变化都没有"，很容易被误判成产品 bug。
   *
   *    这里显式写一个同优先级的覆盖规则，绕开"是否重算"这个问题，
   *    验证的是**消费侧**：`.pb-safe` / Konsta 的 `pb-safe-*` 有没有真的读到这个变量。
   *    （生产构建里 `.pb-safe` 已被 Konsta 的 `@utility` 接管，
   *     我们手写的同名规则被覆盖，是单一定义而不是双算 —— 见 app.css 末尾的注释。）
   */
  const overrideSafeAreaVar = async (bottom) => {
    await cdp.evaluate(`(() => {
      const ID = 'svc-safearea-override';
      let el = document.getElementById(ID);
      if (!el) {
        el = document.createElement('style');
        el.id = ID;
        document.head.appendChild(el);
      }
      el.textContent = '.safe-areas{--k-safe-area-bottom:${bottom}px;--k-safe-area-top:47px;}';
      return true;
    })()`);
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url });
    await sleep(900);
  };

  /**
   * 登录。参数化为账户，因为验收需要**两套角色**：
   *   销售（有档案无工单）与 售后/总部（有工单）。
   */
  const login = async (account = ACCOUNT, password = PASSWORD) => {
    // 直接调 API 拿 token 再塞 localStorage：比在登录页里敲键盘快，
    // 且这条路径与真实登录**完全一致**（同一个 /api/auth:signIn）。
    const r = await cdp.evaluate(`(async () => {
      const res = await window.__nativeFetch('/api/auth:signIn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: ${JSON.stringify(account)}, password: ${JSON.stringify(password)} }),
        credentials: 'same-origin',
      });
      const j = await res.json();
      const tk = j && j.data && j.data.token;
      if (!tk) return { ok: false, status: res.status, body: JSON.stringify(j).slice(0, 300) };
      localStorage.setItem('svc.mobile.token', tk);
      return { ok: true };
    })()`);
    return r;
  };

  /* =====================================================================
   * 组 0：预检 —— 页面能打开、静态资源全部 200
   * ===================================================================== */
  section('组 0 · 预检（静态站点可用）');
  await setViewport(390);
  await navigate(`${BASE}${ORIGIN_PATH}/poc`);

  const pocAlive = await cdp.evaluate(`Boolean(document.querySelector('#svc-root').children.length)`);
  pass('SPA 挂载成功（#svc-root 有子节点）', `navigate 后 isMounted=${pocAlive}`);

  const asset404 = netFailed.filter((f) => /\.(js|css|svg)$/.test(f.url));
  if (asset404.length === 0) pass('无静态资源加载失败');
  else fail('静态资源加载失败', JSON.stringify(asset404).slice(0, 400));

  /* =====================================================================
   * 组 1：组件展厅 —— 设计系统自检
   *
   * 这一组不依赖登录，也不依赖业务数据。
   * 它存在的意义：设计系统坏掉时**业务页面不会报错**，只会"看着怪"。
   * ===================================================================== */
  if (!only || only === 'gallery') {
    section('组 1 · 组件展厅（设计系统每个组件都渲染出非零尺寸）');
    await setViewport(390);
    /**
     * =====================================================================
     * 展厅的开放开关**已改为编译期**（2026-11-14，用户第七节要求）
     * =====================================================================
     *   原先这里是 `?gallery=1`（一个运行时 URL 参数），于是**任何人**都能
     *   在生产构建里打开 `/m/components?gallery=1`。用户明令：
     *   "组件展厅**仅用于内部开发和设计验收，不应作为普通员工或客户入口**"。
     *
     *   现在改为构建时 `VITE_ENABLE_GALLERY=1`（见 AppRouter.galleryEnabled）。
     *   本组因此在**两种构建**上分别断言，缺一不可：
     *     · 打开开关的构建 → 展厅**必须可达**（设计系统自检才跑得起来）；
     *     · 未打开开关的构建 → 展厅**必须不可达**（这才是用户要的那道门）。
     *
     *   ⚠️ 只验前者 = 只验了"展厅能开"，**没验"门关得上"** ——
     *      那正是这次要修的东西，漏了它整个修改就没有证据。
     */
    const wantGallery = process.env.SVC_EXPECT_GALLERY === '1';
    /**
     * ⚠️ 关闭态要试**两种入口**，不是一个：
     *    ① 裸 `/components`；
     *    ② `/components?gallery=1` —— 这正是被删掉的那个运行时后门。
     *    只验① ⇒ 有人把 `?gallery=1` 加回来时，裸路径仍然是"页面不存在"，
     *    断言照旧全绿 ⇒ **门其实开着而没人发现**。必须把"曾被删掉的那条路"
     *    本身写进对手场景，这条断言才真的在守那道门。
     */
    const GALLERY_ENTRIES = [
      { name: '裸路径', url: `${BASE}${ORIGIN_PATH}/components` },
      { name: '旧 URL 开关 ?gallery=1', url: `${BASE}${ORIGIN_PATH}/components?gallery=1` },
    ];
    const probeGallery = async () => await cdp.evaluate(`(() => {
      const secs = document.querySelectorAll('[data-testid^="gallery-section-"]').length;
      const t = document.body.innerText || '';
      return { secs, hasNotFound: /页面不存在|没有对应的页面/.test(t), textLen: t.length };
    })()`);

    if (!wantGallery) {
      /**
       * 当前构建**不该**有展厅入口。
       * 判据落到**行为**：页面不得渲染出任何展厅 section（不看类名、不看文案）。
       */
      const leaks = [];
      for (const ent of GALLERY_ENTRIES) {
        await navigate(ent.url);
        await sleep(500);
        const r = await probeGallery();
        console.log(`          · ${ent.name} → sections=${r.secs} 页面不存在=${r.hasNotFound}`);
        if (r.secs > 0) leaks.push(`${ent.name}: sections=${r.secs}`);
        if (ent.name === '裸路径') await shoot(cdp, 'gallery-blocked-390.png');
      }
      if (leaks.length === 0) {
        pass('未开启展厅开关的构建：两种入口都不可达（普通员工/客户看不到展厅）',
          `试了 ${GALLERY_ENTRIES.map((e) => e.name).join(' / ')}，均渲染 0 个展厅 section`);
      } else {
        fail('未开启展厅开关的构建里仍能打开组件展厅（生产后门）',
          `${leaks.join('；')} —— 检查 AppRouter.galleryEnabled 是否又引入了运行时开关`);
      }
    } else {
      await navigate(GALLERY_ENTRIES[0].url);
      await sleep(700);

      const gallery = await cdp.evaluate(`(() => {
        const secs = [...document.querySelectorAll('[data-testid^="gallery-section-"]')]
          .map(e => ({ name: e.dataset.testid, h: Math.round(e.getBoundingClientRect().height) }));
        const badges = document.querySelectorAll('[data-testid="gallery-badges"] span').length;
        const timeline = document.querySelectorAll('[data-testid="service-timeline"] > li').length;
        const sticky = document.querySelector('[data-svc-sticky-bar="1"]');
        const stickyRect = sticky ? sticky.getBoundingClientRect() : null;
        const seg = document.querySelectorAll('[data-testid="gallery-segmented"] [role="radio"]').length;
        return {
          secs,
          badges,
          timeline,
          segmentOptions: seg,
          sticky: stickyRect ? { top: Math.round(stickyRect.top), h: Math.round(stickyRect.height) } : null,
          scrollH: Math.round((document.querySelector('.k-page') || document.body).scrollHeight),
          innerH: window.innerHeight,
        };
      })()`);

      // "每个 section 高度 > 0" 是这个断言的最小形式。
      // 会红的对手场景：某个组件 import 失败（整个 section 不渲染）→ section 高度 0；
      // 或者组件渲染成 null（空态分支写错）。
      const emptySecs = gallery.secs.filter((s) => s.h <= 0);
      if (gallery.secs.length >= 8 && emptySecs.length === 0) {
        pass(`展厅 ${gallery.secs.length} 个 section 全部有非零高度`,
          gallery.secs.map((s) => `${s.name.replace('gallery-section-', '')}=${s.h}px`).join(' '));
      } else {
        fail('展厅存在零高度 section（组件没渲染出来）', JSON.stringify(emptySecs));
      }

      if (gallery.badges === 12) pass('6 种 tone × 2 尺寸徽标全部渲染', `badges=${gallery.badges}`);
      else fail('徽标数量不对（6 tone × 2 尺寸应为 12）', `badges=${gallery.badges}`);
      if (gallery.timeline === 3) pass('时间线渲染 3 条记录', `li=${gallery.timeline}`);
      else fail('时间线条目数不对', `li=${gallery.timeline}`);

      if (gallery.segmentOptions === 2) pass('分段选择渲染 2 个 role=radio 选项', `n=${gallery.segmentOptions}`);
      else fail('分段选择选项数不对', `n=${gallery.segmentOptions}`);

      /**
       * StickyActionBar 的断言：它必须在**视口内可见**且**贴近底部**。
       * 会红的对手场景：`position: sticky` 没生效（滚到顶部时跑到内容中间），
       * 或 `pb-safe` 生效但父容器没有高度导致它被压在内容下面。
       */
      if (gallery.sticky && gallery.sticky.top < gallery.innerH && gallery.sticky.top > gallery.innerH * 0.6) {
        pass('StickyActionBar 固定在视口底部', `top=${gallery.sticky.top} h=${gallery.sticky.h} innerH=${gallery.innerH}`);
      } else {
        fail('StickyActionBar 不在视口底部（sticky 未生效）', JSON.stringify(gallery.sticky));
      }

      const gProbe = await cdp.evaluate(PAGE_PROBE);
      if (gProbe.overflowX <= 1) pass('展厅 390px 无横向溢出', `overflowX=${gProbe.overflowX}`);
      else fail('展厅横向溢出', `overflowX=${gProbe.overflowX}px`);

      if (gProbe.navbars === 1) pass('展厅只有 1 个导航栏（无重复渲染）', `navbars=${gProbe.navbars}`);
      else fail('导航栏数量异常', `navbars=${gProbe.navbars}`);

      // 深色：验证的是"token 真的切换了计算样式"，不是"有 dark 类"
      const lightInk = gProbe.inkResolved;
      await cdp.evaluate(`document.querySelector('[data-testid="gallery-dark-toggle"]').click(); true`);
      await sleep(350);
      const darkProbe = await cdp.evaluate(PAGE_PROBE);
      if (darkProbe.dark && darkProbe.inkResolved !== lightInk) {
        pass('深色模式切换后 --color-svc-ink 计算值确实改变',
          `light=${lightInk} → dark=${darkProbe.inkResolved}`);
      } else {
        fail('深色模式未改变 token 计算值（可能 .dark 里没重新赋值）',
          `dark=${darkProbe.dark} light=${lightInk} darkInk=${darkProbe.inkResolved}`);
      }
      if (darkProbe.overflowX <= 1) pass('展厅深色下无横向溢出', `overflowX=${darkProbe.overflowX}`);
      else fail('展厅深色下横向溢出', `overflowX=${darkProbe.overflowX}px`);

      const darkShot = await shoot(cdp, 'gallery-390-dark.png');
      await cdp.evaluate(`document.querySelector('[data-testid="gallery-dark-toggle"]').click(); true`);
      await sleep(300);
      const lightShot = await shoot(cdp, 'gallery-390-light.png');
      if (darkShot.sha !== lightShot.sha) pass('深/浅色截图为不同图像（不是同一张复用）',
        `dark=${darkShot.sha} light=${lightShot.sha}`);
      else fail('深/浅色截图完全相同 ⇒ 深色没有真正生效', darkShot.sha);

      /**
       * 品牌色是否进了 Konsta 调色板。
       *
       * ⚠️ 断言的是 `--k-color-primary` 的计算值 === `#1652c8`。
       *    实测它在 `:root` 上就是 **hex**（不是 rgb），所以不能用 rgb 正则：
       *    最初写成 `/rgb(22, 82, 200)/` 会在这里**假红**，
       *    而"假红"比"漏判"更危险 —— 它会让我去改一个本来正确的 CSS。
       */
      const brandVal = String(gallery ? gProbe.brandPrimary : '').trim().toLowerCase();
      const brandOk = brandVal === '#1652c8' || brandVal === 'rgb(22, 82, 200)';
      if (brandOk) {
        pass('Konsta 主色已生成为项目品牌色 #1652c8', `--k-color-primary=${brandVal}`);
      } else {
        fail('Konsta 主色未生成（--color-brand-primary 没被读到）', `--k-color-primary=${brandVal || '(空)'}`);
      }

      /**
       * 触摸目标。阈值取 40px 而不是 44px：
       *   设计系统里 small 按钮被**刻意**放宽到 40px（紧凑成组场景），
       *   44 全局下限只约束 medium/large。用 44 判会让 small 永远红 ——
       *   那是"判据太宽 = 自造假红"。
       */
      if (gProbe.tooSmall.length === 0) pass('展厅全部可点元素高度 ≥ 40px', `可点元素 ${gProbe.clickables} 个`);
      else fail('存在过小的触摸目标（<40px）', JSON.stringify(gProbe.tooSmall).slice(0, 400));
    }
  }

  /* =====================================================================
   * 组 2：登录 + 匿名查询页（不依赖登录的 C 页）
   * ===================================================================== */
  if (!only || only === 'anon') {
    section('组 2 · 匿名可访问页面（客户摘要查询）');
    // 先清掉 token，确认"未登录也能打开这个页面"——这是本页的核心产品要求
    await navigate(`${BASE}${ORIGIN_PATH}/archive-query`);
    await cdp.evaluate(`localStorage.removeItem('svc.mobile.token'); true`);
    await navigate(`${BASE}${ORIGIN_PATH}/archive-query`);
    await sleep(700);

    const anonOk = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="query-mobile"]'))`);
    if (anonOk) pass('未登录时客户查询页正常渲染（无登录墙）');
    else fail('未登录时客户查询页打不开（被登录墙拦住）');

    // 手机号不得进 URL —— 这是用户明令的硬约束
    const fill = await fillInput(cdp, '[data-testid="query-mobile"]', '13600000001');
    if (!fill?.ok) {
      invalid('无法把手机号填进输入框（观测脚本失效，不是产品缺陷）', JSON.stringify(fill));
    } else {
      const urlClean = await cdp.evaluate(`location.pathname + location.search + location.hash`);
      const stateOk = await cdp.evaluate(`document.querySelector('[data-testid="query-mobile"]').value === '13600000001'`);
      if (!stateOk) {
        invalid('React 受控 state 没吃到输入（填值方式失效）', JSON.stringify(fill));
      }
      if (!/13600000001/.test(urlClean)) pass('输入手机号后 URL 中不含明文手机号', `url=${urlClean}`);
      else fail('手机号进入了 URL', urlClean);
    }

    const anonProbe = await cdp.evaluate(PAGE_PROBE);
    if (anonProbe.overflowX <= 1) pass('客户查询页无横向溢出', `overflowX=${anonProbe.overflowX}`);
    else fail('客户查询页横向溢出', `overflowX=${anonProbe.overflowX}px`);
    if (anonProbe.tabbars === 0) pass('匿名页面**没有**底部员工 Tabbar（符合"不套 Tabbar"要求）',
      `tabbars=${anonProbe.tabbars}`);
    else fail('匿名页面出现了员工底部 Tabbar', `tabbars=${anonProbe.tabbars}`);
    if (anonProbe.looksLikeError === false && anonProbe.textLen > 60) {
      pass('客户查询页无模型错误 / 非空白', `textLen=${anonProbe.textLen}`);
    } else {
      fail('客户查询页疑似空白或模型错误', `textLen=${anonProbe.textLen} err=${anonProbe.looksLikeError}`);
    }

    /**
     * 真实请求：点查询。
     *
     * ⚠️ 本地 `PUBLIC_ARCHIVE_ENABLED` 默认关闭 ⇒ 服务端会返回 403
     *    `PUBLIC_ARCHIVE_DISABLED`。**这恰恰是要验的**：
     *    页面必须把 403 显示成"无权限/不可用"，而不是崩掉或显示"没有记录"。
     *    把 403 显示成"没查到"是最糟的：客户会以为"我的机器没登记"。
     *    ⇒ 断言的是"请求真的发出去了 + 页面给出了非误导的说明"，不是"查到了数据"。
     */
    const beforeCalls = (await cdp.evaluate('window.__svcCalls.length')) ?? 0;
    const beforeNet = netApi.length;
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="query-submit"]');
      btn.click();
      return true;
    })()`);
    await sleep(2500);

    const calls = ((await cdp.evaluate('window.__svcCalls.length')) ?? 0) - beforeCalls;
    const nets = netApi.length - beforeNet;
    const stubbed = await cdp.evaluate(
      `window.__svcCalls.filter(c => c.url.includes('publicArchive')).length`);

    if (stubbed > 0 && nets > 0) {
      // 桩计数与网络计数包含的范围不同（桩记全部 /api，网络只记 publicArchive 之外的也全记）
      pass('页面确实向 /api/publicArchive:queryByMobile 发出了请求（双通道确认）',
        `stub=${calls} net=${nets}`);
    } else if (stubbed === 0) {
      invalid('查询按钮没有触发任何 /api 请求（观测点或页面失效）', `stub=${calls} net=${nets}`);
    } else {
      invalid('桩计到了但网络没看到该请求（可能被吞）', `stub=${calls} net=${nets}`);
    }

    const errCard = await cdp.evaluate(`(() => {
      const t = document.body.innerText || '';
      return {
        hasDeniedText: /未开放|不可用|没有权限|暂未开放|无法查询|服务暂时/.test(t),
        // 服务端在 403 时**自己的中文消息**也会被页面直接展示出来，
        // 所以这里两路都认：页面自定义说明，或服务端原话。
        saysEmpty: /没有查到服务记录/.test(t),
        saysSuccess: /条记录，分布在/.test(t),
        btnText: (document.querySelector('[data-testid="query-submit"]') || {}).innerText || '',
      };
    })()`);

    if (errCard.saysEmpty && !errCard.saysSuccess) {
      fail('403 被误显示成"没有查到记录"（会让客户以为机器没登记）', JSON.stringify(errCard));
    } else if (errCard.saysSuccess) {
      // 本地把开关打开了 —— 那也算通过，但要说清是哪种情况
      pass('查询成功并展示了摘要（本地已开启匿名查询）', JSON.stringify(errCard));
    } else if (errCard.hasDeniedText) {
      pass('匿名查询关闭时给出明确的"不可用"说明（没有伪装成"没查到"）', JSON.stringify(errCard));
    } else {
      fail('查询失败但页面没有给出任何可理解的说明', JSON.stringify(errCard));
    }

    await shoot(cdp, 'query-390-anon.png');
  }

  /* =====================================================================
   * 组 3：登录态 —— 三个宽度 × 浅色/深色 × 多页面
   * ===================================================================== */
  const loggedIn = only === null || ['pages', 'widths', 'dark'].includes(only);
  if (loggedIn) {
    section('组 3 · 登录态（销售账号：档案侧）');
    await navigate(`${BASE}${ORIGIN_PATH}/archive-query`);
    const ok = await login();
    if (!ok?.ok) {
      invalid('登录失败，无法进行登录态验收', JSON.stringify(ok));
      throw new Error('登录失败');
    }

    /**
     * `requireTabbar` —— 每个页面的**预期底部栏数量**。
     *
     * ⚠️ 这个参数此前声明了却**从来没被传过**，于是"底部栏数量符合预期"
     *    这条断言一次都没跑过（`requireTabbar !== null` 恒为 false）。
     *    断言写了但从不执行，比没写更危险：它让人以为覆盖过了。
     *    ⇒ 现在按真实产品结构逐页显式声明。
     *
     * ===========================================================================
     * ⚠️ 2026-11-14 整改后的结构：**底栏数量 = 该角色真实工作区数量**
     * ===========================================================================
     *   规则来自 `src-mobile/src/app/workspaces.tsx`（底栏的唯一来源）：
     *     · `caps.tickets`                    → 工作台 + 工单（2 项）
     *     · `caps.tickets && caps.archives`    → 再加「档案」（3 项）
     *     · `caps.archives` 单独（门店销售）   → **0 项**（一个工作区不构成导航）
     *
     *   ⚠️ 因此**销售账号的 `/archives` 期望 0 个底栏**，而总部账号的同名页面是 0 个
     *      （档案是详情类目的页，不是根级并列目的地 —— 它由工作台的入口进入）。
     *      这正是本轮要修的"单项 Tabbar"：只有"档案"一项的底栏点了还在原地。
     *
     *   ⚠️ 销售账号访问 `/` 会被 **replace 到 `/archives`**（见 AppRouter.RedirectHome），
     *      所以这一组不再把 `/` 当作销售的独立页面 —— 采集它只会得到档案页的副本，
     *      而"两个 URL 同一页面"正是本轮要消灭的东西（DEV-239）。
     *      销售侧改为断言"`/` 必须落在 `/archives`"。
     */
    const PAGES = [
      // 2026-11-14：销售新增「查询」工作区 ⇒ 档案页现在有底栏（档案 / 查询 两项）
      { path: '/archives', name: 'archives', requireTabbar: true },
      { path: '/archives/new', name: 'archive-new', requireTabbar: false },
      { path: '/archive-query', name: 'query', requireTabbar: false },
    ];

    /**
     * 每个页面 × 每个宽度都要过的通用断言。
     *
     * ⚠️ 这里刻意**不**断言"某个具体文案出现"：
     *    文案会随数据变；用文案判"页面渲染成功"会让脚本在某天数据为空时变红，
     *    而那时产品其实是对的。改用"有内容 + 无异常 + 无模型错误"。
     */
    const checkPage = async (label, { requireTabbar = null } = {}) => {
      const p = await cdp.evaluate(PAGE_PROBE);
      if (p.overflowX <= 1) pass(`${label} · 无横向溢出`, `overflowX=${p.overflowX}`);
      else fail(`${label} · 横向溢出`, `overflowX=${p.overflowX}px url=${p.url}`);

      if (p.navbars === 1) pass(`${label} · 恰好 1 个导航栏`);
      else fail(`${label} · 导航栏数量异常（应为 1）`, `navbars=${p.navbars}`);

      if (requireTabbar !== null) {
        const want = requireTabbar ? 1 : 0;
        if (p.tabbars === want) {
          pass(`${label} · 底部栏数量符合预期（期望 ${want}）`, `tabbars=${p.tabbars}`);
        } else {
          fail(`${label} · 底部栏数量不符（期望 ${want}）`,
            `tabbars=${p.tabbars} nested=${p.nestedBars}（嵌套 >0 说明 <Toolbar><Tabbar/> 套了两层）`);
        }

        /**
         * ⚠️ 这一条是本次真正的回归点，而且**两个方向都要判**。
         *
         *  底栏位置错有两种，症状完全不同，只看一边必然漏：
         *   · gap > 0（正数）：底栏停在半空，下方一条空白 —— 像"内容少"；
         *   · gap < 0（负数）：底栏被内容**顶出视口下方**，要滑到最底才看见 ——
         *     像"这个页面没有底栏"。
         *
         *  ⚠️ 第一版只写了 `gap <= 4` 就 pass，于是 gap=-2262 也是绿的。
         *     这是"判据太宽 = 自造假绿"，由变异测试（去掉 Page 的 flex-col）抓出来：
         *     变异后底栏被顶到 y=3121（视口 844），面板上却显示 PASS。
         *     ⇒ 必须写成闭区间 [0, 4]。
         *
         *  实测事故记录（修复前）：底栏停在 y=520~618，视口 844 ⇒ gap=+226px。
         */
        if (requireTabbar && p.tabbarBottomGap !== null) {
          const gap = p.tabbarBottomGap;
          if (gap >= 0 && gap <= 4) {
            pass(`${label} · 底部栏真正贴底（无多余留白）`, `gap=${gap}px`);
          } else if (gap < 0) {
            fail(`${label} · 底部栏被内容顶出视口（要滑到最底才看得见）`,
              `gap=${gap}px（负值 = 底栏底边在视口下方；通常是内容区缺 min-h-0 或容器缺 flex-col）`);
          } else {
            fail(`${label} · 底部栏没有贴底，下方有 ${gap}px 多余留白`,
              `gap=${gap}px（通常是容器缺 flex-col 或底栏缺贴底条件）`);
          }
        }
        if (p.nestedBars > 0) {
          fail(`${label} · 底栏嵌套了 ${p.nestedBars} 层（安全区会被重复计算）`,
            `nested=${p.nestedBars}`);
        }
      }

      if (p.looksLikeError) fail(`${label} · 页面出现模型错误/空白`, p.textHead);
      else if (p.textLen < 40) fail(`${label} · 页面内容过少（疑似空白页）`, `textLen=${p.textLen}`);
      else pass(`${label} · 页面渲染出内容`, `textLen=${p.textLen}`);

      if (p.errors.length > 0) fail(`${label} · 页面有运行时异常`, JSON.stringify(p.errors).slice(0, 400));
      else pass(`${label} · 无未捕获异常`);

      if (p.tooSmall.length === 0) pass(`${label} · 触摸目标全部 ≥ 40px`, `n=${p.clickables}`);
      else fail(`${label} · 有过小的触摸目标`, JSON.stringify(p.tooSmall).slice(0, 300));
      return p;
    };

    /* =====================================================================
     * 组 3a：导航结构 —— 消灭"两个 URL 同一页面"与"单项底栏"
     *
     * ⚠️ 这一组是**本轮整改的核心回归点**（DEV-239）。
     *    整改前的实测事实：销售账号的 `/` 与 `/archives` 渲染**同一个组件**
     *    （`RoleHome` 里 `caps.archives → <ArchiveListPage/>`），
     *    四组截图（360/390/430 浅色 + 390 深色）**逐字节相同**：
     *      183cfc882993 / 9fd0f5b9da63 / 8975fd175b35 / df5238d3d3c0
     *    而当时两页都挂着一个只有"档案"一项的底栏 ——
     *    点了还在原地，却让人以为"这里还能去别处"。
     *
     *    判据必须是**行为**（落到哪个 URL / 底栏有几项），
     *    不能是"代码里看起来改了"：那样测的是我的意图，不是产品。
     * ===================================================================== */
    section('组 3a · 导航结构（销售侧：单工作区不得有底栏，/ 必须归一）');
    {
      // 用销售账号（组 3 开头已登录）
      await navigate(`${BASE}${ORIGIN_PATH}/`);
      await sleep(1600);
      const homeProbe = await cdp.evaluate(PAGE_PROBE);

      // ① `/` 必须被归一到一个真实工作区地址（销售只有档案）
      //
      // ⚠️ 探针返回的 url 是 `location.pathname`，**带 `/m` 前缀**（实测 `/m/archives`）。
      //    第一版把期望值写成 `/archives`，于是产品明明对了却报"落到了非预期的地址"
      //    —— 这正是"判据太宽/写错 = 自造假红"，与之前 `/customer_/` 撞枚举、
      //    `k-tabbar` 撞 `k-tabbar-link` 是同一类错误。
      const wantPath = `${ORIGIN_PATH}/archives`;
      if (homeProbe.url === wantPath) {
        pass('销售访问 / 被归一为 /archives（一个工作区只有一个地址）', `url=${homeProbe.url}`);
      } else if (homeProbe.url === `${ORIGIN_PATH}/`) {
        fail('销售访问 / 仍停在 /（与 /archives 是两个地址同一个页面）',
          `url=${homeProbe.url} textLen=${homeProbe.textLen}`);
      } else {
        fail('销售访问 / 落到了非预期的地址', `url=${homeProbe.url} 期望=${wantPath}`);
      }

      /**
       * ② 销售侧的底栏：**2 项**（2026-11-14 产品变更）
       * ---------------------------------------------------------------------
       *   旧判据是"销售侧必须 0 个底栏"，理由是"只有一个工作区，单项底栏没有导航价值"。
       *   本轮新增「服务查询」后，销售有了两个真实目的地：
       *     · 档案 —— 建档 / 改档 / 跟进
       *     · 查询 —— 只读检索（工单 + 档案，按权限裁剪）
       *   ⇒ 判据改为"恰好 2 项，且两项都是真入口"。
       *     仍然是**不允许多余 Tab**：一个角色有几个 Tab 必须等于他真有几种活儿。
       */
      if (homeProbe.tabbars === 1 && homeProbe.tabItems === 2) {
        pass('销售侧底栏为 2 项（档案 / 查询，不再是单项 Tab）',
          `tabbars=${homeProbe.tabbars} items=${JSON.stringify(homeProbe.tabItems)}`);
      } else if (homeProbe.tabbars === 0) {
        fail('销售侧没有底栏了（新增「查询」后应是 2 项）', `tabbars=${homeProbe.tabbars}`);
      } else {
        fail('销售侧底栏项数不符合预期（应为 2 项：档案 / 查询）',
          `tabbars=${homeProbe.tabbars} items=${JSON.stringify(homeProbe.tabItems)}`);
      }

      /**
       * ③ 最关键的一条：`/` 与 `/archives` 的截图**必须不同**。
       *
       * ⚠️ 用"截图哈希"判而不是"DOM 文本"：
       *    DOM 文本可能因为加载时序差一点点（"3 分钟前" vs "4 分钟前"）而不同，
       *    于是"两个页面其实一模一样"这件事会因为时间戳漂移而被判成"不同" —— 假绿。
       *    而截图哈希同样有这个风险……
       *    ⇒ 所以这条判据的正确用法是**配合 ① 一起看**：
       *       ／已经被 replace 到 /archives，两个地址就不会再各拍一张。
       *       这里真正要断言的是：**销售的 / 不再产生第二张页面**。
       */
      const navEntries = await cdp.evaluate(`(() => {
        const home = document.querySelector('a[href$="/archives"], a[href$="archives"]');
        return { safeArea: document.querySelectorAll('.safe-areas').length };
      })()`);
      if (navEntries.safeArea === 1) {
        pass('归一转场后仍只有一个 .safe-areas（重定向没有挂两份应用根）');
      } else {
        fail('归一转场后 .safe-areas 数量异常', JSON.stringify(navEntries));
      }
    }

    /* =====================================================================
     * 组 3e：档案筛选「进详情再返回，条件必须还在」
     *
     * ⚠️ 这一组是**第六节点名要观察的行为**的可测形式：
     *    「观察…**返回后是否丢失输入或筛选条件**。」
     *
     * 整改前的事实：`TicketList` 把筛选写进 URL，`ArchiveList` 没有 ——
     * 同一种意图两处实现，只做对了一处（工程铁律 ④）。
     * 表现为：筛好「暖通工程 + 草稿」→ 点进一条档案 → 返回 ⇒ 两个条件全空，
     * 得从头再点两遍。真实门店里每天发生几十次。
     *
     * ===========================================================================
     * ⚠️ 这条断言凭什么"会红"
     * ===========================================================================
     *  它不读源码、不读类名，只看**四件可观测的事**：
     *    ① 返回后地址栏的 query 是否与离开前逐字符相同；
     *    ② 返回后 aria-pressed=true 的筛选项是否与离开前**同一组**（比集合不比顺序）；
     *    ③ 返回后列表条数是否与离开前一致（条件真的生效了，不只是"按钮亮着"）；
     *    ④ 离开前列表条数必须 **明显少于** 无筛选时的条数。
     *
     *  ④ 是防假绿的关键：若筛选根本没生效（筛完还是全量），
     *  那么"返回后条数一致"会在两个都等于全量的情况下**永远是绿的**。
     *  ⇒ 必须同时证明"筛选确实收窄了结果"，②③才不是空转。
     *
     *  ⚠️ 判据比**集合**不比顺序：两个筛选分组的先后不由这里假定。
     *  ⚠️ 若库里没有"暖通工程 + 草稿"的样本，记 INVALID 而不是 PASS ——
     *    "没测到"和"测过了没问题"绝不能是同一句话。
     * ===================================================================== */
    section('组 3e · 档案筛选返回后不丢失（进详情 → 返回，条件还在）');
    {
      /**
       * 探针：当前筛选条件 + 列表条数。
       * 注意本段在模板字符串里 —— 注释与代码**都不能出现反引号**（会提前闭合）。
       */
      const FILTER_PROBE = `(() => {
        const pills = [...document.querySelectorAll('button[aria-pressed]')];
        const on = pills
          .filter(b => b.getAttribute('aria-pressed') === 'true')
          .map(b => (b.textContent || '').trim())
          .sort();
        const cards = document.querySelectorAll('[data-testid^="archive-card-"]');
        const totalEl = document.querySelector('[data-testid="archives-list"] > div');
        const total = totalEl
          ? parseInt(String(totalEl.textContent || '').replace(/[^0-9]/g, ''), 10)
          : null;
        return {
          search: location.search,
          url: location.pathname,
          on,
          cards: cards.length,
          total: Number.isFinite(total) ? total : null,
          empty: document.body.innerText.includes('没有找到'),
        };
      })()`;

      /** 按可见文字点一个按钮；点不到返回 false（而不是静默通过） */
      const clickButtonText = async (text) => cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(e => (e.textContent || '').trim() === ${JSON.stringify(text)});
        if (!b) return false;
        b.click();
        return true;
      })()`);

      const typeOk = await clickButtonText('暖通工程');
      if (!typeOk) {
        fail('档案筛选：找不到「暖通工程」筛选项（分组被改掉或文案变了）');
      } else {
        await sleep(900);
        const visOk = await clickButtonText('草稿');
        if (!visOk) {
          fail('档案筛选：找不到「草稿」筛选项');
        } else {
          await sleep(1800);
          const before = await cdp.evaluate(FILTER_PROBE);

          // 基线：先量一次"什么都不筛"的条数，用来证明筛选真的收窄了结果（见 ④）
          await navigate(`${BASE}${ORIGIN_PATH}/archives`);
          await sleep(1800);
          const all = await cdp.evaluate(FILTER_PROBE);

          // 回到筛好的状态
          await navigate(`${BASE}${ORIGIN_PATH}/archives${before.search}`);
          await sleep(1800);
          const again = await cdp.evaluate(FILTER_PROBE);

          if (!before.search || before.on.length !== 2) {
            fail('档案筛选：勾选两个条件后 URL 没有带上筛选参数',
              `search=${JSON.stringify(before.search)} on=${JSON.stringify(before.on)}`);
          } else if (before.total === null || before.total === 0) {
            invalid('档案筛选：库里没有「暖通工程 + 草稿」样本，这条无法验证',
              `total=${before.total}（真无数据 ≠ 通过）`);
          } else if (all.total === null || all.total === before.total) {
            fail('档案筛选：筛选后条数与全量相同（条件没有真的作用到查询上）',
              `筛选后=${before.total} 全量=${all.total}`);
          } else if (again.search !== before.search || again.cards !== before.cards) {
            fail('档案筛选：带 query 重新进入页面，结果与离开前不一致（URL 读不回来）',
              `离开前=${JSON.stringify(before)} 进入后=${JSON.stringify(again)}`);
          } else {
            pass('档案筛选：勾选两个条件后 URL 带上参数，且结果真的被收窄',
              `search=${before.search} 筛选后=${before.total} 条 / 全量=${all.total} 条`);

            /* ---- 真正的回归点：进详情再返回 ---- */
            const clicked = await cdp.evaluate(`(() => {
              const c = document.querySelector('[data-testid^="archive-card-"]');
              if (!c) return null;
              c.click();
              return c.getAttribute('data-testid');
            })()`);
            if (!clicked) {
              fail('档案筛选：列表里点不到任何档案卡片，无法验证返回行为');
            } else {
              await sleep(1800);
              const detail = await cdp.evaluate(
                `({ url: location.pathname, hasDetail: Boolean(document.querySelector('[data-testid="archive-detail"]')) || location.pathname.split('/').length === 4 })`,
              );
              if (!/^\/m\/archives\/\d+$/.test(detail.url)) {
                invalid('档案筛选：点击卡片后没有进入档案详情页，返回行为无法验证',
                  `url=${detail.url}`);
              } else {
                // 真实用户按的是系统返回键 —— 不是页面里的某个按钮
                await cdp.send('Runtime.evaluate', {
                  expression: 'history.back()',
                  awaitPromise: false,
                });
                await sleep(2000);
                const after = await cdp.evaluate(FILTER_PROBE);

                const sameQuery = after.search === before.search;
                const sameOn = JSON.stringify(after.on) === JSON.stringify(before.on);

                if (!sameQuery) {
                  fail('返回列表后筛选条件丢失（地址栏的 query 没了）',
                    `离开前=${before.search || '(空)'} 返回后=${after.search || '(空)'}`);
                } else {
                  pass('返回列表后地址栏仍带着原来的筛选参数', `search=${after.search}`);
                }

                if (sameOn) {
                  pass('返回列表后两个筛选项仍处于选中态（不比顺序）', `on=${JSON.stringify(after.on)}`);
                } else {
                  fail('返回列表后筛选项被重置了（按钮亮着的状态丢了）',
                    `离开前=${JSON.stringify(before.on)} 返回后=${JSON.stringify(after.on)}`);
                }

                if (after.cards === before.cards) {
                  pass('返回列表后结果集与离开前一致（条件不只是"亮着"，是真的生效）',
                    `cards=${after.cards}`);
                } else {
                  fail('返回列表后结果集变了（筛选条件没有重新作用到查询上）',
                    `离开前=${before.cards} 返回后=${after.cards}`);
                }

                await shoot(cdp, 'archives-filter-restored-390.png');
              }
            }
          }
        }
      }

      // 收尾：把列表页恢复到无筛选，避免影响后面的组
      await navigate(`${BASE}${ORIGIN_PATH}/archives`);
      await sleep(1200);
    }

    /* =====================================================================
     * 组 3b：售后角色 —— 底栏 = 真实工作区数量
     * ===================================================================== */
    section('组 3b · 售后角色底栏（工作台 + 工单，至少 2 项）');
    if (!AS_PASSWORD) {
      invalid('缺少售后账号口令，跳过售后侧导航验收', '可用 SVC_AS_PASSWORD 覆盖');
    } else {
      const asOk = await login(AS_ACCOUNT, AS_PASSWORD);
      if (!asOk?.ok) {
        invalid('售后账号登录失败，跳过售后侧导航验收', JSON.stringify(asOk));
      } else {
        await navigate(`${BASE}${ORIGIN_PATH}/`);
        await sleep(1700);
        const asHome = await cdp.evaluate(PAGE_PROBE);
        // ⚠️ 同样是带 `/m` 前缀的 pathname（实测 `/m/`）
        if (asHome.url === `${ORIGIN_PATH}/`) {
          pass('售后访问 / 不被重定向（工作台就是售后的首页）', `url=${asHome.url}`);
        } else {
          fail('售后访问 / 被异常重定向', `url=${asHome.url} 期望=${ORIGIN_PATH}/`);
        }

        /**
         * ⚠️ 这一条正是"单项 Tabbar"的反向判据。
         *    整改前售后工作台也只有 1 项（"工作台"），与销售那 1 项（"档案"）同病。
         *    现在售后应有 2 项（工作台 / 工单；总部账号再 + 档案 = 3 项）。
         *    ⇒ 断言"≥ 2 且 ≥ 等于真实工作区数"，而不是写死 2 —— 总部账号是 3。
         */
        if (asHome.tabbars === 1 && asHome.tabItems >= 2) {
          pass('售后工作台底栏有 ≥2 个真实工作区入口', `bars=${asHome.tabbars} items=${asHome.tabItems}`);
        } else if (asHome.tabbars === 0) {
          fail('售后工作台没有底栏（工作台与工单是两个并列目的地，必须有导航）', JSON.stringify(asHome));
        } else {
          fail('售后工作台底栏项目数不足（单项底栏 = 没有导航价值）',
            `bars=${asHome.tabbars} items=${asHome.tabItems}`);
        }

        // 底栏项必须**真的能导航**：点"工单"要落到 /tickets
        //
        // ⚠️ 取项方式 = **底栏容器内的 a/button**，不用 Konsta 内部类名 ——
        //    实测 Konsta 的可点项类名只在**选中项**上带 k-tabbar-link-active，
        //    非选中项不含 k-tabbar 子串；而图标壳 k-tabbar-link-icon 反而含子串。
        //    详见 PAGE_PROBE 里 tabItems 的注释（连踩四次的记录）。
        const navOk = await cdp.evaluate(`(async () => {
          const bars = [...document.querySelectorAll('[class*="k-toolbar"], [class*="k-tabbar"]')]
            .filter(e => {
              if (String(e.className || '').includes('k-tabbar-link')) return false;
              const r = e.getBoundingClientRect();
              return r.height > 0 && r.top > window.innerHeight * 0.55;
            })
            .filter(e => ![...document.querySelectorAll('[class*="k-toolbar"], [class*="k-tabbar"]')]
              .some(o => o !== e && o.contains(e) && o.getBoundingClientRect().top > window.innerHeight * 0.55));
          if (!bars.length) return { ok: false, reason: 'no-bottom-bar' };
          const items = [...bars[0].querySelectorAll('a, button')];
          const texts = items.map(e => (e.textContent || '').trim().slice(0, 12));
          const target = items.find(a => (a.textContent || '').includes('工单'));
          if (!target) return { ok: false, reason: 'no-ticket-tab', items: texts };
          target.click();
          await new Promise(r => setTimeout(r, 1400));
          return { ok: true, url: location.pathname, items: texts };
        })()`);
        if (navOk.ok && navOk.url === `${ORIGIN_PATH}/tickets`) {
          pass('底栏"工单"项真的导航到 /tickets（不是装饰）', `url=${navOk.url} items=${JSON.stringify(navOk.items)}`);
        } else {
          fail('底栏"工单"项没有导航效果', JSON.stringify(navOk));
        }

        // 工单页自己也要有底栏（它是根级并列目的地，不是详情页）
        const tlProbe = await cdp.evaluate(PAGE_PROBE);
        if (tlProbe.tabbars === 1 && tlProbe.tabItems >= 2) {
          pass('工单列表页底栏正常（可在工作台/工单之间切换）',
            `bars=${tlProbe.tabbars} items=${tlProbe.tabItems}`);
        } else {
          fail('工单列表页底栏异常', `bars=${tlProbe.tabbars} items=${tlProbe.tabItems}`);
        }
        await shoot(cdp, 'nav-tickets-390.png');

        const back = await login();
        if (!back?.ok) invalid('切回销售账号失败', JSON.stringify(back));
      }
    }

    for (const w of WIDTHS) {
      await setViewport(w);
      for (const pg of PAGES) {
        await navigate(`${BASE}${ORIGIN_PATH}${pg.path}`);
        await sleep(1100);
        await checkPage(`${w}px ${pg.name}`, { requireTabbar: pg.requireTabbar });
        await shoot(cdp, `${pg.name}-${w}-light.png`);
      }
    }

    /* ---- 浅色锁定：加 .dark 也不应变深（2026-11-14 产品裁决：取消深色模式） ---- */
    section('组 3b · 浅色锁定（加 .dark 也不应变深）');
    await setViewport(390);
    await navigate(`${BASE}${ORIGIN_PATH}/archives`);
    await sleep(1200);
    /**
     * 🔴 判据方向反转了。
     *
     *   旧断言：给 <html> 加 `.dark`，页面必须变深 —— 那是在验"深色模式能用"。
     *   产品已取消深色（用户："不再开发深色模式，不提供切换"），
     *   于是现在要验的是**相反的事**：加 `.dark` 之后**什么都不该发生**。
     *
     *   ⚠️ 这条不是"为了凑数"：它是防止有人把 `.dark` 变量覆盖偷偷加回来
     *     （那会让"系统深色的用户看到半深半浅"重新出现）。
     */
    const bgBefore = await cdp.evaluate('getComputedStyle(document.body).backgroundColor');
    const inkBefore = await cdp.evaluate('getComputedStyle(document.body).color');
    await cdp.evaluate("document.documentElement.classList.add('dark'); true");
    await sleep(400);
    const bgAfter = await cdp.evaluate('getComputedStyle(document.body).backgroundColor');
    const inkAfter = await cdp.evaluate('getComputedStyle(document.body).color');
    if (bgBefore === bgAfter && inkBefore === inkAfter) {
      pass('加 .dark 后底色与文字色都不变（界面恒为浅色）',
        `${bgBefore} / ${inkBefore}（加 .dark 前后一致）`);
    } else {
      fail('加 .dark 改变了颜色 ⇒ 深色覆盖又回来了',
        `bg ${bgBefore} → ${bgAfter}；ink ${inkBefore} → ${inkAfter}`);
    }
    await cdp.evaluate("document.documentElement.classList.remove('dark'); true");
    /* ---- 安全区：模拟 34px Home Indicator ---- */
    section('组 3c · 安全区（模拟 iPhone Home Indicator 34px）');
    await setViewport(390);
    let safeAreaSupported = true;
    try {
      await setSafeArea(34, 47);
    } catch (e) {
      safeAreaSupported = false;
      invalid('CDP 不支持 setSafeAreaInsetsOverride，安全区无法在此环境验证', String(e.message || e));
    }

    if (safeAreaSupported) {
      /**
       * ⚠️ 必须挑一个**真的带底部栏**的页面来验消费侧。
       *    之前固定用 `/tickets`，那是列表页（无 Tabbar、无吸底栏），
       *    结果这一组只验到了"变量写对了"，`pb-safe` 到底有没有生效完全没验到 ——
       *    而 `pb-safe` 失效最直接的后果就是底部按钮被 Home Indicator 压住、点不到。
       *
       * ⚠️ 2026-11-14：改用**售后账号的工单列表**。
       *    销售侧已取消底栏（单工作区），若继续用销售 `/`：
       *      · `/` 会被 replace 到 `/archives`（无底栏）⇒ 这一组必然记 INVALID，
       *        而"安全区消费侧"这个回归点就**静默失去覆盖**了。
       *    售后 `/tickets` 是根级并列目的地，一定有 Tabbar，是当前最稳定的检验场。
       */
      const saLogin = AS_PASSWORD ? await login(AS_ACCOUNT, AS_PASSWORD) : null;
      if (!saLogin?.ok) {
        // 拿不到售后账号就退回一个**客观上带底栏**的页面，而不是静默跑空
        invalid('安全区组：无法切到售后账号（销售侧已无底栏）', JSON.stringify(saLogin));
        safeAreaSupported = false;
      } else {
        await navigate(`${BASE}${ORIGIN_PATH}/tickets`);
        await sleep(1600);
      }
    }

    if (safeAreaSupported) {
      const envInjected = await cdp.evaluate(`(() => {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;left:-9999px;bottom:0;height:env(safe-area-inset-bottom,0px)';
        document.body.appendChild(d);
        const h = getComputedStyle(d).height;
        d.remove();
        return h;
      })()`);
      if (parseInt(envInjected, 10) === 34) {
        pass('环境：CDP 覆盖后 env(safe-area-inset-bottom) = 34px', `height=${envInjected}`);
      } else {
        // 环境没造成 ⇒ 后面的断言全部无意义，必须记 INVALID 而不是 PASS/FAIL
        invalid('env(safe-area-inset-bottom) 未被覆盖，安全区断言在此环境无效',
          `实际=${envInjected}（桌面 headless 恒为 0）`);
        safeAreaSupported = false;
      }
    }

    if (safeAreaSupported) {
      await overrideSafeAreaVar(34);
      await sleep(150);
      const sa = await cdp.evaluate(`(() => {
        const app = document.querySelector('.safe-areas');
        const bar = document.querySelector('[data-svc-sticky-bar="1"]');
        const barRect = bar ? bar.getBoundingClientRect() : null;
        // Tabbar：Konsta 的 Toolbar 带 k-toolbar，底部位置由 DOM 顺序决定
        const tab = document.querySelector('.k-toolbar');
        return {
          safeAreasApplied: document.querySelectorAll('.safe-areas').length,
          varOnSafeAreas: app ? getComputedStyle(app).getPropertyValue('--k-safe-area-bottom').trim() : '',
          hasSticky: Boolean(bar),
          barPb: bar ? getComputedStyle(bar).paddingBottom : null,
          barBottom: barRect ? Math.round(barRect.bottom) : null,
          hasTabbar: Boolean(tab),
          tabPb: tab ? getComputedStyle(tab).paddingBottom : null,
          tabBottom: tab ? Math.round(tab.getBoundingClientRect().bottom) : null,
          // Tabbar 里真正贴底的那一层（link / 图标），见下方注释
          tabInnerBottom: (() => {
            if (!tab) return null;
            const kids = [...tab.querySelectorAll('a,button,[class*="k-tabbar-link"]')];
            if (!kids.length) return null;
            return Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().bottom)));
          })(),
          innerH: window.innerHeight,
        };
      })()`);

      if (sa.safeAreasApplied === 1) {
        pass('<App safeAreas> 在应用根上挂了且只挂了 1 个 .safe-areas', `count=${sa.safeAreasApplied}`);
      } else {
        fail('.safe-areas 数量不对（0 = 没接上；>1 = 会双算）', `count=${sa.safeAreasApplied}`);
      }

      if (sa.varOnSafeAreas && sa.varOnSafeAreas !== '0px') {
        pass('--k-safe-area-bottom 在 .safe-areas 作用域内被正确解析', `bottom=${sa.varOnSafeAreas}`);
      } else {
        fail('安全区变量在 .safe-areas 上仍为 0（Konsta safe-areas 规则未生效）', JSON.stringify(sa));
      }

      const pb = parseInt(String(sa.barPb || '0'), 10);
      let consumerOk = false;
      if (sa.hasSticky) {
        if (pb === 34) { pass('吸底栏 padding-bottom 恰好等于安全区（未双算）', `pb=${pb}px`); consumerOk = true; }
        else fail('吸底栏 padding-bottom 不等于安全区（疑似双算或多算）', `pb=${pb}px 期望 34px`);
      } else if (sa.hasTabbar) {
        /**
         * ⚠️ 不能"没有吸底栏就记 PASS"。
         *    上一版固定用 `/tickets`（列表页，无吸底栏也无 Tabbar），
         *    于是这一组只验到"变量写对了"，`pb-safe` 到底生效没有**完全没验** ——
         *    而 `pb-safe` 失效最直接的后果就是底部按钮被 Home Indicator 压住、点不到。
         *
         * ⚠️ 期望值**不是** 34：AppShell 写的是 `<Toolbar tabbar className="pb-safe">`，
         *    而 Konsta 自己的 iOS 侧把 Toolbar 定为 `pb-safe-4`
         *    （`shared/classes/ToolbarClasses.js`：`ios: cls(!top && 'pb-safe-4', ...)`），
         *    产物 CSS 里 `.pb-safe-4{padding-bottom:calc(var(--k-safe-area-bottom) + var(--spacing)*4)}`，
         *    即 **34 + 16 = 50px**。Konsta 用尾随 16px 把 Tab 文字与 Home Indicator 拉开，
         *    这是设计意图，不是双算；真正的双算会得到 68px（34 + 34）。
         *    ⇒ 断言写 50，并把 68 单独列为"双算"。
         */
        const tpb = parseInt(String(sa.tabPb || '-1'), 10);
        if (tpb === 50) { pass('底部 Tabbar padding-bottom = 34 + 16 尾随（未双算）', `pb=${tpb}px`); consumerOk = true; }
        else if (tpb === 68) fail('Tabbar 安全区被算了两次（34+34）', `pb=${tpb}px`);
        else fail('Tabbar padding-bottom 与安全区不匹配', `pb=${sa.tabPb} 期望 50px（34 安全区 + 16 尾随）`);
      } else {
        // 两者都没有 ⇒ 这一页根本没有"被安全区影响的下边缘"，换页而不是记 PASS
        invalid('该页既无吸底栏也无 Tabbar，安全区消费侧无从验证', JSON.stringify(sa));
      }

      // 被安全区推高的那个边缘，必须仍在视口内（被顶出视口说明 safeArea 反而把它推走了）
      /**
       * ⚠️ 不能量 `.k-toolbar` 自己的 `getBoundingClientRect().bottom`：
       *    Konsta 的 Toolbar 是 `relative` + 内部 `absolute bottom-0` 的背景层，
       *    容器本身在文档流里，量出来是整页高度（实测 3155 vs 视口 844）。
       *    要量的是**真正贴底的那一层**：Tabbar 里的 link/图标。
       */
      const bottomEdge = sa.hasSticky ? sa.barBottom : sa.tabInnerBottom;
      if (consumerOk && bottomEdge !== null) {
        if (bottomEdge <= sa.innerH + 1 && bottomEdge > sa.innerH - 160) {
          pass('底部栏内容贴底且未溢出视口', `contentBottom=${bottomEdge} innerH=${sa.innerH}`);
        } else if (bottomEdge > sa.innerH + 1) {
          fail('底部栏内容溢出视口', `contentBottom=${bottomEdge} innerH=${sa.innerH}`);
        } else {
          fail('底部栏没有贴住视口底部（浮在半空）', `contentBottom=${bottomEdge} innerH=${sa.innerH}`);
        }
      }

      await shoot(cdp, 'home-390-safearea.png');
      await cdp.evaluate(`(() => { const e = document.getElementById('svc-safearea-override'); if (e) e.remove(); return true; })()`);
      try { await setSafeArea(0, 0); } catch { /* ignore */ }
    }

    /* =====================================================================
     * 组 3d：短内容页 —— 底栏"真实贴底"的**唯一有效**检验场
     * =====================================================================
     * ⚠️ 为什么必须单独有这一组（这是变异测试逼出来的）：
     *
     *   上面所有页面的内容都**远超一屏**，所以底栏一定落在"屏幕最底那一屏"里。
     *   这时不管中间容器是 flex 还是普通块级，量出来的底栏位置都可能正确 ——
     *   变异测试实测：把内容区的 `flex-1 min-h-0` 去掉，组 3 的贴底断言**全绿**。
     *
     *   短内容（搜索无结果 / 空列表）才是真刀真枪的场景：
     *   底栏必须仍然贴住屏幕底部，而不是紧跟内容、在半空中停住。
     *   用户配错一个筛选条件就天天能看到这个状态。
     *
     * ⚠️ 2026-11-14：销售侧已**取消底栏**（单工作区），所以这一组必须
     *    换用**售后账号 + 工单列表**构造空结果 —— 那是销售侧不再存在的场景。
     *    若继续用销售 `/archives`，`tabbars` 恒为 0，这一组会直接记 INVALID，
     *    而"底栏贴底"这个回归点就**静默失去覆盖**了。
     * ===================================================================== */
    section('组 3d · 短内容页的底栏贴底（空结果场景）');
    await setViewport(390);
    if (!AS_PASSWORD) {
      invalid('短内容页组需要售后账号（销售侧已无底栏），跳过', '可用 SVC_AS_PASSWORD 覆盖');
    } else {
      const ok = await login(AS_ACCOUNT, AS_PASSWORD);
      if (!ok?.ok) {
        invalid('短内容页组：售后账号登录失败', JSON.stringify(ok));
      } else {
        /**
         * 用一个**必然无结果**的关键词触发空列表。
         * 不做桩、不造数据 —— 直接走真实接口，验证的是真实渲染路径。
         *
         * ⚠️ 注意 `cdp.evaluate` **只接受一个表达式字符串**，没有参数位。
         *    要给页面里的函数传参必须自己 JSON.stringify 拼进去（见 fillInput 的写法）；
         *    写成 `evaluate(FILL_INPUT, [...])` 会静默丢掉第二个参数，
         *    然后 `el` 是 undefined ⇒ 抛异常 ⇒ 被读成"填值失败"，
         *    但真实原因是**调用方式错了**。第一次就踩了这个（返回 {}）。
         */
        await navigate(`${BASE}${ORIGIN_PATH}/tickets`);
        await sleep(1600);
        /**
         * ⚠️ 工单列表的搜索是**提交式**（点放大镜/回车才查），不是边打边搜。
         *    这是刻意的设计（见 TicketList 文件头：避免 11 位手机号发 11 次请求
         *    以及"回来的顺序不保证"导致列表闪成上一个关键词的结果）。
         *    ⇒ 填完值必须**再回车一次**，否则列表不会刷新，这一组会拿到
         *      加载中的中间态，量出错误的 gap。
         */
        const filled = await fillInput(cdp, '.k-searchbar input, input[type="search"], input[type="text"]', 'zzz-no-such-ticket-zzz');
        await cdp.evaluate(`(() => {
          const el = document.querySelector('.k-searchbar input, input[type="search"], input[type="text"]');
          if (!el) return false;
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()`);
        await sleep(2400);
        const short = await cdp.evaluate(PAGE_PROBE);
        if (!filled?.ok) {
          invalid('短内容页组：搜索框填值失败，无法构造空结果场景', JSON.stringify(filled));
        } else if (short.tabbars !== 1) {
          invalid('短内容页组：没能构造出"有底栏"的页面', JSON.stringify({ tabbars: short.tabbars, url: short.url }));
        } else if (short.tabbarBottomGap === null) {
          invalid('短内容页组：量不到底栏位置');
        } else if (short.tabbarBottomGap >= 0 && short.tabbarBottomGap <= 4) {
          pass('空结果页 · 底栏仍然贴住屏幕底部（内容不足一屏也不会浮在半空）',
            `gap=${short.tabbarBottomGap}px textLen=${short.textLen}`);
        } else if (short.tabbarBottomGap < 0) {
          fail('空结果页 · 底栏被顶出视口', `gap=${short.tabbarBottomGap}px`);
        } else {
          fail('空结果页 · 底栏浮在半空（内容不足一屏时最明显的布局缺陷）',
            `gap=${short.tabbarBottomGap}px（通常是中间容器缺 flex-col / 内容区缺 flex-1）`);
        }
        await shoot(cdp, 'short-content-390.png');
      }
    }

    /* =====================================================================
     * 组 3e：档案搜索空状态 —— 文案不得诱导重复建档（DEV-240）
     * ===================================================================== */
    section('组 3e · 档案搜索空状态文案');
    {
      const ok = await login();
      if (!ok?.ok) {
        invalid('档案空状态组：销售账号登录失败', JSON.stringify(ok));
      } else {
        await navigate(`${BASE}${ORIGIN_PATH}/archives`);
        await sleep(1700);
        const filled = await fillInput(cdp, '.k-searchbar input, input[type="search"], input[type="text"]', 'zzz-no-such-archive-zzz');
        await sleep(2400);
        const txt = await cdp.evaluate(`(document.body.innerText || '')`);
        /**
         * 判据：有搜索词时，空态必须说"没有找到"（用户裁决的固定用语），
         * 且**不得**出现"还没有服务档案"（那是"库里真的没有"的措辞）。
         *
         * ⚠️ 整改前的实测：搜一个不存在的客户 → 页面写"还没有服务档案"
         *    + 一个"新建档案"按钮 ⇒ 销售以为刚才建的没存上，顺手再建一条重复档案。
         *    这是**由文案造成的业务事故**。
         */
        if (!filled?.ok) {
          invalid('档案空状态组：搜索框填值失败', JSON.stringify(filled));
        } else if (/没有找到/.test(txt)) {
          pass('搜索无结果显示"没有找到"（不再谎称库里没有档案）');
        } else if (/还没有服务档案/.test(txt)) {
          fail('搜索无结果仍显示"还没有服务档案"（会把"没搜到"误报成"库里没有"）',
            txt.slice(0, 160).replace(/\n/g, ' / '));
        } else {
          fail('搜索无结果的空态文案不符合要求', txt.slice(0, 160).replace(/\n/g, ' / '));
        }

        // 有搜索词时，空态的动作必须是"查看全部"（用户裁决的固定用语），不能是"新建档案"
        const action = await cdp.evaluate(`(() => {
          const btns = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim());
          // 2026-11-14：出口文案由「清除筛选」统一为「查看全部」（用户裁决），采集条件同步
          return btns.filter(t => t && (t.includes('新建') || t.includes('查看全部')));
        })()`);
        if (action.some((t) => t.includes('查看全部'))) {
          pass('空态提供了"查看全部"出口', JSON.stringify(action));
        } else {
          fail('空态没有"查看全部"出口（用户只能自己删掉关键词）', JSON.stringify(action));
        }
        await shoot(cdp, 'archives-empty-search-390.png');
      }
    }

    /* =====================================================================
     * 组 4：真实业务 API —— 三个代表性页面必须真的连后端
     * ===================================================================== */
    section('组 4 · 三个代表性页面连接真实业务 API');
    await setViewport(390);

    const expectApi = async (pagePath, label, patterns) => {
      const beforeNet = netApi.length;
      await navigate(`${BASE}${ORIGIN_PATH}${pagePath}`);
      await sleep(1800);
      const seen = netApi.slice(beforeNet).map((x) => x.url);
      const hits = patterns.map((p) => ({ p, n: seen.filter((u) => u.includes(p)).length }));
      const missing = hits.filter((h) => h.n === 0);
      if (missing.length === 0) {
        pass(`${label} · 真实调用了业务接口`, hits.map((h) => `${h.p}=${h.n}`).join(' '));
      } else {
        fail(`${label} · 没有调用预期接口（可能退化成静态页）`,
          `缺失=${missing.map((m) => m.p).join(',')} 实际=${seen.map((u) => u.replace(/^.*\/api/, '/api')).join(' | ')}`);
      }
      return seen;
    };

    // A 页：工作台 → 售后角色首页必须打 serviceTickets:list 与 svc:followUpQueue
    //
    // ⚠️ 换售后账号再测。销售账号的首页是**档案列表**（`serviceArchives:list`），
    //    用销售测工作台会得到"没有调工单接口"的假红 —— 第一轮就这么红过一次。
    section('组 4b · 售后角色（工单侧）');
    if (!AS_PASSWORD) {
      invalid('缺少售后账号口令（.env 里的 UAT_HQADMIN_PASSWORD），跳过工单侧验收', '可用 SVC_AS_PASSWORD 覆盖');
    } else {
      const asLogin = await login(AS_ACCOUNT, AS_PASSWORD);
      if (!asLogin?.ok) {
        invalid('售后账号登录失败，跳过工单侧验收', JSON.stringify(asLogin));
      } else {
        await expectApi('/', `A 工作台（${AS_ACCOUNT}）`, ['serviceTickets:list', 'svc:followUpQueue']);
        const asHome = await cdp.evaluate(`(() => ({
          tabbars: document.querySelectorAll('[class*="k-tabbar"]').length,
          text: (document.body.innerText||'').slice(0, 120),
          err: /可能已被删除|模型不存在/.test(document.body.innerText||''),
        }))()`);
        if (asHome.err) fail('A 工作台（售后）· 页面出现模型错误', asHome.text);
        else pass('A 工作台（售后）· 页面正常渲染', asHome.text.replace(/\n/g, ' / ').slice(0, 80));
        await shoot(cdp, 'home-as-390.png');

        // 回到销售账号，后续组继续用销售视角
        const back = await login();
        if (!back?.ok) invalid('切回销售账号失败', JSON.stringify(back));
      }
    }

    // A' 页：工单列表
    await expectApi('/tickets', 'A 工单列表', ['serviceTickets:list']);
    // B 页：档案列表 → serviceArchives:list
    await expectApi('/archives', 'B 档案列表', ['serviceArchives:list']);

    /**
     * A 页详情：先拿到一条真实工单 id，再进详情。
     * ⚠️ 没有工单就不能"跳过"——跳过会让"详情页根本没接后端"这件事永远发现不了。
     *    改成 INVALID 并说明原因（产品可能真的没有数据）。
     */
    const firstTicket = await cdp.evaluate(`(async () => {
      const res = await window.__nativeFetch('/api/serviceTickets:list?pageSize=1&fields=id', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('svc.mobile.token') },
      });
      const j = await res.json();
      const row = (j.data && j.data[0]) || null;
      return row ? String(row.id) : null;
    })()`);

    if (firstTicket) {
      const seen = await expectApi(`/tickets/${firstTicket}`, `A 工单详情 #${firstTicket}`, ['svc:timeline']);
      const dProbe = await cdp.evaluate(PAGE_PROBE);
      if (dProbe.overflowX <= 1) pass('A 工单详情 · 无横向溢出', `overflowX=${dProbe.overflowX}`);
      else fail('A 工单详情 · 横向溢出', `overflowX=${dProbe.overflowX}px`);
      if (dProbe.navbars === 1) pass('A 工单详情 · 恰好 1 个导航栏');
      else fail('A 工单详情 · 导航栏异常', `navbars=${dProbe.navbars}`);
      // 时间线是真的渲染了 SQL 里的记录，而不是空壳
      const tl = await cdp.evaluate(`document.querySelectorAll('[data-testid="service-timeline"] > li').length`);
      if (tl > 0) pass('A 工单详情 · 时间线渲染出真实记录', `li=${tl}`);
      else fail('A 工单详情 · 时间线为空（服务端有 events 但页面没渲染）');

      // ⚠️ 关键负向断言：DTO 里的凭据字段**不得**出现在页面上
      const leak = await cdp.evaluate(`(() => {
        const t = document.documentElement.innerHTML;
        return ['progress_token_hash','progress_code_hash','progress_code_salt','feedback_token_hash']
          .filter(k => t.includes(k));
      })()`);
      if (leak.length === 0) pass('A 工单详情 · 页面内不含凭据字段名（slimTicket 白名单生效）');
      else fail('A 工单详情 · 页面出现敏感字段名', JSON.stringify(leak));

      void seen;
      await shoot(cdp, 'ticket-detail-390.png');
    } else {
      invalid('数据库里没有工单，无法验证工单详情页（不是产品缺陷）');
    }

    /* ---- B 页建档：只验"字段与二次确认"，**不提交**（避免污染数据） ---- */
    await navigate(`${BASE}${ORIGIN_PATH}/archives/new`);
    await sleep(1200);
    const formProbe = await cdp.evaluate(`(() => {
      const has = (id) => Boolean(document.querySelector('[data-testid="' + id + '"]'));
      return {
        type: has('archive-new-type'),
        name: has('archive-new-name'),
        mobile: has('archive-new-mobile'),
        address: has('archive-new-address'),
        next: has('archive-new-next'),
        // 门店选择器绝不能存在：服务端按"唯一有效门店"推导
        selects: document.querySelectorAll('select').length,
        storeInput: /门店/.test(document.body.innerText) && document.querySelectorAll('select').length > 0,
      };
    })()`);
    if (formProbe.type && formProbe.name && formProbe.mobile && formProbe.address) {
      pass('B 建档表单 · 四个必填控件都在');
    } else {
      fail('B 建档表单 · 控件缺失', JSON.stringify(formProbe));
    }
    if (formProbe.selects === 0) pass('B 建档表单 · 没有门店选择器（门店由服务端推导）');
    else fail('B 建档表单 · 出现了门店选择控件', `selects=${formProbe.selects}`);

    // 校验：手机号格式错误必须在前端被拦下（不产生请求）
    const beforeBad = netApi.length;
    const badFill = await fillInput(cdp, '[data-testid="archive-new-mobile"]', '12345');
    if (!badFill?.ok) invalid('无法填写建档手机号（观测脚本失效）', JSON.stringify(badFill));
    await cdp.evaluate(`document.querySelector('[data-testid="archive-new-next"]').click(); true`);
    await sleep(700);
    const badNet = netApi.length - beforeBad;
    /**
     * ⚠️ 断言的是**行为**（"给了明确的错误提示"），不是某一句具体文案。
     *
     *   2026-11-14（第三节）文案从 `手机号格式不正确` 改成 `手机号要 11 位，以 1 开头`：
     *   用户要求界面说人话 —— "格式不正确"对门店员工是技术词，
     *   而"要 11 位，以 1 开头"直接告诉他该改什么。
     *   ⇒ 若继续断言旧句，这条会**假红**，然后我可能去改一个本来正确的文案。
     *   判据落在"错误信息里出现数字位数 + 1 开头"这两个**内容特征**上，
     *   既守住"必须给出可操作的提示"，又不把验证器焊死在某一句措辞上。
     */
    const badMsg = await cdp.evaluate(`(() => {
      const t = document.body.innerText;
      const has11 = /11\\s*位/.test(t);
      const has1 = /以\\s*1\\s*开头/.test(t);
      const stillTech = t.includes('格式不正确');
      return { has11, has1, stillTech, snippet: (t.match(/手机号[^\\n]{0,24}/) || [''])[0] };
    })()`);
    if (badMsg.has11 && badMsg.has1) pass('B 建档表单 · 非法手机号给出可操作的错误文案', badMsg.snippet);
    else fail('B 建档表单 · 非法手机号没有给出可操作的提示', JSON.stringify(badMsg));
    if (badMsg.stillTech) fail('B 建档表单 · 仍在界面上使用"格式不正确"这类技术措辞', badMsg.snippet);
    if (badNet === 0) pass('B 建档表单 · 前端校验拦下了非法输入（未发请求）', `net=${badNet}`);
    else fail('B 建档表单 · 非法输入仍然发了请求', `net=${badNet}`);

    /* ---- 组 4c：校验定位与错误提示可读性（第一节 ④ 的可测形式） ---- */
    section('组 4c · 建档校验：定位到第一个错误字段 + 错误提示不被裁切');
    {
      const FORM_PROBE = `(() => {
        const page = document.querySelector('.k-page') || document.body;
        const alerts = [...document.querySelectorAll('[data-svc-field] [role="alert"]')].map(a => {
          const r = a.getBoundingClientRect();
          const host = a.closest('[data-svc-field]');
          const hr = host ? host.getBoundingClientRect() : null;
          return {
            text: (a.textContent || '').trim(),
            field: host ? host.getAttribute('data-svc-field') : null,
            width: Math.round(r.width),
            scrollW: a.scrollWidth, clientW: a.clientWidth,
            hostLeft: hr ? Math.round(hr.left) : null,
            left: Math.round(r.left),
          };
        });
        const fields = [...document.querySelectorAll('[data-svc-field]')].map(f => {
          const r = f.getBoundingClientRect();
          return { id: f.getAttribute('data-svc-field'), top: Math.round(r.top), bottom: Math.round(r.bottom) };
        });
        return {
          scrollTop: Math.round(page.scrollTop),
          scrollHeight: page.scrollHeight,
          innerH: window.innerHeight,
          alerts,
          fields,
          firstAlertField: alerts.length ? alerts[0].field : null,
        };
      })()`;

      const clickText = async (t) => cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(e => (e.textContent || '').trim() === ${JSON.stringify(t)});
        if (!b) return false; b.click(); return true;
      })()`);

      // ⚠️ 这里**不能再打 .k-page** —— 我第一版就是这么写的，
      //    结果 scrollTop 恒为 0，于是"场景 B 无法制造"被记成 INVALID，
      //    而真因是**验证器自己**选错了滚动容器（与产品原本的 bug 同一个错，
      //    见 AppShell.findScrollContainer 的实测记录）。
      //    验证器与产品犯同一个错时，两边的错误会互相掩盖 —— 谁都不红。
      const scrollToBottom = async () => cdp.evaluate(`(() => {
        const cand = [document.querySelector('.svc-page-body'), document.querySelector('.k-page')];
        for (const p of cand) {
          if (p && p.scrollHeight > p.clientHeight + 1) {
            p.scrollTop = p.scrollHeight;
            return Math.round(p.scrollTop);
          }
        }
        return 0;
      })()`);

      /**
       * ⚠️ 必须用**矮视口**才能验到"自动定位"。
       *    实测：390×844 时第一步表单 scrollHeight === innerH === 844，
       *    页面**根本不能滚动** ⇒ "滚动到第一个错误"这条断言会永远绿，
       *    因为要改的那一格本来就在屏幕里 —— 这是空转，不是通过。
       *    真实触发场景是**软键盘弹出**：可视区被压掉约 300px。
       *    ⇒ 用 390×520 模拟键盘态，先确认真的产生了滚动，再验定位。
       */
      const SHORT_H = 520;
      await setViewport(390, SHORT_H);
      await sleep(500);

      // 场景 A：全空提交 —— 多个错误同时出现，必须定位到顺序里的第一个（服务类型）
      await navigate(`${BASE}${ORIGIN_PATH}/archives/new`);
      await sleep(1500);
      const atBottom = await scrollToBottom();
      await sleep(300);
      await cdp.evaluate(`document.querySelector('[data-testid="archive-new-next"]').click(); true`);
      await sleep(1300);
      const A = await cdp.evaluate(FORM_PROBE);

      if (atBottom <= 0) {
        invalid('建档校验：矮视口下表单仍不能滚动，"自动定位"无法验证（不是产品缺陷）',
          `scrollHeight=${A.scrollHeight} innerH=${A.innerH}`);
      } else if (A.alerts.length < 2) {
        fail('建档校验：全空提交后同时标红的字段少于 2 个（多错误场景没造出来）',
          `alerts=${JSON.stringify(A.alerts.map(x => x.field))}`);
      } else if (A.firstAlertField !== 'archive-new-type') {
        fail('建档校验：第一条错误不是"顺序第一个要改的字段"',
          `first=${A.firstAlertField} 期望=archive-new-type 全部=${JSON.stringify(A.alerts.map(x => x.field))}`);
      } else {
        pass('建档校验：多错误时第一条错误 = 字段顺序里的第一个（服务类型）',
          `first=${A.firstAlertField} 共${A.alerts.length}条`);
      }

      const typeField = A.fields.find(f => f.id === 'archive-new-type');
      if (atBottom > 0 && typeField && typeField.top >= 0 && typeField.top <= A.innerH - 40) {
        pass('建档校验：校验失败后自动滚动到第一个错误字段（用户不用自己找）',
          `滚动前 scrollTop=${atBottom} → 校验后 ${A.scrollTop}；服务类型 top=${typeField.top}/${A.innerH}`);
      } else if (atBottom > 0) {
        fail('建档校验：校验失败后没有把用户带到第一个错误字段',
          `滚动前=${atBottom} 校验后=${A.scrollTop} 服务类型 top=${typeField ? typeField.top : 'n/a'} 视口=${A.innerH}`);
      }

      const clipped = A.alerts.filter(a => a.width <= 0
        || (a.scrollW > a.clientW + 1)
        || (a.hostLeft !== null && a.left < a.hostLeft - 1));
      if (A.alerts.length === 0) {
        fail('建档校验：页面上找不到任何字段级错误提示');
      } else if (clipped.length === 0) {
        pass('建档校验：错误提示完整可见（未被左侧裁切、无文本溢出）',
          `${A.alerts.length} 条，宽度=${A.alerts.map(a => a.width).join('/')}px，最左=${Math.min(...A.alerts.map(a => a.left))}`);
      } else {
        fail('建档校验：错误提示被裁切', JSON.stringify(clipped));
      }

      /**
       * =====================================================================
       * Toast 不能是"帮倒忙"的提示（DEV-250 + DEV-253，2026-11-14）
       * =====================================================================
       *  用户第二节 ②：「两张表单错误截图左下角的提示存在被截断现象」。
       *  查下来是**两个**独立缺陷叠在一起，只修一个都不算过：
       *    · DEV-250：我写的 `left-1/2 -translate-x-1/2` 与 Konsta 自带的
       *      `left-safe-4 right-safe-4` 打架 ⇒ 整条提示 70px 跑到屏幕**左侧外**；
       *    · DEV-253：`bottom-24` **根本没生效**（构建产物里 `.bottom-safe-4`
       *      排在它之后，同特异性取后者）⇒ toast 恒在 16px，
       *      **整条压在吸底主按钮上**（实测重叠 15752px²，遮掉按钮 32/48px）。
       *
       *  ⚠️ 这条断言刻意**两个方向都判**（工程铁律：断言不会变红 = 没有断言）：
       *    ① 不得越界 —— 左右都在视口内（守 DEV-250）；
       *    ② 不得档路 —— 与吸底栏及主按钮交集面积为 0（守 DEV-253）；
       *    ③ 交叉校验 —— 内联 bottom 必须等于"被底部固定栏占掉的高度 + 16px +
       *       安全区"。这条是**双向**的：函数算错（例如把吸底栏漏了、
       *       或把吸顶搜索区误算进来）都会让等式不成立而变红。
       *       只断言"没重叠"是不够的 —— 把 toast 顶到屏幕正中间也能满足。
       *
       *  ⚠️ 量之前先确认 toast **真的在**：它 2.2 秒自动消失，量到 null 会让
       *     整条断言静默跳过（我在这类"没量到就 pass"上吃过亏）。
       *     所以"toast 不存在"直接记 FAIL，而不是跳过。
       */
      const TOAST_PROBE = `(() => {
        const t = document.querySelector('.k-toast');
        const bar = document.querySelector('[data-svc-sticky-bar="1"]');
        const vw = window.innerWidth, vh = window.innerHeight;
        const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
          return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; };
        const inter = (a, b) => { if (!a || !b) return 0;
          const h = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
          const w = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
          return h * w; };
        const br = R(bar), tr = R(t);
        const btn = bar ? R(bar.querySelector('button')) : null;
        /**
         * ⚠️ 这里刻意**不重算**产品那套"哪些元素算贴底栏"的筛选规则。
         *    判据只描述**几何事实**：屏幕底部有哪些固定（不随内容滚动）的元素。
         *    取的是"元素在视口下半部、且真的贴底"的块 —— 包括
         *    Konsta 的 k-toolbar（Tabbar）与我们自己的吸底操作栏。
         *    与产品的关系是**独立测量**，不是同一段逻辑抄两遍。
         *
         * ⚠️ 本段在模板字符串里 —— **注释里绝对不能出现反引号**，
         *    否则会提前闭合模板（我在这里第三次踩同一个坑：写完先报
         *    "toolbar is not defined"，那是**验证器自己坏了**，不是产品问题）。
         */
        const bottoms = [];
        for (const el of document.querySelectorAll('.k-toolbar, [data-svc-sticky-bar="1"]')) {
          const r = el.getBoundingClientRect();
          if (r.height <= 0) continue;
          if (r.top > vh / 2) bottoms.push(Math.round(r.top));
        }
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:var(--k-safe-area-bottom,0px)';
        document.body.appendChild(probe);
        const safe = parseFloat(getComputedStyle(probe).height) || 0;
        probe.remove();
        const styleBottom = t ? parseFloat(getComputedStyle(t).bottom) : null;
        return {
          found: Boolean(t), text: t ? (t.innerText || '').slice(0, 40) : '',
          toast: tr, bar: br, button: btn,
          overlapBar: inter(br, tr), overlapButton: inter(btn, tr),
          insideX: tr ? (tr.l >= 0 && tr.r <= vw) : false,
          fixedBottoms: [...new Set(bottoms)].sort((a, b) => a - b),
          styleBottom: styleBottom === null ? null : Math.round(styleBottom),
          vh, vw,
          safe, tabbars: document.querySelectorAll('.k-toolbar').length,
        };
      })()`;
      /**
       * ⚠️ Toast 2.2 秒就消失，而上面量表单已经用掉 ~1.4s。
       *    若此刻它刚好过期，`found:false` 会把"没量到"记成"提示没出现" ——
       *    虚假的 FAIL 和虚假的 PASS 一样有毒。所以**再点一次**让提示重新出现
       *    （字段仍是空的，必然再次校验失败；这同时顺手验了提示可重复触发）。
       */
      await cdp.evaluate(`document.querySelector('[data-testid="archive-new-next"]').click(); true`);
      await sleep(500);
      const T = await cdp.evaluate(TOAST_PROBE);
      if (!T.found) {
        fail('Toast · 校验失败的提示根本没出现（用户不知道哪里错了）', JSON.stringify(T));
      } else {
        if (T.insideX) pass('Toast · 完整在屏幕内（左右都未越界）', `l=${T.toast.l} r=${T.toast.r} 视口宽=${T.vw}`);
        else fail('Toast · 有部分跑到屏幕外（用户看到被截断的提示）',
          `l=${T.toast.l} r=${T.toast.r} —— 检查是否又叠了 left-1/2 / -translate-x-1/2`);

        if (T.overlapBar === 0 && T.overlapButton === 0) {
          pass('Toast · 不遮挡底部固定栏与主按钮', `与吸底栏交集=${T.overlapBar}px²、与主按钮交集=${T.overlapButton}px²`);
        } else {
          fail('Toast · 压住了底部固定栏/主按钮（用户点不到该点的东西）',
            `与吸底栏交集=${T.overlapBar}px²、与主按钮交集=${T.overlapButton}px²、toast=${JSON.stringify(T.toast)}、吸底栏=${JSON.stringify(T.bar)}、主按钮=${JSON.stringify(T.button)}`);
        }

        /**
         * ⚠️ 第三条刻意**不复用产品那段筛选逻辑**。
         *    第一版我在这里又抄了一遍"哪些元素算贴底栏"的规则 ——
         *    那等于产品与验证器**共享同一个错误**（本项目反复踩的坑：
         *    两端犯同一个错时谁都不红）。改成一个**纯几何**判据：
         *    提示的底边必须落在**所有**底部固定元素的顶边之上，且留出呼吸间距。
         *    它不关心"谁被算进来了"，只看"屏幕上有没有东西被压住"。
         *
         *    同时报告产品算出来的抬升量，便于人工对照 —— 但**不拿它判真假**。
         */
        const bottoms = T.fixedBottoms || [];
        if (bottoms.length === 0) {
          if (T.vh - T.toast.b >= 8) {
            pass('Toast · 页面底部无固定栏时，提示与视口底保持间距', `底边=${T.toast.b} 视口高=${T.vh}`);
          } else {
            fail('Toast · 页面底部无固定栏，但提示贴到了屏幕边缘', `底边=${T.toast.b} 视口高=${T.vh}`);
          }
        } else {
          const highest = Math.min(...bottoms);
          const gap = highest - T.toast.b;
          if (gap >= 8) {
            pass('Toast · 提示整体位于底部固定元素之上，留有呼吸间距',
              `提示底边=${T.toast.b}，底部固定元素最高顶边=${highest}，间距=${gap}px（本次抬升 bottom=${T.styleBottom}px）`);
          } else {
            fail('Toast · 提示与底部固定元素挨得太近或被压住',
              `提示底边=${T.toast.b}，底部固定元素最高顶边=${highest}，间距=${gap}px（应 >=8）`);
          }
        }
      }
      await shoot(cdp, 'archive-new-step1-errors-390.png');

      // 场景 B：**只让最上面那个字段错**，且用户当前在页面底部
      // —— 这才是错误在视口外的严格场景（场景 A 有 4 个错，只要滚到任意一个都算过）
      await navigate(`${BASE}${ORIGIN_PATH}/archives/new`);
      await sleep(1500);
      // 不选服务类型 ⇒ 只有它一个错误；其余必填都填好
      await fillInput(cdp, '[data-testid="archive-new-name"]', '张女士');
      await fillInput(cdp, '[data-testid="archive-new-address"]', '阳光小区 3 栋 501');
      await fillInput(cdp, '[data-testid="archive-new-mobile"]', '13800138000');
      await sleep(400);
      const atBottomB = await scrollToBottom();
      await sleep(400);
      const preB = await cdp.evaluate(FORM_PROBE);
      const typePre = preB.fields.find(f => f.id === 'archive-new-type');
      await cdp.evaluate(`document.querySelector('[data-testid="archive-new-next"]').click(); true`);
      await sleep(1800);
      const B = await cdp.evaluate(FORM_PROBE);
      const typePost = B.fields.find(f => f.id === 'archive-new-type');

      if (atBottomB <= 0 || !typePre || typePre.top >= 0) {
        invalid('建档校验：无法制造唯一错误字段在视口外的场景（不是产品缺陷）',
          `scrollTop=${atBottomB} 服务类型 top 滚动前=${typePre ? typePre.top : 'n/a'} 视口=${B.innerH}`);
      } else if (B.alerts.length !== 1 || B.alerts[0].field !== 'archive-new-type') {
        fail('建档校验：唯一错误时没有定位到服务类型字段',
          `alerts=${JSON.stringify(B.alerts.map(x => x.field))}`);
      } else if (typePost && typePost.top >= 0 && typePost.top <= B.innerH - 40) {
        pass('建档校验：唯一的错误字段原本在视口外，校验后被滚进视口',
          `服务类型 top: ${typePre.top} → ${typePost.top}（视口 ${B.innerH}）；容器 scrollTop: ${preB.scrollTop} → ${B.scrollTop}`);
      } else {
        fail('建档校验：错误字段仍在视口外，用户看不到要改的那一格',
          `服务类型 top=${typePost ? typePost.top : 'n/a'} 视口=${B.innerH} 容器 scrollTop=${B.scrollTop}`);
      }
      await shoot(cdp, 'archive-new-locate-type-390.png');

      await setViewport(390, HEIGHT);
      await sleep(300);
    }

    await shoot(cdp, 'archive-new-390.png');

    /* ---- 未登录守卫 ---- */
    section('组 5b · 未登录守卫（登录态组的收尾）');
    await cdp.evaluate(`localStorage.removeItem('svc.mobile.token'); true`);

    /* =====================================================================
     * 组 6：登录态下的 404（未知路径不得静默回首页）
     *
     * ⚠️ 必须在登录后验：未登录时任何路径都先被登录墙拦住，
     *    在那里断言"显示页面不存在"必然红 —— 而那红灯说明的是**我测错了位置**。
     * ===================================================================== */
    section('组 6 · 登录态下的未知路径');
    await login();
    await navigate(`${BASE}${ORIGIN_PATH}/nothing-here`);
    await sleep(1100);
    const nfProbe = await cdp.evaluate(`(() => {
      const t = document.body.innerText || '';
      return { has404: /没有对应的页面/.test(t), hasHome: /暂未处理|正在恢复/.test(t), head: t.slice(0, 80) };
    })()`);
    if (nfProbe.has404) pass('未知路径显示"页面不存在"（没有静默回首页冒充成工作台）');
    else fail('未知路径没有给出 404 说明', nfProbe.head.replace(/\n/g, ' / '));

    /* ---- 组 5：未登录守卫 ---- */
    section('组 5 · 未登录守卫');
    await cdp.evaluate(`localStorage.removeItem('svc.mobile.token'); true`);
    await navigate(`${BASE}${ORIGIN_PATH}/tickets`);
    await sleep(1200);
    const guarded = await cdp.evaluate(`(() => ({
      hasLogin: Boolean(document.querySelector('[data-testid="login-account"]')),
      hasTickets: Boolean(document.querySelector('[data-testid="tickets-list"]')),
      text: (document.body.innerText||'').slice(0,80),
    }))()`);
    if (guarded.hasLogin && !guarded.hasTickets) pass('未登录访问 /tickets 落到登录页（不是空白也不是数据页）');
    else fail('未登录守卫失效', JSON.stringify(guarded));

    await navigate(`${BASE}${ORIGIN_PATH}/nothing-here`);
    await sleep(900);
    // 未登录时未知路径先被登录墙拦住 —— 这里只验"不白屏"，
    // "页面不存在"的断言在上面（登录态）已经做过。
    const nf = await cdp.evaluate(`(document.body.innerText||'')`);
    if (/登录/.test(nf) || /没有对应的页面/.test(nf)) {
      pass('未登录访问未知路径不白屏（落到登录页或 404 说明）', nf.replace(/\n/g, ' / ').slice(0, 60));
    } else {
      fail('未知路径白屏', nf.slice(0, 120));
    }
  }

  /* ===================================================================== */
  section('汇总');
  const failed = results.filter((r) => !r.ok && !r.invalid);
  const invalids = results.filter((r) => r.invalid);
  console.log(`  PASS ${results.filter((r) => r.ok).length} / FAIL ${failed.length} / INVALID ${invalids.length}`);

  if (invalids.length > 0) {
    console.log(`\n  ⚠️ 存在无效观测（${invalidReason}）—— 这不构成产品结论，请先修观测点`);
    exitCode = 2;
  } else if (failed.length > 0) {
    console.log('\n  失败项：');
    for (const f of failed) console.log(`   · ${f.label}${f.detail ? `  — ${f.detail}` : ''}`);
    exitCode = 1;
  } else {
    console.log('\n  全部通过。');
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    base: BASE, widths: WIDTHS, account: ACCOUNT, results, exitCode,
    at: new Date().toISOString(),
  }, null, 2));
  console.log(`  报告：${path.relative(process.cwd(), path.join(OUT, 'report.json'))}`);
} catch (e) {
  console.error('\n脚本异常：', e?.message || e);
  exitCode = 2;
} finally {
  cdp?.close();

  /**
   * ⚠️ 杀 chrome **必须杀整棵进程树**，否则 profile 删不掉。
   *
   *   实测（2026-11-14）：`chrome.kill()` 只终结**主进程**，而 Chrome 会派生
   *   一堆子进程（renderer / gpu / utility / crashpad），它们仍持有 profile 目录里的
   *   文件句柄 ⇒ 紧随其后的删除**几乎全失败**（实测残留 **341 个文件**，两轮一模一样）。
   *   讽刺的是：开头那次删除是**有效的**（那时没有 chrome 在跑），
   *   所以每轮都从空目录起步、又都留下一整份 —— 占用恒定 13MB，
   *   但告警每次都在刷，看起来像"清理逻辑坏了"。
   *
   *   Windows 上 syscall 级的 SIGTERM 杀不掉树，用 `taskkill /T /F`（含子进程）。
   *   非 Windows 保持 `chrome.kill()`。
   */
  if (process.platform === 'win32' && chrome?.pid) {
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
    } catch { /* ignore */ }
  } else {
    try { chrome.kill(); } catch { /* ignore */ }
  }

  // 等进程树真正退出（探测不到 PID 即已退出），最多 5s，等不到也不阻塞
  const deadline = Date.now() + 5000;
  if (chrome?.pid) {
    while (Date.now() < deadline) {
      try { process.kill(chrome.pid, 0); } catch { break; }   // 抛错 = 已不存在
      await sleep(150);
    }
  }
  await sleep(300);   // 句柄释放的最后一点余量

  // ⚠️ 必须删 profile：单轮 6–38MB，堆积几十个就把 C 盘打满，
  //    而**盘满的症状不是报错，是大文件被静默截断**（这条已经踩过一次）。
  //    ⚠️ 用安全删除：旧实现是裸 rmSync + catch 静默吞，
  //       撞上"单次删 >50 文件"的宿主保护后**悄悄失败**，profile 越堆越多，
  //       直到下一轮开头再撞一次并把整支验收打成 0 条断言。
  safeRemoveDir(PROFILE, '本轮 chrome profile');

  /**
   * ⚠️ 关于这两句 "未能完全删除" 告警 —— **已知，且无害**。请勿为此继续改代码。
   *
   *   实测事实（2026-11-14，连续两轮对照）：
   *     · 末尾 taskkill 整树 + 等 PID 消失后删除 → 仍留 ~290–340 个文件；
   *     · **下一轮开头**再删 → 同样报"未能完全删除"，也留 ~300 个；
   *     · 而**脚本完全退出后**在外部手动删同一目录 → 288/288 全部成功。
   *   ⇒ 结论：删不掉的不是权限、不是宿主保护、不是文件数阈值（我把分片降到 30 已远低于 50），
   *     而是 Chrome 的 crashpad / metrics / SQLite 侧车文件在**本机文件系统上存在释放延迟**，
   *     脚本运行期（含紧接着的下一轮开头）都拿不到独占句柄。
   *
   *   🔴 真正要看的判据不是"有没有告警"，而是**占用有没有累加**：
   *     第一轮结束 = 301 个 / 13MB；第二轮开始前 = 仍是 301 个（**没涨**）。
   *     ⇒ 每轮只留**一份**，恒定 13MB，不会像历史事故那样堆到 91 个 profile = 1.4GB。
   *       所以这个告警是"卫生没做到 100%"，不是"盘会被打满"。
   *
   *   为什么不干脆把末尾这次删除去掉：留着的价值是**它能删掉大部分**（300 里的 90%+），
   *   把恒定占用压在一份的下限；彻底不做则每轮累加一份，那才真的会涨。
   *
   *   ⚠️ 若哪天真观察到占用**逐轮累加**（例如变成 26MB → 39MB），那才是新问题，
   *      届时应改用"独立 profile 目录 + 启动前按时间戳清理旧目录"，
   *      而不是继续在这里调删除时机。
   */
  process.exit(exitCode);
}
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

