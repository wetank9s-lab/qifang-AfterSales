import fs from 'node:fs';
const BASE='http://127.0.0.1:13000';
const tok=fs.readFileSync(process.env.TOKF||'storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const role=process.env.ROLE||'hq_admin';
const paths=process.argv.slice(2);
for(const p of paths){
  const r=await fetch(BASE+p,{headers:{Authorization:`Bearer ${tok}`,'X-Role':role}});
  const txt=await r.text();
  console.log('### '+p+' -> '+r.status+' '+txt.slice(0,300).replace(/\n/g,' '));
}
