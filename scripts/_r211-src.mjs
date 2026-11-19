// 在页面上下文里取 stack（sourceURL + 行列），用于把 "J" 还原成源码位置
import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const port = 9961;
const profile = path.join(os.tmpdir(), `r211src-${Date.now()}`); fs.mkdirSync(profile,{recursive:true});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
const child = spawn(chrome, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl=null;
for(let i=0;i<100;i++){ try{ const l=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==='page'); if(p?.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} await sleep(300); }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map();
ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails||r?.result);};
await send('Page.enable'); await send('Runtime.enable');
// 在文档创建前注入：把 console.error 的 stack 记下来
await send('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__errs=[];
  const _e=console.error.bind(console);
  console.error=function(...a){
    try{ const st=new Error().stack||''; window.__errs.push(JSON.stringify(a.map(x=>{try{return typeof x==='string'?x:(x&&x.message)||String(x)}catch(_){return '?'}})) + ' ||| ' + st.split('\n').slice(0,6).join(' <<< ')); }catch(_){}
    _e(...a);
  };`});
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(3000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
await send('Page.navigate',{url:'http://127.0.0.1:13000/admin/'}); await sleep(12000);
console.log(await ev('JSON.stringify((window.__errs||[]),null,1)'));
child.kill('SIGKILL'); try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
