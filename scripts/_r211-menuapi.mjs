import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const port = 9941;
const profile = path.join(os.tmpdir(), `r211ma-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
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
// 在真实页面上下文里调用 routeRepository.listAccessible()
const out = await ev(`(async () => {
  try {
    const eng = window.__nbFlowEngine || null;
    if (!eng) return 'no __nbFlowEngine; keys=' + Object.keys(window).filter(k=>/flow|nb/i.test(k)).slice(0,20).join(',');
    const repo = eng.context && eng.context.routeRepository;
    if (!repo) return 'no routeRepository';
    const list = await repo.listAccessible();
    const flat = (a, d=0, acc=[]) => { (a||[]).forEach(n => { acc.push(' '.repeat(d*2)+n.type+'|'+n.title+'|'+(n.children||[]).length); flat(n.children, d+1, acc); }); return acc; };
    return flat(list).join(' || ');
  } catch(e) { return 'ERR '+e.message; }
})()`);
console.log(out);
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
