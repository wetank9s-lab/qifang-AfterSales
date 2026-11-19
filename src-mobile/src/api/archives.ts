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
  service_address: string | null;
  service_type: string | null;
  product_description: string | null;
  package_description: string | null;
  purchase_date: string | null;
  planned_date: string | null;
  assigned_worker: string | null;
  public_note: string | null;
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

  /** 照片清单（投影不含 storage_key；取二进制走 `photoFile`） */
  async photos(archiveId: number | string): Promise<ArchivePhotoRow[]> {
    const r = await request<any>(qs('/svc:archivePhotoList', { filterByTk: archiveId }));
    const list = Array.isArray(r?.photos) ? r.photos : Array.isArray(r) ? r : [];
    return list.map((p: any) => ({
      id: Number(p.id),
      photo_type: String(p.photo_type ?? ''),
      stage_code: p.stage_code ?? null,
      mime: String(p.mime ?? ''),
      width: p.width ?? null,
      height: p.height ?? null,
      is_public: Boolean(p.is_public),
      created_at: p.created_at ?? null,
    }));
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
  photo_type: string;
  stage_code: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  is_public: boolean;
  created_at: string | null;
}
