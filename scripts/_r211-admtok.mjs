import fs from 'node:fs';
const BASE='http://127.0.0.1:13000';
const r=await fetch(BASE+'/api/auth:signIn',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({account:'admin@nocobase.com',password:process.env.ADMPW})});
const j=await r.json();
console.log(r.status, j?.data?.token? 'TOKEN OK':'NO TOKEN', JSON.stringify(j).slice(0,200));
if(j?.data?.token) fs.writeFileSync('storage/tmp/r211/.tok_admin', j.data.token);
