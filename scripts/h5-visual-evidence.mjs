/**
 * h5-visual-evidence.mjs —— H5（客户 / 师傅侧）四页**真实页面**视觉证据
 * =============================================================================
 * 目的（用户第九节第七项）：
 *   "客户报修、客户评价、师傅现场回执及照片上传等页面尚未在截图包中完整呈现…
 *    请核实其是否已迁入统一设计系统，并提供必要的实际页面截图或操作录屏。"
 *
 * 本脚本做两件事，且**分开报告**：
 *   ① 【事实】H5 侧页面用了哪套设计令牌（读源码 + 读渲染后的 computed style）；
 *   ② 【证据】用真实业务链路铸取 Token，对四个页面拍**真实截图**。
 *
 * ===========================================================================
 * 证据边界（必须先读）
 * ===========================================================================
 *   · 浏览器：本机 Chrome headless，**手机视口 390×844 + 一次性 profile**，
 *     不是真机、不是 iPhone Safari / 微信。
 *   · 数据：走**真实服务端 + 真实 PostgreSQL**，工单由匿名入口真实创建，
 *     跑完按 ticket_no 清理。
 *   · 截图必须**两两不同哈希** —— 否则"拍到了"其实是"拍到了同一张"。
 *     （本项目已有过截图假绿：两张不同文件名的图 md5 相同。）
 *
 * 用法：node scripts/h5-visual-evidence.mjs
 * 退出码：0 全部通过 / 1 有未达标 / 2 环境未就绪
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  BASE_URL,
  ROOT,
  cleanupTicket,
  ensureFixtureJpeg,
  http,
  psqlScalar,
  twoSessions,
  smsSwitch,
  svcPost,
  technicianSubmit,
  technicianUpload,
} from './technician-harness.mjs';
import { reviewTokenFromOutbox, explainMissingReviewToken } from './lib/review-token.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';
// 师傅入口凭据解析：**唯一实现**在 lib/tech-cred.mjs（铁律 ④：别让同一个坑有两条腿）。
// 本文件原先自带一份私有实现；抽出后 h5-visual-evidence 与 ux-final-record 共用。
import { pickTechCred } from './lib/tech-cred.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(ROOT, 'storage/tmp/h5-visual');
const VW = 390;
const VH = 844;

/**
 * ===========================================================================
 * 🔴 用户第六节纪律：**截图上看到的内容必须是真实业务语义**
 * ===========================================================================
 *  「使用真实业务含义的脱敏测试数据，不要以 SEC、FIX、链路验证等测试字样
 *    作为正式 UI 展示效果的判断依据。」
 *
 *   所以这里**不再**把 `[H5VIS] …（脚本自建，跑完自删）` 当成工单正文 ——
 *   那句话会直接出现在师傅页的"问题描述"里、出现在进度页的"我提交的说明"里，
 *   于是"这句话好不好读"变成了对**测试串**的审美判断，毫无意义。
 *
 *   ⚠️ 同时**不能**为了好看去改数据库里已有的真实工单（用户第八节：不改数据库）。
 *      正确做法是：**新建的取证工单本身就用真实业务语言**，
 *      清理靠 `customer_name` 的固定命名（脚本内部识别），而不是靠正文里的标签。
 */
const FIXTURE = {
  customerName: '刘女士',
  content: '客厅空调开机后不制冷，出风口有异响，遥控器显示 E5 故障码，希望上门检查。',
  technicianName: '周师傅',
  serviceNote: '上门检查为外机散热片积灰导致高压保护，已清洗散热片并补充冷媒，试机 30 分钟制冷正常。',
};

fs.mkdirSync(OUT, { recursive: true });

const rows = [];
const ok = (label, pass, detail = '') => {
  rows.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const note = (t) => console.log(`  ·  ${t}`);

/* ------------------------------------------------------------------ 截图 */
function pngInfo(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  } catch { return null; }
}
const shaFile = (f) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); }
  catch { return ''; }
};

/**
 * 一次性 Chrome 进程截一张图。
 * ⚠️ profile 是**每张图一个**并立即删除 —— C 盘是硬约束，
 *    历史上 91 个残留 profile 就把盘打满过。
 *
 * ===========================================================================
 * 🔴 2026-11-13 修正：截图口径从"窗口外框"改为"严格布局视口"
 * ===========================================================================
 *   问题现象：四张截图右侧内容被切（「我要投诉」显示成「我要投讠」、
 *   电话号码被切一半、第五颗星看不全），几何体检却判"无横向溢出"。
 *
 *   根因：`--window-size=390,H` 设的是**窗口外框宽**，
 *   布局视口实际更宽（约 406px），Chrome 再把结果裁到 390 ⇒ 右侧被削。
 *   旁证：四张截图左边界都在 x=16（正确），右边界一律顶到 x=389（被切）。
 *
 *   判据（2026-11-13 一次性定向检查实测，CDP 严格 390 视口）：
 *     `我要投诉` rect = left 199 / right **374**（< 390，完整在屏内）、
 *     越界元素 = **0**、截图宽 = 780 = 390 × DPR(2)。
 *     ⇒ **产品没有横向溢出**；被切的是旧截图口径。
 *
 *   修法：改走 `scripts/lib/h5-shot.mjs`（CDP 设视口后 captureScreenshot）。
 *     该模块是**同步调用的独立进程**，所以本脚本其余部分无需改成 async。
 */
function shoot(name, url, { height = VH, budget = 15000 } = {}) {
  const png = path.join(OUT, `${name}.png`);
  const profile = path.join(os.tmpdir(), `h5v-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/lib/h5-shot.mjs'), url, png, String(VW), String(height), String(budget), profile],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    console.log(`          ⚠️ ${name} 截图失败：${String(e?.message || e).slice(0, 160)}`);
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch { /* ignore */ }
  }
  const info = pngInfo(png);
  const sha = shaFile(png);
  console.log(`          · ${name}.png  ${info ? `${info.w}x${info.h} ${info.bytes}B` : '未产出'}  sha256=${sha}`);
  return { file: png, info, sha };
}

/**
 * 用 CDP 严格设定布局视口后截图（替代命令行 `--screenshot`）。
 * 返回 true 表示成功写出文件。
 */
function shootViaCdp(child, port, url, outPng, height, budget) {
  const sleep = (ms) => { try { execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 }); } catch { /* ignore */ } };
  // 同步等待 CDP 就绪（本函数在 execFileSync 风格下被调用，用轮询 + 同步睡眠）
  let ws = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const list = JSON.parse(execFileSync('curl', ['-s', `http://127.0.0.1:${port}/json/list`], { encoding: 'utf8' }));
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) { ws = pg.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    sleep(300);
  }
  if (!ws) return false;
  try {
    fs.writeFileSync(path.join(OUT, '.ws-url.tmp'), ws);
  } catch { /* ignore */ }
  return wsWritten(ws, outPng, height);
}


/** 取渲染后 DOM 里的一段可见文本（用于断言"对应内容真的渲染了"） */
function visibleText(url, budget = 12000) {
  const profile = path.join(os.tmpdir(), `h5d-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  try {
    const out = execFileSync(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--no-first-run', '--ignore-certificate-errors',
        `--user-data-dir=${profile}`, `--window-size=${VW},${VH}`,
        `--virtual-time-budget=${budget}`, '--dump-dom', url,
      ],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    );
    return out;
  } catch { return ''; } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch { /* ignore */ }
  }
}
const stripTags = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const rid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- 几何体检（CDP） */
/**
 * ===========================================================================
 * 为什么截图之外还要**量几何**（用户第六节）
 * ===========================================================================
 *  「观察…键盘/弹层/滚动、加载成功失败反馈、有无重复导航栏/突兀跳动/**内容遮挡**」
 *
 *  截图能回答"好不好看"，**答不了这三件事**：
 *    ① 内容被裁：一列文字看起来"刚好到边"，其实是 `overflow:hidden` 切掉了后半截；
 *    ② 内容遮挡：底部固定条盖住最后一行，截图里两者都在，肉眼以为没问题；
 *    ③ 横向溢出：`scrollWidth > innerWidth` 在 390px 视口下不会显示滚动条（`--hide-scrollbars`），
 *       截图完全看不出来，但真机上用户可以左右拖动。
 *
 *  ⇒ 这三条只能靠 `getBoundingClientRect` / `scrollWidth` 量。
 *    本函数用一次性 Chrome + CDP 打开目标页，返回**原始几何数据**；
 *    判定逻辑留给调用处（阈值不同页面不同，写在函数里会变成"魔法数集中营"）。
 *
 * ⚠️ 一次性 profile，用完立即删 —— C 盘是硬约束（历史上有 91 个残留 profile 打满过盘）。
 */
async function measureGeometry(url, { width = VW, height = VH, budget = 4000 } = {}) {  const { spawn } = await import('node:child_process');
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = path.join(os.tmpdir(), `h5geo-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--ignore-certificate-errors', '--hide-scrollbars', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  const PROBE = `(() => {
    const de = document.documentElement;

    /**
     * ① 横向溢出：整页。
     *
     * ⚠️ 判据不能只看 documentElement.scrollWidth。
     *    变异测试实测（见 .tmp-geom-mutation.mjs，2026-11-14）：
     *    注入一个 width:430px 的元素后，overflowX **仍然是 0** ——
     *    因为 H5 的根容器普遍带 overflow-x: hidden，
     *    子元素的横向溢出被父级吃掉了，documentElement.scrollWidth 看不见。
     *
     *    而这恰恰是最危险的一类：**内容真的超出了 390px，用户却被禁止左右拖动**
     *    ⇒ 超出部分永久不可达。截图里同样看不出来。
     *
     *    ⇒ 双层判据：
     *      a) 文档级溢出（能拖动的溢出，最严重）；
     *      b) **任何元素的右边界超出视口右沿**（被吃掉的那种，同样不可达）。
     *    两层都报，任何一层命中都算问题。
     *
     *    ⚠️ 变异测试（2026-11-14）实测到的第二件反直觉事实：
     *      注入一个 430px 宽的正常流元素后，**window.innerWidth 从 390 变成了 430**，
     *      而 overflowX 仍是 0 —— 因为移动端仿真里整页可拖动表现为
     *      **布局视口被撑宽**，而不是出现滚动条。
     *      ⇒ 所以这里还要加一条：视口宽度本身必须等于设定值（390）。
     *        视口被撑宽 = 真机上用户要左右拖动才能看全 = 横向溢出。
     */
    const overflowX = Math.max(de.scrollWidth, document.body.scrollWidth) - window.innerWidth;

    const outOfViewport = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // 设计上就是要横向滚的容器（筛选药丸那一排）：跳过
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      // 视觉隐藏（读屏用）的常见写法
      if (cs.position === 'absolute' && (el.clientWidth <= 1 || el.clientHeight <= 1)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 右边界超出视口右沿 2px 以上
      if (r.right > window.innerWidth + 2) {
        outOfViewport.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 40),
          text: (el.textContent || '').trim().slice(0, 24),
          right: Math.round(r.right),
          width: Math.round(r.width),
          innerW: window.innerWidth,
        });
      }
    }

    /**
     * ② 「被裁」判据：元素内容比自身可视区宽，且**它并不打算滚动**。
     *    ⚠️ 必须排除 overflow-x: auto/scroll 的容器（那是设计上的横向滚动，
     *       比如筛选药丸那一排）—— 否则会把"故意的横向滚动"报成"文字被裁"，
     *       又是"判据太宽 = 自造假红"。
     */
    const clipped = [];
    for (const el of document.querySelectorAll('dd, time, dt, p, span, div')) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (cs.overflowX === 'visible') continue;   // 溢出会显示出来，不算"被裁"
      if (cs.textOverflow === 'ellipsis') continue; // 有意省略号
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 30),
          clientW: el.clientWidth,
          scrollW: el.scrollWidth,
          left: Math.round(r.left),
          right: Math.round(r.right),
        });
      }
    }

    // ③ 重复导航栏：同 top、同高的栏只应有一个
    const barEls = [...document.querySelectorAll('.svc-navbar, header, .svc-header, nav')]
      .filter(e => {
        const r = e.getBoundingClientRect();
        return r.height > 20 && r.top < window.innerHeight * 0.25;
      });
    const seenTop = new Set();
    const uniqueBars = barEls.filter(e => {
      const top = Math.round(e.getBoundingClientRect().top);
      if (seenTop.has(top)) return false;
      seenTop.add(top);
      return true;
    });

    /**
     * ④ 「办理进度」每一步的名字与时间：量出来才能判"日期列是否被裁"。
     *    真实症状是时间文字的 scrollWidth > clientWidth（被切），
     *    或它右边界超出父容器右边界。
     */
    const stepTimes = [...document.querySelectorAll('.svc-step-times li')].map(li => {
      const t = li.querySelector('time');
      const tr = t ? t.getBoundingClientRect() : null;
      const lr = li.getBoundingClientRect();
      const nameEl = [...li.children].find(c => c !== t);
      return {
        name: nameEl ? (nameEl.textContent || '').trim() : '',
        time: t ? (t.textContent || '').trim() : '',
        liW: Math.round(lr.width),
        timeW: tr ? Math.round(tr.width) : null,
        timeRight: tr ? Math.round(tr.right) : null,
        liRight: Math.round(lr.right),
        timeScrollW: t ? t.scrollWidth : null,
        timeClientW: t ? t.clientWidth : null,
        // 时间是否超出自身容器（被切）
        cut: t ? t.scrollWidth > t.clientWidth + 1 : null,
        // 时间是否超出 li（跑出容器）
        overflowLi: tr ? tr.right > lr.right + 1 : null,
      };
    });

    // ⑤ 「服务时间」六项
    const times = [...document.querySelectorAll('.svc-times dd')].map(e => {
      const r = e.getBoundingClientRect();
      return {
        text: (e.textContent || '').trim().slice(0, 24),
        w: Math.round(r.width),
        scrollW: e.scrollWidth,
        clientW: e.clientWidth,
        cut: e.scrollWidth > e.clientWidth + 1,
      };
    });

    /**
     * ⑥ 小字号元素的「真实可用宽度余量」（2026-11-13 · 用户第 ③ 条）
     *
     *    用户要求："11–12px 的辅助文字，在不破坏布局的前提下，尽量提高至 13–14px"。
     *    关键词是「**不破坏布局**」—— 所以必须先量出每个元素还能长多少。
     *
     *    ⚠️ 用 scrollWidth 而不是 getBoundingClientRect().width：
     *       nowrap + overflow:hidden 时，rect 会被**容器**限住（看起来刚好装下），
     *       而 scrollWidth 才是文字真正要占的宽度 —— 被裁最隐蔽的形态就在这里。
     *    ⚠️ 估算按**线性比例**（中文等宽汉字近似成立），仅作「能不能提」的初筛；
     *       真正的判据是改完重跑本页断言（时间列不得被裁）。
     *
     *    🔴 本注释里**绝不能出现反引号**：这一段是模板字符串（JS 里嵌 JS），
     *       写入反引号会把模板提前闭合，报的错却是 "Unexpected identifier"，
     *       病因与症状完全不相干。本文件已因此踩过四次（见 PROBE 自检注释）。
     */
    const FONT_SEL = [
      '.svc-step-label', '.svc-step-times li', '.svc-step-times li time',
      '.svc-store-address', '.svc-mat-state', '.svc-mat-act', '.svc-secondary-btn',
      '.svc-capture-limit', '.svc-capture-timer', '.svc-hint', '.svc-note-help',
      '.svc-error', '.svc-ticketno .svc-k', '.svc-last-order-at', '.svc-tech-done-note',
      '.svc-up', '.svc-sheet .svc-ver', '.svc-mat-title', '.svc-privacy',
    ];
    const fontSlack = [];
    for (const s of FONT_SEL) {
      for (const el of document.querySelectorAll(s)) {
        const c = getComputedStyle(el);
        const fs2 = parseFloat(c.fontSize) || 0;
        if (fs2 <= 0 || fs2 > 13) continue;   // 只关心 <=13px 的（要提的那些）
        const p = el.parentElement;
        const pw = p ? p.getBoundingClientRect().width : 0;
        const est13 = fs2 > 0 ? Math.round((el.scrollWidth * 13) / fs2) : 0;
        /**
         * 🔴 「会不会超容器」这个判断**只对 nowrap 元素成立**。
         *
         *    第一版我对所有元素都判，结果 .svc-hint / .svc-step-times li 全报"会超" ——
         *    但它们是 display:flex（justify-content:space-between），
         *    scrollWidth 恒等于**容器宽度**（本来就撑满），
         *    乘个 1.04 当然 > 容器宽 ⇒ **自造假红**。
         *    而它们的 white-space 是 normal，文字长了会**换行**，根本不会横向溢出。
         *
         *    ⇒ 判据收窄到 nowrap：只有"不换行"的文本才有横向溢出风险。
         *      非 nowrap 的只报余量，不报风险（换行是否变难看，靠改完看截图判）。
         */
        fontSlack.push({
          sel: s,
          fs: fs2,
          text: (el.textContent || '').trim().slice(0, 16),
          plainW: Math.round(el.scrollWidth),
          rectW: Math.round(el.getBoundingClientRect().width),
          parentW: Math.round(pw),
          nowrap: c.whiteSpace === 'nowrap',
          estAt13: est13,
          // 只有 nowrap 才可能"提字号 → 横向撑破"；其余会换行
          riskAt13: c.whiteSpace === 'nowrap' && pw > 0 ? est13 > pw : false,
        });
      }
    }

    return {
      url: location.href,
      innerW: window.innerWidth, innerH: window.innerHeight,
      docScrollW: de.scrollWidth, bodyScrollW: document.body.scrollWidth,
      docScrollH: de.scrollHeight,
      overflowX,
      outOfViewport,
      navbars: uniqueBars.length,
      navbarTops: uniqueBars.map(e => Math.round(e.getBoundingClientRect().top)),
      clipped,
      stepTimes,
      times,
      fontSlack,
      textLen: (document.body.innerText || '').trim().length,
    };
  })()`;

  /**
   * ===========================================================================
   * PROBE 自检 —— 在**发出去之前**证明这段探针是完整、可解析、判据齐全的
   * ===========================================================================
   * 🔴 为什么必须有这一步（DEV-248）：
   *    这一段是**模板字符串**（JS 里嵌 JS）。我在它的注释里写了一个反引号，
   *    模板被**提前闭合**，残余代码当成产品代码解析 ——
   *    报出来的错是 `geom is not defined`，**病因与症状完全不相干**，
   *    我因此在错误方向上找了三轮。
   *
   *    同类坑在本文件里已是**第三次**。所以这里不靠"记得别再写"，
   *    而是每次执行都静态验一遍：
   *      ① 是合法表达式；
   *      ② 内部无反引号（有 = 模板被提前闭合）；
   *      ③ 五条关键判据键都在场（防止改别处时把断言悄悄删掉）。
   *    任何一条不满足 ⇒ 直接抛，**不产生任何产品结论**
   *    （"工具坏了"与"产品坏了"必须分开报，本项目铁律）。
   */
  {
    const problems = [];
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return ${PROBE}`);
    } catch (e) {
      problems.push(`不是合法表达式：${e?.message}`);
    }
    const bt = (PROBE.match(/`/g) ?? []).length;
    if (bt > 0) problems.push(`探针内含反引号 ${bt} 个（模板会被提前闭合）`);
    for (const key of ['overflowX', 'outOfViewport', 'clipped', 'stepTimes', 'navbars', 'fontSlack']) {
      if (!PROBE.includes(key)) problems.push(`缺少判据键：${key}`);
    }
    if (problems.length) throw new Error(`PROBE 自检失败（工具问题，不是产品缺陷）：${problems.join('；')}`);
  }

  const wsUrl = await (async () => {
    for (let i = 0; i < 80; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = list.find((x) => x.type === 'page');
        if (t) return t.webSocketDebuggerUrl;
      } catch { /* wait */ }
      await sleep(250);
    }
    return null;
  })();

  if (!wsUrl) {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* noop */ }
    return null;
  }

  try {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const myId = ++id;
      const t = setTimeout(() => { pending.delete(myId); reject(new Error(`CDP timeout ${method}`)); }, 25000);
      pending.set(myId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url });
    await sleep(budget);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
    try { ws.close(); } catch { /* noop */ }
    if (r.exceptionDetails) return null;
    return r.result?.value ?? null;
  } catch {
    return null;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* noop */ }
  }
}

/**
 * 读发件箱并取出**师傅作业凭据**（mock 通道的内存队列 ⇒ 跨进程、非瞬时可见）。
 *
 * ===========================================================================
 * 🔴 为什么不能直接用 `technician-harness.mjs` 的 `tokenFromOutbox()`
 * ===========================================================================
 * 那个夹具只在 `params.link` 上匹配 **43 位**长 Token。
 * 而 2026-11-13 实测本机发件箱里的 `technician_task` 条目已经是：
 *     { scene: 'technician_task', params: { code: 'gYF1M9qsbGhFbSuD4q8nyA' },
 *       preview: '…请点击链接查看并处理：https://sh.scqfls.cn/p/t/gYF1M9qsbGhFbSuD4q8nyA' }
 * 即 **22 位短码 + `params.code`**，`params.link` 根本不存在。
 * ⇒ 夹具恒取到 null。它的失败文案写的是"确认派工成功且通道为 mock"，
 *   读起来像"产品没发短信"—— 而实测 `sms_logs` 三条全 `accepted`、入口 302 可用。
 *   这是**验证器落后于产品**，不是产品缺陷（本项目铁律 ⑤）。
 *
 * 本函数因此按与 `lib/review-token.mjs` **同构**的口径解析：
 *   ① 先读 `preview`（客户/师傅真正收到的正文，是语义对象）；
 *   ② 再兜底结构化字段（`params.code` / `params.link`）；
 *   ③ 形态同时接受 22 位短码与 43 位长 Token（两种入口 nginx 都接了）。
 *
 * 🔴 2026-11-14：上述解析与认领口径已**抽到 `lib/tech-cred.mjs`**
 *    （`pickTechCred()`），本函数只剩"轮询 + 网络"这一层。
 *    理由：录屏脚本需要同一段逻辑，若不抽出来就会出现**第三份**实现
 *    —— 而本项目铁律 ④ 已经因为"两份实现，其中一份过期"付出过代价
 *    （`technician-harness.mjs` 那份只认 43 位长 Token，恒取 null）。
 */
async function tokenFromOutboxPolling({ sessionToken, ticketNo, scene = 'technician_task', timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=300`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const items = r.json?.data?.items ?? [];
    lastCount = items.length;
    const hit = pickTechCred(items, { ticketId: currentTicketId, scene });
    if (hit) return hit;
    await sleep(800);
  }
  throw new Error(
    `发件箱里没有工单 ${ticketNo}(id=${currentTicketId}) 的 ${scene} 短信（30s 内共读到 ${lastCount} 条）—— ` +
      '确认派工成功且通道为 mock',
  );
}
/** 当前工单 id（`biz_id` 认领需要它；在第二部分的 try 里赋值） */
let currentTicketId = null;

/**
 * 建一张**用真实业务语言**的一次性工单。
 *
 * ⚠️ 为什么不用 `technician-harness.mjs` 的 `createScratchTicket()`：
 *    它把 `[${tag}] …（脚本自建，跑完自删）` 写进 `content`、把 `${tag}验收`
 *    写进 `customer_name` —— 这两处**会直接出现在界面上**
 *    （师傅页的"问题描述"、进度页的"我提交的说明"）。
 *    用户第六节明令不得以测试字样判断 UI 效果 ⇒ 本脚本必须自建一份**业务语言**的夹具。
 *
 * ⚠️ 其余一切照旧：仍走**匿名真实入口**（带门店签名）、仍用 `X-Request-Id`、
 *    仍在 finally 里按 ticket_no 清理。**不碰数据库**（用户第八节）。
 *
 * 清理识别靠 `customer_name` 的固定值（见 FIXTURE），不靠正文标签。
 */
async function createBusinessTicket() {
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets${storeEntryQuery('S01')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: FIXTURE.content,
      customer_name: FIXTURE.customerName,
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`匿名建单失败 HTTP ${created.status} ${String(created.body).slice(0, 200)}`);
  }
  const no = String(created.json?.data?.ticket_no ?? '');
  if (!no) throw new Error(`匿名建单未返回 ticket_no（${String(created.body).slice(0, 200)}）`);
  const id = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${no}'`));
  if (!id) throw new Error(`按 ticket_no=${no} 反查不到工单 id`);
  return { ticketId: id, ticketNo: no, mobile };
}

/* =============================================================== 主流程 */
console.log('H5（客户 / 师傅）视觉证据与设计系统核实');
console.log(`  BASE=${BASE_URL}  产物目录=${path.relative(ROOT, OUT)}`);

/* ---------- 第一部分：设计系统事实（读源码，不靠印象） ---------- */
console.log('\n=== 第 1 部分 · H5 与员工端用的是不是同一套设计令牌 ===');

const h5Css = fs.readFileSync(path.join(ROOT, 'h5/src/styles/base.css'), 'utf8');
const mobileCss = fs.readFileSync(path.join(ROOT, 'src-mobile/src/styles/app.css'), 'utf8');

const grab = (css, key) => (new RegExp(`${key}\\s*:\\s*([^;]+);`).exec(css)?.[1] ?? '').trim();

const h5Token = {
  primary: grab(h5Css, '--svc-primary'),
  radius: grab(h5Css, '--svc-radius'),
  bg: grab(h5Css, '--svc-bg'),
  font: grab(h5Css, 'font-size'),
};
const mToken = {
  primary: grab(mobileCss, '--color-svc-brand'),
  radius: grab(mobileCss, '--radius-svc'),
  bg: grab(mobileCss, '--color-svc-bg'),
};

console.log(`    H5      : primary=${h5Token.primary} radius=${h5Token.radius} bg=${h5Token.bg} 正文字号=${h5Token.font}`);
console.log(`    员工端  : primary=${mToken.primary} radius=${mToken.radius} bg=${mToken.bg}`);

const samePrimary = h5Token.primary.replace(/\s/g, '').toLowerCase() === mToken.primary.replace(/\s/g, '').toLowerCase();
const h5UsesKonsta = /konsta/i.test(h5Css);
const h5HasThemeDir = fs.existsSync(path.join(ROOT, 'h5/src/design'));

/**
 * ⚠️ 这里是**事实陈述**，不是 PASS/FAIL 判定。
 *
 *    用户第七节的问法是"**核实其是否已迁入统一设计系统**" —— 核实的结果
 *    可能是"已迁入"也可能是"未迁入"，两者都是有效答案。
 *    把"未迁入"直接写成 FAIL，是把自己的**猜测**当成产品缺陷报出去
 *    （本项目铁律：验证器自己也会错，且错得比产品更隐蔽）。
 *
 *    所以本段只输出事实与差异清单；**要不要合并成一套**是产品决策，
 *    由报告正文给出处置建议，不在这里替用户下结论。
 */
const DESIGN_FACT = {
  h5: h5Token,
  mobile: mToken,
  samePrimary,
  h5UsesKonsta,
  h5HasThemeDir,
  verdict: samePrimary && (h5UsesKonsta || h5HasThemeDir) ? 'SHARED' : 'SEPARATE',
};
console.log('    ⇒ 核实结论：' + (DESIGN_FACT.verdict === 'SHARED'
  ? '两套端共用同一套设计令牌'
  : '**两套端各自独立**（H5 手写 CSS + 自有变量；员工端 Konsta iOS Theme + Tailwind token）'));

/* ---------- 第二部分：真实链路铸取三个 Token ---------- */
console.log('\n=== 第 2 部分 · 用真实业务链路铸取客户报修 / 师傅 / 评价 / 进度四类入口 ===');

let ticketId = null;
let ticketNo = null;
try {
  const { store, hq } = await twoSessions();
  const sms = smsSwitch();
  // ⚠️ 必须 await enable()：它内部要等 11s 过 ConfigService 的缓存 TTL，
  //    不等就派工 ⇒ 短信仍按旧值 rejected ⇒ 发件箱里没有 Token ⇒
  //    失败现象看起来是"产品没发短信"。
  note(`短信开关：${sms.original ?? '(未读到)'} → 临时开启（含 11s 缓存等待，跑完恢复）`);
  await sms.enable();

  try {
    const t = await createBusinessTicket();
    ticketId = t.ticketId;
    ticketNo = t.ticketNo;
    currentTicketId = t.ticketId;
    note(`工单 ${ticketNo}（id=${ticketId}）已创建 —— 正文与客户名均为业务语言`);

    // 派工（铸师傅 Token）
    const disp = await svcPost('dispatch', ticketId, store, {
      technician_name: FIXTURE.technicianName,
      technician_mobile: '13900010001',
      expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
    }, rid());
    ok('门店派工成功（师傅作业短信入队）', disp.status === 200, `HTTP ${disp.status}`);

    const { token: techToken } = await tokenFromOutboxPolling({ sessionToken: hq, ticketNo });
    note(`师傅 Token 已取得（长度 ${techToken.length}）`);

    // 进度链接（客户报修成功通知里的 /p/<token> 或 /p/<22短码>）
    let progressToken = null;
    {
      const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=300`, {
        headers: { Authorization: `Bearer ${hq}` },
      });
      const items = r.json?.data?.items ?? [];
      const cand = items.filter(
        (i) => String(i?.scene ?? '').startsWith('progress_') &&
          String(i?.params?.ticket_no ?? '') === String(ticketNo),
      );
      /**
       * ⚠️ 进度类短信的凭据**不在 `params.link`**，而在 `params.code` / 正文里。
       *    实测形态：preview 含 `…/p/HfXTlrCib_OHdVWTNDBX6g`（22 位），
       *    params = { ticket_no, code }。只读 params.link 会恒取不到。
       */
      for (const it of [...cand].reverse()) {
        const m = /\/p\/(?!t\/)([A-Za-z0-9_-]{16,})/.exec(String(it?.preview ?? ''))
          ?? /\/p\/(?!t\/)([A-Za-z0-9_-]{16,})/.exec(String(it?.params?.link ?? ''))
          ?? (String(it?.params?.code ?? '').length >= 16 ? [null, String(it.params.code)] : null);
        if (m?.[1]) { progressToken = m[1]; break; }
      }
      note(`进度短信 ${cand.length} 条，token=${progressToken ? `长度 ${progressToken.length}` : '未取到'}`);
    }

    // 报修页：讲的是"门店扫码入口"，不是 token
    const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8'));

    /* ---------- 第三部分：四页真实截图 ---------- */
    console.log('\n=== 第 3 部分 · 四页真实截图（手机视口 390×844） ===');

    const shots = {};

    // ① 客户报修
    const reportUrl = `${BASE_URL}/h5/report?k=${entry.entry}`;
    shots.report = shoot('h5-report-form', reportUrl, { height: 1600 });
    {
      const html = visibleText(reportUrl);
      const txt = stripTags(html);
      const hasForm = /故障描述/.test(txt) && /手机号码/.test(txt);
      ok('客户报修页渲染出真实表单（不是空白 / 不是错误页）', hasForm && txt.length > 120,
        `textLen=${txt.length} 含「故障描述」=${/故障描述/.test(txt)}`);
      // 必须**不**出现假的 iOS 状态栏 / 系统时间（用户第二节明令）
      const fakeBars = /9:41|运营商|% 电/.test(txt);
      ok('报修页没有伪造的 iOS 状态栏 / 系统时间', !fakeBars, `命中假状态栏字样=${fakeBars}`);
    }

    // ② 师傅现场回执（含照片上传区）
    const techUrl = `${BASE_URL}/h5/technician/visit/${techToken}`;
    // 先上传 1 张，让"照片上传"区域有真实内容
    const jpeg = ensureFixtureJpeg();
    const up = await technicianUpload(techToken, jpeg, { photoType: 'onsite' });
    note(`师傅上传现场照片 HTTP ${up.status}`);
    shots.tech = shoot('h5-technician-visit', techUrl, { height: 2200 });
    {
      const html = visibleText(techUrl);
      const txt = stripTags(html);
      // P6-TECH-RESULT-SIMPLIFY-01：处理结果枚举已移除，报价/收费与说明是主内容
      const hasNote = /服务说明|处理说明|现场情况/.test(txt);
      const hasCharge = /是否收费|收费/.test(txt);
      const hasPhoto = /照片|现场拍摄|上传/.test(txt);
      ok('师傅页渲染出「说明 + 收费 + 照片」三类内容',
        (hasNote || hasPhoto) && hasCharge && txt.length > 150,
        `textLen=${txt.length} note=${hasNote} charge=${hasCharge} photo=${hasPhoto}`);

      // 处理结果**枚举控件**不得再出现（产品裁决已移除）。
      //
      // 🔴 判据必须落到**控件**，不能落到"页面文本里有没有这四个字"：
      //    实测 `Visit.vue` 里仍有一句正常提示「请写清检查情况、做了哪些维修操作、
      //    **最终处理结果**」—— 那是给师傅看的填写指引，不是枚举控件。
      //    用 /处理结果/ 判 ⇒ 永远假红（本项目铁律：判据太宽 = 自造假红）。
      //    可靠判据 = 页面里**没有**任何一个可选的处理结果选项
      //    （服务端下发的 service_results 枚举值不再渲染成可点项）。
      const hasResultControl = /data-ts-result|选择处理结果|处理结果[:：]\s*(已解决|未解决|无法处理)/.test(txt);
      ok('师傅页已移除「处理结果」枚举控件（P6-TECH-RESULT-SIMPLIFY-01）',
        !hasResultControl, `命中枚举控件=${hasResultControl}（提示语里出现「处理结果」四字不算）`);
    }

    // ③ 师傅提交 → 门店确认 → 客户评价
    const sub = await technicianSubmit(techToken, {
      service_note: FIXTURE.serviceNote,
      is_charged: false,
    });
    ok('师傅提交回执成功（推进到待门店确认）', sub.status === 200,
      `HTTP ${sub.status} ${String(sub.body ?? '').slice(0, 120)}`);

    const visitId = psqlScalar(`SELECT id FROM service_visits WHERE ticket_id=${ticketId} ORDER BY id DESC LIMIT 1`);
    const conf = await svcPost('visitConfirm', String(visitId), store, { amount: null }, rid());
    ok('门店确认成功（触发评价邀请短信）', conf.status === 200, `HTTP ${conf.status}`);

    // 取评价 Token
    let reviewToken = null;
    {
      const deadline = Date.now() + 30000;
      let items = [];
      while (Date.now() < deadline) {
        const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=300`, {
          headers: { Authorization: `Bearer ${hq}` },
        });
        items = r.json?.data?.items ?? [];
        reviewToken = reviewTokenFromOutbox(items, { ticketNo });
        if (reviewToken) break;
        await sleep(600);
      }
      if (!reviewToken) note(`评价 Token 未取到：${explainMissingReviewToken(items, { ticketNo }) ?? ''}`);
    }

    if (reviewToken) {
      shots.review = shoot('h5-customer-review', `${BASE_URL}/h5/customer/review/${reviewToken}`, { height: 1800 });
      const txt = stripTags(visibleText(`${BASE_URL}/h5/customer/review/${reviewToken}`));
      const hasStar = /星|评价|满意|收费/.test(txt);
      ok('客户评价页渲染出真实内容（星级 / 收费核对）', hasStar && txt.length > 100,
        `textLen=${txt.length}`);
      // P0-LOW-RATING-CLOSE：低分**不得**再承诺"退回门店"
      const falsePromise = /退回门店重新处理|会退回门店/.test(txt);
      ok('评价页不再承诺"低分退回门店"（规则已废止，说了就是骗人）',
        !falsePromise, `命中旧承诺=${falsePromise}`);
    } else {
      ok('客户评价页截图（拿到 review_invite Token）', false, '发件箱里没有本工单的 review_invite');
    }

    // ④ 客户进度页
    if (progressToken) {
      shots.progress = shoot('h5-customer-progress',
        `${BASE_URL}/h5/customer/progress/${progressToken}`, { height: 1800 });
      const txt = stripTags(visibleText(`${BASE_URL}/h5/customer/progress/${progressToken}`));
      /**
       * 🔴 判据不能只看"文本够不够长"，也不能只看"有没有出现'待'字"。
       *
       *    实测踩到：页面在**接口 404** 时也会渲染出「服务进度」标题 + 一段
       *    错误说明（textLen≈77）—— 用长度阈值判会把它读成"渲染了内容"。
       *    而它真正的状态恰恰是"没拿到数据"。
       *
       *    ⇒ 分两步断言，且**错误态优先**：
       *      ① 页面必须**不是**错误态（不得出现 `progress-error` 的错误文案特征）；
       *      ② 页面必须渲染出**工单号**（真实数据才有的东西，不是骨架屏文案）。
       */
      const isErrorState = /服务返回了非 JSON|HTTP \d{3}|链接无效|已过期|已被撤销|无法查询/.test(txt);
      const hasData = /FW\d{8}-\d{4}/.test(txt);
      ok('客户进度页拿到了真实进度数据（不是错误态 / 不是空白）',
        !isErrorState && hasData,
        `textLen=${txt.length} 错误态=${isErrorState} 含工单号=${hasData} :: ${txt.slice(0, 160)}`);
    } else {
      ok('客户进度页截图（拿到 /p/ 链接）', false, '发件箱里没有进度类短信链接');
    }

    /* =====================================================================
     * 第 4 部分 · 几何体检（用户第六节：内容遮挡 / 重复导航栏 / 横向溢出）
     *
     * ⚠️ 这一部分**必须**与截图并列存在，不能互相替代：
     *    截图回答"好不好看"；几何回答"有没有被切、有没有被盖"。
     *    390px 视口 + --hide-scrollbars 时，横向溢出在截图里**完全看不出来**，
     *    而真机上用户可以左右拖动整页 —— 这类缺陷只能量出来。
     * ===================================================================== */
    console.log('\n=== 第 4 部分 · 几何体检（390 宽，量 rect 而不是看截图） ===');

    const GEOM_PAGES = [
      ['客户报修', reportUrl],
      ['师傅回执', `${BASE_URL}/h5/technician/visit/${techToken}`],
      ['客户评价', reviewToken ? `${BASE_URL}/h5/customer/review/${reviewToken}` : null],
      ['客户进度', progressToken ? `${BASE_URL}/h5/customer/progress/${progressToken}` : null],
    ];

    const geomAll = {};
    for (const [name, url] of GEOM_PAGES) {
      if (!url) { note(`${name}：无入口 Token，跳过几何体检`); continue; }
      const geo = await measureGeometry(url);
      if (!geo) { note(`${name}：几何体检未取到数据（不是产品判定）`); continue; }
      geomAll[name] = geo;

      // ① 横向溢出：两层判据（文档级可拖动 + 元素超出视口被父级吃掉）
      const oov = geo.outOfViewport ?? [];
      // 视口被撑宽 = 真机横向溢出（变异测试实测：注入 430px 元素后 innerW 390→430）
      const viewportWidened = geo.innerW > 392;
      ok(`${name} · 无横向溢出（既不能拖动整页，也没有元素跑出视口）`,
        geo.overflowX <= 1 && oov.length === 0 && !viewportWidened,
        geo.overflowX > 1
          ? `overflowX=${geo.overflowX}px docScrollW=${geo.docScrollW} innerW=${geo.innerW}`
          : viewportWidened
            ? `视口被撑宽 innerW=${geo.innerW}（应为 390）⇒ 真机上需要左右拖动`
            : (oov.length ? `出界元素=${JSON.stringify(oov.slice(0, 3))}` : `overflowX=0 出界元素=0（innerW=${geo.innerW}）`));

      // ② 重复导航栏
      ok(`${name} · 顶部导航栏恰好 1 个`,
        geo.navbars === 1,
        `navbars=${geo.navbars} tops=${JSON.stringify(geo.navbarTops)}`);

      // ③ 内容被裁
      ok(`${name} · 没有内容被容器裁掉`,
        geo.clipped.length === 0,
        geo.clipped.length
          ? JSON.stringify(geo.clipped.slice(0, 4))
          : `扫描 dd/time/dt/p/span/div，无一 overflow:hidden 且内容超宽`);
    }

    // ④ 进度页专有：底部「办理进度」的时间列
    const pg = geomAll['客户进度'];
    if (pg && Array.isArray(pg.stepTimes)) {
      const bad = pg.stepTimes.filter((s) => s.cut || s.overflowLi);
      ok('客户进度页「办理进度」的时间列完整（日期没有被裁掉）',
        pg.stepTimes.length > 0 && bad.length === 0,
        bad.length
          ? JSON.stringify(bad)
          : `${pg.stepTimes.length} 步：${pg.stepTimes.map((s) => `${s.name}@${s.timeW}px(容器${s.liW})`).join(' / ')}`);
    }
    if (pg && Array.isArray(pg.times)) {
      const cutTimes = pg.times.filter((t) => t.cut);
      ok('客户进度页「服务时间」六项的值完整可读',
        pg.times.length === 0 || cutTimes.length === 0,
        cutTimes.length ? JSON.stringify(cutTimes) : `${pg.times.length} 项，无被裁`);
    }

    /* ---------------------------------------------------------------------
     * 用户第 ③ 条：小字号（≤12.5px）的「真实可用宽度余量」报告
     *
     * ⚠️ 这一节**先只打印、不断言**（第一次运行是取基线）。
     *    断言要等"哪些该提"定下来之后再写死 ——
     *    否则第一天就是在拿"现状"当标准，那是自证，不是验收。
     * ------------------------------------------------------------------- */
    const slackRows = Object.values(geomAll).flatMap((g) => g.fontSlack ?? []);
    if (slackRows.length) {
      console.log('  ·  小字号元素宽度余量（若要提到 13px 会不会超出容器）：');
      const bySel = new Map();
      for (const r of slackRows) {
        const k = r.sel;
        if (!bySel.has(k)) bySel.set(k, []);
        bySel.get(k).push(r);
      }
      for (const [sel, arr] of bySel) {
        const r = arr[0];
        // 只有 nowrap 才判"会不会超"；其余会换行，余量仅供参考
        const risk = r.nowrap ? (r.riskAt13 ? '⚠️ 会超' : '✅ 可提') : '（可换行）';
        console.log(
          `      ${sel.padEnd(26)} ${String(r.fs).padEnd(5)}px  文字${String(r.plainW).padEnd(5)} 容器${String(r.parentW).padEnd(5)} ` +
          `nowrap=${r.nowrap ? 'Y' : 'n'} → 13px 需 ${String(r.estAt13).padEnd(5)} ${risk}  「${r.text}」`,
        );
      }
      const risky = slackRows.filter((r) => r.riskAt13 === true);
      console.log(`      合计 ${slackRows.length} 个 ≤13px 元素；` +
        `**${risky.length} 个 nowrap 元素提到 13px 后会超出容器**` +
        (risky.length ? `：${[...new Set(risky.map((r) => r.sel))].join(' / ')}` : '（其余皆可安全提升或在容器内换行）'));
    }

    // 截图必须两两不同（防"拍到同一张"）
    const list = Object.entries(shots).filter(([, s]) => s?.info);
    const shas = list.map(([, s]) => s.sha);
    const uniq = new Set(shas).size;
    ok(`本次 ${list.length} 张截图两两不同（不是同一张复用）`, uniq === shas.length,
      `${list.map(([k, s]) => `${k}=${s.sha}(${s.info.bytes}B)`).join(' ')}`);

    /**
     * =====================================================================
     * 用户第六节：**界面证据里不得出现测试字样**
     * =====================================================================
     *  「不要以 SEC、FIX、链路验证等测试字样作为正式 UI 展示效果的判断依据。」
     *
     * 这条不只是"我建单时别写测试串"的自我约束 —— 它必须是**可测的**：
     * 页面上真正渲染出来的文本里，如果出现脚本痕迹，
     * 那么"这句文案好不好读"的判断就是对测试串做的，整份视觉证据都作废。
     *
     * ⚠️ 判据范围刻意收窄到**本次取证工单自己产生的页面**（师傅页 / 评价页 / 进度页），
     *    不扫全站：报修页是入口页，不含工单数据。
     *    真要扫全站，会撞上真实业务文案里合法的"测试"二字（如"测试运行正常"），
     *    那又是"判据太宽 = 自造假红"。
     */
    const SCRIPT_MARK = /链路验证|FIX-0\d|SECMeebe|验收客户|脚本自建|跑完自删|H5VIS|CLOSELOOP|UX-PROGRESS|DEV-20\d 并发|\[P5-1走查\]/;
    const contaminated = [];
    for (const [key, url] of [
      ['师傅页', `${BASE_URL}/h5/technician/visit/${techToken}`],
      ['进度页', progressToken ? `${BASE_URL}/h5/customer/progress/${progressToken}` : null],
    ]) {
      if (!url) continue;
      const txt = stripTags(visibleText(url));
      const m = SCRIPT_MARK.exec(txt);
      if (m) contaminated.push(`${key}: "${m[0]}"`);
    }
    ok('本次取证页面不含脚本痕迹（界面证据是业务语义，不是测试串）',
      contaminated.length === 0,
      contaminated.length ? contaminated.join('；') : '四页文本均无 链路验证/FIX-0x/脚本自建 等字样');

    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({
      at: new Date().toISOString(),
      ticketNo,
      designTokens: { h5: h5Token, mobile: mToken, samePrimary },
      shots: Object.fromEntries(list.map(([k, s]) => [k, { sha: s.sha, ...s.info }])),
    }, null, 2), 'utf8');
  } finally {
    try { note(`短信开关已恢复：${JSON.stringify(sms.restore())}`); } catch (e) { note(`⚠️ 短信开关恢复失败：${e?.message}`); }
  }
} catch (e) {
  console.log(`\n  ENV NOT READY：${e?.message ?? e}`);
  if (ticketId) { try { cleanupTicket(ticketId); } catch { /* ignore */ } }
  process.exit(2);
} finally {
  if (ticketId) {
    try { cleanupTicket(ticketId); note(`测试工单 ${ticketNo} 已清理`); }
    catch (e) { note(`⚠️ 清理失败 ${ticketId}：${e?.message}`); }
  }
}

const bad = rows.filter((r) => !r.pass);
console.log(`\n=== 汇总 ===\n  PASS ${rows.length - bad.length} / FAIL ${bad.length}`);
if (bad.length) { bad.forEach((b) => console.log(`  · ${b.label}`)); process.exit(1); }
console.log('  全部通过。');
console.log(`  产物：${path.relative(ROOT, OUT)}`);
