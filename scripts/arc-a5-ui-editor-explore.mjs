/**
 * arc-a5-ui-editor-explore.mjs —— 在 V2 移动页上打开 UI Editor，读出可用区块清单
 *
 * 目的：不猜 schema。直接在真实 UI Editor 里把"能加哪些区块 / 能加哪些动作"
 * 抓成结构化清单，再决定表单怎么搭。
 *
 * 只读：只打开配置面板读取选项，不提交、不保存任何配置。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from '../scripts/verify-store-ui-primary-action.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';
const PAGE_UID = 'n5c25yq5qlt';

const credLines = fs.readFileSync('.tmp-verify/admin-credential-dev.txt', 'utf8').split(/\r?\n/);
const cred = (k) => { const l = credLines.find((x) => new RegExp('^\\s*' + k + '\\s*[:：]').test(x)); return l ? l.replace(/^\s*[A-Za-z]+\s*[:：]\s*/, '').trim() : ''; };
const ROOT = { email: cred('email') || cred('username'), password: cred('password') };

const s = await launchCdp({ label: 'a5ui' });
const { cdp } = s;
try {
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await sleep(2500);
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { timeout: 45000 });
  await cdp.evaluate(`(()=>{const ins=[...document.querySelectorAll('input')];const set=(el,v)=>{const st=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;st.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(ins[0],${JSON.stringify(ROOT.email)});set(ins[1],${JSON.stringify(ROOT.password)});return true;})()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { timeout: 45000 });
  console.log('root 登录完成');

  // 进入移动页（带 ui 编辑参数）
  for (const url of [
    `${BASE}/v/mobile/${PAGE_UID}?ui=1`,
    `${BASE}/v/mobile/${PAGE_UID}`,
  ]) {
    await cdp.send('Page.navigate', { url });
    await sleep(9000);
    const info = await cdp.evaluate(`(() => {
      const rt = document.querySelector('#root') || document.body;
      const txt = (rt.innerText || '').replace(/\\s+/g,' ').trim();
      // 找所有可能是"配置/加号/编辑"的控件
      const btns = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(e => e.offsetParent !== null)
        .map(e => ({ tag: e.tagName, cls: (e.className||'').toString().slice(0,70),
                     txt: (e.innerText||'').trim().slice(0,24),
                     aria: e.getAttribute('aria-label')||'',
                     testid: e.getAttribute('data-testid')||'' }))
        .filter(x => x.txt || x.aria || x.testid);
      return { path: location.pathname + location.search, len: txt.length, txt: txt.slice(0,200),
               btnCount: btns.length, btns: btns.slice(0, 30) };
    })()`);
    console.log(`\n=== ${url} ===`);
    console.log(`  path=${info.path} 正文长度=${info.len} 可见控件=${info.btnCount}`);
    console.log(`  正文: ${JSON.stringify(info.txt)}`);
    for (const b of info.btns) console.log(`   - ${b.tag} txt=${JSON.stringify(b.txt)} aria=${JSON.stringify(b.aria)} testid=${JSON.stringify(b.testid)}`);
  }

  // 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = `.tmp-verify/arc-a5-uieditor-explore-${Date.now()}.png`;
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图: ${p} (${Buffer.from(shot.data,'base64').length} bytes)`);
} finally {
  s.close();
}
