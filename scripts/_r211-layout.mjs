import fs from 'node:fs';
const BASE='http://127.0.0.1:13000';
const tok=fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const cands=['/api/uiSchemas:getJsonSchema/admin-layout-model','/api/uiSchemas:getJsonSchema/admin-layout-model?includeAsyncNode=true','/api/uiSchemas:getProperties/admin-layout-model'];
for(const p of cands){
  const r=await fetch(BASE+p,{headers:{Authorization:`Bearer ${tok}`,'X-Role':'hq_admin'}});
  const t=await r.text();
  console.log(p,'->',r.status,t.slice(0,400).replace(/\n/g,' '));
}
