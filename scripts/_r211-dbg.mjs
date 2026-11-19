import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const filters = (process.argv[2]||'').split(',').filter(Boolean);
const port = 9951;
const profile = path.join(os.tmpdir(), `r211dbg-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child = spawn(chrome, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,900','--enable-logging=stderr','--v=0','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderrBuf='';
child.stderr.on('data',d=>{stderrBuf+=d.toString();});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<100;i++){ try{ const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==='page'); if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} await sleep(300); }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map(); const logs=[];
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
  if(m.method==='Runtime.consoleAPICalled'){ logs.push('['+m.params.type+'] '+m.params.args.map(a=>a.value??a.description??a.type).join(' ')); }
  if(m.method==='Runtime.exceptionThrown'){ logs.push('[EXC] '+(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text)); }
});
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails||r?.result);};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
await send('Runtime.evaluate',{expression:`window.__dbg=[];const o=console.error;console.error=function(...a){window.__dbg.push(a.map(x=>{try{return typeof x==='string'?x:(x&&x.message)||String(x)}catch{return '?'}}).join(' '));o.apply(console,a)};true`});
logs.length=0;
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(12000);
const dbg = await ev('JSON.stringify((window.__dbg||[]).slice(0,20))');
console.log('--- console.error from page ---'); console.log(dbg);
console.log('--- CDP logs (filtered) ---');
const f = filters.length? logs.filter(l=>filters.some(k=>l.includes(k))) : logs;
console.log(f.slice(0,40).join('\n---\n'));
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
