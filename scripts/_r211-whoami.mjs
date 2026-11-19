process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:13000';
for (const f of fs.readdirSync('storage/tmp/r211').filter(x => x.startsWith('.tok_'))) {
  const t = fs.readFileSync('storage/tmp/r211/' + f, 'utf8').trim();
  const r = await fetch(BASE + '/api/auth:check', { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => null);
  console.log(f.padEnd(28), r.status, JSON.stringify(j?.data?.user ? { email: j.data.user.email, roles: j.data.user.roles?.map(x => x.name) } : j)?.slice(0, 160));
}
