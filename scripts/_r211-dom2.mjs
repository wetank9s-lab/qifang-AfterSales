import fs from 'node:fs';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const port = await (async () => { for (let p=9931;p<9990;p++){ try{ await fetch(`http://127.0.0.1:${p}/json/version`); }catch{ return p; } } })();
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const profile = path.join(os.tmpdir(), `r211d2-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child = spawn(chrome, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<100;i++){ try{ const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==='page'); if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} await sleep(300); }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map();
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}))?.result?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(10000);
const out = await ev(`(() => {
  const s = document.querySelector('.ant-layout-sider') || document.body;
  const lis = [...s.querySelectorAll('li')].map(n => ({
    cls: n.className.slice(0,110),
    txt: (n.innerText||'').trim().slice(0,20),
    mid: n.getAttribute('data-menu-id') || n.getAttribute('data-menu-key') || '',
    depth: (()=>{let d=0,p=n;while(p&&p!==s){p=p.parentElement;d++;}return d;})(),
  }));
  // 也看看 header 的 tab 区
  const tabs = [...document.querySelectorAll('.ant-pro-layout-top-menu, .ant-tabs-tab, [class*=TopMenu]')].map(n=>(n.innerText||'').trim()).slice(0,10);
  return { lis, tabs, siderCls: (document.querySelector('.ant-layout-sider')||{}).className || '' };
})()`);
console.log(JSON.stringify(out,null,1).slice(0,4000));
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
