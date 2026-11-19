/**
 * 服务档案适配器（ArchiveApiAdapter）
 *
 * ===========================================================================
 * 职责边界（与 TicketApiAdapter 同构）
 * ===========================================================================
 *   只做三件事：字段白名单投影、UI 语义 → 查询语法翻译、屏蔽 X-Request-Id 细节。
 *   **不做**权限判断、不做数据裁剪、不推断状态。
 *
 * ===========================================================================
 * 一个必须记住的通道区分：读走原生 list/get，写走 svc:archive*
 * ===========================================================================
 *   服务端 `ROLE_ACL_ACTIONS` 给业务角色授的是 serviceArchives 的
 *   `view / list / get`（只读）。原生 create/update/destroy **一律无授权** ——
 *   因为"标记完成必须两张照片""阶段必须按顺序""并发不得静默覆盖"
 *   这三条规则数据库表达不了。
 *
 *   ⇒ 所以本文件里：
 *     · `list()` / `detail()` 走原生 `/serviceArchives:list` / `:get`
 *       （服务端 storeScope 按门店裁，前端不参与）；
 *     · 所有写操作走 `/svc:archiveCreate` / `archiveUpdate` / …
 *       （每个都带 X-Request-Id，它是**幂等键**，不是装饰）。
 *
 *   把写操作写成原生 `:update` 会得到 403 —— 而且是在"看起来没问题"之后才 403。
 */

import { listRequest, request, qs, upload, type ListResult } from './http';

/** 档案行（原生 `serviceArchives:list` 的字段子集） */
export interface ArchiveRow {
  id: number;
  archive_no: string | null;
  archive_type: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  /**
   * 服务端下发的「这个手机号对你是否可见」判据（R2.2.1 §四）。
   *
   * 🔴 由服务端中间件 `archive-read-scope.ts` 逐行写入，移动端**不要自己判**。
   *    它同时解决了"没填号码"与"无权查看"两种 null 的歧义：
   *      visible === false ⇒ 无权限（界面不显示号码，也不说"已隐藏"，只是不占位）
   *      visible === true  ⇒ 有权限，`customer_mobile` 为 null 时才是真的没填
   */
  customer_mobile_visible?: boolean | null;
  service_address: string | null;
  service_type: string | null;
  product_description: string | null;
  package_description: string | null;
  purchase_date: string | null;
  planned_date: string | null;
  assigned_worker: string | null;
  public_note: string | null;
  /**
   * 🔒 内部备注（`serviceArchives.notes`）。
   * ⚠️ **只在 `get()` 里补**，不在列表白名单里 —— 列表拉长文本是白送带宽，
   *    也让"哪些字段被展示过"变得含糊。服务端注释写明它永不进入客户查询投影。
   */
  notes?: string | null;
  status: string | null;
  visibility: string | null;
  store_id: number | null;
  version: number | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * ⚠️ 白名单。**不要**在这里加 `notes`（内部备注）：
 *    客户投影里没有它，员工投影里有，但它是长文本，列表里完全用不到 ——
 *    列表拉它是白送带宽，也让"哪些字段被展示过"变得含糊。
 *    详情（`notes`）由 `detail()` 单独拉。
 */
const ARCHIVE_LIST_KEYS: (keyof ArchiveRow & string)[] = [
  'id', 'archive_no', 'archive_type', 'customer_name', 'customer_mobile',
  // ⚠️ R2.2.1 §四：服务端中间件 `archive-read-scope.ts` 会在响应行上**追加**
  //    `customer_mobile_visible`（投影发生在 fields 裁剪**之后**，
  //    所以即使不在这里列出来也能拿到 —— 实测 id=1 用 `fields=id,customer_mobile`
  //    请求时它照样出现）。这里仍然显式列出，理由不是"能不能拿到"，
  //    而是**让人一眼看出它属于本页契约**：谁删掉它，谁就会让
  //    "无权限"与"客户没填号码"重新变得无法区分。
  //
  // 🔴 另外纠正一个很容易想错的地方：原生 list 的 `fields` 参数**不是**安全边界 ——
  //    客户端可以自己改 `fields=customer_mobile`。真正的边界是服务端的投影中间件。
  'customer_mobile_visible',
  'service_address', 'service_type', 'product_description', 'package_description',
  'purchase_date', 'planned_date', 'assigned_worker', 'public_note',
  'status', 'visibility', 'store_id', 'version', 'completed_at', 'created_at', 'updated_at',
];

export interface ArchiveFilter {
  /** service / hvac；不传 = 全部 */
  type?: 'service' | 'hvac' | '';
  /** 关键词（档案号 / 客户 / 电话 / 地址） */
  keyword?: string;
  /** 可见性：draft / published / voided；不传 = 全部 */
  visibility?: string;
  status?: string;
}

function buildFilter(f: ArchiveFilter): Record<string, unknown> {
  const and: unknown[] = [];
  if (f.type) and.push({ archive_type: f.type });
  if (f.visibility) and.push({ visibility: f.visibility });
  if (f.status) and.push({ status: f.status });

  const kw = f.keyword?.trim();
  if (kw) {
    and.push({
      $or: [
        { archive_no: { $includes: kw } },
        { customer_name: { $includes: kw } },
        { customer_mobile: { $includes: kw } },
        { service_address: { $includes: kw } },
      ],
    });
  }
  if (and.length === 0) return {};
  if (and.length === 1) return and[0] as Record<string, unknown>;
  return { $and: and };
}

/** 建档入参（与服务端 `ArchiveService.create` 的必填/可选完全对应） */
export interface ArchiveCreateInput {
  archive_type: 'service' | 'hvac';
  /**
   * ⚠️ **不要传 store_id**。
   *   服务端 A5-B3 明确：请求不传 ⇒ 取当前销售**唯一**的有效门店绑定；
   *   传了 ⇒ 仍走门店一致性校验（不放宽）。
   *   前端没有任何可靠途径知道"我在哪家店"，让用户选店 = 允许跨店。
   */
  customer_name: string;
  customer_mobile: string;
  service_address: string;
  /** 普通上门服务必填；暖通**不用**这个字段 */
  service_type?: string | null;
  product_description?: string | null;
  package_description?: string | null;
  /** YYYY-MM-DD */
  purchase_date?: string | null;
  planned_date?: string | null;
  assigned_worker?: string | null;
  /**
   * 🔒 **内部备注**（`serviceArchives.notes`，服务端注释"永不进入客户查询投影"）。
   * ⚠️ 与 `public_note`（对客户说明）是**两列**，不能互相顶替：
   *    写进 `public_note` 的内容客户查询时能看到。
   *    R2.2.1 起员工端只填内部备注，「客户可见备注」已按用户第 7.2 条删除。
   */
  notes?: string | null;
  public_note?: string | null;
}

export interface ArchiveStageRow {
  id: number;
  stage_code: string;
  stage_order: number;
  status: string;
  /** 该阶段照片数（服务端 `listStages` 数的是**归属到本阶段**的照片） */
  photo_count: number;
  note?: string | null;
  /**
   * ⚠️ R2.2.1：以下字段是服务端 `listStages()` **一直在返回**、但前端一直没取的。
   *    移动端要支持"现场完成阶段"就必须知道：
   *      · `version`       —— 乐观锁，`archiveStageComplete` 必传 `expected_version`；
   *                           不传或传错 ⇒ 409 `ARCHIVE_STAGE_STALE`（"刚被别人改过"）。
   *      · `photo_required`/`photo_max` —— 照片规则由服务端定，前端**不自己推断**
   *                           （哪些阶段必传照片是业务规则，写两份必然漂）。
   *      · `withdraw_reason` —— 撤回过的阶段要显示原因，否则员工会以为"做完了又变没做"。
   */
  done_at: string | null;
  stage_date?: string | null;
  completed_at?: string | null;
  version?: number;
  withdraw_reason?: string | null;
  photo_required?: boolean;
  photo_max?: number;
}

/** 暖通阶段的完成/撤回结果 */
export interface ArchiveStageMutationResult {
  archive: unknown;
  stage?: unknown;
  withdrawn?: string[];
}


export const ArchiveApiAdapter = {
  /**
   * 列表。
   *
   * ⚠️ `sort=-created_at` 而不是 `-id`：档案号是按创建顺序生成的，
   *    但历史导入的数据 id 与时间不同序。用户在列表里期待"最新建的在上"。
   */
  async list(filter: ArchiveFilter, page = 1, pageSize = 20): Promise<ListResult<ArchiveRow>> {
    const path = qs('/serviceArchives:list', {
      page,
      pageSize,
      filter: JSON.stringify(buildFilter(filter)),
      fields: ARCHIVE_LIST_KEYS.join(','),
      // NocoBase 的排序参数是重复键 `sort=-created_at&sort=-id`；
      // 用数组形式写在这里，避免某些网关对重复键的处理差异。
      sort: '-created_at',
    });
    return listRequest<ArchiveRow>(path);
  },

  /** 单条（原生 get，服务端按门店裁） */
  async get(id: number | string): Promise<ArchiveRow | null> {
    const row = await request<ArchiveRow>(qs('/serviceArchives:get', { filterByTk: id }));
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const k of ARCHIVE_LIST_KEYS) if (k in row) out[k] = (row as any)[k];
    // ⚠️ `notes`（内部备注）与 `customer_mobile_visible` **不在** ARCHIVE_LIST_KEYS 里：
    //    前者刻意不进列表投影（见上方白名单注释），后者是服务端追加的判定标记。
    //    但详情页两样都要：`notes` 用于展示内部备注，`visible` 用于区分
    //    "无权限看不到号码"与"客户没填号码"。所以单独补两个键。
    if ('notes' in (row as any)) out.notes = (row as any).notes;
    if ('customer_mobile_visible' in (row as any)) {
      out.customer_mobile_visible = (row as any).customer_mobile_visible;
    }
    return out as unknown as ArchiveRow;
  },

  /** 暖通阶段（`svc:archiveStageList`，含每阶段照片数；不下发 storage_key） */
  async stages(archiveId: number | string): Promise<ArchiveStageRow[]> {
    const r = await request<any>(qs('/svc:archiveStageList', { filterByTk: archiveId }));
    const list = Array.isArray(r?.stages) ? r.stages : Array.isArray(r) ? r : [];
    return list.map((s: any) => ({
      id: Number(s.id),
      stage_code: String(s.stage_code ?? ''),
      stage_order: Number(s.stage_order ?? 0),
      status: String(s.status ?? ''),
      done_at: s.done_at ?? null,
      note: s.note ?? null,
      photo_count: Number(s.photo_count ?? 0),
      // R2.2.1 新增：现场操作所需（见 ArchiveStageRow 注释）
      stage_date: s.stage_date ?? null,
      completed_at: s.completed_at ?? null,
      version: Number(s.version ?? 0),
      withdraw_reason: s.withdraw_reason ?? null,
      photo_required: typeof s.photo_required === 'boolean' ? s.photo_required : undefined,
      photo_max: Number.isFinite(Number(s.photo_max)) ? Number(s.photo_max) : undefined,
    }));
  },

  /**
   * 完成某个暖通阶段（R2.2.1 移动端现场操作）。
   *
   * ⚠️ `expected_version` 是**必传**：服务端用它做乐观锁。
   *    不带或传错 ⇒ 409 `ARCHIVE_STAGE_STALE`。这正是"两个师傅同时点完成"。
   *
   * ⚠️ 照片必填由**服务端**判（`ARCHIVE_STAGE_PHOTO_REQUIRED`）：
   *    前端只做提前提示（少一次"填完被拒"），判定权不在前端。
   */
  async completeStage(
    archiveId: number | string,
    stageCode: string,
    input: { stage_date: string; note?: string | null; expected_version: number },
    requestId: string,
  ): Promise<ArchiveStageMutationResult> {
    return request(qs('/svc:archiveStageComplete', { filterByTk: archiveId, stage_code: stageCode }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /**
   * **修改**已完成阶段的施工日期与备注（R2.2.1 §七）。
   *
   * 🔴 与 `withdrawStage` 的本质区别（务必别混用）：
   *    · 本方法：只写 `stage_date` / `note`；`status` 保持 `done`；
   *      **后续阶段不动**；照片**保持发布**；档案 status 不动。
   *    · `withdrawStage`：status → withdrawn，**连锁撤回**其后所有已完成阶段，
   *      照片全部 unpublished，若原状态 accepted 则退回 completed。
   *
   *    所以"把修改做成撤回的改名按钮"不是文案问题：员工改一句备注，
   *    客户看到的进度会整条倒退回去，而界面上只写着"批量撤回成功"。
   *
   * ⚠️ `expected_version` 是乐观锁（服务端把 status 一起写进 WHERE）：
   *    不带或传旧值 ⇒ 409 `ARCHIVE_STAGE_STALE`。
   */
  async updateStage(
    archiveId: number | string,
    stageCode: string,
    input: { stage_date?: string | null; note?: string | null; expected_version: number },
    requestId: string,
  ): Promise<{ stage: any; changed: string[] }> {
    return request(qs('/svc:archiveStageUpdate', { filterByTk: archiveId, stage_code: stageCode }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /**
   * 撤回某个暖通阶段（连锁撤回其后所有已完成阶段）。
   *
   * ⚠️ 服务端会**同时**把后续阶段的照片下架（`published=false`），并在同一事务里完成。
   *    前端不要自己"顺手"处理照片，否则会出现"阶段撤回了但照片还对外可见"的半提交状态。
   *
   * ⚠️ `reason` 必填（服务端 `ARCHIVE_STAGE_MISSING_REASON` 400）。
   *    原因不是走形式：撤回会连锁影响后面几个阶段，事后必须能说清"为什么退回去"。
   */
  async withdrawStage(
    archiveId: number | string,
    stageCode: string,
    input: { reason: string; expected_version: number },
    requestId: string,
  ): Promise<ArchiveStageMutationResult> {
    return request(qs('/svc:archiveStageWithdraw', { filterByTk: archiveId, stage_code: stageCode }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /**
   * 给某个阶段上传一张现场照片。
   *
   * ⚠️ multipart 的文本字段（`stage_id` / `photo_type`）必须**跟在 FormData 里**，
   *    不能走 query —— 服务端 `archivePhotoAttach` 读的是 `ctx.request.body`
   *    （multer 解析后的位置）。写成 query 会静默变成 null，
   *    照片就挂到"档案级"而不是"阶段级"，而阶段照片数恒为 0 ⇒ 永远完成不了。
   *
   * ⚠️ 不要设 `Content-Type`：必须让 fetch 自己算 multipart 的 boundary。
   *    手工写 `multipart/form-data`（不带 boundary）是这类"选了图上传不上"的头号原因。
   */
  async attachStagePhoto(
    archiveId: number | string,
    input: { stage_id: number; file: File; photo_type?: string },
    requestId: string,
  ): Promise<{ photo: ArchivePhotoRow }> {
    const form = new FormData();
    form.append('stage_id', String(input.stage_id));
    form.append('photo_type', input.photo_type ?? 'stage');
    form.append('file', input.file, input.file.name || 'photo.jpg');
    return upload(qs('/svc:archivePhotoAttach', { filterByTk: archiveId }), form, {
      requestId,
      timeoutMs: 60_000,
    });
  },

  /**
   * 移除一张阶段照片（R2.2.1 §七 / §九）。
   *
   * ⚠️ 这是**真删**（行 + 文件），不是"取消发布"。
   *    取消发布（`archivePhotoPublish(published=false)`）是撤回语义，
   *    照片仍留在内部列表里 —— 员工点「移除」想要的是"这张传错了，删掉"。
   *
   * ⚠️ 必需照片数不能变零：服务端会在删之前重新数一次本阶段剩余张数，
   *    低于下限返回 409 `ARCHIVE_STAGE_PHOTO_REQUIRED`。
   *    正确做法是**先传替换照片，再移除旧照片**（UI 层已禁用违规删除）。
   */
  async removeStagePhoto(
    archiveId: number | string,
    photoId: number,
    requestId: string,
  ): Promise<{ removed: number; stage_id: number | null; remaining: number }> {
    return request(qs('/svc:archivePhotoRemove', { filterByTk: archiveId, photo_id: photoId }), {
      method: 'POST',
      body: {},
      withRequestId: true,
      requestId,
    });
  },

  /**
   * 照片清单（投影不含 storage_key；取二进制走 `photoFile`）。
   *
   * 🔴 `stage_id` 是**唯一事实**，`stage_code` 是派生值 —— 2026-11-19 实测踩到：
   *    服务端 `archivePhotoService.project()` 返回的是
   *    `{id, archive_id, stage_id, photo_type, mime, byte_size, width, height, published, uploaded_at}`，
   *    **没有 `stage_code`**。而移动端历史上直接读 `p.stage_code` ⇒ 恒为 null ⇒
   *    「阶段面板按 stage_code 过滤照片」永远得到空数组。
   *
   *    后果不是报错，而是**看起来正常的空状态**：
   *    修改阶段面板显示「现场照片 0/6」，而库里明明有 1 张 ——
   *    用户会以为"照片丢了"，甚至重新上传（把必需照片数推高）。
   *    这正是本轮 §九「照片组件要显示真实缩略图，不要只显示数量」要防的那类假象。
   *
   *    ⇒ 这里用 `stages` 入参把 `stage_id → stage_code` 映射出来。
   *      不传就保持 null（调用方自己知道没有阶段上下文，例如"全部照片"视图），
   *      **不猜**。字段名也一并对齐服务端：`published` / `uploaded_at`。
   */
  async photos(
    archiveId: number | string,
    stages?: Array<{ id: number; stage_code: string }>,
  ): Promise<ArchivePhotoRow[]> {
    const r = await request<any>(qs('/svc:archivePhotoList', { filterByTk: archiveId }));
    const list = Array.isArray(r?.photos) ? r.photos : Array.isArray(r) ? r : [];
    const codeOfStage = new Map<number, string>();
    for (const s of stages ?? []) {
      if (s?.id != null && s?.stage_code) codeOfStage.set(Number(s.id), String(s.stage_code));
    }
    return list.map((p: any) => {
      const stageId = p.stage_id === null || p.stage_id === undefined ? null : Number(p.stage_id);
      return {
        id: Number(p.id),
        stage_id: Number.isFinite(stageId as number) ? (stageId as number) : null,
        photo_type: String(p.photo_type ?? ''),
        // 优先用服务端将来可能补上的 stage_code；当前服务端没有 ⇒ 走映射表
        stage_code: p.stage_code ?? (stageId !== null ? codeOfStage.get(stageId!) ?? null : null),
        mime: String(p.mime ?? ''),
        width: p.width ?? null,
        height: p.height ?? null,
        is_public: Boolean(p.is_public ?? p.published),
        created_at: p.created_at ?? p.uploaded_at ?? null,
      };
    });
  },

  /**
   * 建档。
   *
   * ⚠️ `requestId` 是**幂等键**（服务端用 `${userId}:${requestId}` 做唯一约束）。
   *    同一次用户点击必须复用同一个 requestId；换一个就真的建第二张档案。
   *    ⇒ 由调用方在"打开表单那一刻"生成一次并保存，提交成功后丢弃。
   */
  async create(input: ArchiveCreateInput, requestId: string): Promise<{ archive: any }> {
    return request('/svc:archiveCreate', {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 发布（只改 visibility，不碰进度） */
  async publish(archiveId: number, requestId: string): Promise<void> {
    await request(qs('/svc:archivePublish', { filterByTk: archiveId }), {
      method: 'POST',
      body: {},
      withRequestId: true,
      requestId,
    });
  },
};

export interface ArchivePhotoRow {
  id: number;
  /** 阶段 id（服务端投影的**真实字段**；`stage_code` 只是派生） */
  stage_id?: number | null;
  photo_type: string;
  /** 由 `stage_id` 映射得到；无阶段上下文时为 null */
  stage_code: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  is_public: boolean;
  created_at: string | null;
}
