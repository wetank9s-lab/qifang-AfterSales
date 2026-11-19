import fs from 'node:fs';
const BASE = 'http://127.0.0.1:13000';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin','utf8').trim();
const r = await fetch(`${BASE}/api/desktopRoutes:listAccessible?tree=true&paginate=false&layout=admin-layout-model`, {
  headers: { Authorization: `Bearer ${tok}`, 'X-Role': 'hq_admin' }
});
const j = await r.json();
const g = (j.data||[]).find(n=>n.type==='group'&&n.title==='日常业务');
if (g) console.log('DS-CHILDREN', (g.children||[]).map(c=>c.type+':'+c.title).join(' | '));
const walk = (n, d=0) => { console.log(' '.repeat(d*2) + `${n.type} | ${n.title} | ${n.id} | children=${(n.children||[]).length}`); (n.children||[]).forEach(c=>walk(c,d+1)); };
(j.data||[]).forEach(n=>walk(n));
