/**
 * B-36：客户报修页 Banner 的**后台管理动作**（`svc:banner*`）。
 *
 * =============================================================================
 * 授权链（固定顺序，缺一不可）
 * =============================================================================
 *   ① 登录身份（ACL 已要求 `loggedIn`，匿名不可达）；
 *   ② **配置权限**：`CAPABILITY.ADMIN`（hq_admin）**或** `CAPABILITY.WRITE_TICKET`
 *      （门店售后 / 总部售后）—— 用户要求"上传接口必须验证管理员或门店配置权限"；
 *   ③ **门店归属**：非总部角色只能对自己的授权门店操作
 *      （复用 `permissions.assertStoreInScope`，与建单/转店是**同一份**范围判据）；
 *      `store_id` 为空（总部通用）**只有** `CAPABILITY.ADMIN` 能创建/发布。
 *
 * ⚠️ 第 ③ 步刻意复用 `assertStoreInScope` 而不是自己查一遍门店归属：
 *    本仓库为"同一段判据两条腿"付过多次代价（docs/ENGINEERING-RULES.md 铁律 ④）。
 *    自己查一份的典型后果是：建单那边收紧了范围，Banner 这边还是旧的 —— 于是
 *    某个被移出授权范围的门店**仍能被改 Banner**。
 *
 * =============================================================================
 * 为什么写动作走这里而不是原生 CRUD
 * =============================================================================
 *   与 `pageThemeDrafts` 同口径：`store_banners` 的原生 CRUD 对业务角色全关。
 *   理由：本表有 `storage_key`（内部路径）与 `status`（发布状态机），
 *   放开原生写 = "绕过发布审核直接改表"变成一条合法路径，
 *   而"只有一条写入口"正是发布/下架全部保证的基础。
 */
import { koaMulter } from '@nocobase/utils';
import { memoryStorage } from 'multer';
import { CAPABILITY, ForbiddenError } from '../../services/permission-service';
import { publishBanner, revokeBanner, BANNER_STATUS } from '../../services/banner-service';
import { BANNER_MAX_BYTES, BannerFormatError, type BannerStore } from '../../services/banner-store';
import { ValidationError } from '../../services/ticket-service';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramsOf,
  requireRequestId,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

export interface BannerDeps extends SvcActionDeps {
  db: any;
  /** 独立公开 Banner 存储（**不是**客户媒体存储） */
  banners: BannerStore;
}

/** multipart 字段名。与 `publicMedia` 刻意不同：两个通道的字段名不该撞在一起 */
const BANNER_UPLOAD_FIELD = 'banner';

function intOf(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('BANNER_BAD_INT', `${label} 必须是正整数（实际 ${JSON.stringify(raw ?? null)}）`);
  }
  return n;
}

/** 解析 multipart 单文件（复用 koaMulter 写法，与 publicMedia / 师傅上传同构） */
async function readSingleUpload(ctx: any, maxSizeBytes: number) {
  if (!ctx?.request?.is?.('multipart/*')) return null;
  const middleware = koaMulter({ storage: memoryStorage(), limits: { files: 1, fileSize: maxSizeBytes } }).single(
    BANNER_UPLOAD_FIELD,
  );
  try {
    await middleware(ctx, async () => {});
  } catch (error: any) {
    if (error?.name === 'MulterError' && error?.code === 'LIMIT_FILE_SIZE') {
      throw new BannerFormatError(
        'BANNER_TOO_LARGE',
        `Banner 图片不能超过 ${Math.floor(maxSizeBytes / 1024 / 1024)}MB`,
        413,
      );
    }
    if (error?.name === 'MulterError') {
      throw new BannerFormatError('BANNER_UPLOAD_MALFORMED', `上传内容无法解析（${String(error?.code)}）`, 400);
    }
    throw error;
  }
  const file = ctx?.[BANNER_UPLOAD_FIELD] ?? ctx?.request?.file ?? null;
  if (!file || !file.buffer) return null;
  return file;
}

export function createBannerHandlers(deps: BannerDeps): Record<string, ActionHandler> {
  const { services, logger, db, banners } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  const runInTransaction = async <T>(fn: (t: any) => Promise<T>): Promise<T> => {
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      throw new ValidationError('BANNER_TX_UNAVAILABLE', '数据库事务不可用，写入已中止', 500);
    }
    return sequelize.transaction(fn);
  };

  /**
   * 谁能配置 Banner：总部管理员，或具备工单写能力的门店/总部售后。
   * ⚠️ `viewer` 不具备 `WRITE_TICKET` ⇒ 自然被挡（不需要额外枚举）。
   */
  const assertConfigCapability = (actor: any): void => {
    const isAdmin = permissions.can(actor, CAPABILITY.ADMIN);
    const canWrite = permissions.can(actor, CAPABILITY.WRITE_TICKET);
    if (!isAdmin && !canWrite) {
      throw new ForbiddenError(
        'BANNER_FORBIDDEN',
        '配置客户页 Banner 需要门店配置权限或总部管理员权限',
      );
    }
  };

  const isAdmin = (actor: any): boolean => permissions.can(actor, CAPABILITY.ADMIN);

  /**
   * 校验目标门店的归属。
   *   · `storeId` 为空 ⇒ 总部通用 Banner ⇒ **只有 hq_admin** 可操作；
   *   · `storeId` 有值 ⇒ 必须在该角色的授权门店范围内（复用统一判据）。
   */
  const assertStoreTarget = (actor: any, storeId: number | null): void => {
    if (storeId === null) {
      permissions.assertCapability(actor, CAPABILITY.ADMIN, '总部通用 Banner 只有总部管理员可以配置');
      return;
    }
    permissions.assertStoreInScope(actor, storeId, '配置 Banner');
  };

  // ------------------------------------------------------------------ 列表
  /** 后台列表：返回**该角色有权看到**的 Banner（含草稿与已下架，供管理） */
  const bannerList = wrap('bannerList', async (ctx, actor) => {
    assertConfigCapability(actor);
    const scope = permissions.scopeOf(actor);
    const repo = db.getRepository('storeBanners');

    // 总部管理员看全量；其余角色只看授权门店 + 总部通用（他们要看得到回退项）
    let filter: any = {};
    if (scope.kind !== 'all') {
      const ids = scope.kind === 'stores' ? scope.storeIds : [];
      filter = ids.length ? { $or: [{ store_id: { $in: ids } }, { store_id: null }] } : { store_id: null };
    }

    const rows = await repo.find({ filter, sort: ['-uploaded_at'], appends: ['store'] });

    // 「指定适用门店」下拉的数据源。
    //
    // 🔴 为什么**不**复用 `svc:storeOptions`（它确实存在，`actions/svc/ticket.ts:410`）：
    //    它回的是 `{options:[{code,name}]}` —— **没有主键 id**，而 `bannerUpload` 的
    //    `store_id` 必须是正整数主键（`permissions.assertStoreInScope` 也吃 id）。
    //    要复用它只有两条路，两条都比这里更糟：
    //      ① 给 `storeOptions` 加 `id` ⇒ 会撞 `verify-store-workflow-paths.mjs` 的
    //         "只回 code/name" 断言 —— **放宽既有门禁**正是本仓库明令不许的；
    //      ② 把 `bannerUpload` 的入参从 id 改成 code ⇒ 改一条已在跑的契约
    //         （e2e 探针与前端都按 `store_id` 写），收益却只是少一次投影。
    //
    // ⚠️ 关键：**范围判据没有第二条腿**。这里用的是**上面同一个** `scope`（`scopeOf(actor)`），
    //    与 `storeOptions` 是同一个来源 ⇒ 不会出现"下拉里有、点下去 403"的分叉
    //    （铁律 ④ 防的是判据分叉，不是"同一份数据少一次投影"）。
    // ⚠️ 与 `storeOptions` 同口径**只给启用门店**：停用门店放上去建出来也没人看得到。
    const activeFilter = { active: true };
    const storesRepo = db.getRepository('stores');
    let storeOptions: Array<{ id: number; name: string }> = [];
    if (scope.kind === 'all') {
      const stores = await storesRepo.find({ filter: activeFilter, sort: ['sort_order'] });
      storeOptions = (stores ?? []).map((s: any) => {
        const p = typeof s?.toJSON === 'function' ? s.toJSON() : { ...(s ?? {}) };
        return { id: Number(p.id), name: String(p.name ?? '') };
      });
    } else if (scope.kind === 'stores') {
      const stores = await storesRepo.find({
        filter: { ...activeFilter, id: { $in: scope.storeIds } },
        sort: ['sort_order'],
      });
      storeOptions = (stores ?? []).map((s: any) => {
        const p = typeof s?.toJSON === 'function' ? s.toJSON() : { ...(s ?? {}) };
        return { id: Number(p.id), name: String(p.name ?? '') };
      });
    }
    // `scope.kind === 'none'` ⇒ 空数组（它连"总部通用"都没权限，见 `assertStoreTarget`）

    const items = rows.map((row: any) => {
      const p = typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row ?? {}) };
      const store = p.store ? (typeof p.store.toJSON === 'function' ? p.store.toJSON() : p.store) : null;
      return {
        id: Number(p.id),
        store_id: p.store_id ?? null,
        store_name: store ? String(store.name ?? '') : null,
        file_name: String(p.file_name),
        mime: String(p.mime),
        byte_size: Number(p.byte_size),
        width: p.width ?? null,
        height: p.height ?? null,
        status: String(p.status),
        enabled: p.enabled !== false,
        alt_text: p.alt_text ?? null,
        published_at: p.published_at ? new Date(p.published_at).toISOString() : null,
        revoked_at: p.revoked_at ? new Date(p.revoked_at).toISOString() : null,
        uploaded_at: p.uploaded_at ? new Date(p.uploaded_at).toISOString() : null,
        // 预览 URL 用公开路径 —— 后台预览走的就是客户那条路（**同一条腿**，
        // 避免"后台看着好、客户看不到"这类只在发布后才暴露的差异）
        preview_url: `/api/public/banner/${encodeURIComponent(String(p.file_name))}`,
      };
    });
    ok(ctx, { items, store_options: storeOptions, can_manage_global: isAdmin(actor) });
  });

  // ------------------------------------------------------------------ 上传
  /** 上传一张 Banner（落 `DRAFT`，需再调 publish 才对客户生效） */
  const bannerUpload = wrap('bannerUpload', async (ctx, actor) => {
    assertConfigCapability(actor);
    const requestId = requireRequestId(ctx, 'bannerUpload');
    if (!requestId) return;

    const file = await readSingleUpload(ctx, BANNER_MAX_BYTES);
    if (!file) {
      throw new ValidationError('BANNER_NO_FILE', `请以 multipart 上传字段「${BANNER_UPLOAD_FIELD}」提供图片`, 422);
    }

    // 门店定向：`store_id` 可空（总部通用）。读 query 或 body。
    const rawStore = param(ctx, 'store_id') ?? paramsOf(ctx)?.values?.store_id;
    const storeId = rawStore === undefined || rawStore === null || rawStore === '' ? null : intOf(rawStore, 'store_id');
    assertStoreTarget(actor, storeId);

    // 目标门店必须存在且启用（否则会建出一张永远无人看到的 Banner）
    if (storeId !== null) {
      const store = await db.getRepository('stores').findOne({ filter: { id: storeId } });
      if (!store) throw new ValidationError('BANNER_STORE_NOT_FOUND', `门店 ${storeId} 不存在`, 422);
    }

    // 校验 + 落盘（嗅探/尺寸/指纹都在 store 里做，**不看扩展名与 Content-Type**）
    const stored = await banners.save({
      buffer: file.buffer,
      declaredMime: file.mimetype ?? null,
      originalName: file.originalname ?? null,
    });

    const altRaw = param(ctx, 'alt_text');
    const altText = altRaw === undefined ? null : String(altRaw).trim().slice(0, 120) || null;

    const repo = db.getRepository('storeBanners');
    const result = await runInTransaction(async (t) => {
      // 同店同内容已存在 ⇒ 复用那一行（不重复建行），与 store.save 的 reused 语义对齐
      const existing = await repo.findOne({
        filter: { store_id: storeId, content_hash: stored.contentHash },
        transaction: t,
      });
      if (existing) {
        const p = typeof existing?.toJSON === 'function' ? existing.toJSON() : { ...existing };
        return { id: Number(p.id), reused: true, status: String(p.status), file_name: String(p.file_name) };
      }
      const created = await repo.create({
        values: {
          store_id: storeId,
          file_name: stored.fileName,
          storage_key: stored.storageKey,
          mime: stored.mime,
          byte_size: stored.byteSize,
          width: stored.width,
          height: stored.height,
          content_hash: stored.contentHash,
          status: BANNER_STATUS.DRAFT,
          enabled: true,
          alt_text: altText,
          uploaded_by_user_id: actor.userId ?? null,
          uploaded_at: new Date(),
          request_id: requestId,
        },
        transaction: t,
      });
      const p = typeof created?.toJSON === 'function' ? created.toJSON() : { ...created };
      return { id: Number(p.id), reused: false, status: String(p.status), file_name: String(p.file_name) };
    });

    ok(ctx, {
      id: result.id,
      status: result.status,
      reused: result.reused,
      file_name: result.file_name,
      mime: stored.mime,
      width: stored.width,
      height: stored.height,
      byte_size: stored.byteSize,
      // 未发布 ⇒ 预览 URL 此时还读不到（公开面只服务已发布）。后台列表统一给 URL，
      // 这里额外说明"发布后才可见"，避免管理员以为上传即生效。
      preview_available_after_publish: true,
    });
  });

  // ------------------------------------------------------------------ 发布
  const bannerPublish = wrap('bannerPublish', async (ctx, actor) => {
    assertConfigCapability(actor);
    const requestId = requireRequestId(ctx, 'bannerPublish');
    if (!requestId) return;
    const id = intOf(param(ctx, 'banner_id') ?? paramsOf(ctx)?.filterByTk, 'banner_id');

    const row = await db.getRepository('storeBanners').findOne({ filter: { id } });
    if (!row) throw new ValidationError('BANNER_NOT_FOUND', `Banner ${id} 不存在`, 404);
    const p = typeof row?.toJSON === 'function' ? row.toJSON() : { ...row };
    assertStoreTarget(actor, p.store_id ?? null);

    const result = await runInTransaction((t) =>
      publishBanner(db, id, { t, actorUserId: actor.userId ?? null, requestId }),
    );
    logger?.info?.(`[svc:bannerPublish] Banner ${id} → ${result.status}${result.replayed ? '（回放）' : ''}`);
    ok(ctx, { id, status: result.status, replayed: result.replayed, file_name: String(p.file_name) });
  });

  // ------------------------------------------------------------------ 下架
  const bannerRevoke = wrap('bannerRevoke', async (ctx, actor) => {
    assertConfigCapability(actor);
    const requestId = requireRequestId(ctx, 'bannerRevoke');
    if (!requestId) return;
    const id = intOf(param(ctx, 'banner_id') ?? paramsOf(ctx)?.filterByTk, 'banner_id');

    const row = await db.getRepository('storeBanners').findOne({ filter: { id } });
    if (!row) throw new ValidationError('BANNER_NOT_FOUND', `Banner ${id} 不存在`, 404);
    const p = typeof row?.toJSON === 'function' ? row.toJSON() : { ...row };
    assertStoreTarget(actor, p.store_id ?? null);

    const result = await runInTransaction((t) => revokeBanner(db, id, { t, requestId }));
    logger?.info?.(`[svc:bannerRevoke] Banner ${id} → ${result.status}${result.replayed ? '（回放）' : ''}`);
    ok(ctx, { id, status: result.status, replayed: result.replayed });
  });

  return { bannerList, bannerUpload, bannerPublish, bannerRevoke };
}
