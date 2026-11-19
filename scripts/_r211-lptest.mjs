// 以 admin 身份登录本地，导出实际菜单树：看 flowPage 是否被放进 group 的 children
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:13000';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const q = async (u) => (await (await fetch(BASE+u,{headers:{Authorization:`Bearer ${tok}`,'X-Role':'hq_admin'}})).json());
const j = await q('/api/desktopRoutes:listAccessible?tree=true&paginate=false');
console.log(JSON.stringify(j.data.map(n=>({t:n.title,id:n.id,ty:n.type,ch:(n.children||[]).length})),null,0));
