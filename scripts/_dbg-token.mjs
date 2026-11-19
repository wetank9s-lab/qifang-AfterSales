import { launchCdp } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const BASE='https://127.0.0.1';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const s=await launchCdp({port:9543,label:'dbg'});
const {cdp}=s;
try{
  await cdp.send('Page.navigate',{url:BASE+'/admin/'});
  await sleep(3000);
  const pw=envValue('UAT_STORE_A_PASSWORD');
  const r1=await cdp.evaluate(`(async()=>{
    const r=await fetch('/api/auth:signIn',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({account:'uat.store.a@svc.local',password:${JSON.stringify(pw)}})});
    const j=await r.json();
    localStorage.setItem('NOCOBASE_TOKEN',j.data.token);
    localStorage.setItem('NOCOBASE_ROLE','store_after_sales');
    const immediate=localStorage.getItem('NOCOBASE_TOKEN');
    return {signInStatus:r.status, tokenLen:(j.data.token||'').length, immediateLen:(immediate||'').length,
            keys:Object.keys(localStorage)};
  })()`);
  console.log('r1(同一evaluate内)', JSON.stringify(r1));
  const r2=await cdp.evaluate(`({len:(localStorage.getItem('NOCOBASE_TOKEN')||'').length, keys:Object.keys(localStorage), role:localStorage.getItem('NOCOBASE_ROLE'), url:location.href})`);
  console.log('r2(下一次evaluate)', JSON.stringify(r2));
  await sleep(2500);
  const r3=await cdp.evaluate(`({len:(localStorage.getItem('NOCOBASE_TOKEN')||'').length, url:location.href})`);
  console.log('r3(+2.5s)', JSON.stringify(r3));
}finally{s.close();}
