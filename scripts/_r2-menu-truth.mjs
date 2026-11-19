/**
 * R2 · 菜单真值探针（**只读**，不写任何路由）
 *
 * 目的：在动手重组菜单**之前**，先拿到"当前菜单实际长什么样"的两份独立证据。
 *   判据甲（接口层）：`GET /api/desktopRoutes:listAccessible` —— 客户端渲染菜单
 *                    实际消费的那一个接口。**不是** `desktopRoutes:list`（那是管理配置接口）。
 *   判据乙（DOM 层）：真实后台侧边栏渲染出的分组与条目文本。
 *
 * 为什么必须有两条：
 *   2026-11-12 记录过 DEV —— "看到 listAccessible 只返回 1 条就认定菜单没配"，
 *   真因是查询没带 `layout` 参数。同一类错法再来一次就废一轮。
 *   又：`rolesDesktopRoutes` 行数**不能**当判据（用户明确否定过"只报 DB 行数"）。
 *
 * 用法：
 *   node scripts/_r2-menu-truth.mjs                      # 默认 admin + hq_admin
 *   ROLE_SET=admin node scripts/_r2-menu-truth.mjs       # 只跑一个角色
 */
import { launchCdp } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = {
  admin: { email: envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), pw: envValue('SMOKE_ADMIN_PASSWORD') },
  hq_admin: { email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), pw: envValue('UAT_HQADMIN_PASSWORD') },
  hq: { email: 'uat.hq@svc.local', pw: envValue('UAT_HQ_PASSWORD') },
  store: { email: 'uat.store.a@svc.local', pw: envValue('UAT_STORE_A_PASSWORD') },
};

const wanted = (process.env.ROLE_SET || 'admin,hq_admin').split(',').map((s) => s.trim()).filter(Boolean);

/** 递归把 listAccessible 的树拍平成 "组 / 页" 两行文本，便于逐字比对 */
function flatten(node, depth = 0, out = []) {
  const title = String(node?.title ?? '').trim();
  const type = String(node?.type ?? '');
  out.push(`${'  '.repeat(depth)}[${type}] ${title}`);
  for (const c of node?.children ?? []) flatten(c, depth + 1, out);
  return out;
}

const results = {};

for (const who of wanted) {
  const acct = ACCOUNTS[who];
  if (!acct?.pw) {
    console.log(`\n===== ${who}：跳过（.env 缺口令） =====`);
    continue;
  }
  console.log(`\n===== ${who} · ${acct.email} =====`);
  const s = await launchCdp({ port: 9541, label: `menu-${who}` });
  const { cdp } = s;
  try {
    await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
    await sleep(3000);

    // ---- 页面内登录。⚠️ `role` 取不到时**绝不能**把字符串 "null" 写进 localStorage：
    //      那会让后续请求带 `X-Role: null` ⇒ 服务端 401（NOCOBASE_ROLE 非法）。
    //      2026-11-16 实测踩到：探针因此把"门店角色 7 个页面"报成"401 无菜单"，
    //      而直连 fetch（不带 X-Role）其实 200。**验证器自己会错，且错得比产品隐蔽。**
    const login = await cdp.evaluate(`(async()=>{
      const r=await fetch('/api/auth:signIn',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({account:${JSON.stringify(acct.email)},password:${JSON.stringify(acct.pw)}})});
      const j=await r.json();
      if(!j||!j.data||!j.data.token) return {ok:false,status:r.status,body:JSON.stringify(j).slice(0,200)};
      localStorage.setItem('NOCOBASE_TOKEN',j.data.token);
      // 权威取角色：roles:check 的 data.roles[0]
      let role=null;
      try{
        const c=await fetch('/api/roles:check',{headers:{Authorization:'Bearer '+j.data.token}});
        const cj=await c.json();
        role=(cj&&cj.data&&cj.data.roles&&cj.data.roles[0])||null;
      }catch(e){}
      if(!role){ try{ const c2=await fetch('/api/auth:check',{headers:{Authorization:'Bearer '+j.data.token}});
        const c2j=await c2.json(); role=(c2j&&c2j.data&&c2j.data.roles&&c2j.data.roles[0])||null; }catch(e){} }
      if(role) localStorage.setItem('NOCOBASE_ROLE',role);
      else localStorage.removeItem('NOCOBASE_ROLE');
      return {ok:true,role:role,tokenLen:j.data.token.length,token:j.data.token};
    })()`);
    if (!login?.ok) {
      console.log(`  ❌ 登录失败：${JSON.stringify(login)}`);
      continue;
    }
    console.log(`  登录成功 role=${login.role} tokenLen=${login.tokenLen}`);

    // ⚠️ 登录后**立即导航**到 /admin/，再在新文档里自愈式重设 token。
    //    2026-11-16 实测：登录后不导航直接读 localStorage，token 可能已被
    //    该 SPA 的 auth 流程清掉（读到 0）⇒ 接口 401 ⇒ 误报"该角色无菜单"。
    //    这里既做自愈，也在最终判定前加"token 必须非空"的硬断言。
    await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
    await sleep(5000);
    const token = await cdp.evaluate(`(async()=>{
      if(!localStorage.getItem('NOCOBASE_TOKEN')){
        localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(login.token)});
        if(!localStorage.getItem('NOCOBASE_ROLE')) localStorage.setItem('NOCOBASE_ROLE',${JSON.stringify(login.role || '')});
        return localStorage.getItem('NOCOBASE_TOKEN');
      }
      return localStorage.getItem('NOCOBASE_TOKEN');
    })()`);
    const roleHeader = await cdp.evaluate(`localStorage.getItem('NOCOBASE_ROLE')`);
    console.log(`  token 长度=${token?.length ?? 0}  X-Role=${JSON.stringify(roleHeader)}`);
    if (!token || token.length < 20) {
      console.log(`  ⚠️ TEST INVALID：token 为空/过短，本次探测结论不可用（先修探针，别下结论）。`);
      continue;
    }

    // ---- 判据甲：接口层。带 layout 与不带 layout 各来一次（这正是历史踩坑点）
    const apiProbe = await cdp.evaluate(`(async()=>{
      const H={'Authorization':'Bearer '+localStorage.getItem('NOCOBASE_TOKEN'),
               'X-Role':localStorage.getItem('NOCOBASE_ROLE')||''};
      const get=async(u)=>{const r=await fetch(u,{headers:H});let j=null;try{j=await r.json()}catch(e){}
        return {status:r.status,n:(j&&j.data&&j.data.length)||0,data:(j&&j.data)||null};};
      const noLayout=await get('/api/desktopRoutes:listAccessible');
      const withLayout=await get('/api/desktopRoutes:listAccessible?layout=admin-layout-model');
      return {noLayout:{status:noLayout.status,n:noLayout.n,tree:noLayout.data},
              withLayout:{status:withLayout.status,n:withLayout.n,tree:withLayout.data}};
    })()`);

    console.log(`  [甲-接口] listAccessible 无 layout → status=${apiProbe.noLayout.status} n=${apiProbe.noLayout.n}`);
    console.log(`  [甲-接口] listAccessible?layout=admin-layout-model → status=${apiProbe.withLayout.status} n=${apiProbe.withLayout.n}`);

    // ---- 探针自证：接口层拿不到 2xx 时先判"探针无效"，不把 401 当产品结论
    //      （2026-11-16 实测：X-Role 被写成字符串 "null" ⇒ 401 ⇒ 差点误报"门店角色无菜单"）
    if (apiProbe.withLayout.status !== 200 && apiProbe.noLayout.status !== 200) {
      console.log(`  ⚠️ TEST INVALID：两个变体都不是 200（无layout=${apiProbe.noLayout.status}, 有layout=${apiProbe.withLayout.status}）` +
        `\n     —— 可能是探针自身问题（如 X-Role 非法），不得据此判"该角色无菜单"。`);
    }

    const tree = apiProbe.withLayout.n >= apiProbe.noLayout.n ? apiProbe.withLayout.tree : apiProbe.noLayout.tree;
    const apiFlat = [];
    for (const n of tree ?? []) flatten(n, 0, apiFlat);
    console.log('  [甲-接口] 可见树：');
    for (const line of apiFlat) console.log(`      ${line}`);

    // ---- 判据乙：DOM 层。真实侧边栏
    await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
    await sleep(5500);
    // 导航会把 token 清掉（SPA 未登录态），这里自愈，否则侧边栏只会渲染成登录页
    await cdp.evaluate(`(()=>{
      localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(login.token)});
      ${login.role ? `localStorage.setItem('NOCOBASE_ROLE',${JSON.stringify(login.role)});` : ''}
      return 1;
    })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
    await sleep(6500);
    const dom = await cdp.evaluate(`(()=>{
      const pick=(sel)=>[...document.querySelectorAll(sel)].map(e=>(e.innerText||'').trim()).filter(Boolean);
      // NocoBase 侧边栏菜单项；pull 多种选择器，任一命中即可（不依赖单一类名）
      const itemSel='.ant-menu-item,.ant-menu-submenu-title,[class*="menu-item"]';
      const items=pick(itemSel);
      const uniq=[...new Set(items)].slice(0,60);
      return {href:location.href, itemCount:items.length, items:uniq,
              hasSider:!!document.querySelector('.ant-layout-sider'),
              tables:document.querySelectorAll('.ant-table').length};
    })()`);
    console.log(`  [乙-DOM] href=${dom.href} 侧边栏存在=${dom.hasSider} 菜单项=${dom.itemCount}`);
    for (const it of dom.items) console.log(`      · ${it.replace(/\s+/g, ' ')}`);

    results[who] = { role: roleHeader, tokenLen: token?.length ?? 0, api: apiProbe, apiFlat, dom };

    // ---- 截图（viewport，非 captureBeyondViewport —— 后者会把页面打回 loading）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    const { createHash } = await import('node:crypto');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'storage', 'tmp', 'r2-menu');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `menu-${who}-before.png`);
    writeFileSync(f, buf);
    console.log(`  截图 ${f} bytes=${buf.length} sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
  } finally {
    s.close();
  }
}

const { writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const outDir = join(process.cwd(), 'storage', 'tmp', 'r2-menu');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'before.json'), JSON.stringify(results, null, 2));
console.log(`\n原始证据：storage/tmp/r2-menu/before.json`);
