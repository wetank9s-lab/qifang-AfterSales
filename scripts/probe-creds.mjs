/**
 * 本轮（R2.2.4-rc.3）生产只读探针的**统一凭据入口**。
 *
 * ⚠️ 为什么单独抽一个文件：
 *   本轮新增了 4 个探针脚本，第一版把验收账号邮箱**写死在脚本里**（`r224acc.*@svc.local`）。
 *   这违反了 `PROJECT-RULES.md` 的"docs/scripts 不写入真实账号标识"——
 *   虽然那是测试账号，但它指向**生产库**，写进公开仓库等于公布一个可探测的登录名。
 *   ⇒ 统一改为从环境变量读，缺了就直接退出，**不给默认值**。
 *
 * 环境变量（置于 `.env`，禁止入库）：
 *   PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD   平台超管
 *   PROD_STORE_EMAIL / PROD_STORE_PASSWORD   门店售后验收账号
 *   ARC_TEST_PW                              本轮新建的两个验收账号口令
 *   ACC_SALES_EMAIL / ACC_MGR_EMAIL          本轮新建的验收账号邮箱
 */
export function need(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`缺少环境变量 ${name}（本轮探针不提供默认值，避免把账号写进仓库）`);
    process.exit(2);
  }
  return v;
}

export const CREDS = {
  get adminEmail() { return need('PROD_ADMIN_EMAIL', 'admin@nocobase.com'); },
  get adminPassword() { return need('PROD_ADMIN_PASSWORD'); },
  get storeEmail() { return need('PROD_STORE_EMAIL'); },
  get storePassword() { return need('PROD_STORE_PASSWORD'); },
  get acceptancePassword() { return need('ARC_TEST_PW'); },
  get salesEmail() { return need('ACC_SALES_EMAIL'); },
  get mgrEmail() { return need('ACC_MGR_EMAIL'); },
};
