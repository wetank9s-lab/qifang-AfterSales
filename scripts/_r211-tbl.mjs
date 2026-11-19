import fs from 'node:fs';
const BASE='http://127.0.0.1:13000';
const tok=fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
for (const p of ['/api/desktopRoutes:list?paginate=false&pageSize=200','/api/desktopRoutes:list?paginate=true&pageSize=2','/api/rolesDesktopRoutes:list?paginate=false']) {
  const r=await fetch(BASE+p,{headers:{Authorization:`Bearer ${tok}`,'X-Role':'hq_admin'}});
  const t=await r.text();
  console.log(p,'->',r.status,t.slice(0,160).replace(/\s+/g,' '));
}
