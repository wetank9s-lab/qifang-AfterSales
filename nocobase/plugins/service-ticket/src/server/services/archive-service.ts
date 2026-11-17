import {
  ARCHIVE_EVENT_TYPE,
  ARCHIVE_HQ_READ_ROLES,
  ARCHIVE_READ_ROLES,
  ARCHIVE_SERVICE_PHOTO_REQUIRED_TYPES,
  ARCHIVE_STAGE_CODE,
  ARCHIVE_STAGE_ORDER,
  ARCHIVE_STATUS,
  ARCHIVE_TYPE,
  ARCHIVE_VISIBILITY,
  ARCHIVE_WRITE_ROLES,
  ROLE,
  type RoleName,
} from '../constants';
import type { Actor } from './permission-service';

/**
 * ArchiveService —— 服务档案的**唯一写入口**（ARC-V1 / A2·A3）
 *
 * 三条设计原则，都对应执行令里的硬要求：
 *
 * 1. **能力与范围都在服务端判**（不是页面判）。
 *    `assertCanWrite` 先看角色，再看"这条档案的门店是否落在 actor 的授权门店内"。
 *    页面隐藏按钮只影响体验，不影响边界。
 *
 * 2. **完成规则不是"必填校验"，是业务判定**。
 *    "普通服务完工必须有前后照片" 这条，前端标 required 是无效的 ——
 *    一次 `update {status:'completed'}` 就能绕过。所以它写在 `complete()` 里，
 *    并且**读的是照片表里真实存在的行**，不是请求体里声明的数量。
 *
 * 3. **并发用 version 乐观锁**，不用 `updated_at` 比较。
 *    同一秒内的两次写入 `updated_at` 可能相等 ⇒ 后者静默覆盖前者，
 *    而档案里丢的是照片和阶段进度，事后无法从日志还原。
 */

export interface ArchiveActorLike extends Actor {
  roles: RoleName[];
  storeIds: number[];
}

export class ArchiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export class ArchiveService {
  constructor(
    private readonly db: any,
    private readonly logger?: { warn?: (m: string) => void; info?: (m: string) => void },
  ) {}

  private repo(name: string) {
    return this.db.getRepository(name);
  }

  /**
   * 读某一行的**已提交**版本（绕过调用方可能持有的未提交事务）。
   *
   * 为什么需要：幂等冲突的落败方在**自己的**事务里查“先到者”，
   * 而先到者的 INSERT 此刻还在它自己的事务里、尚未提交 ——
   * 用同一个连接（或同一个事务）去查，读到的是 `null`，于是落败方会以为
   * “记录被删了”，把一次本该回放的请求报成 409/500。
   *
   * `transaction: null` 让 ORM 走连接池里的另一条连接，在 READ COMMITTED 下
   * 该连接看不见未提交的写；等先到者 commit 之后重查才拿得到。
   * 拿不到 `sequelize` 时退回普通读（行为与旧版一致，不会更差）。
   */
  async loadCommittedRow(table: string, filter: Record<string, unknown>): Promise<any | null> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      return this.repo(table).findOne({ filter });
    }
    // 独立事务、立即提交：只用于把“新连接”的语义讲清楚，不承载任何业务写入
    return sequelize.transaction(async (t: any) =>
      this.repo(table).findOne({ filter, transaction: t }),
    );
  }

  // -------------------------------------------------------------------------
  // 鉴权
  // -------------------------------------------------------------------------

  /** 是否具备写档案的能力（角色层）。门店负责人 / 总部角色 / viewer 都不在列。 */
  canWrite(actor: ArchiveActorLike): boolean {
    return actor.roles.some((r) => ARCHIVE_WRITE_ROLES.includes(r));
  }

  canRead(actor: ArchiveActorLike): boolean {
    return actor.roles.some((r) => ARCHIVE_READ_ROLES.includes(r));
  }

  assertCanRead(actor: ArchiveActorLike): void {
    if (!this.canRead(actor)) {
      throw new ArchiveError('ARCHIVE_FORBIDDEN', '当前角色无档案访问权限', 403);
    }
  }

  /**
   * 写权限 + 门店归属。
   *
   * ⚠️ 顺序刻意是"先能力、再归属"：
   *    `store_manager` 调写接口应当是明确的 **403 没权限**，
   *    而不是"这条档案不存在"（404）—— 后者会让负责人以为数据被删了，
   *    也会把"权限不足"和"越权探测"混在一起，日志上无法区分。
   */
  assertCanWriteStore(actor: ArchiveActorLike, storeId: number): void {
    if (!this.canWrite(actor)) {
      throw new ArchiveError('ARCHIVE_FORBIDDEN', '当前角色无档案写入权限（只读或非门店销售）', 403);
    }
    if (!Number.isFinite(storeId) || storeId <= 0) {
      throw new ArchiveError('ARCHIVE_BAD_STORE', '门店无效', 400);
    }
    if (!actor.storeIds.includes(storeId)) {
      // 越权与不存在统一 404，避免探测别家门店是否存在
      throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    }
  }

  /** 读单条时的归属校验（总部角色放行，但仅跨店只读） */
  assertCanAccessRow(actor: ArchiveActorLike, row: any): void {
    this.assertCanRead(actor);
    if (actor.roles.some((r) => ARCHIVE_HQ_READ_ROLES.includes(r))) return;
    if (!actor.storeIds.includes(Number(row.store_id))) {
      throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    }
  }

  // -------------------------------------------------------------------------
  // 档案号
  // -------------------------------------------------------------------------

  /**
   * 档案号 `DA-YYYYMMDD-XXXX`。
   *
   * 用"当天最大序号 + 1"，并靠 `archive_no` 的唯一索引兜底撞号（并发下重试一次）。
   * 不引入额外序列表：档案量级远小于工单，一张唯一索引足够。
   */
  private async nextArchiveNo(now = new Date()): Promise<string> {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const prefix = `DA-${y}${m}${d}-`;

    const rows = await this.repo('serviceArchives').find({
      filter: { archive_no: { $like: `${prefix}%` } },
      fields: ['archive_no'],
      sort: ['-archive_no'],
      limit: 1,
    });
    const last = rows?.[0]?.archive_no ?? '';
    const seq = last.startsWith(prefix) ? Number(last.slice(prefix.length)) || 0 : 0;
    return prefix + String(seq + 1).padStart(4, '0');
  }

  // -------------------------------------------------------------------------
  // 创建
  // -------------------------------------------------------------------------

  async create(
    actor: ArchiveActorLike,
    input: {
      archive_type: string;
      store_id: number;
      customer_name: string;
      customer_mobile: string;
      service_address: string;
      service_type?: string | null;
      product_description?: string | null;
      package_description?: string | null;
      purchase_date?: string | null;
      planned_date?: string | null;
      assigned_worker?: string | null;
      notes?: string | null;
      public_note?: string | null;
      sales_user_id?: number | null;
    },
    /**
     * 事务（可选）。传入时**档案行、暖通阶段行、创建事件**全部在这个事务里写，
     * 由调用方（`svc:archiveCreate`）连同幂等记录一起提交/回滚。
     *
     * 为什么必须能传：幂等记录与业务写入必须同生共死。
     * 分开写的话，任一侧失败都会留下“有业务没幂等”（重放会多建一张）或
     * “有幂等没业务”（真正的重试被误判成重放、调用方永远拿不到那张档案）。
     */
    transaction?: any,
  ): Promise<any> {
    this.assertCanWriteStore(actor, Number(input.store_id));

    const type = String(input.archive_type ?? '');
    if (type !== ARCHIVE_TYPE.SERVICE && type !== ARCHIVE_TYPE.HVAC) {
      throw new ArchiveError('ARCHIVE_BAD_TYPE', '档案类型必须是 service 或 hvac', 400);
    }
    // 必填按**业务契约**判，不因为"数据库列允许 NULL"就跳过
    for (const [key, label] of [
      ['customer_name', '客户姓名'],
      ['customer_mobile', '客户手机号'],
      ['service_address', '服务地址'],
    ] as const) {
      const v = input[key];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new ArchiveError('ARCHIVE_MISSING_FIELD', `${label}为必填`, 400);
      }
    }
    const mobile = String(input.customer_mobile).trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new ArchiveError('ARCHIVE_BAD_MOBILE', '手机号格式不正确', 400);
    }
    // 暖通不使用 service_type；上门服务必须有服务类型
    let serviceType: string | null = null;
    if (type === ARCHIVE_TYPE.SERVICE) {
      serviceType = input.service_type ? String(input.service_type) : null;
      if (!serviceType) {
        throw new ArchiveError('ARCHIVE_MISSING_FIELD', '上门服务必须选择服务类型', 400);
      }
    }

    const archiveNo = await this.nextArchiveNo();
    const row = await this.repo('serviceArchives').create({
      values: {
        archive_no: archiveNo,
        store_id: Number(input.store_id),
        archive_type: type,
        customer_name: String(input.customer_name).trim(),
        customer_mobile: mobile,
        service_address: String(input.service_address).trim(),
        service_type: serviceType,
        product_description: input.product_description ?? null,
        package_description: input.package_description ?? null,
        purchase_date: input.purchase_date ?? null,
        planned_date: input.planned_date ?? null,
        assigned_worker: input.assigned_worker ?? null,
        notes: input.notes ?? null,
        public_note: input.public_note ?? null,
        sales_user_id: input.sales_user_id ?? actor.userId ?? null,
        status: ARCHIVE_STATUS.PENDING,
        visibility: ARCHIVE_VISIBILITY.DRAFT,
        version: 1,
        created_by: actor.userId ?? null,
        updated_by: actor.userId ?? null,
      },
      ...(transaction ? { transaction } : {}),
    });

    // 暖通：建档案时**一次性写入六行**阶段，顺序固定。
    // 只有六行都在，"跳过阶段"才能被检出（缺行 ≠ 未做）。
    if (type === ARCHIVE_TYPE.HVAC) {
      for (let i = 0; i < ARCHIVE_STAGE_ORDER.length; i += 1) {
        await this.repo('serviceArchiveStages').create({
          values: {
            archive_id: row.id,
            stage_code: ARCHIVE_STAGE_ORDER[i],
            stage_order: i + 1,
            status: 'pending',
            version: 1,
          },
          ...(transaction ? { transaction } : {}),
        });
      }
    }

    await this.writeEvent(
      actor,
      row.id,
      null,
      'archive_created',
      {
        archive_type: type,
        // ⚠️ 事件里**不写手机号明文**（执行令：审计不得含客户手机号）
      },
      transaction,
    );

    return row;
  }

  // -------------------------------------------------------------------------
  // 更新（乐观锁）
  // -------------------------------------------------------------------------

  async update(
    actor: ArchiveActorLike,
    archiveId: number,
    patch: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<any> {
    const existing = await this.mustLoad(archiveId);
    this.assertCanWriteStore(actor, Number(existing.store_id));

    if (String(existing.visibility) === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能继续编辑', 409);
    }
    if (Number(expectedVersion) !== Number(existing.version)) {
      // ⚠️ 这条文案会**原样显示给一线用户**，不要写"请刷新"。
      //
      //    2026-11-10 A5-D 实测：原先写的是「该档案已被其他人修改，请刷新后重试
      //    （你的修改未保存）」。问题有两层：
      //      · "请刷新"是**最危险的建议** —— 用户一刷新，正在填的表单就没了，
      //        而这条 409 恰恰发生在"内容还在、只是没存上"的时刻；
      //      · 只说"修改未保存"不说"内容还在"，用户会以为白填了，急着重新输入。
      //    服务端文案会覆盖前端 Alert 的描述文字（见 archive-edit-block 的 saveError 拼装），
      //    所以**这里才是最终生效的那一句**，前端那套只是标题。
      throw new ArchiveError(
        'ARCHIVE_STALE',
        '数据已更新，本次修改未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    // 白名单：只允许改这些列。status / visibility / store_id / archive_no
    // **不在此列** —— 它们各有专用 action，防止一条 update 改掉状态或把档案挪到别家。
    const allowed = [
      'customer_name', 'customer_mobile', 'service_address',
      'product_description', 'package_description',
      'purchase_date', 'planned_date', 'service_type',
      'assigned_worker', 'notes', 'public_note',
    ] as const;
    const values: Record<string, unknown> = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) values[key] = patch[key];
    }
    if (values.customer_mobile !== undefined) {
      const m = String(values.customer_mobile).trim();
      if (!/^1[3-9]\d{9}$/.test(m)) {
        throw new ArchiveError('ARCHIVE_BAD_MOBILE', '手机号格式不正确', 400);
      }
      values.customer_mobile = m;
    }
    if (Object.keys(values).length === 0) {
      throw new ArchiveError('ARCHIVE_NOTHING_TO_UPDATE', '没有可更新的字段', 400);
    }

    values.updated_by = actor.userId ?? null;
    values.version = Number(existing.version) + 1;

    // 条件更新：WHERE version = 旧值。没有行被更新 ⇒ 有人抢先改了。
    //
    // 🔴 判据必须用 `RETURNING id` 的**返回行数**，不能解构 `sequelize.query` 的第一个返回值。
    //    2026-11-09 实测踩过：`const [affected] = await sequelize.query(UPDATE ...)` 拿到的
    //    是**结果集**（UPDATE 无 RETURNING 时为空数组），`Number([]) === 0` 恒成立
    //    ⇒ 所有更新都报 ARCHIVE_STALE。更糟的是"并发不得覆盖"这条断言因此**假绿**：
    //    它测出来的 409 是因为"永远失败"，不是因为"真的检测到冲突"。
    const [updatedRows] = (await this.db.sequelize.query(
      `UPDATE service_archives SET ${Object.keys(values)
        .map((k) => `${k} = :${k}`)
        .join(', ')}, updated_at = now()
       WHERE id = :id AND version = :oldVersion
       RETURNING id`,
      { replacements: { ...values, id: archiveId, oldVersion: Number(existing.version) } },
    )) as unknown as [Array<{ id: number }>];
    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      throw new ArchiveError(
        'ARCHIVE_STALE',
        // 同 update() 的口径：不引导刷新（会丢当前输入），并说明内容还在
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    const updated = await this.mustLoad(archiveId);
    await this.writeEvent(actor, archiveId, null, 'archive_updated', {
      fields: Object.keys(values).filter((k) => !['updated_by', 'version'].includes(k)),
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // 完成
  // -------------------------------------------------------------------------

  /**
   * 标记完成（普通上门服务）。
   *
   * 判据**全部取自数据库真实状态**，不信任请求体：
   *   · `completed_at` 必填（执行令：实际完成日期）；
   *   · `before` / `after` 各至少 1 张 —— 查 photo 表计数；
   *   · 已作废的档案不能再完成。
   */
  async complete(
    actor: ArchiveActorLike,
    archiveId: number,
    input: { completed_at: string; expectedVersion?: number },
  ): Promise<any> {
    const existing = await this.mustLoad(archiveId);
    this.assertCanWriteStore(actor, Number(existing.store_id));

    if (existing.archive_type !== ARCHIVE_TYPE.SERVICE) {
      throw new ArchiveError(
        'ARCHIVE_WRONG_TYPE',
        '暖通工程请按阶段完成，不能直接标记完成',
        400,
      );
    }
    if (existing.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能标记完成', 409);
    }    if (existing.status === ARCHIVE_STATUS.COMPLETED) {
      throw new ArchiveError('ARCHIVE_ALREADY_COMPLETED', '该档案已完成', 409);
    }
    if (!input?.completed_at) {
      throw new ArchiveError('ARCHIVE_MISSING_COMPLETED_AT', '必须填写实际完成日期', 400);
    }
    if (
      input.expectedVersion !== undefined &&
      Number(input.expectedVersion) !== Number(existing.version)
    ) {
      throw new ArchiveError(
        'ARCHIVE_STALE',
        // 同 update() 的口径：不引导刷新（会丢当前输入），并说明内容还在
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    // ---- 照片硬闸：查的是表里真实存在的行 ----
    const photos = await this.repo('serviceArchivePhotos').find({
      filter: { archive_id: archiveId },
      fields: ['photo_type'],
    });
    const have = new Set((photos || []).map((p: any) => String(p.photo_type)));
    const missing = ARCHIVE_SERVICE_PHOTO_REQUIRED_TYPES.filter((t) => !have.has(t));
    if (missing.length > 0) {
      const labels: Record<string, string> = { before: '服务前', after: '服务后' };
      throw new ArchiveError(
        'ARCHIVE_PHOTO_REQUIRED',
        `标记完成前必须上传：${missing.map((t) => labels[t] ?? t).join('、')}照片`,
        409,
      );
    }

    // 同 update()：受影响行数必须来自 `RETURNING`，不是 query 的第一个返回值。
    const [doneRows] = (await this.db.sequelize.query(
      `UPDATE service_archives
          SET status = :status, completed_at = :completedAt,
              version = version + 1, updated_by = :by, updated_at = now()
        WHERE id = :id AND version = :oldVersion
        RETURNING id`,
      {
        replacements: {
          status: ARCHIVE_STATUS.COMPLETED,
          completedAt: input.completed_at,
          by: actor.userId ?? null,
          id: archiveId,
          oldVersion: Number(existing.version),
        },
      },
    )) as unknown as [Array<{ id: number }>];
    if (!Array.isArray(doneRows) || doneRows.length === 0) {
      throw new ArchiveError(
        'ARCHIVE_STALE',
        // 同 update() 的口径：不引导刷新（会丢当前输入），并说明内容还在
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    await this.writeEvent(actor, archiveId, null, 'archive_updated', {
      transition: `${existing.status} -> ${ARCHIVE_STATUS.COMPLETED}`,
    });
    return this.mustLoad(archiveId);
  }

  // -------------------------------------------------------------------------
  // 发布（ARC-V1 / A5-E）
  // -------------------------------------------------------------------------

  /**
   * 把档案置为「已发布」——**受控**发布，唯一入口是 `svc:archivePublish`。
   *
   * 为什么不开放原生 `serviceArchives:update`：原生 update 能一次改掉任意列
   * （含 `status` / `store_id` / `archive_no`），且走不到 applyScope 之外的保护。
   *
   * 四条语义（用户 2026-11-11 A5-E 执行令）：
   *   ① **visibility 与业务 status 相互独立** —— 未完工（status=pending）也能发布；
   *      反之完工也不会自动发布（`complete()` 里没有一行碰 visibility）。
   *   ② 只有 `ARCHIVE_WRITE_ROLES`（当前即 store_sales）且**本店**能发布；
   *      负责人 / 总部 / 跨店一律被 `assertCanWriteStore` 拒掉（403 或 404）。
   *   ③ 已发布再发布 ⇒ 409 `ARCHIVE_ALREADY_PUBLISHED`，不重复推进版本、不重复写事件。
   *   ④ 并发：`WHERE version = :oldVersion` + `RETURNING id`，0 行即 409。
   *      （同 `update()` / `complete()` 的口径：判据必须来自 RETURNING 的行数。）
   *
   * ⚠️ 发布**不**代表照片发布：照片仍是 `published=false`，客户看不到。
   *    两者要分别操作，这是用户明确要求「区分档案已发布与照片已发布」的落点。
   */
  async publish(
    actor: ArchiveActorLike,
    archiveId: number,
    input: { expectedVersion?: number } = {},
  ): Promise<any> {
    const existing = await this.mustLoad(archiveId);
    this.assertCanWriteStore(actor, Number(existing.store_id));

    if (String(existing.visibility) === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能发布', 409);
    }
    if (String(existing.visibility) === ARCHIVE_VISIBILITY.PUBLISHED) {
      throw new ArchiveError('ARCHIVE_ALREADY_PUBLISHED', '该档案已发布', 409);
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      Number(input.expectedVersion) !== Number(existing.version)
    ) {
      throw new ArchiveError(
        'ARCHIVE_STALE',
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    // `published_at` 只在**首次**发布时写入（再次发布不可达，这里只是防御）
    const [rows] = (await this.db.sequelize.query(
      `UPDATE service_archives
          SET visibility = :published,
              published_at = COALESCE(published_at, now()),
              version = version + 1,
              updated_by = :by,
              updated_at = now()
        WHERE id = :id AND version = :oldVersion AND visibility <> :published
        RETURNING id`,
      {
        replacements: {
          published: ARCHIVE_VISIBILITY.PUBLISHED,
          id: archiveId,
          oldVersion: Number(existing.version),
          by: actor.userId ?? null,
        },
      },
    )) as unknown as [Array<{ id: number }>];

    if (!Array.isArray(rows) || rows.length === 0) {
      // 没有任何行被更新：要么并发抢先改了，要么刚被别人发布 —— 统一按并发冲突处理
      throw new ArchiveError(
        'ARCHIVE_STALE',
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    await this.writeEvent(actor, archiveId, null, ARCHIVE_EVENT_TYPE.PUBLISHED, {
      // ⚠️ payload 只放能公开的事实：不放手机号、不放 token、不放 storage_key
      from: String(existing.visibility),
      to: ARCHIVE_VISIBILITY.PUBLISHED,
      // 明确记录"业务状态没有因此改变"，避免后来人误以为发布=完工
      status_unchanged: String(existing.status),
    });

    return this.mustLoad(archiveId);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async mustLoad(archiveId: number): Promise<any> {
    const row = await this.repo('serviceArchives').findOne({ filter: { id: archiveId } });
    if (!row) {
      // 不存在与无权访问统一 404，避免探测
      throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    }
    return row;
  }

  /**
   * 写审计事件。
   *
   * ⚠️ **只记录能归属到具体档案的事件**（用户 2026-11-09 明确）。
   *    `payload` 里**不得**出现客户手机号明文、验证码、storage_key。
   *
   * `transaction` 可选：撤回阶段时用户要求"阶段状态 / 连锁撤回 / 照片取消发布"
   * 同事务提交，事件也应跟着同一个事务走 —— 否则事务回滚了、事件却留下，
   * 审计会显示"撤回过"而数据说"没撤"。
   */
  async writeEvent(
    actor: ArchiveActorLike,
    archiveId: number,
    stageId: number | null,
    eventType: string,
    payload: Record<string, unknown> = {},
    transaction?: any,
  ): Promise<void> {
    try {
      await this.repo('serviceArchiveEvents').create({
        values: {
          archive_id: archiveId,
          stage_id: stageId,
          event_type: eventType,
          actor_user_id: actor.userId ?? null,
          actor_role: actor.roles?.[0] ?? null,
          payload_json: payload,
          created_at_custom: new Date(),
        },
        ...(transaction ? { transaction } : {}),
      });
    } catch (error) {
      // 事件写失败不阻断业务，但必须留痕 —— 静默丢审计是最坏的选项
      this.logger?.warn?.(
        `[archive] 事件写入失败 archive=${archiveId} type=${eventType}: ${(error as Error)?.message}`,
      );
    }
  }
}

/** 端点用：把 ArchiveError 映射成 HTTP 状态，其它异常按 500 */
export function isArchiveError(error: unknown): error is ArchiveError {
  return error instanceof ArchiveError;
}

/**
 * 客户是否**可以读到这张照片** —— 全系统唯一判定（用户 2026-11-10 冻结）。
 *
 * 三个条件**同时**成立才可见：
 *   ① 档案 `visibility = published`（草稿/作废一律不给）；
 *   ② 照片 `published = true`（撤回阶段会把它们置 false，历史发布过也不算数）；
 *   ③ 若照片属于某个阶段（暖通），该阶段必须 `status = done`。
 *      普通上门服务照片 `stage_id` 为 NULL，只看 ①②。
 *
 * 为什么必须做成一个函数、而不是在每条查询里各写一遍 where：
 *   这三条是"与"关系，任何一条漏写都不会报错，只会**多给一张照片**。
 *   而照片是客户住宅现场 —— 多给一张不是体验问题。
 *   将来 A4 的客户查询接口、后台预览、导出都必须调这一个函数。
 *
 * ⚠️ 它只判**可见性**，不判"这个客户是不是本人"。
 *    归属校验（store_id + customer_mobile 会话绑定）是另一层，在 A4 做。
 */
export function isPhotoCustomerVisible(
  archive: { visibility?: string | null },
  photo: { published?: boolean | null; stage_id?: number | null },
  stage?: { status?: string | null } | null,
): boolean {
  if (String(archive?.visibility ?? '') !== ARCHIVE_VISIBILITY.PUBLISHED) return false;
  if (photo?.published !== true) return false;
  // 暖通阶段照片：阶段被撤回（withdrawn）或还没完成（pending）都不能给
  if (photo?.stage_id !== null && photo?.stage_id !== undefined) {
    if (String(stage?.status ?? '') !== 'done') return false;
  }
  return true;
}
