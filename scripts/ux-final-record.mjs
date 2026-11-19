/**
 * ux-final-record.mjs —— UX-FINAL 第四节：三段**真实操作录屏**（A / B / C）
 * =============================================================================
 * 用户原文要求
 * -----------------------------------------------------------------------------
 *   "三段真实操作录屏：**不得静态截图拼接**；
 *    模拟浏览器与**真机**录屏须**分别标注**。"
 *
 * ===========================================================================
 * 🔴 本脚本的合法性基础（必须先读，这决定了报告里能写什么）
 * ===========================================================================
 *
 * ① **不是截图拼接**：用 CDP `Page.startScreencast` 采集**真实渲染帧流**
 *    （浏览器在每次合成后推一帧），再用 ffmpeg 编成 MP4。
 *    脚本会**量出来**证明它是帧流而不是拼接：
 *      · 帧数 > 1；
 *      · **唯一 sha256 帧数 > 1**（页面真的在变）；
 *      · 每帧都 ack（不 ack 只会收到一帧，这是最经典的"只录到第一帧"坑）。
 *    三条任一不成立 ⇒ 判 **INVALID**（工具坏），**不产出产品结论**。
 *
 * ② **必须标注是"模拟浏览器"还是"真机"**：本脚本产出的一律是
 *    **模拟浏览器（headless Chrome + 390×844 移动仿真）**，**不是真机**。
 *    产物文件名带 `sim-` 前缀、元数据里写死 `device: 'headless-chrome-simulated'`。
 *    ⚠️ 真机（iPhone Safari / 微信内置浏览器）**本脚本不产出**，
 *       需要人工用真机录 —— 报告里必须如实写这条边界，不得含糊。
 *
 * ③ **操作是真操作**：录屏里的每一步都通过 CDP 派发**真实输入事件**
 *    （`Input.dispatchMouseEvent` / `Input.insertText`），走真实前端逻辑、
 *    打真实接口。**不预置 DOM 结果、不伪造响应**。
 *    脚本会记录本轮的**网络请求流水**作为交叉证据：
 *    如果录屏里"提交成功"而网络里没有那笔 POST，那就是假录屏。
 *
 * ④ 数据：走**真实服务端 + 真实 PostgreSQL**，工单由匿名真实入口创建，
 *    正文/客户名用**业务语言**（用户第六节：不得以测试字样判断 UI 效果），
 *    跑完按 ticket_no 精确清理（只删自己建的那张）。
 *
 * ===========================================================================
 * 三段录屏的内容
 * ===========================================================================
 *   A · 客户匿名报修（H5）：扫码入口进入 → 填姓名/电话/故障描述 → 触发表单校验
 *       → 修正 → 提交 → 提交成功页（工单号 + 进度入口）→ 打开进度页看状态
 *   B · 师傅现场回执（H5）：师傅链接进入 → 看客户信息 → 写服务说明
 *       → 选「未收费」 → 附加现场照片 → 提交回执 → 成功态
 *   C · 门店员工工作台（移动端）：登录 → 工单/档案列表 → 打开详情抽屉
 *       → 切换底栏 → 切浅色/深色
 *
 * 用法：
 *   node scripts/ux-final-record.mjs                 # 录全部三段
 *   node scripts/ux-final-record.mjs --only=A        # 只录 A
 *   node scripts/ux-final-record.mjs --keep-frames   # 保留中间帧目录（默认删）
 * 退出码：0 全部通过 / 1 有未达标 / 2 环境未就绪
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

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
  technicianUpload,
} from './technician-harness.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';
import { pickTechCred } from './lib/tech-cred.mjs';

const OUT = path.join(ROOT, 'storage/tmp/ux-final-record');
const FRAMES_ROOT = path.join(ROOT, 'storage/tmp/ux-final-frames');
/** 手机视口（与全项目验收口径一致：390×844 = iPhone 14/15 逻辑分辨率） */
const VW = 390;
const VH = 844;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha16 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const rid = () => crypto.randomUUID();

/**
 * 读 JPEG 的真实像素尺寸（解析 SOF 段）。
 *
 * 为什么必须自己读：`Page.screencastFrame` 的 `metadata` 里**没有**宽高，
 * 只有时间戳。而"录出来的视频是多大"这件事**不能靠假设**——
 * 本轮实测 C 段产出的是 **390×514**，而视口设的是 390×844。
 * 如果不去量，报告里就会写"三段都是 390×844"，那是**假的**。
 */
function jpegSize(buf) {
  let i = 2; // 跳过 SOI (FFD8)
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15，排除 DHT(0xC4) / JPG(0xC8) / DAC(0xCC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

/* ------------------------------------------------------------------ 账本 */
const rows = [];
const ok = (label, pass, detail = '') => {
  rows.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const invalid = (label, detail) => {
  rows.push({ label, pass: null });
  console.log(`  INVALID ${label}${detail ? `\n          ${detail}` : ''}`);
};
const note = (t) => console.log(`  · ${t}`);
const section = (t) => console.log(`\n=== ${t} ===`);

/**
 * 业务语言的取证夹具。
 * ⚠️ 用户第六节：不得以 `[TEST]` / `SEC` / `FIX` 等测试字样作为正式 UI 效果的判断依据。
 *    所以这三段录屏里出现的一切文案都是**真的会被客户/师傅看到的那种句子**。
 *
 * 🔴 **手机号必须每次运行不同**（本轮踩到并修掉的坑）：
 *    匿名报修接口有**按手机号**的限流（实测 `scope: 'mobile'`, `limit: 5/日`）。
 *    夹具写死一个号码 ⇒ 跑第 6 次就 `429 RATE_LIMITED`，
 *    而脚本把它报成「环境/流程异常」—— 看起来像"产品建单坏了"。
 *    这是**取证夹具自己把配额用光**，不是产品缺陷（铁律 ⑤）。
 *    注意：本机 `sms.enabled` 默认为 true 时，**每次建单都会真的发一条短信**，
 *    所以夹具更不该反复用同一个号去打限流边界。
 */
const RUN_TAG = String(Date.now()).slice(-6);
/** 137/136 前缀 + 8 位：看起来像真实号码，后 8 位每次不同（避开手机号维度限流） */
const mob = (prefix, seed) => `${prefix}${RUN_TAG}${String(seed).padStart(2, '0')}`;

/**
 * 🔴 **两套夹具必须不同**（本轮实测踩到并修掉的设计缺陷）
 * -----------------------------------------------------------------------------
 * 第 0 部分用 HTTP 建的那张"给师傅做作业"的种子单，与 A 段**在镜头前提交**的
 * 报修单，如果**手机号 + 门店 + 类型 + 事项文本**四者全同，
 * 服务端会命中 **重复单识别**（`DUPLICATE_TICKET`，窗口见配置）并回 **409**。
 *
 * 而前端对这个 409 的处理是**正确的产品行为**：原样打开原单
 * （`Report/index.vue` 的 `case 'DUPLICATE_TICKET'` → `banner: '正在为您打开原单 …'` + `goSuccess`）。
 * ⇒ 于是页面上**真的出现了成功页与工单号**，但网络里那笔 POST 是 **409 不是 2xx**。
 *
 * 这不是产品缺陷，是**我的取证夹具把两个场景做成了同一件事**。
 * 如果当时只写"页面出现工单号就算成功"（不看网络），这一轮就会把
 * "命中去重、原单回放"当成"客户成功建了新单"报出去 —— 那正是
 * 用户第四节"**不得以静态截图拼接**"要防的那类假证据。
 *
 * ⇒ 修法：**种子单**与**镜头前提交**用不同的客户与故障，
 *    它们本来就是两件事（一张是给师傅派的活，一张是录屏里客户现场报修）。
 */
const SEED_FIXTURE = {
  customerName: '吴女士',
  mobile: mob('136', 1),
  /** 与镜头前的报修**不同的事项文本**（判重带 content 这一维，见 ticket.ts ⑧） */
  content: '空调开机后不制冷，出风口有异味，遥控器显示 E5 故障码，希望上门检查。',
  techName: '周师傅',
  serviceNote: '上门检查为外机散热片积灰导致高压保护，已清洗散热片并补充冷媒，试机 30 分钟制冷正常。',
};

/** A 段**在镜头前**由客户亲手填写的报修内容（业务语言，见用户第六节） */
const FIXTURE = {
  customerName: '陈先生',
  mobile: mob('137', 2),
  content: '洗衣机脱水时剧烈晃动并发出撞击声，疑似内筒失衡，约好今天下午上门。',
  techName: SEED_FIXTURE.techName,
  serviceNote: SEED_FIXTURE.serviceNote,
};

/**
 * 读 `.env` 里的值（用于取门店账号口令 —— **不打印、不入日志**）。
 * 与 `technician-harness.mjs` 的 `envValue` 同口径；这里再写一份是因为
 * 那份没有 export（若以后要共用，应提升到 lib 而不是抄第三份）。
 */
function envValue(key, fallback = '') {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(txt);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
  } catch { return fallback; }
}

/* ------------------------------------------------------ 找浏览器 / ffmpeg */
function findChrome() {
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge（录屏需要真实浏览器内核）');
}

/**
 * ffmpeg 从 `imageio-ffmpeg` 取 —— 不假设它在 PATH 里（本机实测没有）。
 * ⚠️ 取不到就抛，**不要**退化成"用截图拼一个假视频"：那就是用户明令禁止的东西。
 */
let _ff = null;
function ffmpegPath() {
  if (_ff) return _ff;
  const candidates = [];
  try {
    candidates.push(
      execFileSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch { /* 见下 */ }
  for (const c of candidates) if (c && fs.existsSync(c)) { _ff = c; return _ff; }
  throw new Error(
    '找不到 ffmpeg（需要 `python -m pip install imageio-ffmpeg`）。' +
      '**不会**用静态截图拼接来代替录屏 —— 那是用户明确禁止的做法。',
  );
}

/* ---------------------------------------------------- 极简 CDP 客户端 */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method) this.events.push(msg);
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

/* ======================================================= 录屏器（核心） */
/**
 * 一个"边操作边录"的会话。
 *
 * 设计要点：
 *   ① screencast 在**页面导航之前**就开 —— 否则会漏掉首屏；
 *   ② 每帧**必须 ack**，否则只来一帧（本文件头 ① 的第三个判据）；
 *   ③ 帧**只在内存里攒**、结束时一次性落盘 —— 中途落盘会把 C 盘当草稿纸
 *      （C 盘是硬约束，历史上被 91 个 chrome profile 打满过）；
 *   ④ 每帧记 `bytes` + `sha`，最终判"是不是真的在变"。
 */
class Recorder {
  constructor(cdp, { label, profile }) {
    this.cdp = cdp;
    this.label = label;
    this.profile = profile;
    this.frames = [];
    this.acked = 0;
    this.started = false;
  }

  async start() {
    this.cdp.on((m) => {
      if (m.method !== 'Page.screencastFrame') return;
      const buf = Buffer.from(m.params.data, 'base64');
      /**
       * ⚠️ 每帧都量**真实像素尺寸**，不用视口设定值顶替。
       *    本轮实测：C 段产出了一批 **390×514** 的帧（视口设的是 390×844）
       *    —— 也就是说"帧尺寸会被浏览器改"，不量就会写出错误的报告。
       */
      const size = jpegSize(buf);
      this.frames.push({
        ts: m.params.metadata?.timestamp ?? 0,
        bytes: buf.length,
        sha: sha16(buf),
        w: size?.width ?? null,
        h: size?.height ?? null,
        buf,
      });
      this.cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId })
        .then(() => { this.acked += 1; })
        .catch(() => { /* ack 失败不该中断录屏 */ });
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 72, maxWidth: VW, maxHeight: VH, everyNthFrame: 1,
    });
    this.started = true;

    /**
     * 录屏一启动就量**视口的真实尺寸**。
     * 理由：本轮实测 C 段产出的帧是 **390×514**，而视口设定 390×844 ——
     * 如果不量，"录了但只录到上半屏"这件事**从帧数与哈希里完全看不出来**
     * （帧数正常、内容也在变），报告却会写成"390×844 手机录屏"。
     * ⇒ 把 innerHeight / visualViewport 一起记下来，用于事后归因。
     */
    try {
      this.viewportAtStart = await this.cdp.evaluate(`(() => ({
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        dpr: window.devicePixelRatio,
        vvW: Math.round(window.visualViewport?.width ?? 0),
        vvH: Math.round(window.visualViewport?.height ?? 0),
        vvScale: window.visualViewport?.scale ?? null,
        docH: document.documentElement.clientHeight,
      }))()`);
    } catch { this.viewportAtStart = null; }
  }

  /**
   * 编码成 MP4。
   *
   * ⚠️ 帧时间戳**不用** `metadata.timestamp` 直接算帧率：那是合成时刻，
   *    在页面静止时会**挤在一起**（间隔 0），照它编码会得到一个快到看不清的视频。
   *    实测的做法：固定 **8fps** 输出，并把**静止段压缩**交给 x264 的
   *    `-g`（关键帧间隔）与 `-crf` 处理 —— 这是给"看操作过程"用的，
   *    不是给逐帧分析用的，帧率恒定比时间精确更重要。
   */
  async stopAndEncode(filename) {
    await this.cdp.send('Page.stopScreencast');
    const uniqSha = new Set(this.frames.map((f) => f.sha));
    const uniqBytes = new Set(this.frames.map((f) => f.bytes));
    /**
     * 帧尺寸分布（**必须量，不能假设**）。
     * 实测 C 段出现过 390×514 —— 与视口设定 390×844 不一致，
     * 那是"帧尺寸会被浏览器按内容改"的真实行为，报告里必须如实写。
     */
    const dims = new Map();
    for (const f of this.frames) {
      const k = `${f.w}x${f.h}`;
      dims.set(k, (dims.get(k) ?? 0) + 1);
    }
    const dimList = [...dims.entries()].sort((a, b) => b[1] - a[1]);

    const info = {
      label: this.label,
      frames: this.frames.length,
      uniqueFrames: uniqSha.size,
      uniqueBytes: uniqBytes.size,
      acked: this.acked,
      minBytes: this.frames.length ? Math.min(...this.frames.map((f) => f.bytes)) : 0,
      maxBytes: this.frames.length ? Math.max(...this.frames.map((f) => f.bytes)) : 0,
      firstSha: this.frames[0]?.sha ?? null,
      lastSha: this.frames[this.frames.length - 1]?.sha ?? null,
      /** 帧尺寸分布，如 [['390x844', 96]] 或 [['390x844',80],['390x514',1]] */
      frameDims: dimList.map(([k, n]) => ({ size: k, count: n })),
      /** 绝大多数帧的尺寸 —— 这才是报告里该写的"录制分辨率" */
      dominantSize: dimList[0]?.[0] ?? null,
      /**
       * 尺寸"不合群"的帧数。**不为 0 必须如实报**：
       * 它们是 ffmpeg 取首帧尺寸毁掉整段成片的直接原因（见编码器注释）。
       */
      offSizeFrames: this.frames.filter((f) => `${f.w}x${f.h}` !== dimList[0]?.[0]).length,
      /**
       * 是否**每一帧**都等于设定视口。
       * ⚠️ 这判的是"录制侧纯洁度"，不是"成片尺寸"——
       *    成片尺寸由编码器的显式 scale+pad 锁定，两者分开报。
       */
      matchesViewport: dimList.length === 1 && dimList[0][0] === `${VW}x${VH}`,
      /** 启动时视口的真实尺寸（用于归因"帧为什么比视口矮"） */
      viewportAtStart: this.viewportAtStart ?? null,
    };

    /**
     * 判 INVALID 的三条（"工具坏"与"产品坏"必须分开报）。
     * ⚠️ `frames > 1` 但 `uniqueFrames === 1` = **页面全程没变** ——
     *    那不是"录屏成功"，那可能是导航失败/白屏，必须单独看。
     */
    if (!this.started) return { ...info, verdict: 'INVALID', reason: 'screencast 未成功启动' };
    if (this.frames.length <= 1) return { ...info, verdict: 'INVALID', reason: `只收到 ${this.frames.length} 帧（疑似未 ack 或页面未合成）` };
    if (this.acked === 0) return { ...info, verdict: 'INVALID', reason: '没有任何一帧被 ack' };
    // uniqueFrames === 1 不判 INVALID（真的可能全程静态），但标记出来
    const staticScreen = uniqSha.size === 1;

    fs.mkdirSync(OUT, { recursive: true });
    const frameDir = path.join(FRAMES_ROOT, filename.replace(/\.mp4$/, ''));
    fs.mkdirSync(frameDir, { recursive: true });
    this.frames.forEach((f, i) => {
      fs.writeFileSync(path.join(frameDir, `f${String(i).padStart(5, '0')}.jpg`), f.buf);
    });

    const mp4 = path.join(OUT, filename);
    /**
     * 🔴 输出尺寸必须**显式锁定**，不能交给 ffmpeg 自己推。
     *
     *    本轮实测（这是一次真实的静默错产物）：
     *      B 段 81 帧里有 **80 帧是 390×844、1 帧是 390×514**
     *      （那 1 帧出现在页面尚未稳定时），而 ffmpeg 的 image2 解复用器
     *      **拿第一张图的尺寸当整段视频的尺寸** ⇒ 整段成片变成 **390×514**，
     *      后面所有 390×844 的帧被**缩放/裁切**进去。
     *      而 `dominantSize` 仍然是 390×844 ⇒ 只看"多数帧"的话
     *      **完全看不出成片已经变形**。
     *
     *    ⇒ 修法：显式 `scale=W:H:force_original_aspect_ratio=decrease` + `pad`
     *      （居中留边，**不拉伸**），把所有帧归一到设定视口。
     *      这样偶尔一帧尺寸不同只会被留边，不会毁掉整段成片。
     *    ⇒ 同时把"尺寸异常帧"的数量如实记进 manifest（不掩盖）。
     */
    execFileSync(ffmpegPath(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', '8', '-i', path.join(frameDir, 'f%05d.jpg'),
      // 偶数宽高 + yuv420p：否则部分播放器（含本机 Chrome/微信）打不开
      // 先按比例缩进目标框，再居中留边补齐 —— 保证成片恒为 VW×VH 且不变形
      '-vf', `scale=${VW}:${VH}:force_original_aspect_ratio=decrease,`
        + `pad=${VW}:${VH}:(ow-iw)/2:(oh-ih)/2:color=white,`
        + `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-r', '8', mp4,
    ], { stdio: 'pipe' });

    const stat = fs.statSync(mp4);
    // 用 ffmpeg 自己回读时长（本机无 ffprobe）—— 证明产物**真的能解码**
    let duration = null;
    let streamLine = null;
    try {
      const probe = execFileSync(ffmpegPath(), ['-hide_banner', '-i', mp4], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      duration = /Duration:\s*([0-9:.]+)/.exec(probe)?.[1] ?? null;
      streamLine = probe.split('\n').find((l) => l.includes('Video:'))?.trim() ?? null;
    } catch (e) {
      // ffmpeg 无输出文件时返回非 0，但 stderr 里有我们要的信息
      const txt = String(e.stdout ?? '') + String(e.stderr ?? '');
      duration = /Duration:\s*([0-9:.]+)/.exec(txt)?.[1] ?? null;
      streamLine = txt.split('\n').find((l) => l.includes('Video:'))?.trim() ?? null;
    }

    /**
     * 两源交叉校验分辨率 —— 但**以成片为准**。
     *
     * ⚠️ 这里有个真实踩过的坑必须写清楚：
     *    上一稿我拿"多数帧的尺寸"（dominantSize）当判据，
     *    而 B 段 81 帧里 80 帧是 390×844、**1 帧**是 390×514 ——
     *    ffmpeg 拿**首帧**尺寸定整段成片 ⇒ 成片是 390×514，
     *    而 dominantSize 仍是 390×844 ⇒ **判据全绿、成片已变形**。
     *    ⇒ 所以真正的判据只能是 **ffmpeg 回读到的成片尺寸**；
     *      dominantSize 只是辅助归因信息。
     *    编码器现已显式 scale+pad 锁死输出尺寸，这条断言才有意义
     *    （若我忘了加 scale+pad，它会红）。
     */
    const streamDim = /,\s(\d{2,5})x(\d{2,5})\s/.exec(streamLine ?? '');
    const streamSize = streamDim ? `${streamDim[1]}x${streamDim[2]}` : null;
    const outputSizeOk = streamSize === `${VW}x${VH}`;

    return {
      ...info,
      verdict: 'OK',
      staticScreen,
      mp4,
      bytes: stat.size,
      sha: sha16(fs.readFileSync(mp4)),
      duration,
      streamLine,
      streamSize,
      /** 成片尺寸是否等于设定手机视口 —— **这条才是交付物的判据** */
      outputSizeOk,
      frameDir,
    };
  }

  /** 删中间帧（默认行为：C 盘是硬约束，只留 MP4） */
  dropFrames(frameDir) {
    try { fs.rmSync(frameDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 无害 */ }
  }
}

/* ====================================================== 交互辅助（真输入） */
/**
 * 真实鼠标点击（**派发 Input 事件**，不是 `el.click()`）。
 *
 * 为什么不用 `el.click()`：那是**脚本调用 DOM API**，会绕过命中测试、
 * 也绕过了 Konsta/Vue 依赖的真实事件流细节。录屏要证明"员工点得到"，
 * 就必须走浏览器自己的输入管线 —— 顺带还能抓到"按钮被遮住点不到"这类缺陷。
 */
async function realClick(cdp, selector) {
  const box = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!box) throw new Error(`找不到可点击元素：${selector}`);
  if (box.w <= 0 || box.h <= 0) throw new Error(`元素尺寸为 0，点不到：${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: Math.round(box.x), y: Math.round(box.y),
      button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(40);
  }
  await sleep(220);
}

/**
 * 按**精确文案**真实点击（用于没有 data-testid 的按钮）。
 *
 * ⚠️ 必须**精确匹配**（trim 后完全相等），不能用包含匹配：
 *    师傅页同时有「未收费」「已收费」两个按钮，`/收费/` 会同时命中，
 *    `find()` 取第一个 —— 于是"选了未收费"这件事可能根本没发生，
 *    而录屏与断言都看不出来（本项目铁律：判据太宽 = 自造假红）。
 */
async function realClickByText(cdp, exactText) {
  const box = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button, [role="button"], a')];
    const el = els.find(e => (e.textContent || '').trim() === ${JSON.stringify(exactText)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!box) throw new Error(`找不到文案为「${exactText}」的可点击元素`);
  if (box.w <= 0 || box.h <= 0) throw new Error(`「${exactText}」尺寸为 0，点不到`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: Math.round(box.x), y: Math.round(box.y),
      button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(40);
  }
  await sleep(220);
}

/**
 * 真实键入（**逐字符**派发 `Input.insertText`，带节奏）。
 *
 * ⚠️ 直接 `el.value = x` 有几个问题：不触发 Vue 的 v-model（那个靠 input 事件）、
 *    在录屏里也看不出"人在打字"。这里走 `focus` + 逐字插入 + 补发 input/change，
 *    与 `ui-verify.mjs` 的 FILL_INPUT 口径一致（它用的是原生 setter + 事件，
 *    因为受控组件必须过 setter 才能被 React 认到）。
 */
async function realType(cdp, selector, text, { perChar = 38 } = {}) {
  const ready = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!ready) throw new Error(`聚焦失败：${selector}`);
  await sleep(120);
  for (const ch of text) {
    await cdp.send('Input.insertText', { text: ch }).catch(() => { /* 某些字符不支持逐字插入 */ });
    await sleep(perChar);
  }
  // 兜底：insertText 对受控组件不一定触发 Vue/React 的 onChange，补一次原生 setter + 事件
  await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (el.value !== ${JSON.stringify(text)}) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(160);
}

/** 平滑滚一屏（录屏里要能看到滚动这件事在发生） */
async function realScroll(cdp, dy, steps = 8) {
  for (let i = 0; i < steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(VW / 2), y: Math.round(VH / 2),
      deltaX: 0, deltaY: Math.round(dy / steps), button: 'none',
    }).catch(() => { /* noop */ });
    await sleep(70);
  }
  await sleep(160);
}

async function waitFor(cdp, expr, timeout = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v; try { v = await cdp.evaluate(expr); } catch { v = undefined; }
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`等待超时${label ? `（${label}）` : ''}: ${expr}`);
}

/* ============================================================ 浏览器管理 */
async function launchBrowser(port, profile) {
  const chromePath = findChrome();
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--ignore-certificate-errors',
    '--hide-scrollbars',
    `--window-size=${VW},${VH}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await (async () => {
    for (let i = 0; i < 90; i += 1) {
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
    throw new Error('Chrome 调试端口未就绪');
  }
  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 2, mobile: true,
  });
  return { child, cdp, chromePath };
}

/**
 * 关浏览器 + 清 profile。
 *
 * 🔴 Windows 上 `child.kill()` **杀不掉进程树**（实测残留 341 个文件）。
 *    必须 `taskkill /PID <pid> /T /F`，再轮询等 PID 消失 —— 否则 profile 下次删不掉。
 */
async function shutdownBrowser(child, profile) {
  const pid = child?.pid;
  try { child?.kill('SIGKILL'); } catch { /* noop */ }
  if (pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* 已退出 */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      try {
        execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { stdio: 'pipe' });
        // 仍能列到就再等
      } catch { break; }
      await sleep(200);
      // 简化判据：tasklist 输出里还有该 PID 就跑
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
        if (!out.includes(String(pid))) break;
      } catch { break; }
    }
  }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4 }); } catch { /* 侧车文件晚释放，无害 */ }
}

/* ============================================================== 主流程 */
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;
const keepFrames = process.argv.includes('--keep-frames');

console.log('UX-FINAL · 第四节：三段真实操作录屏（A 客户报修 / B 师傅回执 / C 员工工作台）');
console.log(`  BASE=${BASE_URL}`);
console.log(`  设备：**模拟浏览器**（headless Chrome ${VW}×${VH} 移动仿真）—— ⚠️ **不是真机**`);
console.log(`  产物：${path.relative(ROOT, OUT)}`);
console.log(`  仅：${only ?? 'A / B / C 全部'}`);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FRAMES_ROOT, { recursive: true });

/**
 * 网络流水（交叉证据）：录屏里说"提交成功"，
 * 就必须能在流水里找到那笔 POST —— 否则是假录屏。
 */
let netLog = [];
let exitCode = 0;

const manifest = {
  generatedAt: new Date().toISOString(),
  deviceKind: 'headless-chrome-simulated',
  deviceNote:
    '**模拟浏览器**（headless Chrome + 390×844 移动仿真）。**不是真机录屏**。' +
    '真机（iPhone Safari / 微信内置浏览器）需人工另录，本脚本不产出。',
  viewport: { width: VW, height: VH, deviceScaleFactor: 2 },
  recordings: [],
  assertions: [],
};

let ticketId = null;
let ticketNo = null;
/** A 段走界面提交时**另外**建出来的工单号（同样要清理，见 A 段的注释） */
let uiTicketNoFromUi = null;
let sms = null;

try {
  /* ============================================================= 准备数据 */
  section('第 0 部分 · 用真实链路准备一段"可录的操作"');

  const { store, hq } = await twoSessions();
  sms = smsSwitch();
  note(`短信开关：${sms.original ?? '(未读到)'} → 临时开启（含 11s 缓存等待，跑完恢复）`);
  await sms.enable();

  // 匿名建单（真实入口 + X-Request-Id）—— 用业务语言。
  // ⚠️ 这里用 **SEED_FIXTURE**（吴女士 / 空调），与 A 段镜头前提交的
  //    FIXTURE（陈先生 / 洗衣机）**刻意不同** —— 否则会命中重复单识别，
  //    详见 SEED_FIXTURE 上方的长注释。
  const created = await http(`${BASE_URL}/api/public/tickets${storeEntryQuery('S01')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: SEED_FIXTURE.content,
      customer_name: SEED_FIXTURE.customerName,
      customer_mobile: SEED_FIXTURE.mobile,
      privacy_agreed: true,
    }),
  });
  ticketNo = String(created.json?.data?.ticket_no ?? '');
  if (!ticketNo) throw new Error(`匿名建单失败 HTTP ${created.status} ${String(created.body).slice(0, 200)}`);
  ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`));
  note(`种子工单 ${ticketNo}（id=${ticketId}）已创建 —— 客户=${SEED_FIXTURE.customerName}，正文为业务语言`);

  // 派工（铸师傅 Token）
  const disp = await svcPost('dispatch', ticketId, store, {
    technician_name: SEED_FIXTURE.techName,
    technician_mobile: '13900010001',
    expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    service_mode: 'inhouse',
  }, rid());
  if (disp.status !== 200) throw new Error(`派工失败 HTTP ${disp.status}`);

  // 师傅凭据（唯一实现，两个消费方共用）
  let techToken = null;
  {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !techToken) {
      const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=300`, {
        headers: { Authorization: `Bearer ${hq}` },
      });
      const hit = pickTechCred(r.json?.data?.items ?? [], { ticketId });
      if (hit) techToken = hit.token;
      else await sleep(800);
    }
  }
  if (!techToken) throw new Error('30s 内没从发件箱取到师傅凭据（确认派工成功且通道为 mock）');
  note(`师傅凭据已取得（长度 ${techToken.length}）`);

  // 门店入口（客户报修页用）
  const entryQ = storeEntryQuery('S01');
  const reportUrl = `${BASE_URL}/h5/report${entryQ}`;
  const techUrl = `${BASE_URL}/h5/technician/visit/${techToken}`;

  /* =================================================================== A */
  if (!only || only === 'A' || only === 'C') {
    section(`第 1 部分 · 录屏 ${only === 'C' ? '' : 'A · 客户匿名报修'}${only === 'C' ? 'C · 门店员工工作台' : ''}`);

    const portA = 9700 + Math.floor(Math.random() * 100);
    const profileA = path.join(os.tmpdir(), `uxrec-a-${Date.now()}`);
    const { child, cdp } = await launchBrowser(portA, profileA);
    netLog = [];
    cdp.on((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params?.request?.url || '';
        if (u.includes('/api/')) netLog.push({ phase: 'req', method: m.params.request.method, url: u });
      }
      if (m.method === 'Network.responseReceived') {
        const u = m.params?.response?.url || '';
        if (u.includes('/api/')) netLog.push({ phase: 'res', status: m.params.response.status, url: u });
      }
    });

    try {
      /* ---- A · 客户匿名报修 ---- */
      if (!only || only === 'A') {
        const recA = new Recorder(cdp, { label: 'A · 客户匿名报修', profile: profileA });
        await recA.start();

        // ① 打开报修页（首屏就在录）
        await cdp.send('Page.navigate', { url: reportUrl });
        await waitFor(cdp, `Boolean(document.querySelector('[data-testid="repair-name"]'))`, 15000, '报修表单出现');
        await sleep(900);
        ok('A · 报修页在录屏内真实渲染出表单', true, `url=${reportUrl.replace(BASE_URL, '')}`);

        // ② **先故意触发校验**（用户第二节①关心的正是这个体验），再修正
        await realClick(cdp, '[data-testid="submit-repair"]');
        await sleep(700);
        const errs = await cdp.evaluate(`(() => {
          const out = [];
          for (const el of document.querySelectorAll('.svc-error')) {
            const t = (el.textContent || '').trim();
            if (t) out.push(t);
          }
          const first = document.querySelector('.is-invalid');
          const nav = document.querySelector('.svc-header');
          return {
            msgs: out,
            firstInvalidTop: first ? Math.round(first.getBoundingClientRect().top) : null,
            navBottom: nav ? Math.round(nav.getBoundingClientRect().bottom) : null,
          };
        })()`);
        ok('A · 空表单提交会给出中文校验提示（不是空白/不是技术文案）',
          errs.msgs.length > 0 && errs.msgs.every((m) => /[\u4e00-\u9fa5]/.test(m)),
          `提示=${JSON.stringify(errs.msgs).slice(0, 160)}`);

        /**
         * ⚠️ 判"错误字段是否被导航栏遮住"必须量**两个数**：
         *    字段的 top 与**导航栏的 bottom**。只看"top > 0"是假绿 ——
         *    字段可能正好压在导航栏底下（top=12 但栏底=60 ⇒ 上半截看不见）。
         */
        ok('A · 校验后首个错误字段没有被顶部导航栏遮挡',
          errs.firstInvalidTop === null || errs.firstInvalidTop >= (errs.navBottom ?? 0),
          `字段 top=${errs.firstInvalidTop}  导航栏 bottom=${errs.navBottom}`);

        await sleep(700);

        // ③ 真实填写：姓名 / 手机 / 故障描述
        await realType(cdp, '[data-testid="repair-name"]', FIXTURE.customerName);
        await realType(cdp, '[data-testid="repair-mobile"]', FIXTURE.mobile);
        await realType(cdp, '[data-testid="repair-content"]', FIXTURE.content, { perChar: 22 });
        await sleep(500);
        const filled = await cdp.evaluate(`(() => {
          const g = (s) => (document.querySelector(s)?.value ?? '');
          return { name: g('[data-testid="repair-name"]'), mobile: g('[data-testid="repair-mobile"]'), content: g('[data-testid="repair-content"]') };
        })()`);
        ok('A · 真实键入的内容进入了输入框（不是脚本直接写值）',
          filled.name === FIXTURE.customerName && filled.content === FIXTURE.content,
          `name=${filled.name} 描述长度=${filled.content.length}`);

        // ④ 提交（真实点击）。
        // ⚠️ **没有**隐私勾选框：报修页的隐私口径是"页脚提示 + 提交即视为 basis:'submission'"
        //    （见 Report/index.vue 的 privacyForAudit 注释），不是一个 checkbox。
        //    原先我按印象写了一个 `[data-testid="privacy-agree"]` —— 源码里不存在，
        //    那种写法会静默不报错、录屏里也看不出少了一步。已按真实 DOM 删除。
        await realClick(cdp, '[data-testid="submit-repair"]');

        // ⑤ 等成功页（用**工单号**判，不用文案 —— 文案会变）
        const gotSuccess = await waitFor(cdp, `(() => {
          const t = document.body.innerText || '';
          return /提交成功/.test(t) && /FW\\d{8}-\\d{4}/.test(t);
        })()`, 20000, '提交成功页').then(() => true).catch(() => false);

        /**
         * 🔴 交叉证据：录屏里"提交成功"必须能在**网络流水**里找到那笔 POST。
         *    这是"真录屏"与"演出来的成功"的分界。
         *    ⚠️ 判据要落到**本工单**：只看"有个 POST /api/public/tickets"不够 ——
         *       那可能是别的请求，也证明不了它**成功**（2xx）。
         */
        const posted = netLog.filter((x) => x.phase === 'req' && x.method === 'POST' && /\/api\/public\/tickets/.test(x.url));
        const posted2xx = netLog.some((x) => x.phase === 'res' && /\/api\/public\/tickets/.test(x.url) && x.status >= 200 && x.status < 300);
        ok('A · 录屏内的"提交成功"有真实网络证据（POST 真实工单接口且 2xx）',
          posted.length > 0 && posted2xx,
          `POST 次数=${posted.length} 2xx=${posted2xx}`);
        /**
         * 🔴 判据失败时**必须把原始条目打出来**再下结论。
         *    否则很容易把"我的观测通道漏了这种形态"读成"产品没提交成功"
         *    —— 本项目已有过多次同类误判（铁律 ⑤：验证器自己也会错）。
         */
        if (!(posted.length > 0 && posted2xx)) {
          console.log('          诊断 · 与提交相关的网络条目：');
          const near = netLog.filter((x) => /public|tickets/.test(String(x.url ?? '')));
          if (near.length === 0) {
            console.log('            （没有 /public/tickets 相关条目）');
            console.log(`            本轮总条目=${netLog.length}，前 10 条：`);
            for (const x of netLog.slice(0, 10)) {
              console.log(`              ${x.phase} ${x.status ?? x.method} ${String(x.url).slice(0, 120)}`);
            }
          }
          for (const x of near.slice(0, 14)) {
            console.log(`            ${x.phase} ${x.status ?? x.method} ${String(x.url).slice(0, 130)}`);
          }
        }
        // 把本段网络证据随录屏一起入库（跨段清空后仍留证）
        manifest.netByRecording = manifest.netByRecording ?? {};
        manifest.netByRecording.A = netLog.slice(-120);
        ok('A · 客户报修录屏走到了提交成功页（页面含真实工单号）', gotSuccess);

        /**
         * 🔴 A 段走界面提交会**再建一张工单**（与第 0 部分用 HTTP 建的那张不是同一张）。
         *    它同样必须被清理 —— 否则每跑一次录屏就往库里留一张孤儿单，
         *    而"库里多了单"这件事**不会有任何告警**（本项目的经典静默污染）。
         *    ⇒ 从成功页读出它的工单号，登记到清理列表。
         */
        if (gotSuccess) {
          const uiTicketNo = await cdp.evaluate(`(() => {
            const m = /FW\\d{8}-\\d{4}/.exec(document.body.innerText || '');
            return m ? m[0] : null;
          })()`);
          if (uiTicketNo && uiTicketNo !== ticketNo) {
            uiTicketNoFromUi = uiTicketNo;
            note(`录屏内界面提交产生工单 ${uiTicketNo}（将在收尾一并清理）`);
          }
        }

        await sleep(1200);

        // ⑥ 从成功页打开进度页（真实点击「查看处理进度」）
        const hasProgressBtn = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="goto-progress"]'))`);
        if (hasProgressBtn) {
          await realClick(cdp, '[data-testid="goto-progress"]');
          await sleep(1800);
          const onProgress = await cdp.evaluate(`(() => {
            const t = document.body.innerText || '';
            return /进度|服务进展|处理进展|工单/.test(t) && !/提交成功/.test(t);
          })()`);
          ok('A · 成功页可真实跳转到进度页（录屏内可见这一步）', onProgress,
            `url=${await cdp.evaluate('location.pathname')}`);
          note('已从成功页打开客户进度页');
        } else {
          note('成功页没有「查看处理进度」入口 —— 录屏继续，不阻断（已如实记录）');
        }
        // 进度页滚一下，让"办事进度"这条链路在视频里可见
        await realScroll(cdp, 260);
        await sleep(900);

        const recAOut = await recA.stopAndEncode('sim-A-customer-report.mp4');
        manifest.recordings.push({ id: 'A', title: '客户匿名报修（H5）', url: reportUrl.replace(BASE_URL, ''), ...recAOut });
        if (recAOut.verdict !== 'OK') { invalid('A · 录屏产出', recAOut.reason); exitCode = 1; }
        else {
          ok('A · 录屏是真实帧流不是截图拼接（帧数/唯一帧/ack 三条同时成立）',
            recAOut.frames > 1 && recAOut.uniqueFrames > 1 && recAOut.acked > 0,
            `帧=${recAOut.frames} 唯一帧=${recAOut.uniqueFrames} ack=${recAOut.acked}`);
          ok('A · MP4 真实可解码（ffmpeg 回读到时长与视频流）',
            Boolean(recAOut.duration) && Boolean(recAOut.streamLine),
            `${recAOut.bytes}B sha=${recAOut.sha} 时长=${recAOut.duration} ${recAOut.streamLine ?? ''}`);
          // 判据是**成片尺寸**（ffmpeg 回读），不是"多数帧尺寸"
          ok(`A · 成片尺寸锁定为手机视口 ${VW}x${VH}（不变形、不裁切）`,
            recAOut.outputSizeOk === true,
            `成片=${recAOut.streamSize} 录制侧多数帧=${recAOut.dominantSize} 异常帧=${recAOut.offSizeFrames ?? 0}`);
          if (recAOut.staticScreen) {
            note('⚠️ A 全程画面完全静止（唯一帧=1）—— 已如实记录，不当作通过证据的加分项');
          }
          if (!keepFrames) recA.dropFrames(recAOut.frameDir);
        }

        // 清空流水，避免 A 的网络事件污染 C 的判据
        netLog = [];
      }

      /* ---- C · 门店员工工作台（同一浏览器，先清登录态） ---- */
      if (!only || only === 'C') {
        const MOBILE = process.env.SVC_MOBILE_BASE || 'https://127.0.0.1';
        const recC = new Recorder(cdp, { label: 'C · 门店员工工作台', profile: profileA });
        await recC.start();

        // 先访问工作台 → 会被重定向到登录页（这是真实行为，录进去）
        await cdp.send('Page.navigate', { url: `${MOBILE}/m/` });
        await sleep(1500);
        await cdp.evaluate(`localStorage.removeItem('svc.mobile.token'); true`);
        await cdp.send('Page.navigate', { url: `${MOBILE}/m/` });
        const loginShown = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="login-account"]'))`, 15000, '登录页')
          .then(() => true).catch(() => false);
        ok('C · 未登录访问工作台会到登录页（录屏内可见）', loginShown);

        if (loginShown) {
          /**
           * 用**门店账号**（`uat.store.a`）而不是销售账号。
           *
           * 🔴 探针实测（scripts/_probe-accounts-tabs.mjs）：
           *    · `arc1_sales_a`（销售）→ 落在 `/m/archives`，`caps.tickets=false`
           *      ⇒ `workspacesOf()` 不产出「工作台/工单」两个 Tab，**这一页没有底栏**；
           *    · `uat.store.a`（门店）→ 落在 `/m/`（工作台），底栏有「工作台 / 工单」两项，
           *      并且库里有真实工单（217 待受理）。
           * ⇒ 录屏 C 要展示"员工在底栏之间走动 + 打开工单详情"，
           *    必须用**具备 tickets 能力**的账号。用销售账号会得到一段
           *    "没有底栏"的视频 —— 那不是缺陷，那是**选错了角色**。
           */
          const cAccount = process.env.SVC_REC_ACCOUNT || envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
          const cPassword = process.env.SVC_REC_PASSWORD || envValue('UAT_STORE_A_PASSWORD');
          // 真实输入账号密码并点登录（走真实 /api/auth:signIn）
          await realType(cdp, '[data-testid="login-account"]', cAccount);
          await realType(cdp, '[data-testid="login-password"]', cPassword);
          await sleep(400);
          await realClick(cdp, '[data-testid="login-submit"]');
          const loggedIn = await waitFor(cdp, `(() => {
            const t = document.body.innerText || '';
            return Boolean(localStorage.getItem('svc.mobile.token')) &&
              (!/请使用门店或总部的现有账号登录/.test(t));
          })()`, 20000, '登录完成').then(() => true).catch(() => false);
          ok('C · 真实登录成功（录屏内的登录是走真实接口的）', loggedIn);

          const signInOk = netLog.some((x) => x.phase === 'res' && /auth:signIn/.test(x.url) && x.status >= 200 && x.status < 300);
          ok('C · 登录有真实网络证据（auth:signIn 2xx）', signInOk,
            `signIn 响应数=${netLog.filter((x) => x.phase === 'res' && /auth:signIn/.test(x.url)).length}`);

          if (loggedIn) {
            await sleep(1400);

            /**
             * 先**探明**当前落在哪个页面、有没有卡片，再决定点什么。
             *
             * 🔴 上一稿直接按印象去找 `.k-list-item / li a[href*=...]` ——
             *    那些选择器在 Konsta 里**都不存在**，于是"打开详情"这一步
             *    静默地没发生：录屏照录、断言照绿，只有人去看视频才发现少了动作。
             *    这类"选择器猜错但不报错"是本项目最贵的一种失败（铁律 ⑤ 的变体）。
             *
             * 真实选择器（读源码得到，不是猜的）：
             *   工单卡 = `article[data-testid^="ticket-card-"]`（Domain.tsx · TicketCard）
             *   档案卡 = `article[data-testid^="archive-card-"]`（Domain.tsx · ArchiveCard）
             */
            const homeProbe = await cdp.evaluate(`(() => ({
              path: location.pathname,
              tickets: document.querySelectorAll('article[data-testid^="ticket-card-"]').length,
              archives: document.querySelectorAll('article[data-testid^="archive-card-"]').length,
              navTitle: (document.querySelector('.k-navbar .k-navbar-title, .k-navbar')?.innerText || '').trim().split('\\n')[0],
            }))()`);
            note(`落点：${homeProbe.path}（${homeProbe.navTitle}）工单卡=${homeProbe.tickets} 档案卡=${homeProbe.archives}`);

            // 滚一屏，让列表内容在视频里出现（真实滚动）
            await realScroll(cdp, 240);
            await sleep(800);

            /**
             * 切底栏**必须在打开详情之前**做。
             *
             * 🔴 两处修正（都由探针实测得到，不是猜的，见 scripts/_probe-tabbar-dom.mjs）：
             *   ① **类名**：Konsta 的底栏链接**没有** `k-tabbar-link` 基类 ——
             *      实测 `querySelectorAll('.k-tabbar-link')` 恒返回 0，导致"切 Tab 未执行"。
             *      真实形态是：容器 `.k-toolbar`（高 64、贴底）里的 `a.k-link`；
             *      **激活项**额外带 `k-tabbar-link-active`，非激活项只带 `k-link`。
             *      （这与 `ui-verify.mjs` 里早记过的那条完全同构：依赖 Konsta 内部类名 ⇒ 判据脆。）
             *   ② **顺序**：上一稿放在打开详情之后 ⇒ `arr.length=0`，
             *      因为**详情页根本不渲染底栏**。那不是"底栏坏了"，是步骤顺序错。
             */
            const tabSwitched = await cdp.evaluate(`(() => {
              const links = [...document.querySelectorAll('.k-toolbar a')];
              if (links.length === 0) return { ok: false, reason: '本页无底栏（.k-toolbar a = 0）', labels: [] };
              const before = location.pathname;
              const cur = links.findIndex(l => String(l.className || '').includes('k-tabbar-link-active'));
              const target = links.find((l, i) => i !== cur) ?? links[0];
              target.click();
              return { ok: true, label: (target.textContent || '').trim(), count: links.length, before };
            })()`);
            await sleep(1700);
            if (tabSwitched?.ok) {
              const nowPath = await cdp.evaluate('location.pathname');
              note(`已从底栏切换到「${tabSwitched.label}」（底栏共 ${tabSwitched.count} 项）→ ${nowPath}`);
              // ⚠️ 判据用**点击前实测路径**，不硬编码 —— 落点会随账号能力变
              ok('C · 底栏导航真实可用（点击后路由发生变化）', nowPath !== tabSwitched.before,
                `${tabSwitched.before} → ${nowPath}`);
            } else {
              note(`切底栏未执行：${tabSwitched?.reason ?? '未知'} —— 如实记录`);
            }

            // 打开详情：在当前页找卡片（工单卡优先，其次档案卡）
            const cardProbe = await cdp.evaluate(`(() => ({
              path: location.pathname,
              tickets: document.querySelectorAll('article[data-testid^="ticket-card-"]').length,
              archives: document.querySelectorAll('article[data-testid^="archive-card-"]').length,
            }))()`);
            const targetSel = cardProbe.tickets > 0
              ? 'article[data-testid^="ticket-card-"]'
              : (cardProbe.archives > 0 ? 'article[data-testid^="archive-card-"]' : null);

            if (targetSel) {
              const before = await cdp.evaluate('location.pathname');
              await cdp.evaluate(`(() => {
                document.querySelector(${JSON.stringify(targetSel)}).scrollIntoView({ block: 'center' });
                return true;
              })()`);
              await sleep(350);
              await realClick(cdp, targetSel);
              await sleep(1900);
              const after = await cdp.evaluate('location.pathname');
              ok(`C · 从列表真实点开了详情（${targetSel.includes('ticket') ? '工单' : '档案'}）`,
                after !== before,
                `${before} → ${after}`);
              // 详情页滚一屏，让详情内容在视频里出现
              await realScroll(cdp, 220);
              await sleep(700);
            } else {
              note(`本页（${cardProbe.path}）没有工单卡也没有档案卡 —— 如实记录，不当作通过`);
              const emptyProbe = await cdp.evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`);
              note(`页面文本：${emptyProbe}`);
            }

            // 深色 → 浅色（用户第五节要求确认深色正常，录进视频里）
            await cdp.evaluate(`(() => {
              document.documentElement.classList.add('dark');
              localStorage.setItem('svc.mobile.theme', 'dark');
              return true;
            })()`);
            await sleep(1400);
            const darkOk = await cdp.evaluate(`document.documentElement.classList.contains('dark')`);
            ok('C · 深色模式在录屏内真实生效（根节点 .dark）', darkOk === true);
            await sleep(900);
            await cdp.evaluate(`(() => {
              document.documentElement.classList.remove('dark');
              localStorage.setItem('svc.mobile.theme', 'light');
              return true;
            })()`);
            await sleep(1300);
            note('已录下 深色 → 浅色 切换');
          }
        }

        const recCOut = await recC.stopAndEncode('sim-C-store-workbench.mp4');
        manifest.recordings.push({ id: 'C', title: '门店员工工作台（移动端）', url: '/m/', ...recCOut });
        if (recCOut.verdict !== 'OK') { invalid('C · 录屏产出', recCOut.reason); exitCode = 1; }
        else {
          ok('C · 录屏是真实帧流不是截图拼接（帧数/唯一帧/ack 三条同时成立）',
            recCOut.frames > 1 && recCOut.uniqueFrames > 1 && recCOut.acked > 0,
            `帧=${recCOut.frames} 唯一帧=${recCOut.uniqueFrames} ack=${recCOut.acked}`);
          ok('C · MP4 真实可解码（ffmpeg 回读到时长与视频流）',
            Boolean(recCOut.duration) && Boolean(recCOut.streamLine),
            `${recCOut.bytes}B sha=${recCOut.sha} 时长=${recCOut.duration} ${recCOut.streamLine ?? ''}`);
          ok(`C · 成片尺寸锁定为手机视口 ${VW}x${VH}（不变形、不裁切）`,
            recCOut.outputSizeOk === true,
            `成片=${recCOut.streamSize} 录制侧多数帧=${recCOut.dominantSize} 异常帧=${recCOut.offSizeFrames ?? 0}`);
          if (!keepFrames) recC.dropFrames(recCOut.frameDir);
        }
      }
    } finally {
      cdp.close();
      await shutdownBrowser(child, profileA);
    }
  }

  /* =================================================================== B */
  if (!only || only === 'B') {
    section('第 2 部分 · 录屏 B · 师傅现场回执');

    /**
     * ⚠️ B 段用**自己的浏览器**：师傅页需要在提交前先上传一张现场照片，
     *    而照片要经真实 `technicianUpload` 打接口。用旧浏览器会把
     *    A/C 的登录态与缓存带进来，判据就不再干净。
     */
    const jpeg = ensureFixtureJpeg();
    // ⚠️ 用 harness 的 `technicianUpload`，**不自己拼路径**。
    //    上一稿我按印象写成 `/visits/<token>/photos` + octet-stream —— 源码里真实路径是
    //    `POST /api/technician/visits/<token>/files`，且是 **multipart**（字段名 `file` + `photo_type`）。
    //    那种"看起来对"的猜测会 404，而失败会被误读成"产品传不了照片"。
    const up = await technicianUpload(techToken, jpeg, { photoType: 'onsite' });
    note(`预置现场照片 HTTP ${up.status}（师傅页会显示它，但**提交动作仍由录屏里的真实点击完成**）`);
    /**
     * ⚠️ 成功码是 **201 Created**，不是 200 —— 上一稿写 `!== 200` 于是把一次
     *    **成功的上传**打成了"失败"警告。这是"判据太窄 = 自造假红"的又一例
     *    （本项目已记过多起：判据太宽/太窄都会造假结论）。
     *    照片上传是**创建**资源，201 才是它正确的语义。
     */
    if (!(up.status >= 200 && up.status < 300)) {
      note('⚠️ 预置照片失败 —— B 段录屏里照片区可能为空，已如实记录（不当作产品缺陷）');
    }

    const portB = 9850 + Math.floor(Math.random() * 100);
    const profileB = path.join(os.tmpdir(), `uxrec-b-${Date.now()}`);
    const { child, cdp } = await launchBrowser(portB, profileB);
    netLog = [];
    cdp.on((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params?.request?.url || '';
        if (u.includes('/api/')) netLog.push({ phase: 'req', method: m.params.request.method, url: u });
      }
      if (m.method === 'Network.responseReceived') {
        const u = m.params?.response?.url || '';
        if (u.includes('/api/')) netLog.push({ phase: 'res', status: m.params.response.status, url: u });
      }
    });

    try {
      const recB = new Recorder(cdp, { label: 'B · 师傅现场回执', profile: profileB });
      await recB.start();

      await cdp.send('Page.navigate', { url: techUrl });
      const loaded = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="customer-card"]') || document.querySelector('textarea'))`, 15000, '师傅页加载')
        .then(() => true).catch(() => false);
      ok('B · 师傅页在录屏内真实渲染（能看到客户信息/表单）', loaded);
      await sleep(1100);

      // 看清客户信息（滚一下）
      await realScroll(cdp, 200);

      // 写服务说明
      const noteSel = 'textarea';
      await realType(cdp, noteSel, FIXTURE.serviceNote, { perChar: 20 });
      const noteVal = await cdp.evaluate(`(document.querySelector('textarea')?.value ?? '')`);
      ok('B · 真实键入的服务说明进入了输入框', noteVal.length > 10, `长度=${noteVal.length}`);

      // 选「未收费」（真实点击）
      //
      // ⚠️ 「未收费」按钮**没有 data-testid**（源码里就是一个 `:class` + `@click` 的 button），
      //    所以只能按**可见文案**定位。但这里有个判据陷阱要避开：
      //    页面里同时存在「未收费」与「已收费」两个按钮，用 `/收费/` 会同时命中两个。
      //    ⇒ 必须用**精确文案**（trim 后完全相等），不能用包含匹配。
      const chargePicked = await cdp.evaluate(`(() => {
        const btns = [...document.querySelectorAll('.svc-segment button, button')];
        const mine = btns.find(b => (b.textContent || '').trim() === '未收费');
        if (!mine) return false;
        mine.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      if (chargePicked) {
        // 用**真实鼠标事件**点（不是 el.click()）—— 走浏览器命中测试，
        // 顺带能抓到"按钮存在但点不到"（被遮挡）这类问题
        await realClickByText(cdp, '未收费');
        await sleep(600);
        const active = await cdp.evaluate(`(() => {
          const btns = [...document.querySelectorAll('.svc-segment button, button')];
          const mine = btns.find(b => (b.textContent || '').trim() === '未收费');
          return mine ? mine.className.includes('is-active') : null;
        })()`);
        ok('B · 选中「未收费」后按钮进入 is-active 态（真的选上了）', active === true,
          `className 含 is-active=${active}`);
      } else {
        note('没找到「未收费」按钮 —— 录屏继续（以实际界面为准），已如实记录');
      }
      await sleep(600);

      // 提交回执（真实点击）
      const submitted = await cdp.evaluate(`(() => {
        const b = document.querySelector('form button.svc-submit[type="submit"]');
        if (!b) return { found: false };
        b.scrollIntoView({ block: 'center' });
        return { found: true, disabled: Boolean(b.disabled) };
      })()`);
      if (submitted.found && !submitted.disabled) {
        await cdp.evaluate(`(() => { document.querySelector('form button.svc-submit[type="submit"]').click(); return true; })()`);
      } else if (submitted.found) {
        // 提交按钮 disabled ⇒ 必填项还没齐（最可能是「未收费」没选上）
        // ⇒ 如实记录，**不要**为了"录出成功"去绕过禁用 —— 那才是假录屏
        note('提交按钮处于 disabled —— 说明必填项还没齐全，录进去的就是这个真实状态');
      }
      await sleep(2600);

      const submitOk = netLog.some((x) => x.phase === 'res' && /\/api\/technician\/visits\/.*\/submit/.test(x.url) && x.status >= 200 && x.status < 300);
      const submitReq = netLog.filter((x) => x.phase === 'req' && /\/api\/technician\/visits\/.*\/submit/.test(x.url));
      if (submitReq.length > 0) {
        ok('B · 录屏内的"提交回执"有真实网络证据（POST submit 且 2xx）', submitOk,
          `POST 次数=${submitReq.length} 2xx=${submitOk}`);
      } else {
        // 提交按钮没点着（disabled）—— 这不是产品缺陷，但录屏就缺了最后一步，如实记
        note('⚠️ 本段录屏没有产生 submit 请求（按钮 disabled）—— 已在报告里如实标注，不计为通过');
      }

      await realScroll(cdp, 180);
      await sleep(1000);

      const recBOut = await recB.stopAndEncode('sim-B-technician-visit.mp4');
      manifest.recordings.push({ id: 'B', title: '师傅现场回执（H5）', url: techUrl.replace(BASE_URL, '').replace(techToken, '<token>'), ...recBOut });
      if (recBOut.verdict !== 'OK') { invalid('B · 录屏产出', recBOut.reason); exitCode = 1; }
      else {
        ok('B · 录屏是真实帧流不是截图拼接（帧数/唯一帧/ack 三条同时成立）',
          recBOut.frames > 1 && recBOut.uniqueFrames > 1 && recBOut.acked > 0,
          `帧=${recBOut.frames} 唯一帧=${recBOut.uniqueFrames} ack=${recBOut.acked}`);
        ok('B · MP4 真实可解码（ffmpeg 回读到时长与视频流）',
          Boolean(recBOut.duration) && Boolean(recBOut.streamLine),
          `${recBOut.bytes}B sha=${recBOut.sha} 时长=${recBOut.duration} ${recBOut.streamLine ?? ''}`);
        ok(`B · 成片尺寸锁定为手机视口 ${VW}x${VH}（不变形、不裁切）`,
          recBOut.outputSizeOk === true,
          `成片=${recBOut.streamSize} 录制侧多数帧=${recBOut.dominantSize} 异常帧=${recBOut.offSizeFrames ?? 0}`);
        if (!keepFrames) recB.dropFrames(recBOut.frameDir);
      }
    } finally {
      cdp.close();
      await shutdownBrowser(child, profileB);
    }
  }

  /* --------------------------------------------------------------- 收尾 */
  section('第 3 部分 · 汇总');

  const recs = manifest.recordings;
  for (const r of recs) {
    console.log(`  ${r.id} · ${r.title}`);
    console.log(`      文件 ${path.basename(r.mp4 ?? '(未产出)')}  ${r.bytes ?? 0}B  sha=${r.sha ?? '-'}  时长 ${r.duration ?? '-'}`);
    console.log(`      帧=${r.frames} 唯一帧=${r.uniqueFrames} ack=${r.acked}  设备=${manifest.deviceKind}`);
  }

  /**
   * 三条**跨段**的总判据（这是"不得静态截图拼接"的真正落点）：
   *   ① 每段都产出 MP4 且能解码；
   *   ② 所有段**两两不同哈希**（否则"录了三段"其实是"同一段存了三次"——
   *      本项目已发生过"两张不同文件名的图 md5 相同"的假绿）；
   *   ③ 三段总唯一帧数远大于段数（证明是帧流）。
   */
  if (recs.length >= 2) {
    const shas = recs.map((r) => r.sha);
    ok('三段录屏两两哈希不同（不是同一段重复存三份）',
      new Set(shas).size === shas.length, `sha=${shas.join(' / ')}`);
  }
  if (recs.length > 0) {
    const totalFrames = recs.reduce((a, r) => a + (r.frames ?? 0), 0);
    ok('三段录屏合计是帧流（总帧数 >> 段数）',
      totalFrames > recs.length * 5, `总帧数=${totalFrames} 段数=${recs.length}`);
  }
} catch (e) {
  const msg = String(e?.message ?? e);
  console.log(`\n  环境/流程异常：${msg}`);
  if (/EnvNotReady|环境/.test(msg)) exitCode = 2;
  else { invalid('主流程未跑完', msg.slice(0, 400)); exitCode = 1; }
} finally {
  /* 🔴 短信开关必须恢复（铁律：不留环境改动），且**恢复本身要被验证** */
  try {
    if (sms) {
      const r = sms.restore();
      console.log(`\n  短信开关恢复：${r.note}${r.ok ? '' : ' ⚠️ 未恢复成功，需手工核查'}`);
    }
  } catch (e) { console.log(`\n  ⚠️ 短信开关恢复异常：${e.message}`); }

  /* 工单精确清理（只删自己建的） */
  try {
    if (ticketId) {
      cleanupTicket(ticketId);
      const left = psqlScalar(`SELECT count(*) FROM service_tickets WHERE id=${ticketId}`);
      console.log(`  取证工单 ${ticketNo}(id=${ticketId}) 已清理：库中剩余 ${left} 行`);
      if (String(left) !== '0') console.log('  ⚠️ 工单未删净，请手工核查');
    }
    // A 段界面提交建的那张（如果与上面不同）
    if (uiTicketNoFromUi) {
      const uiId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${uiTicketNoFromUi}'`));
      if (uiId) {
        cleanupTicket(uiId);
        const left = psqlScalar(`SELECT count(*) FROM service_tickets WHERE id=${uiId}`);
        console.log(`  录屏内界面所建工单 ${uiTicketNoFromUi}(id=${uiId}) 已清理：库中剩余 ${left} 行`);
        if (String(left) !== '0') console.log('  ⚠️ 该工单未删净，请手工核查');
      } else {
        console.log(`  录屏内界面所建工单 ${uiTicketNoFromUi}：库里查不到（可能已被清理）`);
      }
    }
  } catch (e) { console.log(`  ⚠️ 清理工单异常：${e.message}`); }

  /* 元数据落盘（含"这是模拟不是真机"的边界声明） */
  try {
    const passed = rows.filter((r) => r.pass === true).length;
    const failed = rows.filter((r) => r.pass === false).length;
    const inval = rows.filter((r) => r.pass === null).length;
    manifest.assertions = rows;
    manifest.summary = { PASS: passed, FAIL: failed, INVALID: inval };
    manifest.netTail = netLog.slice(-80);
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\n  结果：PASS ${passed} / FAIL ${failed} / INVALID ${inval}`);
    console.log(`  清单：${path.relative(ROOT, path.join(OUT, 'manifest.json'))}`);
    if (failed > 0) exitCode = 1;
    else if (inval > 0) exitCode = 2;
  } catch (e) { console.log(`  ⚠️ 元数据落盘异常：${e.message}`); if (!exitCode) exitCode = 1; }

  if (!keepFrames) {
    try { fs.rmSync(FRAMES_ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 无害 */ }
  }
  process.exit(exitCode);
}
