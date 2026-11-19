import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const port = 9996;
const profile = path.join(os.tmpdir(), `r211tr-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child = spawn(chrome, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<100;i++){ try{ const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==='page'); if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} await sleep(300); }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map(); const scripts=new Map(); const errs=[];
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
 if(m.method==='Debugger.scriptParsed'){ scripts.set(m.params.scriptId, m.params.url); }
 if(m.method==='Runtime.exceptionThrown'){ const d=m.params.exceptionDetails; errs.push({text:d.text, url:d.url, line:d.lineNumber, col:d.columnNumber, desc:d.exception&&d.exception.description, stack:(d.stackTrace&&d.stackTrace.callFrames||[]).slice(0,6).map(f=>`${f.functionName||'(anon)'} @ ${scripts.get(f.scriptId)||f.scriptId}:${f.lineNumber}:${f.columnNumber}`)}); }
});
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails||r?.result);};
await send('Page.enable'); await send('Runtime.enable'); await send('Debugger.enable');
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
errs.length=0;
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(12000);
console.log(JSON.stringify(errs.slice(0,8), null, 1));
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
