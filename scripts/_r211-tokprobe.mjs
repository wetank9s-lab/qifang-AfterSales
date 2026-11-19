process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { readEnv, signIn } from './_b36-lib.mjs';
const BASE = 'http://127.0.0.1:13000';
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
console.log('token len', tok?.length);
for (const [label, init] of [
  ['Authorization Bearer', { headers: { Authorization: 'Bearer ' + tok } }],
  ['X-Authenticator+Auth', { headers: { Authorization: 'Bearer ' + tok, 'X-Authenticator': 'basic' } }],
]) {
  for (const p of ['/api/auth:check', '/api/uiSchemas:getJsonSchema/wz4qkejuvd6']) {
    const r = await fetch(BASE + p, init);
    console.log(label.padEnd(24), p.slice(0, 44).padEnd(46), r.status);
  }
}
