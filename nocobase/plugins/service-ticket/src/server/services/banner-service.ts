/**
 * `banner-service` —— Banner 的**领域逻辑**（B-36）
 *
 * =============================================================================
 * 这个文件是 Banner "谁能看到什么"的**唯一事实来源**
 * =============================================================================
 *   两条判据各自只有一处实现，公开面与后台面**共用**：
 *     · `pickBannerForStore()` —— "这个门店该看哪张图"（门店 → 总部回退）；
 *     · `PUBLIC_BANNER_FILTER`  —— "什么算已发布"（两个条件：status + revoked_at）。
 *
 *   ⚠️ 刻意写成一处而不是"公开面查一次、后台面再查一次"：
 *      本仓库为"同一段逻辑两条腿"付过多次代价（见 docs/ENGINEERING-RULES.md 铁律 ④）。
 *      这里若分裂，典型后果是**下架后后台显示已下架、客户端还在放** ——
 *      而两边各自看都"对"。
 *
 * =============================================================================
 * 发布状态机（只有三个状态，刻意不做审批流）
 * =============================================================================
 *   DRAFT --publish--> PUBLISHED --revoke--> REVOKED
 *     ^                   |                     |
 *     +-----（重新上传）---+                     |
 *     +------------republish（从 REVOKED 恢复）--+
 *
 *   · `DRAFT`    ：上传完成但未发布 —— 客户**看不到**；
 *   · `PUBLISHED`：客户可见（且 `revoked_at IS NULL`）；
 *   · `REVOKED`  ：已下架 —— 客户**立刻**看不到，行保留供审计（`revoked_at` 留痕）。
 */
import { ValidationError } from './ticket-service';
import { BANNER_STATUS, PUBLIC_BANNER_FILTER } from '../constants';

/**
 * 已发布且未下架 —— 公开面与门店回退**共用**的唯一过滤条件。
 *
 * ⚠️ 值本身定义在 `constants.ts`（与 collection 的下拉共用一份），
 *    这里只做**转发**，不是第二处定义。任何"改这里就够了"的想法都是错的：
 *    真正要改的是 constants.ts 里那一个对象。
 */
export { BANNER_STATUS, PUBLIC_BANNER_FILTER };

export type BannerStatus = (typeof BANNER_STATUS)[keyof typeof BANNER_STATUS];

export interface BannerRow {
  id: number;
  store_id: number | null;
  file_name: string;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  content_hash: string;
  status: BannerStatus;
  enabled: boolean;
  alt_text: string | null;
  published_at: string | null;
  revoked_at: string | null;
  uploaded_at: string;
}

function plain(row: any): any {
  return typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row ?? {}) };
}

/**
 * 公开面的**白名单投影**。
 *
 * ⚠️ 绝不返回 `storage_key`（与客户媒体的口径一致：路径是内部实现细节）、
 *    也不返回 id / 操作人 / 字节数 —— 客户端只需要 URL 与尺寸。
 */
export function publicBannerPayload(row: any, urlOf: (fileName: string) => string) {
  const p = plain(row);
  if (!p?.file_name) return null;
  return {
    url: urlOf(String(p.file_name)),
    width: p.width ?? null,
    height: p.height ?? null,
    alt: String(p.alt_text ?? '').trim() || null,
  };
}

/**
 * 选出门店该显示的 Banner。
 *
 * 判定顺序（**顺序本身就是规则**，与 H5 的"门店优先、总部回退"逐字对应）：
 *   ① 该门店自己的**已发布** Banner（`store_id = ?`，取最新一条）；
 *   ② 没有 ⇒ **总部通用**（`store_id IS NULL`，取最新一条）；
 *   ③ 都没有 ⇒ `null`（调用方**不渲染** Banner，也不留空白占位）。
 *
 * ⚠️ 步骤 ② 就是需求里的"总部通用 Banner 作为门店默认回退"，
 *    它**不需要**额外字段：`store_id IS NULL` 已经唯一表达了"通用"。
 */
export async function pickBannerForStore(db: any, storeId: number | null | undefined): Promise<any | null> {
  const repo = db.getRepository('storeBanners');
  const sid = Number(storeId);

  if (Number.isFinite(sid) && sid > 0) {
    const own = await repo.findOne({
      filter: { ...PUBLIC_BANNER_FILTER, store_id: sid, enabled: true },
      sort: ['-published_at', '-id'],
    });
    if (own) return own;
  }

  // 总部通用（store_id IS NULL）
  return repo.findOne({
    filter: { ...PUBLIC_BANNER_FILTER, store_id: null, enabled: true },
    sort: ['-published_at', '-id'],
  });
}

/**
 * 公开读的**二次确认**：给定文件名，返回**仅当它属于"已发布且未下架"的行时**的行。
 *
 * 这是"文件名不是权限"的落地：知道 URL ≠ 有权读。
 * 下架后（`revoked_at` 有值）即使 URL 没变，这里也会返回 null ⇒ 404。
 */
export async function findPublicBannerByFileName(db: any, fileName: string): Promise<any | null> {
  const name = String(fileName ?? '').trim();
  // 形态预筛：只接受本服务生成的名字（`banner-<16 hex>.<jpg|png|webp>`）。
  // 既挡了路径穿越，也避免把任意字符串带进查询。
  if (!/^banner-[0-9a-f]{16}\.(jpg|png|webp)$/.test(name)) return null;
  return db.getRepository('storeBanners').findOne({
    filter: { ...PUBLIC_BANNER_FILTER, enabled: true, file_name: name },
  });
}

// ---------------------------------------------------------------------------
// 状态流转（调用方负责事务与权限）
// ---------------------------------------------------------------------------

function assertTransition(from: string, to: string, allowed: Record<string, string[]>, action: string): void {
  const okTargets = allowed[from] ?? [];
  if (!okTargets.includes(to)) {
    throw new ValidationError(
      'BANNER_BAD_TRANSITION',
      `Banner 当前状态是 ${from}，不能执行「${action}」（允许：${okTargets.join(' / ') || '无'}）`,
      409,
    );
  }
}

/** 允许的状态流转（**白名单式**，不是"除 A 之外都行"） */
const TRANSITIONS: Record<string, string[]> = {
  [BANNER_STATUS.DRAFT]: [BANNER_STATUS.PUBLISHED],
  [BANNER_STATUS.PUBLISHED]: [BANNER_STATUS.REVOKED],
  [BANNER_STATUS.REVOKED]: [BANNER_STATUS.PUBLISHED],
};

export interface PublishInput {
  t: any;
  actorUserId?: number | null;
  requestId?: string | null;
}

/**
 * 发布：`DRAFT`/`REVOKED` → `PUBLISHED`。
 *
 * 幂等：已经是 `PUBLISHED` ⇒ **回放**（返回 `replayed: true`），不重复写时间戳。
 * 理由与 `pageThemeReleases` 一致：管理员双击"发布"不应产生第二次副作用。
 */
export async function publishBanner(db: any, bannerId: number, input: PublishInput): Promise<{ status: string; replayed: boolean }> {
  const repo = db.getRepository('storeBanners');
  const row = await repo.findOne({ filter: { id: bannerId }, transaction: input.t, lock: input.t.LOCK?.UPDATE });
  if (!row) throw new ValidationError('BANNER_NOT_FOUND', `Banner ${bannerId} 不存在`, 404);

  const p = plain(row);
  if (p.status === BANNER_STATUS.PUBLISHED && !p.revoked_at) {
    return { status: BANNER_STATUS.PUBLISHED, replayed: true };
  }
  assertTransition(String(p.status), BANNER_STATUS.PUBLISHED, TRANSITIONS, '发布');

  await repo.update({
    filter: { id: bannerId },
    values: {
      status: BANNER_STATUS.PUBLISHED,
      published_at: new Date(),
      revoked_at: null,
      published_by_user_id: input.actorUserId ?? null,
      request_id: input.requestId ?? null,
    },
    transaction: input.t,
  });
  return { status: BANNER_STATUS.PUBLISHED, replayed: false };
}

/**
 * 下架：`PUBLISHED` → `REVOKED`。
 *
 * 🔴 下架必须**立刻**对客户生效。生效方式不是删除行，而是写 `revoked_at` ——
 *    因为公开读的过滤条件里有 `revoked_at: null`，一写就不再被选中。
 *    这比"物理删除"更安全：留痕可审计，且不会因缓存/并发出现"删了但还在服务"。
 */
export async function revokeBanner(db: any, bannerId: number, input: PublishInput): Promise<{ status: string; replayed: boolean }> {
  const repo = db.getRepository('storeBanners');
  const row = await repo.findOne({ filter: { id: bannerId }, transaction: input.t, lock: input.t.LOCK?.UPDATE });
  if (!row) throw new ValidationError('BANNER_NOT_FOUND', `Banner ${bannerId} 不存在`, 404);

  const p = plain(row);
  if (p.status === BANNER_STATUS.REVOKED || p.revoked_at) {
    return { status: BANNER_STATUS.REVOKED, replayed: true };
  }
  assertTransition(String(p.status), BANNER_STATUS.REVOKED, TRANSITIONS, '下架');

  await repo.update({
    filter: { id: bannerId },
    values: { status: BANNER_STATUS.REVOKED, revoked_at: new Date(), request_id: input.requestId ?? null },
    transaction: input.t,
  });
  return { status: BANNER_STATUS.REVOKED, replayed: false };
}
