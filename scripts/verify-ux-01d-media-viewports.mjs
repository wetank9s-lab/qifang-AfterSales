/**
 * verify-ux-01d-media-viewports.mjs —— B-25 的**定向补证**：媒体区在 375 / 390 / 420 三档宽度下的表现。
 *
 * 背景（用户 2026-10-19 核查要求）：
 *   `verify-customer-media-ui.mjs` 用的是**设备档位**（Android 412 / iPhone 390 / 微信 390），
 *   与 UX-01D M1 要求的 375 / 390 / 420 **不是同一组宽度**；其中 375 与 420 实际未被该门禁覆盖。
 *   ⇒ 不改那个冻结门禁（它的档位语义是"设备模拟"），只补这一条**定向验证**。
 *
 * 判什么：
 *   ① 三档宽度下媒体区提示 = 当前生效配置的 `copy.media_help`；
 *   ② 四个入口（拍照 / 相册 / 录音 / 拍视频）都在且可点；
 *   ③ 首次授权弹层里的隐私用途说明存在；
 *   ④ 无横向滚动。
 *
 * 用法：node scripts/verify-ux-01d-media-viewports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const entry = `S01.${crypto.createHmac('sha256', envValue('SIGN_SECRET')).update('store-entry:S01').digest('base64url').slice(0, 22)}`;

const cfg = await (await fetch(`${BASE}/api/publicUiTheme:get`)).json().catch(() => null);
const doc = cfg?.data ?? cfg ?? {};
const expectHelp = doc?.copy?.media_help ?? '也可直接填写文字，任选一种即可说明问题。';
const helpVisible = doc?.modules?.media_help !== false;

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  B-25 定向补证：媒体区 @375 / @390 / @420');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  当前生效帮助文案：${expectHelp}（显示=${helpVisible}）`);

const session = await launchCdp({ port: 9441, label: 'ux01d-media-vp' });
const { cdp } = session;
try {
  for (const [w, h] of [[375, 812], [390, 844], [420, 900]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(entry)}` });
    await cdp.waitFor(`!!document.querySelector('[data-testid="capture-photo"]')`, { what: `媒体区@${w}`, timeout: 40_000 });
    await sleep(600);

    const info = JSON.parse(
      await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-testid="media-uploader"]');
        const help = root.querySelector('[data-testid="media-or-hint"]');
        const ids = ['capture-photo', 'pick-from-album-btn', 'capture-audio', 'capture-video'];
        return JSON.stringify({
          help: help ? help.textContent.trim() : null,
          entries: ids.map((id) => {
            const el = document.querySelector('[data-testid="' + id + '"]');
            if (!el) return id + '=missing';
            const r = el.getBoundingClientRect();
            const disabled = el.disabled === true || el.className.includes('is-disabled');
            return id + '=' + (r.width > 40 && r.height > 30 && !disabled ? 'ok' : 'bad');
          }),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        });
      })()`),
    );

    check(
      helpVisible ? info.help === expectHelp : info.help === null,
      `@${w} 媒体区提示与生效配置一致`,
      JSON.stringify({ help: info.help }),
    );
    check(
      info.entries.every((e) => String(e).endsWith('=ok')),
      `@${w} 四个媒体入口都在且可点`,
      info.entries.join(','),
    );
    check(info.scrollWidth <= info.innerWidth, `@${w} 无横向滚动`, `${info.scrollWidth} <= ${info.innerWidth}`);

    // 首次授权弹层（每档清一次 sessionStorage）
    await cdp.evaluate(`sessionStorage.removeItem('svc-media-consent')`);
    await cdp.evaluate(`document.querySelector('[data-testid="capture-photo"]').click()`);
    await cdp.waitFor(`!!document.querySelector('[data-testid="media-consent"]')`, { what: `授权弹层@${w}`, timeout: 10_000 });
    const consent = await cdp.evaluate(
      `(() => document.querySelector('[data-testid="media-consent"]').innerText.split(String.fromCharCode(10)).join(' '))()`,
    );
    check(/仅用于本次售后处理/.test(String(consent)), `@${w} 授权弹层保留隐私用途说明`, String(consent).slice(0, 70));
    await cdp.evaluate(`document.querySelector('[data-testid="consent-no"]').click()`);
    await cdp.waitFor(`!document.querySelector('[data-testid="media-consent"]')`, { what: `关闭弹层@${w}`, timeout: 10_000 });

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `media-${w}.png`), Buffer.from(shot.data, 'base64'));
  }
} finally {
  session.close();

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  B-25 定向补证：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过（375 / 390 / 420）');
  console.log('  截图：.tmp-verify/ux01d-m1/media-375|390|420.png');
  console.log('');
}
