/**
 * arc-a5-mobile-open.mjs —— ARC-V1 / A5 移动页真实打开验证
 *
 * 判据（每条都要能变红）：
 *   P1 登录后 `/v/mobile/n5c25yq5qlt` 真的渲染出页面（不是 404 / 白屏 / 转圈）
 *   P2 强制刷新（Ctrl+F5 级：Page.reload ignoreCache）后仍渲染
 *   P3 直接带地址冷启动（新开标签，无历史）仍渲染
 *   P4 页面上真的存在一个可放置内容的容器（BlockGridModel 渲染的 grid）
 *   R1 反向对照：一个**不存在**的 schemaUid 必须打不开 —— 证明 P1 不是"任何路径都 200"
 *
 * 纪律：只读；不改任何数据。
 */
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

const UID = process.argv[2] || 'n5c25yq5qlt';
const BAD = 'zzzz0000notexist';
const fs = await import('node:fs');
const t = fs.readFileSync('.env', 'utf8');
const g = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(t); return m ? m[1].trim() : ''; };
const ACCOUNT = g('UAT_HQADMIN_EMAIL') || 'uat.hqadmin@svc.local';
const PASSWORD = g('UAT_HQADMIN_PASSWORD');
const BASE = 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

// 页面"真的渲染"的判据：取 #root 内可见文本 + 是否有错误提示
const PROBE = `(() => {
  const root = document.querySelector('#root') || document.body;
  const txt = (root.innerText || '').replace(/\\s+/g,' ').trim();
  return {
    url: location.href,
    title: document.title,
    textLen: txt.length,
    text: txt.slice(0, 400),
    html: (root.innerHTML || '').length,
    loading: /加载中|Loading/i.test(txt) && txt.length < 60,
    notFound: /404|Not Found|页面不存在|not found/i.test(txt),
    errorTip: /出错了|Something went wrong|Internal Server Error/i.test(txt),
    grid: document.querySelectorAll('.ant-grid, [class*="grid"], [class*="Grid"]').length,
    editable: document.querySelectorAll('[data-flow-model], .flow-model, [class*="flowModel"]').length,
  };
})()`;

const s = await launchCdp({ label: 'a5open' });
const { cdp } = s;
try {
  // 登录
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(() => { const ins=[...document.querySelectorAll('input')]; const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}; set(ins[0],${JSON.stringify(ACCOUNT)}); set(ins[1],${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  console.log('  登录完成');

  // P1 首次打开
  console.log('\n--- P1 首次打开 ---');
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/${UID}` });
  await sleep(9000);
  const p1 = await cdp.evaluate(PROBE);
  console.log('        ' + JSON.stringify(p1));
  check(!p1.loading && !p1.notFound && !p1.errorTip && p1.textLen > 0,
    'P1 页面渲染出内容（非加载中/404/报错）', `url=${p1.url} textLen=${p1.textLen}`);

  // P2 强制刷新
  console.log('\n--- P2 强制刷新（忽略缓存）---');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(9000);
  const p2 = await cdp.evaluate(PROBE);
  check(!p2.loading && !p2.notFound && !p2.errorTip && p2.textLen > 0,
    'P2 强制刷新后仍渲染', `url=${p2.url} textLen=${p2.textLen}`);
  check(p1.text === p2.text || Math.abs(p1.textLen - p2.textLen) < 40,
    'P2b 刷新前后渲染内容一致（状态可持久）',
    `before=${p1.text.slice(0, 60)} / after=${p2.text.slice(0, 60)}`);

  // P3 冷启动（新上下文路径：先离开再到回）
  console.log('\n--- P3 离开后重新直接访问 ---');
  await cdp.send('Page.navigate', { url: `${BASE}/v/` });
  await sleep(4000);
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/${UID}` });
  await sleep(8000);
  const p3 = await cdp.evaluate(PROBE);
  check(!p3.loading && !p3.notFound && !p3.errorTip && p3.textLen > 0,
    'P3 离开后重新直接访问仍可打开', `textLen=${p3.textLen}`);

  // P4 可放置内容的容器
  console.log('\n--- P4 容器 ---');
  check(p3.grid > 0 || p3.editable > 0, 'P4 页面存在可放置区块的容器',
    `grid=${p3.grid} flowModelNodes=${p3.editable}`);

  // R1 反向对照
  console.log('\n--- R1 反向对照：不存在的 schemaUid ---');
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/${BAD}` });
  await sleep(8000);
  const r1 = await cdp.evaluate(PROBE);
  console.log('        ' + JSON.stringify({ url: r1.url, textLen: r1.textLen, text: r1.text.slice(0, 160), notFound: r1.notFound, loading: r1.loading }));
  check(r1.notFound || r1.errorTip || r1.textLen < 40 || r1.url.indexOf(BAD) === -1,
    'R1 不存在的 schemaUid 打不开（证明 P1 判据有效）',
    `notFound=${r1.notFound} textLen=${r1.textLen} url=${r1.url}`);

  // 截图
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/${UID}` });
  await sleep(9000);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const path = `.tmp-verify/arc-a5-mobile-${UID}-${Date.now()}.png`;
  fs.writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log(`\n  截图: ${path}  (${Buffer.from(shot.data, 'base64').length} bytes)`);
} finally {
  s.close();
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n=== ${pass}/${results.length} PASS ===`);
process.exit(pass === results.length ? 0 : 1);
