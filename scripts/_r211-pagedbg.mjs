process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { readEnv, signIn } from './_b36-lib.mjs';
const BASE = process.env.R21_BASE || 'http://127.0.0.1:13000';
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
const H = { Authorization: 'Bearer ' + tok };
for (const p of [
  '/api/flowModels:list?paginate=false',
  '/api/flowModels:list',
  '/api/uiSchemas:getJsonSchema/6dbu7gadt9j',
  '/api/desktopRoutes:list?paginate=false',
  '/api/roles:check',
  '/api/app:getInfo',
]) {
  const r = await fetch(BASE + p, { headers: H });
  const t = await r.text();
  console.log(p.slice(0, 60).padEnd(62), r.status, t.slice(0, 110).replace(/\n/g, ' '));
}
