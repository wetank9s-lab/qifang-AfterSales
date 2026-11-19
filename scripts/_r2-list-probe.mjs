import { launchCdp } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const BASE='https://127.0.0.1';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const s=await launchCdp({port:9541,label:'probe'});
const {cdp}=s;
try{
 await cdp.send('Page.navigate',{url:BASE+'/admin/'});
 await sleep(4000);
 await cdp.evaluate(`(async()=>{const r=await fetch('/api/auth:signIn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'uat.store.a@svc.local',password:${JSON.stringify(envValue('UAT_STORE_A_PASSWORD'))}})});const j=await r.json();localStorage.setItem('NOCOBASE_TOKEN',j.data.token);localStorage.setItem('NOCOBASE_ROLE','store_after_sales');return 1;})()`);
 await cdp.send('Page.navigate',{url:BASE+'/admin/tujyw08ec1d'});
 await sleep(6000);
 const info=await cdp.evaluate(`(()=>{
   const rows=[...document.querySelectorAll('.ant-table-row')];
   return {href:location.href,rowCount:rows.length,
     first:rows[0]?(rows[0].innerText||'').slice(0,300):null,
     btns:rows[0]?[...rows[0].querySelectorAll('button,a')].map(b=>b.innerText).slice(0,15):[],
     hasDrawer:!!document.querySelector('.ant-drawer'),
     tables:document.querySelectorAll('.ant-table').length};
 })()`);
 console.log(JSON.stringify(info,null,2));
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
 console.log('shot bytes(empty check)='+Buffer.from(shot.data,'base64').length);
}finally{s.close();}
