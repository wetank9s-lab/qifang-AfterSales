/**
 * arc-a5-route-probe.mjs —— ARC-V1 / A5 移动页 URL 形态探测（只读）
 *
 * 背景：库里的路由是 flowPage + schemaUid=n5c25yq5qlt，
 *   但 `/v/mobile/n5c25yq5qlt` 返回 404。
 *   plugin-mobile 客户端路由里写的是：
 *     /page/:pageSchemaUid
 *     /page/:pageSchemaUid/tabs/:tabSchemaUid
 *   所以真实形态很可能是 `/v/mobile/page/<uid>`。
 *
 * 做法：把候选 URL 全部实测一遍，谁渲染出内容谁就是正解。
 *   不猜、不推断、不改数据。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

const UID = process.argv[2] || 'n5c25yq5qlt';
const TABS = process.argv[3] || '97x481j2bv1';
const BAD = 'zzzz0000notexist';
const t = fs.readFileSync('.env', 'utf8');
const g = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(t); return m ? m[1].trim() : ''; };
const ACCOUNT = g('UAT_HQADMIN_EMAIL') || 'uat.hqadmin@svc.local';
const PASSWORD = g('UAT_HQADMIN_PASSWORD');
const BASE = 'https://127.0.0.1';

const CANDIDATES = [
  `/v/mobile/${UID}`,
  `/v/mobile/page/${UID}`,
  `/v/mobile/page/${UID}/tabs/${TABS}`,
  `/m/${UID}`,
  `/m/page/${UID}`,
  `/v/${UID}`,
];

const PROBE = `(() => {
  const root = document.querySelector('#root') || document.body;
  const txt = (root.innerText || '').replace(/\\s+/g,' ').trim();
  return {
    textLen: txt.length,
    text: txt.slice(0, 200),
    notFound: /404|页面不存在|Not Found/i.test(txt) || /404/.test(location.pathname),
    errorTip: /出错了|Something went wrong|Internal Server Error/i.test(txt),
  };
})()`;

const s = await launchCdp({ label: 'a5probe' });
const { cdp } = s;
const out = [];
try {
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(() => { const ins=[...document.querySelectorAll('input')]; const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}; set(ins[0],${JSON.stringify(ACCOUNT)}); set(ins[1],${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  console.log('登录完成，开始逐个探测\n');

  for (const path of CANDIDATES) {
    await cdp.send('Page.navigate', { url: BASE + path });
    await sleep(7000);
    const r = await cdp.evaluate(PROBE);
    const rec = { path, finalUrl: (await cdp.evaluate('location.pathname')), ...r };
    out.push(rec);
    const ok = !rec.notFound && !rec.errorTip && rec.textLen > 10;
    console.log(`${ok ? '✅ 可用' : '❌ 不可用'}  ${path}`);
    console.log(`     → ${rec.finalUrl}  textLen=${rec.textLen}  ${JSON.stringify(rec.text.slice(0, 90))}`);
  }

  // 对照：正确形态 + 不存在的 uid，必须失败
  await cdp.send('Page.navigate', { url: `${BASE}/v/mobile/page/${BAD}` });
  await sleep(7000);
  const bad = await cdp.evaluate(PROBE);
  console.log(`\n反向对照 /v/mobile/page/${BAD}: notFound=${bad.notFound} textLen=${bad.textLen} ${JSON.stringify(bad.text.slice(0, 80))}`);
} finally {
  s.close();
}

console.log('\n=== 汇总 ===');
const good = out.filter((r) => !r.notFound && !r.errorTip && r.textLen > 10);
console.log(`可用形态 ${good.length} 个：${good.map((g) => g.path).join(', ') || '(无)'}`);
fs.writeFileSync('.tmp-verify/arc-a5-route-probe.json', JSON.stringify(out, null, 2), 'utf8');
