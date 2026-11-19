process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:13000';
const PW = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PW) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }
for (const acc of ['uat.hqadmin@svc.local', 'uat.r211.hq@svc.local', 'uat.r211.store@svc.local']) {
  const r = await fetch(BASE + '/api/auth:signIn', { method: 'POST', body: new URLSearchParams({ account: acc, password: PW }) });
  const j = await r.json().catch(() => null);
  const t = j?.data?.token;
  console.log(acc.padEnd(30), r.status, t ? 'OK' : '');
  if (t) fs.writeFileSync('storage/tmp/r211/.tok_' + acc.split('@')[0].replace(/\./g, '_'), t);
}
