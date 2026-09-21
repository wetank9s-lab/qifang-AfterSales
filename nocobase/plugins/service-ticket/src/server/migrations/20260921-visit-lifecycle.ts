/**
 * 迁移：service_visits 增加**自身生命周期**字段（Phase 4-A）。
 *
 * 新增列：
 *   visit_status                  varchar(255) NOT NULL DEFAULT 'ASSIGNED'
 *   assigned_at                   timestamptz NULL
 *   reassigned_from_visit_id      bigint      NULL
 *   superseded_at                 timestamptz NULL
 *   superseded_reason             text        NULL
 *   token_revoked_at              timestamptz NULL
 *   token_revoked_reason          varchar(64) NULL
 * 新增索引：
 *   service_visits_visit_status
 *   service_visits_reassigned_from_visit_id
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么必须用迁移：`sync()` 会**补列**，但**不会回填数据**
 * ---------------------------------------------------------------------------
 * 本插件所有表都由 `defineCollection()` 声明、由 NocoBase 的 `db.sync()` 建表，
 * 而 NocoBase 的 `db.sync()` **默认就是增量同步**：
 *
 *   @nocobase/database/lib/database.js 的 Database 构造函数里写死了
 *     const opts = { sync: { alter: { drop: false }, force: false }, ...options };
 *
 * 也就是说它跑的是 `alter: { drop: false }` —— **会补列，只是不删列**。
 * 这一点在本迁移落地时被真机实测确认（2026-09-21）：重启后 7 个新列
 * 与 2 个新索引**在迁移执行之前**就已由 sync 建好，迁移日志显示"新增列 0 个"。
 *
 * ⚠️ 因此本文件里的 `ADD COLUMN IF NOT EXISTS` 段是**冗余保险**，不是主路径。
 *    它保留的理由：① 显式写清期望的列形态（类型/长度/默认值）；
 *    ② 若未来 NocoBase 改了 sync 的默认行为，这里是唯一的兜底。
 *
 * **真正的、不可被 sync 替代的价值是「数据回填」**，而这恰恰是 sync 做不到的：
 *   对既有实例，sync 加上 `visit_status NOT NULL DEFAULT 'ASSIGNED'` 时，
 *   PG 会把**所有历史行**（包括那些"师傅已提交""门店已确认"的）统统填成 `'ASSIGNED'`。
 *   那个值对它们而言是**错的**：一条已确认完工的 Visit 会被显示成"等待上门"，
 *   后台的待办列表里凭空多出一堆早就不该存在的任务。
 *
 *   所以回填条件**不能**写成 `WHERE visit_status IS NULL` —— sync 已经把它填满了，
 *   那个条件永远匹配不到任何行（本迁移的第一版就是这么写的，属于真缺陷：
 *   在有空 Visit 数据的实例上会静默地一行都不修）。正确写法见下面的
 *   「按历史字段**推导并纠正**」：只在历史字段能证明"阶段比 ASSIGNED 更靠后"时才推进。
 *
 * ---------------------------------------------------------------------------
 * 两条执行路径必须收敛到同一结果
 * ---------------------------------------------------------------------------
 *   路径 A 全新实例：sync 按 collection 定义建列建索引 → 本迁移的 DDL 段全部 no-op，
 *                    回填段因为没有任何行而 no-op。
 *   路径 B 既有实例：sync 补列（历史行被 DEFAULT 填成 ASSIGNED）→
 *                    由本迁移的**回填段**把值纠正成真实阶段。
 *
 * 这也是本迁移刻意**不用** `ADD COLUMN ... NOT NULL DEFAULT` 一步到位的原因：
 * 那一步在老实例上就是上面说的错误来源，必须"先加空列 → 再回填 → 最后收紧约束"。
 * 但要诚实说明：**这条顺序在纯声明式路线下做不到**（sync 会先用 DEFAULT 填满），
 * 所以本迁移的回填段必须写成"可纠正已填错值"的形态，而不是"填空值"的形态。
 *
 * 命名必须与 NocoBase 生成的完全一致（否则在新装实例上会建出**重复索引**）：
 *   真机取证（2026-09-21）：service_visits 上现有索引名为
 *     service_visits_ticket_id / service_visits_technician_mobile /
 *     service_visits_store_confirm_status / service_visits_ticket_id_visit_no …
 *   即 `<表名>_<列名>`（复合列用下划线连接）。
 *   同时确认：NocoBase **不会**为 belongsTo 建 FK 约束（只有列 + 索引），
 *   所以这里也只建索引，不建外键 —— 与既有表结构保持同构。
 *
 * 失败语义：**抛出**。被 umzug 记为完成的迁移若静默失败，这些列将永远不存在，
 *   且不会有第二次机会（与另外两个迁移的策略一致）。
 */
import { Migration } from '@nocobase/database';

/** 表名（本插件全表 underscored: true，见 collections/_helpers.ts） */
const TABLE = 'service_visits';

/**
 * 新增列定义。
 *
 * 类型与既有列**逐一对齐**（真机 information_schema 取证）：
 *   string(length)      → varchar(length)；无 length 的 string → varchar(255)
 *   text                → text
 *   date                → timestamp with time zone
 *   belongsTo           → bigint
 */
const NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  // 先以可空形态加入：老实例的历史行需要回填，不能一上来就 NOT NULL
  { name: 'visit_status', ddl: 'varchar(255)' },
  { name: 'assigned_at', ddl: 'timestamp with time zone' },
  { name: 'reassigned_from_visit_id', ddl: 'bigint' },
  { name: 'superseded_at', ddl: 'timestamp with time zone' },
  { name: 'superseded_reason', ddl: 'text' },
  { name: 'token_revoked_at', ddl: 'timestamp with time zone' },
  { name: 'token_revoked_reason', ddl: 'varchar(64)' },
];

/**
 * 索引定义。名字与列名一致，与 NocoBase 的生成规则逐字对齐。
 * 复合/唯一索引**不在**这里补：唯一的 `(ticket_id, visit_no)` 与字段级
 * `access_token_hash` 唯一约束都是 Phase 2 就已落库的，无需重建。
 */
const NEW_INDEXES: Array<{ name: string; columns: string }> = [
  { name: `${TABLE}_visit_status`, columns: 'visit_status' },
  { name: `${TABLE}_reassigned_from_visit_id`, columns: 'reassigned_from_visit_id' },
];

export default class extends Migration {
  /** 表已建好、插件已加载完毕之后执行（与另两个迁移一致） */
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
      throw new Error(
        '[service-ticket/migration] 无法取得 db.sequelize（迁移上下文不完整），' +
          'service_visits 生命周期字段未补写',
      );
    }

    // ⚠️ 这里**刻意不**做"表是否存在"的预检（如 to_regclass）。
    //
    //   第一版写过，结果是离线校验出现**假红灯**：桩环境的 sequelize.query 返回的是
    //   扁平数组，而真实 sequelize 返回的是 `[rows, metadata]` 元组，于是
    //   `const [regRows] = ...` 在桩里拿到的是一个表描述对象而非行数组，
    //   预检恒判"表不存在"并抛错。真机全绿、离线恒红 —— 正是"会误报的检查比没有检查更糟"。
    //
    //   去掉它的理由不止于假红灯：这条预检**本来就是冗余的**。
    //     · 离线校验（verify-plugin-load.mjs）已经对**每个**迁移断言
    //       `instance.on === 'afterLoad'`，即"表建好之后才跑"这条前提已被守住；
    //     · 万一表真的不存在，下面的 `ALTER TABLE` 会自己抛
    //       `42P01 relation "service_visits" does not exist` —— 报错同样清晰，
    //       而且不需要多一次查询、也不依赖驱动返回形状。
    //   一句话：不要为了"更早报错"去引入一个依赖驱动细节的探针。

    let addedColumns = 0;
    let backfilled = 0;

    try {
      // 整个迁移放在一个事务里：PG 的 DDL 是事务性的，
      // 中途失败必须整体回滚 —— 半个生命周期字段比完全没有更难排障。
      //
      // 宿主没有 sequelize.transaction 时（离线桩环境）退化为"直接执行、不传事务"，
      // 与 TicketService.withTransaction 的既有约定**完全一致**。
      // 真机上 db.sequelize 必然有 transaction，所以生产路径永远是带事务的；
      // 这里退化的唯一目的是让迁移能被离线校验独立执行 —— 那条校验正是
      // "迁移写过但跑不起来"的唯一拦截点，不能因为桩不完整就放弃它。
      await runInTransaction(sequelize, async (transaction: any) => {
        // ---- 1) 补列（老实例真正生效，新实例 no-op） ----
        for (const column of NEW_COLUMNS) {
          const [before] = await sequelize.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = $1 AND column_name = $2`,
            { bind: [TABLE, column.name], transaction },
          );
          const existed = Array.isArray(before) && before.length > 0;

          await sequelize.query(
            `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${column.name} ${column.ddl}`,
            { transaction },
          );
          if (!existed) addedColumns += 1;
        }

        // ---- 2) 回填并**纠正** visit_status（绝不覆盖已推进到更后阶段的行） ----
        //
        // 映射依据 docs/STATE-MACHINE.md §「Visit 生命周期」：
        //   store_confirm_status='confirmed'  → CONFIRMED
        //   store_confirm_status='rejected'   → REJECTED
        //   已提交回执（submitted_at 非空）    → SUBMITTED
        //   其余（含尚无回执的新派工）         → ASSIGNED
        //
        // WHERE 的两个分支都是必需的：
        //   ① `visit_status IS NULL` —— 老列由本迁移的 DDL 段（而非 sync）加出来的情形；
        //   ② `visit_status='ASSIGNED' 且历史字段显示阶段更靠后` —— **主要路径**：
        //      sync 已经用 DEFAULT 'ASSIGNED' 把所有历史行填满了，只有这个分支能纠正它。
        //
        // 安全性：② 只会把 ASSIGNED **推进**到 CASE 的结果，且必须先有历史字段作证；
        //   已经处于 SUBMITTED / CONFIRMED / REJECTED / SUPERSEDED / CANCELLED 的行
        //   一律不匹配（前三个靠 visit_status 本身排除，后两个同理）——
        //   即本语句**永远不会把一个已完成的 Visit 退回**。
        //
        // 幂等：重复执行时 CASE 结果与现值相同，UPDATE 等价于空操作。
        //
        // 判据顺序不可交换：门店确认/驳回是终态，必须先判；否则一条
        //   "已确认"的历史 Visit 会因为 submitted_at 非空而被回填成 SUBMITTED，
        //   丢掉"门店已审"这一事实。
        const [backfillResult] = await sequelize.query(
          `UPDATE ${TABLE}
              SET visit_status = CASE
                    WHEN store_confirm_status = 'confirmed' THEN 'CONFIRMED'
                    WHEN store_confirm_status = 'rejected'  THEN 'REJECTED'
                    WHEN submitted_at IS NOT NULL           THEN 'SUBMITTED'
                    ELSE 'ASSIGNED'
                  END
            WHERE visit_status IS NULL
               OR (
                    visit_status = 'ASSIGNED'
                AND (store_confirm_status <> 'pending' OR submitted_at IS NOT NULL)
                  )
            RETURNING 1`,
          { transaction },
        );
        // 行数**由 RETURNING 自己数**，不看驱动返回的 metadata。
        // 实测（2026-09-21）sequelize 对 PG 的 UPDATE 经 `query()` 取到的第一段不是行数，
        // 靠 metadata 猜会恒得 -1，日志里就成了没信息的"回填 历史行"。
        // RETURNING 是 PG 的强项，用它既准确又与方言无关。
        backfilled = Array.isArray(backfillResult) ? backfillResult.length : -1;

        // ---- 3) 回填 assigned_at ----
        //
        // 语义是"本次派工产生的时刻"。对历史行，Visit 行的创建时间就是它 ——
        // 没有更准的近似（Ticket.dispatch_at 只有首次派工那一次）。
        await sequelize.query(
          `UPDATE ${TABLE} SET assigned_at = created_at WHERE assigned_at IS NULL`,
          { transaction },
        );

        // ---- 4) 收紧约束（顺序必须是"回填之后再 NOT NULL"） ----
        await sequelize.query(
          `ALTER TABLE ${TABLE} ALTER COLUMN visit_status SET DEFAULT 'ASSIGNED'`,
          { transaction },
        );
        await sequelize.query(
          `ALTER TABLE ${TABLE} ALTER COLUMN visit_status SET NOT NULL`,
          { transaction },
        );

        // ---- 5) 补索引 ----
        for (const index of NEW_INDEXES) {
          await sequelize.query(
            `CREATE INDEX IF NOT EXISTS ${index.name} ON ${TABLE} (${index.columns})`,
            { transaction },
          );
        }

        // ---- 6) 残留检查：收紧后仍为空说明回填漏了行，必须让它响 ----
        //
        // 这一步是刻意的自我校验：如果 CASE 分支有遗漏（比如历史数据里
        // store_confirm_status 出现了映射表之外的值），这里会立刻暴露，
        // 而不是等到某个后台页面渲染出一片空白状态才发现。
        const [nullRows] = await sequelize.query(
          `SELECT count(*)::int AS n FROM ${TABLE} WHERE visit_status IS NULL`,
          { transaction },
        );
        const rawCount = Array.isArray(nullRows) ? Number((nullRows[0] as any)?.n) : NaN;
        // 取不到就当 0，且**不把 NaN 当成已知值**：`Number(undefined) ?? 0` 得到的是 NaN
        // （NaN 不是 nullish），写错会让 `NaN > 0` 恒假、这条自检变成装饰。
        const nullCount = Number.isFinite(rawCount) ? rawCount : 0;
        if (nullCount > 0) {
          throw new Error(
            `仍有 ${nullCount} 行 visit_status 为空 —— 回填的 CASE 分支未覆盖全部历史数据，` +
              '请核对 store_confirm_status 的实际取值',
          );
        }
      });

      log.info(
        `[service-ticket] service_visits 生命周期迁移完成：新增列 ${addedColumns} 个` +
          `（已存在的不重复添加），回填/纠正 visit_status ${backfilled} 行` +
          `（sync 会把历史行一律填成 ASSIGNED，此处按历史字段纠正）` +
          `，索引 ${NEW_INDEXES.length} 条已就绪`,
      );
    } catch (error) {
      throw new Error(
        `[service-ticket/migration] service_visits 生命周期字段补写失败：${(error as Error)?.message}。` +
          '该迁移尚未被记为完成，修复后重启即可重跑',
      );
    }
  }
}

/**
 * 在事务里执行；宿主没有 `sequelize.transaction` 时退化为直接执行。
 *
 * 为什么允许退化（而不是"没有事务就报错"）：
 *   离线校验 `verify-plugin-load.mjs` 会**真的调用每个迁移的 up()**，
 *   它用的桩没有实现 transaction。若这里硬报错，就会出现
 *   "离线恒红、真机全绿"的假红灯 —— 而那条校验恰恰是
 *   "迁移写出来了却根本跑不起来"的唯一拦截点，绝不能因为桩不完整而失效。
 *
 *   这不是放松要求：真机路径上 `db.sequelize.transaction` 必然存在
 *   （NocoBase 的 Database 封装了 sequelize），所以**生产永远走事务分支**。
 *   同样的取舍在 services/ticket-service.ts 的 withTransaction 里已经做过一次，
 *   此处沿用同一约定，避免两处对"桩环境怎么办"给出不同答案。
 */
async function runInTransaction<T>(
  sequelize: any,
  fn: (transaction: unknown) => Promise<T>,
): Promise<T> {
  if (typeof sequelize.transaction !== 'function') {
    return fn(undefined);
  }
  return sequelize.transaction(fn);
}
