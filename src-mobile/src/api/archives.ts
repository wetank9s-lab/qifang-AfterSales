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

import { listRequest, request, qs, type ListResult } from './http';

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
  public_note?: string | null;
}

export interface ArchiveStageRow {
  id: number;
  stage_code: string;
  stage_order: number;
  status: string;
  done_at: string | null;
  note: string | null;
  photo_count: number;
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
    }));
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
