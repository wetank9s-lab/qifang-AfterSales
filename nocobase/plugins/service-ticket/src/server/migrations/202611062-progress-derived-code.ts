import { Migration } from '@nocobase/database';

/**
 * BE-03-SMS-TEMPLATE-02-R1（方案 A4）：给 `service_tickets` 加**派生短码**两列。
 *
 * 背景（详见 `constants.ts` 的 `PROGRESS_DERIVE`）：
 *   客户「有新的处理进展」短信必须带一个**可用的** `/p/{code}`，但进度 Token 的明文
 *   只在建单那次请求里存在（库里只有 sha256），而 `mintForTicket()` 刻意不轮换。
 *   ⇒ 采用 HMAC 派生：`code = base64url(HMAC-SHA256(SIGN_SECRET, "progress-code|id|salt|epoch")[0..16])`。
 *
 * 两列各自的角色（**都不是凭据**）：
 *   · `progress_code_salt` —— 随机盐，明文可存。它只保证"同一张工单在两个库里不可互推"，
 *     真正的秘密是 `SIGN_SECRET`（production 缺失即拒绝启动，见 profile.ts ④）。
 *     注意与 `progress_token_hash` 的纪律**不冲突**：那条是"凭据只存哈希"，
 *     这条是"派生输入的非秘密部分"。
 *   · `progress_code_epoch` —— 默认 0（NOT NULL）。撤销这一族派生码 = +1，
 *     且**不影响** `progress_token_hash` 那一枚（A4 的 ①"原有码不失效"就是靠这个分开存）。
 *
 * 幂等：`ADD COLUMN IF NOT EXISTS`；`progress_code_epoch` 补默认值 + NOT NULL 也幂等。
 *
 * ⚠️ 为什么 epoch 必须 NOT NULL DEFAULT 0 而不是可空：
 *    可空会让"从未派生过"与"派生过但值丢失"无法区分，而两者在解析侧的处理**不同**
 *    （前者跳过、后者必须报警），合并成一个 NULL 就是把审计线索抹掉。
 *
 * ⚠️ `down()` 会删列 ⇒ 已发出的派生码全部失效（无法再重算）。
 *    这是**预期的**：派生码本来就可在任意时刻重新生成，不需要"救回数据"。
 *    但原始进度 Token（`progress_token_hash`）**不受影响**，历史链接继续可用。
 *
 * ⚠️ 索引**不归本 migration 管**（这是本轮踩到的一个真实坑，留档）：
 *    第一版 migration 里手写了一条 `CREATE INDEX i_service_tickets_progress_code_salt
 *    ... WHERE salt IS NOT NULL`，同时 `serviceTickets.ts` 的 `indexes: []` 里也声明了
 *    同一个字段 —— 结果库里出现**两条**语义重复的索引（一条 partial、一条普通），
 *    写入时双倍维护。
 *    实测证明：NocoBase 的 `db.sync()` 发生在 `afterLoad` migration **之前**，
 *    所以集合定义那条索引一定先存在，migration 里无论写不写 `IF NOT EXISTS`，
 *    都只会走"已存在"分支 —— 即那段代码是**永远执行不到的死代码**。
 *    ⇒ 已删除。索引所有权单一归 `serviceTickets.ts` 的 `indexes: []`。
 *    教训：同一件事在集合定义与 migration 里各写一遍 = 同一个坑有两条腿，
 *    而且其中一条（migration 的）因为执行顺序而**永远不会报警**。
 */
export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);

    await q(`ALTER TABLE service_tickets ADD COLUMN IF NOT EXISTS progress_code_salt varchar(32)`);

    await q(
      `ALTER TABLE service_tickets ADD COLUMN IF NOT EXISTS progress_code_epoch integer NOT NULL DEFAULT 0`,
    );

    // 既有行如果因为历史 DDL 落成 NULL，补成 0（幂等；正常情况 0 行受影响）
    await q(`UPDATE service_tickets SET progress_code_epoch = 0 WHERE progress_code_epoch IS NULL`);

    // 索引由 `serviceTickets.ts` 的 `indexes: []` 负责（db.sync 早于本 migration），
    // 此处刻意**不**建 —— 详见文件头注释。
  }

  async down(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    // 兜底删除第一版 migration 可能遗留的重复索引（幂等；新版库里不存在）
    await q(`DROP INDEX IF EXISTS i_service_tickets_progress_code_salt`);
    await q(`ALTER TABLE service_tickets DROP COLUMN IF EXISTS progress_code_epoch`);
    await q(`ALTER TABLE service_tickets DROP COLUMN IF EXISTS progress_code_salt`);
  }
}
