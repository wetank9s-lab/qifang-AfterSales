import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const port = 9981;
const profile = path.join(os.tmpdir(), `r211tm-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child = spawn(chrome, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<100;i++){ try{ const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==='page'); if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} await sleep(300); }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map();
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails||r?.result);};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(11000);
// 点「管理与设置」这个顶部 tab
const before = await ev(`(() => {
  const hs = [...document.querySelectorAll('li.ant-menu-item, li.ant-menu-submenu')].map(n=>n.innerText.trim().slice(0,20));
  const sider = (document.querySelector('.ant-layout-sider')||{}).innerText||'';
  return JSON.stringify({ top: hs, sider: sider.replaceAll(String.fromCharCode(10),'|') });
})()`);
console.log('BEFORE', before);
const click = await ev(`(() => {
  const el = [...document.querySelectorAll('li.ant-menu-item')].find(n => (n.innerText||'').trim()==='管理与设置');
  if (!el) return 'nf'; el.click(); return 'ok';
})()`);
console.log('click', click);
await sleep(3000);
const after = await ev(`(() => {
  const sider = (document.querySelector('.ant-layout-sider')||{}).innerText||'';
  const subs = [...document.querySelectorAll('.ant-menu-submenu')].map(n=>n.className.slice(0,80)+' :: '+n.innerText.trim().slice(0,30));
  return JSON.stringify({ sider: sider.replaceAll(String.fromCharCode(10),'|'), subs, url: location.pathname });
})()`);
console.log('AFTER', after);
await send('Page.captureScreenshot',{format:'png'}).then(r=>{const b=Buffer.from(r.result.data,'base64');fs.writeFileSync('storage/tmp/r211/shots/00-menu-expanded.png',b);console.log('shot',b.length);});
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
