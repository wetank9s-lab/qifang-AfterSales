/**
 * 迁移：历史归档的**门店身份确认名单**（P11-3 第 4 项 · 用户 D 条）
 * =============================================================================
 *
 * ===========================================================================
 * 为什么需要这个名单，以及它为什么**只放两家演练门店**
 * ===========================================================================
 * 用户原话：
 *   「归档时必须……**验证正式门店 code 与真实门店身份的确认关系**」
 *   「**因为当前 15 家门店 code 尚未全部核定，真实历史资料不得未经确认就正式归属。**」
 *   「允许使用**完全合成的测试文件、已验证授权的测试门店**进行端到端归档演练；
 *     不得为了让门禁转绿，偷偷把**真实 Excel 归到某个占位门店**。」
 *
 * ⇒ 名单里每一项都带 `scope`：
 *     · `scope: 'drill'`      —— 只接受**演练**归属（本次写的是 S01 / S02）；
 *     · `scope: 'production'` —— 才允许真实历史资料归属。
 *
 * 🔴 **本迁移一条 `production` 都不写。** 于是：
 *    · 真实七份门店 Excel **结构上无法**被归档到任何门店
 *      （`assertStoreConfirmed(code,'production')` 必然抛 409）；
 *    · 演练用的合成文件可以走通完整闭环。
 *   这不是纪律，是一条**走不通的路** —— 正是用户要的那种保证。
 *
 * ===========================================================================
 * 为什么是 S01 / S02
 * ===========================================================================
 * 它们是本项目**已核定授权的验收账号**所绑定的门店：
 *   · `UAT-A` (`uat.store.a@svc.local`) → **S01**
 *   · `UAT-B` (`uat.store.b@svc.local`) → **S02**
 * 即"已验证授权的测试门店"（用户允许的演练对象）。
 * 其余 13 家**一个都不在名单里** —— 包括那些真实 Excel 对应的门店。
 *
 * ⚠️ 名单写在 `service_settings`（现成的 key/value 表），**不新建表、不改 stores**：
 *    它是一份**配置**（"哪些门店的身份已被确认"），不是业务数据；
 *    而且将来用户逐家核定后，只需改这一条 key 的内容即可，
 *    不必写迁移、不必动门店行。
 */
import { Migration } from '@nocobase/database';

const SETTINGS = 'service_settings';
/** 与服务端 `services/historical-import/archive.ts` 的 `STORE_IDENTITY_KEY` **必须一致** */
const STORE_IDENTITY_KEY = 'historical.store-identity-confirmations';

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const log = {
      info: (m: string) => app?.log?.info?.(m),
      warn: (m: string) => app?.log?.warn?.(m),
    };
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[service-ticket/migration] 无法取得 db.sequelize —— 门店身份确认名单未落地');
    }

    const confirmedAt = new Date().toISOString();
    const payload = {
      note:
        '历史归档的"门店 code ↔ 真实门店身份"确认名单。' +
        'scope=production 才允许真实历史资料归属；当前**没有任何** production 条目。',
      stores: {
        S01: {
          code: 'S01',
          storeName: '圣大家电新都店',
          scope: 'drill',
          confirmedAt,
          confirmedBy: 'migration:20261012-historical-store-identity',
          evidence:
            '该门店绑定了已核定授权的验收账号 UAT-A（uat.store.a@svc.local）；' +
            '仅用于**合成文件**的归档闭环演练，不接受真实历史资料归属',
        },
        S02: {
          code: 'S02',
          storeName: '圣大家电青白江店',
          scope: 'drill',
          confirmedAt,
          confirmedBy: 'migration:20261012-historical-store-identity',
          evidence:
            '该门店绑定了已核定授权的验收账号 UAT-B（uat.store.b@svc.local）；' +
            '仅用于**合成文件**的归档闭环演练，不接受真实历史资料归属',
        },
      },
    };

    await sequelize.query(
      `INSERT INTO ${SETTINGS} (created_at, updated_at, key, value, value_type, description, updated_by)
       VALUES (now(), now(), $1, $2, 'json', $3, 'migration:20261012')
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      {
        bind: [
          STORE_IDENTITY_KEY,
          JSON.stringify(payload),
          '历史归档门店身份确认名单（P11-3 第 4 项 · 用户 D 条）',
        ],
      },
    );

    // ---- 自检：名单里的门店必须真实存在（否则演练会以"门店不存在"失败，误导排查）----
    //
    // ⚠️ **空库必须放行**。这条自检第一版是无条件执行的，于是在
    //    `verify-plugin-load.mjs` 的**离线脚手架**（空库、种子还没跑）上直接抛错：
    //    「确认名单里的门店 S01 在 stores 表里不是恰好 1 行（实得 0）」。
    //    这与 `202610105-store-official-profile` 的处理一致 ——
    //    迁移不该假设"种子已经跑过"，那是**执行顺序**而不是**数据正确性**。
    const [storeCountRows] = await sequelize.query(`SELECT count(*)::int AS n FROM stores`);
    const storeCount = Number((storeCountRows as any)?.[0]?.n ?? 0);
    if (storeCount === 0) {
      log.info?.(
        '[migration] stores 表为空（全新库/离线脚手架）—— 跳过门店存在性自检；' +
          '名单本身已落地，等种子跑完后即可用于归属校验',
      );
    } else {
      for (const code of Object.keys(payload.stores)) {
        const [rows] = await sequelize.query(`SELECT count(*)::int AS n FROM stores WHERE code = $1`, {
          bind: [code],
        });
        const n = Number((rows as any)?.[0]?.n ?? 0);
        if (n !== 1) {
          throw new Error(
            `[migration] 自检失败：确认名单里的门店 ${code} 在 stores 表里不是恰好 1 行（实得 ${n}）`,
          );
        }
      }
    }

    // ---- 自检：**不得**有任何 production 条目（这是本阶段最要紧的一条）----
    const productionCount = Object.values(payload.stores).filter((s: any) => s.scope === 'production').length;
    if (productionCount !== 0) {
      throw new Error(
        `[migration] 自检失败：本阶段**不得**存在 scope=production 的门店（实得 ${productionCount} 条）—— ` +
          '15 家门店 code 尚未全部核定，真实历史资料不得正式归属',
      );
    }

    log.info?.(
      `[migration] 历史归档门店身份名单已落地：${Object.keys(payload.stores).join('、')}` +
        '（全部 scope=drill，**0 条 production** ⇒ 真实历史资料无法被归档到任何门店）',
    );
  }
}
