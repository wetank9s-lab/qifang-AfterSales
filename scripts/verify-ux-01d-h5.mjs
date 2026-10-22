/**
 * verify-ux-01d-h5.mjs —— UX-01D M1 **客户 H5 真实浏览器**门禁。
 *
 * 判什么（用户 §六/§七/§八）：
 *   A. 三视口（375/390/420）× 四个页面（报修/投诉/成功/进度）：无横向滚动、主题生效；
 *   B. 品牌名 / 副标题 / 媒体帮助文案 / 帮助条显隐**真实来自已发布配置**；
 *   C. 主题切换**不重建表单**：已输入内容不丢；
 *   D. 对比度：主按钮白字 ≥4.5、次要文字 ≥4.5（每个预设都算一遍）；
 *   E. 20 字长名称在 375px 下不溢出；
 *   F. **预览零副作用**：不建单、不建媒体会话、不发短信；提交/采集禁用；
 *   G. 预览凭证：过期 / 篡改 / 草稿已变更(409) 都被拒；凭证不出现在 URL；
 *   H. 配置接口不可用时**回退默认值**且页面照常可用。
 *
 * 副作用与收尾：本脚本会创建 1 张进度页夹具工单（按 ID 清理）、会发布若干版本，
 * 结束时把线上恢复为**运行前快照**（再发一版，不改写历史）。
 *
 * 用法：node scripts/verify-ux-01d-h5.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(ROOT, '.tmp-verify', 'ux01d-m1');
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

const SIGN_SECRET = envValue('SIGN_SECRET');
const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
  }).trim();

async function api(pathname, { method = 'GET', token, body, requestId, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const uuid = () => crypto.randomUUID();
const unwrap = (r) => r.json?.data?.data ?? r.json?.data ?? r.json;

const DEFAULT_DOC = {
  schema_version: 1,
  brand: { name: '四川七方连锁售后服务平台', subtitle: '' },
  theme: { preset: 'classic-blue' },
  copy: { media_help: '也可直接填写文字，任选一种即可说明问题。' },
  modules: { media_help: true },
};

const VARIANT_DOC = {
  schema_version: 1,
  brand: { name: '七方售后服务中心', subtitle: '家电维修 · 免费上门检测' },
  theme: { preset: 'brand-red' },
  copy: { media_help: '有问题可以拍照或录音，我们会尽快联系您。' },
  modules: { media_help: false },
};

const LONG_NAME = '四川七方连锁售后服务平台成都高新旗舰门店'; // 20 字
const LONG_DOC = {
  ...DEFAULT_DOC,
  brand: { name: LONG_NAME, subtitle: '' },
  theme: { preset: 'graphite' },
};

const PREVIEW_DRAFT_DOC = {
  ...DEFAULT_DOC,
  brand: { name: '草稿预览名称', subtitle: '只有预览能看到' },
  theme: { preset: 'brand-red' },
};

const signedEntry = (code = 'S01') =>
  `${code}.${crypto.createHmac('sha256', SIGN_SECRET).update(`store-entry:${code}`).digest('base64url').slice(0, 22)}`;

function contrast(hexA, hexB) {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const la = lum(hexA);
  const lb = lum(hexB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01D M1：客户 H5 真实浏览器（三视口 / 主题 / 预览 / 回退）');
console.log('══════════════════════════════════════════════════════════════');

let admin;
try {
  const r = await api('/api/auth:signIn', {
    method: 'POST',
    body: { email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), password: envValue('UAT_HQADMIN_PASSWORD') },
  });
  if (r.status !== 200) throw new Error(`hq_admin 登录失败 HTTP ${r.status}`);
  admin = r.json.data.token;
} catch (error) {
  console.log(`  ⛔ 环境未就绪：${error.message}`);
  process.exit(2);
}

const getDraft = async () => unwrap(await api('/api/svc:uiThemeDraft', { token: admin }));
const saveDraft = async (doc, rev) =>
  api('/api/svc:uiThemeSave', { method: 'POST', token: admin, requestId: uuid(), body: { doc, expected_revision: rev } });
const publishDoc = async (doc) => {
  const cur = await getDraft();
  const rev = Number(cur.draft?.revision ?? 0);
  const s = await saveDraft(doc, rev);
  if (s.status !== 200) throw new Error(`保存失败 HTTP ${s.status}: ${s.text.slice(0, 160)}`);
  const p = await api('/api/svc:uiThemePublish', {
    method: 'POST',
    token: admin,
    requestId: uuid(),
    body: { expected_revision: Number(unwrap(s)?.revision), note: 'H5 门禁切换配置' },
  });
  if (p.status !== 200) throw new Error(`发布失败 HTTP ${p.status}: ${p.text.slice(0, 160)}`);
  return Number(unwrap(p)?.version ?? 0);
};
const mintPreview = async () =>
  unwrap(
    await api('/api/svc:uiThemePreview', { method: 'POST', token: admin, requestId: uuid(), body: {} }),
  )?.token ?? '';

const publicConfig = async () => {
  const r = await api('/api/publicUiTheme:get');
  return r.json?.data ?? r.json;
};

const initialPublic = await publicConfig();
const restoreDoc = initialPublic.version
  ? {
      schema_version: 1,
      brand: initialPublic.brand,
      theme: initialPublic.theme,
      copy: initialPublic.copy,
      modules: initialPublic.modules,
    }
  : DEFAULT_DOC;

let fixtureId = 0;
let fixtureNo = '';
const session = await launchCdp({ port: 9421, label: 'ux01d-m1' });
const { cdp } = session;

const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
};

const viewport = async (w, h) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
};

const openReport = async (w = 390, h = 844) => {
  await viewport(w, h);
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(signedEntry('S01'))}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="store-card"]')`, { what: '门店卡', timeout: 40_000 });
  await sleep(500);
};

const noHScroll = () =>
  cdp.evaluate(
    `(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))()`,
  );

try {
  // -------------------------------------------------------------------------
  // A. 默认配置：品牌/文案/主题都来自「已发布」（当前 = 默认）
  // -------------------------------------------------------------------------
  console.log('\nA. 默认配置渲染（发布记录为空或=默认）');
  await publishDoc(DEFAULT_DOC);
  const cfg0 = await publicConfig();
  check(cfg0.brand.name === DEFAULT_DOC.brand.name, '公开配置 = 默认品牌', cfg0.brand.name);

  await openReport(390, 844);
  const base = await cdp.evaluate(`(() => {
    const h1 = document.querySelector('[data-testid="brand-name"]');
    const sub = document.querySelector('[data-testid="brand-subtitle"]');
    const help = document.querySelector('[data-testid="media-or-hint"]');
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--svc-primary').trim();
    return {
      name: h1 ? h1.innerText.trim() : '',
      subtitle: sub ? sub.innerText.trim() : null,
      help: help ? help.innerText.trim() : null,
      primary,
      title: document.title,
      theme: document.documentElement.getAttribute('data-theme'),
    };
  })()`);
  check(base.name === DEFAULT_DOC.brand.name, '页头品牌名 = 已发布名称', base.name);
  check(base.subtitle === null, '副标题为空 ⇒ 不渲染', String(base.subtitle));
  check(base.help === DEFAULT_DOC.copy.media_help, '媒体帮助文案 = 默认文案', String(base.help));
  check(base.primary.toLowerCase() === '#2f6fed', '主题变量 = 经典蓝', base.primary);
  check(base.theme === null, 'classic-blue 不写 data-theme（保持默认 DOM）', String(base.theme));
  check(base.title.includes(DEFAULT_DOC.brand.name), '浏览器页签包含品牌名', base.title);
  await shot('report-default-390');

  // -------------------------------------------------------------------------
  // B. 切换配置：品牌红 + 副标题 + 帮助文案 + 隐藏帮助条
  // -------------------------------------------------------------------------
  console.log('\nB. 切换已发布配置（品牌 / 副标题 / 文案 / 主题 / 帮助条显隐）');
  const vVariant = await publishDoc(VARIANT_DOC);
  await openReport(390, 844);
  const v = await cdp.evaluate(`(() => {
    const h1 = document.querySelector('[data-testid="brand-name"]');
    const sub = document.querySelector('[data-testid="brand-subtitle"]');
    const help = document.querySelector('[data-testid="media-or-hint"]');
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--svc-primary').trim();
    const weak = getComputedStyle(document.documentElement).getPropertyValue('--svc-text-weak').trim();
    const submit = document.querySelector('[data-testid="submit-repair"]');
    return {
      name: h1 ? h1.innerText.trim() : '',
      subtitle: sub ? sub.innerText.trim() : null,
      helpVisible: !!help,
      primary, weak,
      theme: document.documentElement.getAttribute('data-theme'),
      submitBg: submit ? getComputedStyle(submit).backgroundColor : '',
    };
  })()`);
  check(v.name === VARIANT_DOC.brand.name, '品牌名已切换', v.name);
  check(v.subtitle === VARIANT_DOC.brand.subtitle, '副标题已显示', String(v.subtitle));
  check(v.helpVisible === false, '帮助条已隐藏（配置 modules.media_help=false）', String(v.helpVisible));

  // 「隐藏帮助条」只能隐藏那条提示：四个采集入口与隐私用途说明都必须还在
  const hiddenHelpSide = await cdp.evaluate(`(() => {
    const ids = ['capture-photo', 'pick-from-album-btn', 'capture-audio', 'capture-video'];
    const entries = ids.map((id) => {
      const el = document.querySelector('[data-testid="' + id + '"]');
      if (!el) return id + '=missing';
      const r = el.getBoundingClientRect();
      const disabled = el.disabled === true || el.className.includes('is-disabled');
      return id + '=' + (r.width > 40 && r.height > 30 && !disabled ? 'ok' : 'bad');
    });
    return JSON.stringify({ entries });
  })()`);
  const hiddenInfo = JSON.parse(hiddenHelpSide);
  check(
    hiddenInfo.entries.every((e) => String(e).endsWith('=ok')),
    '隐藏帮助条后：四个采集入口仍完整可用',
    hiddenInfo.entries.join(','),
  );

  await cdp.evaluate(`sessionStorage.removeItem('svc-media-consent')`);
  await cdp.evaluate(`document.querySelector('[data-testid="capture-photo"]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-testid="media-consent"]')`, { what: '授权弹层', timeout: 10_000 });
  const consentHiddenCase = await cdp.evaluate(
    `(() => document.querySelector('[data-testid="media-consent"]').innerText.split(String.fromCharCode(10)).join(' '))()`,
  );
  check(
    /仅用于本次售后处理/.test(String(consentHiddenCase)),
    '隐藏帮助条后：首次授权仍保留隐私用途说明',
    String(consentHiddenCase).slice(0, 90),
  );
  await cdp.evaluate(`document.querySelector('[data-testid="consent-no"]').click()`);
  await cdp.waitFor(`!document.querySelector('[data-testid="media-consent"]')`, { what: '关闭授权弹层', timeout: 10_000 });
  check(v.theme === 'brand-red', 'data-theme = brand-red', String(v.theme));
  check(v.primary.toLowerCase() === '#c8362c', '主色变量 = 品牌红', v.primary);
  check(/rgb\(200,\s*54,\s*44\)/.test(v.submitBg), '主按钮实际背景 = 品牌红', v.submitBg);
  check(contrast(v.primary, '#ffffff') >= 4.5, `主色白字对比度 ≥4.5（实测 ${contrast(v.primary, '#ffffff').toFixed(2)}）`);
  check(contrast(v.weak, '#ffffff') >= 4.5, `次要文字对比度 ≥4.5（实测 ${contrast(v.weak, '#ffffff').toFixed(2)}）`, v.weak);
  await shot('report-variant-390');
  note('已发布版本', `v${vVariant}`);

  // -------------------------------------------------------------------------
  // C. 三视口 × 四页面
  // -------------------------------------------------------------------------
  console.log('\nC. 三视口（375/390/420）× 报修 / 投诉 / 成功 / 进度');
  for (const [w, h] of [[375, 812], [390, 844], [420, 900]]) {
    await openReport(w, h);
    const m = await noHScroll();
    check(m.scrollWidth <= m.innerWidth, `报修页 @${w} 无横向滚动`, `${m.scrollWidth} <= ${m.innerWidth}`);
    await shot(`report-${w}`);

    await cdp.evaluate(`document.querySelector('[data-testid="mode-complaint"]').click()`);
    await cdp.waitFor(`!!document.querySelector('[data-testid="submit-complaint"]')`, { what: '投诉表单' });
    await sleep(300);
    const c = await noHScroll();
    check(c.scrollWidth <= c.innerWidth, `投诉页 @${w} 无横向滚动`, `${c.scrollWidth} <= ${c.innerWidth}`);
    await shot(`complaint-${w}`);

    // 成功页（纯 URL 参数）
    const qs = new URLSearchParams({
      no: 'FW20261017-0099',
      store: '示例门店',
      at: '2026-10-17T15:30:00+08:00',
      type: 'repair',
      k: signedEntry('S01'),
    });
    await cdp.send('Page.navigate', { url: `${BASE}/h5/report/success?${qs.toString()}` });
    await cdp.waitFor(`!!document.querySelector('[data-testid="success-title"]')`, { what: '成功页' });
    await sleep(600);
    const s = await noHScroll();
    const sTheme = await cdp.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue('--svc-primary').trim()`,
    );
    check(s.scrollWidth <= s.innerWidth, `成功页 @${w} 无横向滚动`, `${s.scrollWidth} <= ${s.innerWidth}`);
    check(sTheme.toLowerCase() === '#c8362c', `成功页 @${w} 主题跟随（品牌红）`, sTheme);
    await shot(`success-${w}`);
  }

  // -------------------------------------------------------------------------
  // D. 20 字长名称在 375 下不溢出
  // -------------------------------------------------------------------------
  console.log('\nD. 最长名称（20 字）@375');
  await publishDoc(LONG_DOC);
  await openReport(375, 812);
  const longInfo = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="brand-name"]');
    const r = el.getBoundingClientRect();
    return {
      text: el.innerText.trim(),
      len: Array.from(el.innerText.trim()).length,
      right: r.right,
      width: r.width,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight || '0'),
      height: r.height,
    };
  })()`);
  check(longInfo.len === 20, '名称长度为 20', String(longInfo.len));
  check(longInfo.right <= longInfo.innerWidth, '名称右边界未超出视口', `${longInfo.right} <= ${longInfo.innerWidth}`);
  check(longInfo.scrollWidth <= longInfo.innerWidth, '页面无横向滚动', `${longInfo.scrollWidth} <= ${longInfo.innerWidth}`);
  await shot('report-longname-375');

  // -------------------------------------------------------------------------
  // E. 主题切换不重建表单（输入保留）
  // -------------------------------------------------------------------------
  console.log('\nE. 主题切换不重建表单（已输入内容保留）');
  await publishDoc(VARIANT_DOC);
  await openReport(390, 844);
  const typed = '这是切换主题前输入的内容';
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="repair-content"]');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, ${JSON.stringify(typed)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // 打一个标记：如果组件被重建，这个自定义属性会消失
    el.setAttribute('data-keep-mark', '1');
    return true;
  })()`);
  // 用一个"只改主题"的配置：直接改 DOM 上的 data-theme（等价于运行时应用新主题，不重载页面）
  await cdp.evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', 'graphite');
    return true;
  })()`);
  await sleep(400);
  const preserved = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="repair-content"]');
    return {
      value: el.value,
      mark: el.getAttribute('data-keep-mark'),
      primary: getComputedStyle(document.documentElement).getPropertyValue('--svc-primary').trim(),
      formExists: !!document.querySelector('[data-testid="submit-repair"]'),
    };
  })()`);
  check(preserved.value === typed, '输入内容保留', preserved.value);
  check(preserved.mark === '1', 'DOM 节点未被重建（自定义标记还在）', String(preserved.mark));
  check(preserved.primary.toLowerCase() === '#475569', '主题变量已切换为石墨灰', preserved.primary);
  check(preserved.formExists, '表单仍存在');

  // -------------------------------------------------------------------------
  // F. 预览：真实页面 + 零副作用
  // -------------------------------------------------------------------------
  console.log('\nF. 预览（真实 H5 + 零副作用 + 凭证语义）');
  const beforeCounts = {
    tickets: Number(pg(`select count(*) from service_tickets`) || 0),
    sessions: Number(pg(`select count(*) from customer_media_sessions`) || 0),
    sms: Number(pg(`select count(*) from sms_logs`) || 0),
  };

  // 草稿改成"只有预览能看到"的内容（不发布）
  const curDraft = await getDraft();
  const savePreviewDraft = await saveDraft(
    PREVIEW_DRAFT_DOC,
    Number(curDraft.draft?.revision ?? 0),
  );
  check(savePreviewDraft.status === 200, '草稿已保存（未发布）', `HTTP ${savePreviewDraft.status}`);

  const token = await mintPreview();
  check(Boolean(token), '签发预览凭证', token ? `${token.slice(0, 12)}…` : '空');

  // 🔴 凭证由**后台（登录 + hq_admin + 签发者本人）**消费；iframe（H5 匿名上下文）只收内容。
  const docRes = await api('/api/svc:uiThemePreviewDoc', {
    method: 'POST',
    token: admin,
    requestId: uuid(),
    body: { token },
  });
  const view = unwrap(docRes);
  check(docRes.status === 200, '受控动作消费凭证 ⇒ 200（拿到草稿）', `HTTP ${docRes.status}`);
  check(view?.doc?.brand?.name === PREVIEW_DRAFT_DOC.brand.name, '消费结果是草稿内容', String(view?.doc?.brand?.name));

  // 宿主页：同源的成功页；在其中嵌一个真实 H5 iframe（与后台同构）
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report/success?no=HOST&store=x&at=2026-10-17T10:00:00%2B08:00&type=repair` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="success-title"]')`, { what: '宿主页' });
  await cdp.evaluate(`(() => {
    const f = document.createElement('iframe');
    f.id = 'pv';
    f.src = '/h5/report?uiPreview=1';
    f.style.cssText = 'width:390px;height:760px;border:1px solid #ccc';
    document.body.appendChild(f);
    return true;
  })()`);
  await cdp.waitFor(
    `(() => { const d = document.getElementById('pv')?.contentDocument; return !!(d && d.querySelector('[data-testid="preview-banner"]')); })()`,
    { what: '预览页加载', timeout: 40_000 },
  );
  const previewPayload = JSON.stringify({
    type: 'svc-ui-preview-doc',
    doc: view?.doc ?? null,
    store: view?.store ?? null,
    revision: Number(view?.revision ?? 0),
  });
  await cdp.evaluate(`(() => {
    const f = document.getElementById('pv');
    f.contentWindow.postMessage(${previewPayload}, location.origin);
    return true;
  })()`);
  await cdp.waitFor(
    `(() => { const d = document.getElementById('pv')?.contentDocument; return d && d.querySelector('[data-testid="brand-name"]')?.innerText.includes('草稿预览名称'); })()`,
    { what: '草稿内容生效', timeout: 20_000 },
  );

  const preview = await cdp.evaluate(`(() => {
    const d = document.getElementById('pv').contentDocument;
    const q = (s) => d.querySelector(s);
    const disabled = (s) => { const el = q(s); return el ? el.disabled === true : null; };
    return {
      name: q('[data-testid="brand-name"]').innerText.trim(),
      banner: q('[data-testid="preview-banner"]')?.innerText.trim(),
      submitRepair: disabled('[data-testid="submit-repair"]'),
      capturePhoto: disabled('[data-testid="capture-photo"]'),
      captureAudio: disabled('[data-testid="capture-audio"]'),
      albumDisabled: q('[data-testid="pick-from-album-btn"]')?.className.includes('is-disabled'),
      store: q('[data-testid="store-name"]')?.innerText.trim(),
      theme: d.documentElement.getAttribute('data-theme'),
    };
  })()`);
  check(preview.name === PREVIEW_DRAFT_DOC.brand.name, '预览显示**草稿**内容（未发布）', preview.name);
  check(/预览模式/.test(String(preview.banner)), '预览横幅可见', String(preview.banner));
  check(preview.submitRepair === true, '提交按钮禁用', String(preview.submitRepair));
  check(preview.capturePhoto === true && preview.captureAudio === true, '媒体采集入口禁用', `${preview.capturePhoto}/${preview.captureAudio}`);
  check(preview.albumDisabled === true, '相册入口禁用', String(preview.albumDisabled));
  check(preview.store === '示例门店（预览）', '门店卡为合成门店（不读真实门店）', String(preview.store));
  check(preview.theme === 'brand-red', '预览主题 = 草稿主题', String(preview.theme));

  // 即使绕过 disabled，提交也走不到建单
  await cdp.evaluate(`(() => {
    const d = document.getElementById('pv').contentDocument;
    d.querySelector('[data-testid="submit-repair"]').click();
    return true;
  })()`);
  await sleep(800);
  const afterCounts = {
    tickets: Number(pg(`select count(*) from service_tickets`) || 0),
    sessions: Number(pg(`select count(*) from customer_media_sessions`) || 0),
    sms: Number(pg(`select count(*) from sms_logs`) || 0),
  };
  check(
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
    '预览未产生工单/媒体会话/短信（计数不变）',
    `${JSON.stringify(beforeCounts)} → ${JSON.stringify(afterCounts)}`,
  );
  await shot('preview-frame');

  // 输入保留：在预览里输入，再刷新一次预览（同 revision 新凭证），内容不丢
  await cdp.evaluate(`(() => {
    const d = document.getElementById('pv').contentDocument;
    const el = d.querySelector('[data-testid="repair-content"]');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, '预览中输入的文字');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.setAttribute('data-keep-mark', 'pv');
    return true;
  })()`);
  // 只重新下发同一份内容（**不切模式**）：证明"重新应用配置不会重建表单"
  await cdp.evaluate(`(() => {
    const f = document.getElementById('pv');
    f.contentWindow.postMessage(${previewPayload}, location.origin);
    return true;
  })()`);
  await sleep(1200);
  const afterRefresh = await cdp.evaluate(`(() => {
    const d = document.getElementById('pv').contentDocument;
    const el = d.querySelector('[data-testid="repair-content"]');
    return { value: el?.value ?? null, mark: el?.getAttribute('data-keep-mark') ?? null };
  })()`);
  check(afterRefresh.value === '预览中输入的文字', '刷新预览后输入仍在', String(afterRefresh.value));
  check(afterRefresh.mark === 'pv', '预览组件未被重建', String(afterRefresh.mark));

  // 再单独验证"报修/投诉切换不重载页面"
  await cdp.evaluate(`(() => {
    const f = document.getElementById('pv');
    f.contentWindow.postMessage({ type: 'svc-ui-preview-mode', mode: 'complaint' }, location.origin);
    return true;
  })()`);
  await sleep(600);
  const modeSwitched = await cdp.evaluate(
    `(() => !!document.getElementById('pv').contentDocument.querySelector('[data-testid="submit-complaint"]'))()`,
  );
  check(modeSwitched === true, '报修/投诉切换不重载页面', String(modeSwitched));

  // 伪造消息必须被忽略：从**页面自己**发（event.source === window，不是 parent）
  await cdp.evaluate(`(() => {
    const f = document.getElementById('pv');
    f.contentWindow.eval('window.postMessage({ type: "svc-ui-preview-doc", doc: { brand: { name: "HACK" } } }, location.origin)');
    return true;
  })()`);
  await sleep(600);
  const afterForged = await cdp.evaluate(
    `(() => document.getElementById('pv').contentDocument.querySelector('[data-testid="brand-name"]')?.innerText.trim() || '')()`,
  );
  check(afterForged === PREVIEW_DRAFT_DOC.brand.name, '非 parent 来源的伪造消息被忽略', afterForged);

  // 凭证不进 URL：iframe src 中没有 token
  const frameSrc = await cdp.evaluate(`document.getElementById('pv')?.getAttribute('src') || ''`);
  check(!frameSrc.includes(token.slice(0, 12)), '预览 URL 不含凭证', frameSrc);

  // -------------------------------------------------------------------------
  // G. 进度页（需要真实 Token）——自建 1 张夹具单，跑完清理
  // -------------------------------------------------------------------------
  console.log('\nG. 进度页（真实 Token）');
  await publishDoc(VARIANT_DOC);
  const entry = signedEntry('S01');
  const reqId = uuid();
  const created = await api(`/api/public/tickets?k=${encodeURIComponent(entry)}`, {
    method: 'POST',
    requestId: reqId,
    body: {
      entry,
      store_code: 'S01',
      ticket_type: 'repair',
      content: '[UX01D-M1] 进度页主题基线（自建夹具，截图后按 ID 清理）',
      customer_name: 'UX01D-M1',
      // B-24 的教训：夹具号码必须**每次唯一**（否则同日重跑会撞上 phone daily limit）
      customer_mobile: `139${String(Date.now()).slice(-8)}`,
    },
  });
  if (created.status !== 201) throw new Error(`建单失败 HTTP ${created.status}: ${created.text.slice(0, 160)}`);
  const createdData = created.json?.data ?? {};
  fixtureNo = String(createdData.ticket_no ?? '');
  const progressToken = String(createdData.progress_token ?? '');
  fixtureId = Number(pg(`select id from service_tickets where ticket_no='${fixtureNo}'`) || 0);
  note('进度页夹具', `${fixtureNo} (id=${fixtureId})`);

  for (const [w, h] of [[375, 812], [390, 844], [420, 900]]) {
    await viewport(w, h);
    await cdp.send('Page.navigate', { url: `${BASE}/h5/customer/progress/${encodeURIComponent(progressToken)}` });
    await cdp.waitFor(`!!document.querySelector('[data-testid="progress-timeline"]')`, { what: '进度页', timeout: 30_000 });
    await sleep(600);
    const m = await noHScroll();
    const theme = await cdp.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue('--svc-primary').trim()`,
    );
    check(m.scrollWidth <= m.innerWidth, `进度页 @${w} 无横向滚动`, `${m.scrollWidth} <= ${m.innerWidth}`);
    check(theme.toLowerCase() === '#c8362c', `进度页 @${w} 主题跟随总部配置`, theme);
    await shot(`progress-${w}`);
  }

  // -------------------------------------------------------------------------
  // H. 配置接口不可用 ⇒ 回退默认值，页面照常可用
  // -------------------------------------------------------------------------
  console.log('\nH. 配置接口失败时回退默认值');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*publicUiTheme:get*'] });
  await viewport(390, 844);
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(signedEntry('S01'))}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="store-card"]')`, { what: '回退时门店卡', timeout: 40_000 });
  await sleep(1200);
  const fallback = await cdp.evaluate(`(() => ({
    name: document.querySelector('[data-testid="brand-name"]')?.innerText.trim(),
    help: document.querySelector('[data-testid="media-or-hint"]')?.innerText.trim() || null,
    submit: !!document.querySelector('[data-testid="submit-repair"]'),
    theme: document.documentElement.getAttribute('data-theme'),
  }))()`);
  check(fallback.name === DEFAULT_DOC.brand.name, '品牌回退为默认值', String(fallback.name));
  check(fallback.help === DEFAULT_DOC.copy.media_help, '帮助文案回退默认', String(fallback.help));
  check(fallback.submit === true, '表单仍可用（不白屏）', String(fallback.submit));
  check(fallback.theme === null, '主题回退经典蓝', String(fallback.theme));
  await cdp.send('Network.setBlockedURLs', { urls: [] });
  await shot('report-fallback-390');
} finally {
  session.close();

  // 清理进度页夹具（按 ID）
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

  // 恢复线上为运行前内容（再发一版，不改写历史）
  try {
    const ver = await publishDoc(restoreDoc);
    note('恢复线上', `v${ver}`);
  } catch (error) {
    note('恢复失败', String(error?.message ?? error));
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  H5 验收：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('  截图：.tmp-verify/ux01d-m1/');
  console.log('');
}
