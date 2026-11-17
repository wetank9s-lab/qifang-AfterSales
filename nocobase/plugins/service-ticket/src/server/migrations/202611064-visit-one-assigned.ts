import { Migration } from '@nocobase/database';

/**
 * DEV-208：`service_visits` 同一工单**至多一条 ASSIGNED**（数据库级互斥）。
 *
 * =============================================================================
 * 为什么要一个数据库级约束，而不是"在 dispatch 里再查一次"
 * =============================================================================
 *
 * 2026-11-06 DEV-207 并发验收（`dev207-concurrency.test.mjs` D 组）实测：
 * 同一张工单**同时**发出两个 `POST /api/svc:dispatch`，两个都返回 **200**，
 * 库里产生两条 `visit_no=1 / visit_no=2` 且**都是 `ASSIGNED`** 的 Visit。
 *
 * 根因是 `TicketService.dispatch()` 里的**先查后写**：
 *
 * ```
 *   const active = await this.visits.findActiveByTicket(id, transaction);  // ← 读
 *   if (active) throw StateConflictError('VISIT_ALREADY_ASSIGNED');        // ← 判
 *   … create visit …                                                       // ← 写
 * ```
 *
 * 两个并发事务在 READ COMMITTED 下**都查不到**对方的未提交行 ⇒ 都通过守卫 ⇒ 都插入。
 * 而 `conditionalUpdate()` 的 `WHERE status = ANY(...)` 拦不住它：
 * 两个事务都看到工单还是 `new`，两边的 `UPDATE service_tickets` 都命中 1 行。
 *
 * ⚠️ 这段代码**自己就看得出问题**：`findActiveByTicket()` 在发现多于一条时打的是
 *    「说明有代码绕过 VisitService 直接写库」—— 但它正是那段绕过的代码。
 *
 * =============================================================================
 * 🔴 为什么最终用**触发器**而不是唯一索引（这一版是第二次尝试）
 * =============================================================================
 *
 * 第一版用的是部分唯一索引 `UNIQUE (ticket_id) WHERE visit_status='ASSIGNED'`。
 * 迁移里建得好好的、自检也过了，但**容器一重启就消失**。
 *
 * 原因在 `@nocoBase/database` 的 `sync-runner.js` → `handleUniqueIndex()`：
 * 它列出表上**所有单字段唯一索引**，只要对应属性没声明 `unique: true` 就
 * `removeIndex()` 删掉。而我的索引恰好是**单字段**（`ticket_id`），
 * 也没法在 collection 里声明（`indexes: []` 不支持 `WHERE` 谓词，
 * 声明成普通唯一索引又会**禁止改派** —— 改派要保留旧 Visit）。
 *
 * ⇒ 结论：**凡单字段唯一索引，NocoBase 都要自己管**，插件不能偷偷建一个。
 *    多字段唯一索引不受影响（`if (!isSingleField) continue`），
 *    但 `(ticket_id, x)` 这种形状表达不了"至多一条 ASSIGNED"。
 *
 * ⇒ 改用 **BEFORE INSERT OR UPDATE 触发器**：`pg_trigger` 不在 sync-runner
 *    的视野里，跨重启存活，且能在**插入那一刻**拒绝第二条 ASSIGNED。
 *
 * ⚠️ 顺带发现的一个更隐蔽的问题（第一版的实际事故）：
 *    "迁移发现数据有问题就跳过建索引"这个设计，配合 `migrations` 表的
 *    "已执行不再跑"语义，会产生**永久静默缺失**——索引不存在，但日志说
 *    "按预期未创建"，而迁移已经登记为完成、再也不会重试。
 *    ⇒ 本版的做法：**每次都尝试建**，用 `CREATE OR REPLACE` 语义；
 *      发现历史重复时**照样建**，但把冲突明细打出来。
 *      重复行不会让触发器创建失败（触发只对**新写入**生效），
 *      所以"历史脏数据"与"拦住新脏数据"可以并存 —— 这正是这次该有的行为。
 *
 * 幂等：`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` 再建。
 * `down()` 删触发器与函数；**不删历史数据**。
 */
export default class extends Migration {
  on = 'afterLoad';

  /** 触发器与函数名（唯一属主是本迁移，collection 定义里不得再声明同类东西） */
  static readonly TRIGGER = 'trg_service_visits_one_assigned';
  static readonly FUNC = 'svc_visits_one_assigned_guard';

  async up(): Promise<void> {
    const q = (sqlText: string) => this.db.sequelize.query(sqlText);

    // ---- ① 建守卫函数 ----
    //
    // 语义：**将要**插入/更新为 ASSIGNED 的行，若同 ticket 已存在另一条 ASSIGNED，
    // 则抛 unique_violation（23505）。选 23505 而不是自定义错误码，是为了让
    // 应用层的 `isUniqueViolation` 分支**继续有效** —— 应用只需要认一种错。
    //
    // ⚠️ `v.id <> NEW.id` 这个条件不能省：UPDATE 把一条已经是 ASSIGNED 的行
    //    再写一次（比如改预约时间）时，它**自己**就是那条 ASSIGNED，
    //    不加排除会让所有对 ASSIGNED 行的更新全部失败。
    //
    // ⚠️ `FOR UPDATE` 不是必须的（INSERT 的并发由唯一性冲突决定），但加上它能
    //    让两个并发事务在**同一行**上串行，避免"都插进去"的窗口 —— 这里用
    //    `PERFORM ... LIMIT 1` 就够了：触发器的 `RAISE` 本身回滚整个语句。
    await q(`
      CREATE OR REPLACE FUNCTION ${(this.constructor as any).FUNC}()
      RETURNS trigger AS $$
      DECLARE
        conflict_id integer;
      BEGIN
        IF NEW.visit_status <> 'ASSIGNED' THEN
          RETURN NEW;
        END IF;

        SELECT v.id INTO conflict_id
          FROM service_visits v
         WHERE v.ticket_id = NEW.ticket_id
           AND v.visit_status = 'ASSIGNED'
           AND v.id <> COALESCE(NEW.id, -1)
         LIMIT 1;

        IF conflict_id IS NOT NULL THEN
          RAISE EXCEPTION
            'ticket % already has ASSIGNED visit % (uq_service_visits_one_assigned)',
            NEW.ticket_id, conflict_id
            USING ERRCODE = '23505',
                  CONSTRAINT = 'uq_service_visits_one_assigned';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---- ② 挂触发器 ----
    //
    // `BEFORE INSERT OR UPDATE`：必须在写入**之前**拦，`AFTER` 时会话已经脏了。
    // 先 DROP 再 CREATE 是为了"改了函数体也能重挂"（`CREATE TRIGGER IF NOT EXISTS`
    // 会在触发器已存在时静默跳过，导致迁移改了逻辑却不生效 —— 又一个静默漂移）。
    await q(`DROP TRIGGER IF EXISTS ${(this.constructor as any).TRIGGER} ON service_visits`);
    await q(`
      CREATE TRIGGER ${(this.constructor as any).TRIGGER}
        BEFORE INSERT OR UPDATE OF visit_status, ticket_id ON service_visits
        FOR EACH ROW
        EXECUTE FUNCTION ${(this.constructor as any).FUNC}()
    `);

    // ---- ③ 留痕：历史重复（不阻止建触发器，只报出来）----
    const [dupRows] = (await q(`
      SELECT ticket_id,
             count(*)::int AS n,
             string_agg(id::text, ',' ORDER BY id) AS visit_ids
        FROM service_visits
       WHERE visit_status = 'ASSIGNED'
       GROUP BY ticket_id
      HAVING count(*) > 1
       ORDER BY ticket_id
       LIMIT 20
    `)) as unknown as [Array<{ ticket_id: string; n: number; visit_ids: string }>];
    const dups = Array.isArray(dupRows) ? dupRows : [];
    if (dups.length > 0) {
      console.log(
        `[migration 202611064] ⚠️ 历史数据：${dups.length} 张工单已存在多条 ASSIGNED 的 Visit` +
          '（触发器**已建**，只拦截新写入；历史行需人工处置）：',
      );
      for (const r of dups) {
        console.log(
          `[migration 202611064]   ticket=${r.ticket_id} 条数=${r.n} visit_ids=[${r.visit_ids}]`,
        );
      }
    }

    // ---- ④ 自检：触发器真的在吗（防"以为建了"）----
    const [chk] = (await q(`
      SELECT count(*)::int AS n
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'service_visits'
         AND t.tgname = '${(this.constructor as any).TRIGGER}'
         AND NOT t.tgisinternal
    `)) as unknown as [Array<{ n: number }>];
    const present = Array.isArray(chk) && Number(chk[0]?.n) > 0;
    console.log(
      `[migration 202611064] 触发器自检：${present ? '存在（BEFORE INSERT OR UPDATE）' : '★缺失（应当已创建！）'}`,
    );
  }

  async down(): Promise<void> {
    const q = (sqlText: string) => this.db.sequelize.query(sqlText);
    await q(`DROP TRIGGER IF EXISTS ${(this.constructor as any).TRIGGER} ON service_visits`);
    await q(`DROP FUNCTION IF EXISTS ${(this.constructor as any).FUNC}()`);
    // 兼容第一版留下的部分唯一索引（若曾被手工建过）
    await q(`DROP INDEX IF EXISTS uq_service_visits_one_assigned`);
  }
}
