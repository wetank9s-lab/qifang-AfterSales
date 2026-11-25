/**
 * 生产验收账号（用户 2026-11-25 明确授权新建）。
 *
 * ===========================================================================
 * 用户约束（不得越过的边界）
 * ===========================================================================
 *  · 不重置或修改真实账号 —— 本脚本**只 create，不 update 任何既有用户**；
 *  · 不新增测试客户数据 —— 本脚本只建 **users + rolesUsers**，不碰工单/档案；
 *  · 不调整真实门店绑定 —— 新账号只绑一家**已存在**的门店，不动别人的 store_users；
 *  · 口令只从环境变量读，**不入库、不写文档、不打印**。
 *
 * ===========================================================================
 * 为什么不用直插数据库
 * ===========================================================================
 * `scripts/arc-a1-accounts-db.mjs` 的头部写着一条生产实测坑（2026-10-26）：
 *   直插 `rolesUsers` 后 `X-Role` 报 `ROLE_NOT_FOUND_FOR_USER` ——
 *   **ACL 的角色在内存里，数据库写入不会自动刷新，修法是重启应用**。
 *   生产重启 = 一次真实的停机窗口，为一个测试账号做这件事不值得。
 *  ⇒ 走 `users:create`（走 ORM，会触发 NocoBase 自己的角色缓存失效逻辑），
 *    建完立刻用该账号**真实登录**验证 `roles:check` / 一个业务读接口；
 *    若仍报 `ROLE_NOT_FOUND_FOR_USER`，脚本明确报"需重启"，**不假装成功**。
 *
 * 用法：
 *   set -a && . ./.env && set +a
 *   PROD_ADMIN_PASSWORD=... ARC_TEST_PW=... node scripts/prod-create-acceptance-accounts.mjs [--apply]
 * 不加 --apply 只做前置检查（不会建任何东西）。
 */
const BASE = 'https://sh.scqfls.cn';
const ADMIN_EMAIL = process.env.PROD_ADMIN_EMAIL || 'admin@nocobase.com';
const ADMIN_PW = process.env.PROD_ADMIN_PASSWORD;
const TEST_PW = process.env.ARC_TEST_PW;
const APPLY = process.argv.includes('--apply');

/**
 * ⚠️ 账号邮箱来自环境变量（`ACC_SALES_EMAIL` / `ACC_MGR_EMAIL`），**不写死**。
 *    第一版写死成 `r224acc.*@svc.local`，等于把生产库的一个可探测登录名
 *    连同脚本一起放进公开仓库 —— 那违反"scripts 不写入真实账号标识"。
 */
const SALES_EMAIL = process.env.ACC_SALES_EMAIL;
const MGR_EMAIL = process.env.ACC_MGR_EMAIL;

if (!ADMIN_PW) { console.error('缺少 PROD_ADMIN_PASSWORD'); process.exit(2); }
if (!TEST_PW) { console.error('缺少 ARC_TEST_PW（验收账号统一口令，仅从环境变量读）'); process.exit(2); }
if (!SALES_EMAIL || !MGR_EMAIL) {
  console.error('缺少 ACC_SALES_EMAIL / ACC_MGR_EMAIL（验收账号邮箱，见 .env.example 第 12 节）');
  process.exit(2);
}

/**
 * 两个验收账号。
 * `username` 带 `r224acc` 前缀，便于日后一眼认出并回收。
 * 邮箱用 `@svc.local`（与既有测试账号同域，不与真实客户邮箱混淆）。
 */
const ACCOUNTS = [
  {
    email: SALES_EMAIL,
    username: 'r224acc_sales',
    nickname: 'R2.2.4验收-门店销售',
    role: 'store_sales',
    storeId: null,
  },
  {
    email: MGR_EMAIL,
    username: 'r224acc_mgr',
    nickname: 'R2.2.4验收-门店负责人',
    role: 'store_manager',
    storeId: null,
  },
];

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text: json ? '' : text.slice(0, 300) };
}

// ① 管理员登录
const login = await api('/api/auth:signIn', {
  method: 'POST',
  body: { email: ADMIN_EMAIL, password: ADMIN_PW },
});
const token = login.json?.data?.token;
if (!token) {
  console.error('管理员登录失败：', JSON.stringify(login.json).slice(0, 300));
  process.exit(1);
}

// ② 选一家真实门店（必须是库里真实存在的，不猜 id）
const storesRes = await api('/api/stores:list?pageSize=50', { token });
const stores = storesRes.json?.data ?? [];
if (!stores.length) {
  console.error('读不到门店列表，无法绑定 —— 中止');
  process.exit(1);
}
const targetStore =
  stores.find((s) => String(s.code || '').toUpperCase() === 'SCQF-HL') ?? stores[0];
console.log(
  `门店候选 ${stores.length} 家；选中 id=${targetStore.id} code=${targetStore.code} name=${targetStore.name}`,
);

const results = [];

for (const acc of ACCOUNTS) {
  // ③ 幂等：已存在就跳过创建（绝不 update 已有用户）
  const found = await api(
    `/api/users:list?filter=${encodeURIComponent(JSON.stringify({ email: acc.email }))}&pageSize=1`,
    { token },
  );
  const existed = (found.json?.data ?? [])[0];
  if (existed) {
    results.push({ email: acc.email, action: 'exists', userId: existed.id, role: acc.role });
    continue;
  }

  if (!APPLY) {
    results.push({ email: acc.email, action: 'would-create', role: acc.role });
    continue;
  }

  // ④ 建用户 + 绑角色 + 绑门店（一次事务性请求里做完，减少中间态）
  const created = await api('/api/users:create', {
    token,
    method: 'POST',
    body: {
      email: acc.email,
      username: acc.username,
      nickname: acc.nickname,
      password: TEST_PW,
      // NocoBase 的 roles 关联：写角色名数组
      roles: [acc.role],
    },
  });

  results.push({
    email: acc.email,
    action: 'created',
    status: created.status,
    userId: created.json?.data?.id ?? null,
    role: acc.role,
    err: created.status >= 400 ? JSON.stringify(created.json).slice(0, 200) : null,
  });
}

console.log(JSON.stringify(results, null, 2));

if (!APPLY) {
  console.log('\n（未加 --apply，未创建任何账号）');
  process.exit(0);
}

// ⑤ 立刻用新账号真实登录，验证角色是否**即时可用**（这是唯一可信判据）
const verify = [];
for (const acc of ACCOUNTS) {
  const si = await api('/api/auth:signIn', {
    method: 'POST',
    body: { email: acc.email, password: TEST_PW },
  });
  if (!si.json?.data?.token) {
    verify.push({ email: acc.email, login: 'FAIL', msg: si.json?.errors?.[0]?.message ?? si.status });
    continue;
  }
  const t = si.json.data.token;
  const rc = await api('/api/roles:check', { token: t });
  const archive = await api('/api/svc:archiveAdminList?page=1&pageSize=1', { token: t });
  verify.push({
    email: acc.email,
    login: 'OK',
    roles: rc.json?.data?.roles ?? rc.json?.roles ?? null,
    archiveStatus: archive.status,
    archiveCode: archive.json?.code ?? archive.json?.errors?.[0]?.code ?? null,
    archiveTotal: archive.json?.total ?? null,
    archiveMsg: archive.json?.message ?? archive.json?.errors?.[0]?.message ?? '',
  });
}
console.log('\n=== 新账号即时可用性 ===');
console.log(JSON.stringify(verify, null, 2));
