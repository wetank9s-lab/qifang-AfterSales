process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'http://127.0.0.1:13000';
// 口令走环境变量，不入库（仓库 public）
const PW = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PW) { console.error('缺少口令：export R212_PASS=<本地口令>'); process.exit(1); }
const r = await fetch(BASE + '/api/auth:signIn', { method: 'POST', body: new URLSearchParams({ account: process.env.R212_ADMIN || 'admin@nocobase.com', password: PW }) });
const j = await r.json().catch(() => null);
const t = j?.data?.token;
console.log('admin login', r.status, t ? 'OK' : JSON.stringify(j).slice(0, 150));
if (t) {
  const H = { Authorization: 'Bearer ' + t };
  for (const p of ['/api/flowModels:list?paginate=false', '/api/uiSchemas:getJsonSchema/6dbu7gadt9j', '/api/desktopRoutes:list?paginate=false']) {
    const x = await fetch(BASE + p, { headers: H });
    console.log(p.slice(0, 50).padEnd(52), x.status);
  }
  const fs = await import('node:fs');
  fs.writeFileSync('storage/tmp/r211/.tok_admin', t);
}
