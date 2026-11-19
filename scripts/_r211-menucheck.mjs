// 菜单虚拟分组验证：只认 DOM 里真实渲染出的结构，不看配置、不看日志。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const TOKFILE = process.argv[2] || 'storage/tmp/r211/.tok_uat_hqadmin';
const SHOT = process.argv[3] || '';
const tok = fs.readFileSync(TOKFILE,'utf8').trim();
const port=9949; const profile=path.join(os.tmpdir(),`r211mg-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child=spawn(chrome,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,1000','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<120;i++){try{const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());const p=l.find(t=>t.type==='page');if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;}}catch{} await sleep(300);}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r?.result?.result?.value??JSON.stringify(r?.result?.exceptionDetails||r?.result);};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'});
// 等分组真正出现（最多 25s）
let ok=false;
for(let i=0;i<25;i++){
  await sleep(1000);
  const n=Number(await ev("document.querySelectorAll('.ant-layout-sider li[data-svc-vgroup]').length"))||0;
  if(n>0){ ok=true; break; }
}
if(String(await ev('location.pathname')).includes('signin')){ console.log('LOGIN FAILED'); child.kill('SIGKILL'); process.exit(2); }
const out=await ev(`(() => {
  const NL=String.fromCharCode(10);
  const T=n=>(n.innerText||'').trim().split(NL).map(s=>s.trim()).filter(Boolean).join(' / ');
  const sider=document.querySelector('.ant-layout-sider');
  const menu=sider && sider.querySelector('ul.ant-menu');
  const groups=[...document.querySelectorAll('li[data-svc-vgroup]')].map(b=>({
    key:b.getAttribute('data-svc-vgroup'),
    title:T(b.querySelector('.ant-menu-submenu-title')||b),
    collapsed:b.getAttribute('data-collapsed'),
    items:[...b.querySelectorAll('li')].map(T).filter(Boolean),
    visible:(b.querySelector('ul.ant-menu-sub')||{}).style?.display !== 'none',
  }));
  const looseTop=[...menu.children].filter(n=>!n.hasAttribute('data-svc-vgroup')).map(T).filter(Boolean);
  return JSON.stringify({url:location.pathname, groups, looseTop}, null, 1);
})()`);
console.log(out);
if(SHOT){ const r=await send('Page.captureScreenshot',{format:'png'}); const b=Buffer.from(r.result.data,'base64'); fs.writeFileSync(path.join('storage/tmp/r211/shots',SHOT),b); console.log('shot',SHOT,b.length,'B'); }
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
process.exit(ok?0:3);
