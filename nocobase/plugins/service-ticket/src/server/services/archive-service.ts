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
  PLATFORM_ADMIN_ROLES,
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

  /**
   * 是否**平台超管**（`root` / `admin`）。
   *
   * 🔴 2026-11-25 浏览器验收第六层根因（**已踩第三次**）：
   *    `actor.roles` 是 `normalizeRolesDetailed()` **归一化之后**的业务角色，
   *    `root` / `admin` 已经被剥掉、单独放进 `actor.platformRoles`。
   *    所以"在 roles 里找 root"**永远找不到** —— 那不是数据问题，是两块字段。
   *
   *    这个坑此前在 `archiveAdminList` 里踩过两次并修好（见 archive.ts 的注释），
   *    但那个修法是**就地**写在动作里的，`canRead` / `assertCanAccessRow`
   *    两条共用路径一直没修 ⇒
   *      · 列表页正常（走 `archiveAdminList`，已修）；
   *      · 点「详情」→ `svc:archiveProductList` / `archiveStageList` /
   *        `archivePhotoList` 全 403「当前角色无档案访问权限」；
   *      · 表现是**弹窗打开了但只有标题、正文 29 字、0 个输入框**。
   *    这正是"列表能看、点进去白的"那种一半好一半坏的状态。
   *
   *    所以这次把判据**收到唯一一处**（这里），让三条路径共用，
   *    而不是在每个动作里各写一遍"记得读 platformRoles"。
   */
  isPlatformAdmin(actor: ArchiveActorLike): boolean {
    const platform = (actor as any)?.platformRoles;
    const list: string[] = Array.isArray(platform) ? platform : [];
    return list.some((r) => PLATFORM_ADMIN_ROLES.includes(r as any));
  }

  canRead(actor: ArchiveActorLike): boolean {
    // 超管 = 平台管理员，与 `archiveAdminList` 的口径一致
    if (this.isPlatformAdmin(actor)) return true;
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
    // 超管跨店可读（与 `archiveAdminList` 的 isHq 口径一致），
    // 否则"列表里看得到 4 条、点第 2 条就 404 说档案不存在"。
    if (this.isPlatformAdmin(actor)) return;
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
        /**
         * 🔴 R2.2.1 用户第 7.4 条：「**保存即正式发布**」。
         *
         * 原来这里写 `DRAFT`，于是新建的档案只有员工看得见，
         * 客户拿手机号查不到 —— 而一线员工的理解是"我填完保存了，客户就能查"。
         * 这个认知差在中转环节不会暴露（员工自己能看到列表里有一条），
         * 只在客户打电话说"查不到"时才炸，那时已经在电话里解释了。
         *
         * ⚠️ **改的是服务端默认创建行为，不是前端隐藏一个按钮**。
         *    前端藏按钮只能挡住走界面的人；而 `svc:archiveCreate` 是唯一建档入口，
         *    在这里定 visibility 才是真正生效的那一处（用户原话："必须修改实际服务端
         *    默认创建行为，不能只隐藏前端按钮"）。
         *
         * ⚠️ **不动存量草稿**：这里只影响新建。库里 id=26 等历史草稿保持 `draft`，
         *    因为用户明确"现有草稿不允许未经批准批量自动发布"。
         *
         * ⚠️ `status` 与 `visibility` 仍然正交：这里只把 visibility 置为 published，
         *    status 仍是 `pending`（业务进度 = 待开始），两者**不可混淆**。
         *    发布不代表完工，完工也不会自动发布（见 `publish()` 注释四条语义）。
         *
         * ⚠️ `published_at` 与 visibility **同一条 INSERT 写入**。若分两步
         *    （先建后 publish），中间会存在"published 但 published_at 为空"的窗口，
         *    而客户查询投影与审计都读 `published_at`。
         */
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
        published_at: new Date(),
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
        // R2.2.1：把"建档时就已经对外可见"这件事写进事件，而不是让审计
        // 去对比"没有 published 事件却 visible" 这种反推。
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
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
    /**
     * 完工后能否编辑（R2.2.4-rc.2 · 用户 §三）
     * ===================================================================
     * 用户原话：「允许授权销售在相应状态下编辑已获准更正的内容，
     *           包括完工后的信息纠错；但不能通过普通编辑接口绕过完成动作、
     *           照片校验或状态机。」
     *
     * ⇒ **completed 不拦**（信息纠错是真实业务需求：日期记错、型号写错）。
     *   拦截点不在"状态"，而在"能改哪些列"——
     *   白名单里没有 status / visibility / completed_at / published_at，
     *   所以这条路**在结构上**无法推进或回退状态，也无法伪造完工时间。
     *
     * ⚠️ 这里刻意不写一个 `if (status === 'completed') throw`：
     *    那会把"改错一个日期"变成"只能作废重建一条档案"，
     *    正是用户明令禁止的「不得因为档案已经创建，就要求销售重新创建一条档案」。
     */
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
    //
    // ⚠️ `service_date` 在列内、`completed_at` **不在**：
    //    前者是"哪天上门的"这一业务事实，允许随时纠正（含完工后）；
    //    后者是完工动作的产物，改它等于篡改状态流转证据。
    //    这正是用户「编辑上门日期不等于执行完工操作」的服务端落点。
    const allowed = [
      'customer_name', 'customer_mobile', 'service_address',
      'product_description', 'package_description',
      'purchase_date', 'planned_date', 'service_date', 'service_type',
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
    /**
     * 修改留痕（R2.2.4-rc.2 · 用户 §三「修改记录」）。
     *
     * ===================================================================
     * 记什么、不记什么
     * ===================================================================
     *   记：字段名 + **前后值**（计划日期 / 实际日期 / 服务内容 / 备注 / 产品清单）。
     *   不记：完整客户手机号。用户明令「审计中不打印完整手机号或凭证」。
     *
     *   ⚠️ 手机号为什么是**整字段替换成掩码**而不是"记下前后值再脱敏显示"：
     *      审计存进 `payload_json` 之后，任何有档案读权限的人都能看到。
     *      存一份"改动前 13912345678 / 改动后 13900001111"等于把两个真实号码
     *      长期留在事件表里。只记"改过"这件事本身即可 ——
     *      真要追号码变更，有 `updated_by` + 时间 + 客户本人可核对。
     *
     *   ⚠️ 值要**截断**：`notes` 是自由文本，可能几千字，
     *      原样进事件表会让档案时间线变成一片字海（且 payload 无长度上限）。
     */
    const AUDIT_MASK = new Set(['customer_mobile']);
    const AUDIT_MAX_LEN = 120;
    const shrink = (v: unknown): unknown => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      const s = String(v);
      return s.length > AUDIT_MAX_LEN ? `${s.slice(0, AUDIT_MAX_LEN)}…` : s;
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(values)) {
      if (key === 'updated_by' || key === 'version') continue;
      const from = (existing as any)?.[key] ?? null;
      const to = values[key] ?? null;
      // 只记"真的变了"的字段：把未变字段也记进去会让时间线充满噪音
      const same = from === to || String(from ?? '') === String(to ?? '');
      if (same) continue;
      changes[key] = AUDIT_MASK.has(key)
        ? { from: from === null ? null : '[已脱敏]', to: to === null ? null : '[已脱敏]' }
        : { from: shrink(from), to: shrink(to) };
    }
    await this.writeEvent(actor, archiveId, null, 'archive_updated', {
      fields: Object.keys(values).filter((k) => !['updated_by', 'version'].includes(k)),
      // 新产品没有"旧值"可对比，用标记说明"由调用方另行记录"（见 archive.ts 的清单事件）
      changes,
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // 开始服务（R2.2.5 §三）
  // -------------------------------------------------------------------------

  /**
   * 开始服务：`pending`（或历史遗留的 `scheduled`）→ `serving`。
   *
   * =========================================================================
   * 为什么必须有这个动作，而不是让客户端 `update { status: 'serving' }`
   * =========================================================================
   *   ① `update()` 的白名单里**没有** `status` —— 那是刻意的：
   *      `status` / `visibility` / `store_id` 各有专用动作，
   *      一条普通 update 绝不能改状态（否则"编辑档案"就能伪造完工）。
   *   ② 但 `ARCHIVE_STATUS.SERVING = 'serving'` 这个常量**此前没有任何写入点**
   *      （全仓库只有常量定义与中文标签）。也就是说：
   *      销售端根本走不到"服务中" —— 这是一条**断链**，不是"选项太少"。
   *   ③ 用户 §三 要求"销售端只展示 待服务/服务中/已完成"，且
   *      "优先复用现有状态机和接口"。⇒ 复用现有 `status` 列与三个枚举值，
   *      只补一个受控转换动作，**不新增状态、不新增表、不新增迁移**。
   *
   * =========================================================================
   * 转换规则（唯一合法起点）
   * =========================================================================
   *   合法起点：`pending`（待服务）、`scheduled`（已预约，历史遗留值）。
   *   目标：`serving`。
   *
   *   ⚠️ 刻意**不接受**从 `completed` 回到 `serving`：
   *      用户 §三 明确"已完成详情…保留原完成时间及状态，不因普通修改自动退回"。
   *      一旦允许 completed→serving，"完成服务"就成了可撤销的普通按钮，
   *      而实际上它已经被客户/总部看到过。退回必须走专门的纠错流程（本轮不做）。
   *
   *   ⚠️ 暖通走阶段完成，没有"开始服务"这个概念 ⇒ 400 `ARCHIVE_WRONG_TYPE`。
   *
   *   ⚠️ 重复调用（已经是 serving）⇒ 409 `ARCHIVE_ALREADY_SERVING`。
   *      不用"幂等返回 200"：那会让"我点了两次"和"别人先开始了"看起来一样，
   *      而两者该让用户做的事不同（前者什么都不用做，后者要去核对谁在场地）。
   */
  async startService(
    actor: ArchiveActorLike,
    archiveId: number,
    input: { expectedVersion?: number; serviceDate?: string | null } = {},
  ): Promise<any> {
    const existing = await this.mustLoad(archiveId);
    this.assertCanWriteStore(actor, Number(existing.store_id));

    if (existing.archive_type !== ARCHIVE_TYPE.SERVICE) {
      throw new ArchiveError('ARCHIVE_WRONG_TYPE', '暖通工程请按阶段推进，没有「开始服务」这一步', 400);
    }
    if (String(existing.visibility) === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能开始服务', 409);
    }
    if (String(existing.status) === ARCHIVE_STATUS.COMPLETED) {
      throw new ArchiveError(
        'ARCHIVE_ALREADY_COMPLETED',
        '这条档案已经完成服务，不会退回「服务中」。如需更正记录，请用「修改服务记录」',
        409,
      );
    }
    if (String(existing.status) === ARCHIVE_STATUS.SERVING) {
      throw new ArchiveError('ARCHIVE_ALREADY_SERVING', '这条档案已经是「服务中」，无需重复开始', 409);
    }
    if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== Number(existing.version)) {
      throw new ArchiveError(
        'ARCHIVE_STALE',
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    /**
     * `service_date` 的写入条件（只在**本来为空**时写）。
     *
     * ⚠️ 为什么是 `COALESCE` 而不是直接覆盖：
     *    "开始服务"面板上的日期默认当天，但它只是**记录**"今天上门了"。
     *    若这条档案此前已经记过实际日期（例如补录过一次又撤回），
     *    开始动作不该把它改掉 —— 用户 §二 明确"修改日期不自动改变其他字段"，
     *    反过来"开始服务"也不该顺手改写已有的实际日期。
     *    用 `COALESCE(service_date, :serviceDate)` 表达"只在空的时候补上"。
     */
    const serviceDate = String(input.serviceDate ?? '').trim() || null;

    /**
     * 合法起点白名单 —— **正面列举**，不用 `status <> 'completed'`。
     *
     * ⚠️ 为什么不用"排除法"：排除法会让将来新增的每一个状态
     *    （例如 `cancelled` / `rejected`）**自动获得**"可以直接开始服务"的权利，
     *    而那种授予是静默的、没人会去复核。正面列举要求新增状态时
     *    必须回来改这一行，改的时候就会被问"它能不能开始服务"。
     *
     * `scheduled`（已预约）在列：它是历史数据里出现过的值，
     * 语义上"预约了但还没到场"，开始服务正是它的下一步。
     */
    const ALLOWED_FROM: readonly string[] = [
      ARCHIVE_STATUS.PENDING,
      ARCHIVE_STATUS.SCHEDULED,
    ];

    /**
     * 白名单通过 `IN (:from)` **传数组**展开。
     *
     * 🔴 2026-11-26 实测（`.probe/r225-diag-seq.cjs`，容器内直接跑）：
     *    这里原本写的是 `from: ALLOWED_FROM.map(x => `'${x}'`).join(',')`
     *    —— 一个**字符串**。Sequelize 把 `:from` 当成单个参数、把其中的引号再转义一层，
     *    最终 SQL 是
     *      `status IN ('''pending'',''serving'',''scheduled''')`
     *    等于在比较一个"含引号的单值"，**永远匹配不到任何行**。
     *    ⇒ UPDATE 恒 0 行 ⇒ 一律抛 `ARCHIVE_STALE`，
     *    而"数据已更新"的文案把一次纯粹的 SQL 缺陷伪装成了并发冲突。
     *    更坏的是并发断言会因此**假绿**（409 来自"永远失败"而非"真的冲突"）。
     *
     * 既有正确用法（同一仓库）：`archive-stage-service.ts` 的
     *   `AND stage_id IN (:stageIds)` + `stageIds: withdrawStageIds`（数组）。
     * 结论：`IN (:x)` 只在**值是数组**时才被展开成列表；传字符串就是单值。
     *
     * 记录在 docs/DEVIATIONS.md：DEV-R225-02。
     */
    const fromList = [...ALLOWED_FROM];

    const [rows] = (await this.db.sequelize.query(
      `UPDATE service_archives
          SET status = :serving,
              service_date = COALESCE(service_date, :serviceDate),
              version = version + 1,
              updated_by = :by,
              updated_at = now()
        WHERE id = :id AND version = :oldVersion AND status IN (:fromList)
        RETURNING id`,
      {
        replacements: {
          serving: ARCHIVE_STATUS.SERVING,
          serviceDate,
          by: actor.userId ?? null,
          id: archiveId,
          oldVersion: Number(existing.version),
          fromList,
        },
      },
    )) as unknown as [Array<{ id: number }>];

    if (!Array.isArray(rows) || rows.length === 0) {
      // 走到这里说明"读到的状态"与"更新时的状态"不一致（并发）
      throw new ArchiveError(
        'ARCHIVE_STALE',
        '数据已更新，本次操作未保存；你填写的当前内容仍在页面上，请核对后再决定是否重新加载',
        409,
      );
    }

    await this.writeEvent(actor, archiveId, null, 'archive_updated', {
      transition: `${existing.status} -> ${ARCHIVE_STATUS.SERVING}`,
      // ⚠️ 只记"补了实际日期"这件事，不记日期本身以外的任何个人信息
      ...(serviceDate && !existing.service_date ? { service_date: serviceDate } : {}),
    });
    return this.mustLoad(archiveId);
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
   *
   * =========================================================================
   * R2.2.5 §三 · 合法起点：pending / serving / scheduled（**不再任意状态**）
   * =========================================================================
   *   用户 §三 给的是两条路径：
   *     · 服务中详情 →「完成服务」              ⇒ 起点 `serving`
   *     · 待服务详情 →「补录服务结果」→ 一次完成 ⇒ 起点 `pending`
   *
   *   而改造前这里只有"不是 completed"这一条拦，等于
   *   **任何状态都能跳完成**（包括 `accepted` 这种不该出现在普通服务上的值）。
   *
   *   ⚠️ 为什么补录**不**要求先 startService：
   *      用户 §三 明写「事后补录…一次填写实际日期+前后照片+备注后完成服务」。
   *      强制先"开始"再"完成"会让补录变成三步，而补录的业务场景恰恰是
   *      "这事儿已经做完了，我现在才录"。要求它先走一个假的"服务中"，
   *      等于制造一条**不真实的中间状态记录**。
   *      ⇒ 起点放宽到 `pending`/`serving`/`scheduled`，转换仍受控。
   *
   *   ⚠️ 已完成再完成 ⇒ 409（保持原行为，不幂等返回 200）：
   *      "完成"会写 `completed_at`，重复执行等于改写完工时间。
   *      而且要区分"我点了两次"与"别人已经完成" —— 两者该做的事不同。
   */
  async complete(
    actor: ArchiveActorLike,
    archiveId: number,
    input: { completed_at: string; expectedVersion?: number; service_date?: string | null },
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
    }
    if (existing.status === ARCHIVE_STATUS.COMPLETED) {
      throw new ArchiveError('ARCHIVE_ALREADY_COMPLETED', '该档案已完成', 409);
    }
    /**
     * 合法起点白名单。
     *
     * ⚠️ 这里的判据是"能不能完成"，不是"现在是什么"。所以要**正面列举**
     *    允许的起点，而不是只排除 completed —— 后者会让将来新增的状态
     *    （比如若某天加了 `cancelled`）自动获得"能直接完成"的权利。
     */
    const COMPLETABLE_FROM: readonly string[] = [
      ARCHIVE_STATUS.PENDING,
      ARCHIVE_STATUS.SERVING,
      ARCHIVE_STATUS.SCHEDULED,
    ];
    if (!COMPLETABLE_FROM.includes(String(existing.status))) {
      throw new ArchiveError(
        'ARCHIVE_BAD_TRANSITION',
        `当前状态（${existing.status}）不能直接完成服务`,
        409,
      );
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

    /**
     * `service_date` 与 `completed_at` 的关系（R2.2.5 §三）。
     *
     *   · `completed_at` 是 timestamptz，"哪天点的完成"；
     *   · `service_date` 是 dateOnly，"哪天上门的"。
     *   两者默认同一天，但**用户可以分开填**（补录昨天上门、今天才录）。
     *
     *   ⚠️ 只在调用方**明确给了** `service_date` 时才写；没给就保留原值
     *      （包括 NULL）—— 用户 §二 明令"实际日期未填写时不伪造为计划日期或当天"。
     */
    const serviceDate = typeof input.service_date === 'string' && input.service_date.trim() !== ''
      ? input.service_date.trim()
      : null;

    // 同 startService：白名单必须**传数组**让 `IN (:x)` 展开成列表（DEV-R225-02）。
    // 传字符串会被整体转义成单个值，永远匹配不到任何行。
    const completeFromList = [...COMPLETABLE_FROM];

    // 同 update()：受影响行数必须来自 `RETURNING`，不是 query 的第一个返回值。
    const [doneRows] = (await this.db.sequelize.query(
      `UPDATE service_archives
          SET status = :status, completed_at = :completedAt,
              service_date = COALESCE(:serviceDate, service_date),
              version = version + 1, updated_by = :by, updated_at = now()
        WHERE id = :id AND version = :oldVersion AND status IN (:completeFromList)
        RETURNING id`,
      {
        replacements: {
          status: ARCHIVE_STATUS.COMPLETED,
          completedAt: input.completed_at,
          serviceDate,
          by: actor.userId ?? null,
          id: archiveId,
          oldVersion: Number(existing.version),
          completeFromList,
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
      ...(serviceDate ? { service_date: serviceDate } : {}),
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
