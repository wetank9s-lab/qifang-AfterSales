/**
 * UX-01D M1：客户页面装修的**受控读写**（`svc:uiTheme*`）。
 *
 * =============================================================================
 * 权限模型（用户 M1 裁决 · 与 UX-01C 同一口径）
 * =============================================================================
 *   · **只有 `hq_admin`**（`CAPABILITY.ADMIN`）能读草稿、保存、预览、发布、回滚；
 *   · `hq_after_sales` / `store_*` / `viewer` **一律 403**（读也不行 —— 草稿是本轮
 *     尚未对外生效的内容，不是"只读资料"）；
 *   · 匿名 **401**（这些是 `loggedIn` ACL，未登录进不来）。
 *
 *   ⚠️ 两张表**都不开放原生 CRUD**（包括 hq_admin）：写只走本文件的动作，
 *      读也只走这里。否则"绕过发布审核直接改表"会变成一条合法路径，
 *      而发布/回滚/审计的全部保证都建立在"只有一条写入口"上。
 *
 * =============================================================================
 * 并发 / 幂等 / 事务（与 UX-01C 相同纪律，但**多了版本维度**）
 * =============================================================================
 *   · 保存：`expected_revision` 乐观锁（条件更新把 revision 压进 WHERE）；
 *   · 发布：行锁 + `UNIQUE(scope, version)`；`expected_revision` 不符 ⇒ 409；
 *   · 幂等：同 `request_id` + 内容相同 ⇒ 回放；内容不同 ⇒ 409 `IDEMPOTENT_PAYLOAD_MISMATCH`；
 *   · **原子性**：插入 release 与更新草稿在**同一事务**；任一步失败 ⇒ 线上版本不变。
 */
import { CAPABILITY } from '../../services/permission-service';
import {
  DEFAULT_UI_DOC,
  diffUiDoc,
  mintPreviewToken,
  normalizeUiDoc,
  publishUiTheme,
  readDraftUiTheme,
  readPreviewUiTheme,
  readPublishedUiTheme,
  rollbackUiTheme,
  saveUiThemeDraft,
  UI_THEME_SCOPE,
  type UiDocDiffItem,
} from '../../services/page-theme';
import { ValidationError } from '../../services/ticket-service';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramPresence,
  requireRequestId,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

export interface UiThemeDeps extends SvcActionDeps {
  /** 直连 db：本组动作要开事务、取行锁、读两张新表（services 图里刻意不挂原始句柄） */
  db: any;
}

const MAX_NOTE = 100;

function intOf(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError('UI_THEME_BAD_INT', `${label} 必须是非负整数（实际 ${JSON.stringify(raw ?? null)}）`);
  }
  return n;
}

function noteOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const text = String(raw).trim();
  if (Array.from(text).length > MAX_NOTE) {
    throw new ValidationError('UI_THEME_NOTE_TOO_LONG', `发布说明最多 ${MAX_NOTE} 个字符`);
  }
  if (/[<>]/.test(text)) {
    throw new ValidationError('UI_THEME_NOTE_CHARS', '发布说明不能包含 < 或 >');
  }
  return text;
}

export function createUiThemeHandlers(deps: UiThemeDeps): Record<string, ActionHandler> {
  const { services, logger, db } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  const assertAdmin = (actor: any) => permissions.assertCapability(actor, CAPABILITY.ADMIN);

  const runInTransaction = async <T>(fn: (t: any) => Promise<T>): Promise<T> => {
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      throw new ValidationError('UI_THEME_TX_UNAVAILABLE', '数据库事务不可用，写入已中止', 500);
    }
    return sequelize.transaction(fn);
  };

  /** 读：草稿 + 线上版本 + 两者差异（差异由服务端算，前端只显示） */
  const uiThemeDraft = wrap('uiThemeDraft', async (ctx, actor) => {
    assertAdmin(actor);
    const draft = await readDraftUiTheme(db, UI_THEME_SCOPE);
    const published = await readPublishedUiTheme(db, UI_THEME_SCOPE);
    const diff: UiDocDiffItem[] = draft
      ? diffUiDoc(published?.doc ?? DEFAULT_UI_DOC, draft.doc)
      : [];

    ok(ctx, {
      scope: UI_THEME_SCOPE,
      defaults: DEFAULT_UI_DOC,
      draft,
      published: published
        ? { version: published.version, doc: published.doc, published_at: published.published_at }
        : null,
      diff,
    });
  });

  /** 保存草稿：乐观锁 + 幂等 */
  const uiThemeSave = wrap('uiThemeSave', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'uiThemeSave');
    if (!requestId) return;
    assertAdmin(actor);

    const doc = normalizeUiDoc(param(ctx, 'doc'));
    const expectedRevision = intOf(param(ctx, 'expected_revision'), 'expected_revision');

    const result = await runInTransaction((t) =>
      saveUiThemeDraft(db, {
        t,
        doc,
        expectedRevision,
        requestId,
        actorUserId: Number(actor.userId) || null,
      }),
    );

    const published = await readPublishedUiTheme(db, UI_THEME_SCOPE);
    logger.info?.(
      `[svc:uiThemeSave] 草稿保存为 v${result.revision}` +
        `${result.replayed ? '（幂等回放）' : ''}，线上仍是 v${published?.version ?? 0}`,
    );
    ok(ctx, {
      data: {
        revision: result.revision,
        base_version: result.base_version,
        replayed: result.replayed,
        diff: diffUiDoc(published?.doc ?? DEFAULT_UI_DOC, doc),
      },
    });
  });

  /** 发布：整份快照 + 原子 + 幂等 */
  const uiThemePublish = wrap('uiThemePublish', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'uiThemePublish');
    if (!requestId) return;
    assertAdmin(actor);

    const expectedRevision = intOf(param(ctx, 'expected_revision'), 'expected_revision');
    const note = noteOf(param(ctx, 'note'));

    const result = await runInTransaction((t) =>
      publishUiTheme(db, {
        t,
        expectedRevision,
        requestId,
        actorUserId: Number(actor.userId) || null,
        note,
      }),
    );

    logger.info?.(
      `[svc:uiThemePublish] 已发布 v${result.version}` +
        `${result.replayed ? '（幂等回放）' : ''}，发布人 ${actor.userId}`,
    );
    ok(ctx, {
      data: {
        version: result.version,
        published_at: result.published_at,
        replayed: result.replayed,
      },
    });
  });

  /** 回滚：以旧快照再发一版，不改写历史 */
  const uiThemeRollback = wrap('uiThemeRollback', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'uiThemeRollback');
    if (!requestId) return;
    assertAdmin(actor);

    const toVersion = Number(param(ctx, 'to_version'));
    if (!Number.isInteger(toVersion) || toVersion <= 0) {
      throw new ValidationError('UI_THEME_BAD_VERSION', `to_version 必须是正整数（实际 ${JSON.stringify(param(ctx, 'to_version') ?? null)}）`);
    }
    const note = noteOf(param(ctx, 'note'));

    const result = await runInTransaction((t) =>
      rollbackUiTheme(db, {
        t,
        toVersion,
        requestId,
        actorUserId: Number(actor.userId) || null,
        note,
      }),
    );

    logger.warn?.(
      `[svc:uiThemeRollback] 回滚到 v${result.rolled_back_from} ⇒ 新版本 v${result.version}` +
        `${result.replayed ? '（幂等回放）' : ''}`,
    );
    ok(ctx, {
      data: {
        version: result.version,
        published_at: result.published_at,
        rolled_back_from: result.rolled_back_from,
        replayed: result.replayed,
      },
    });
  });

  /** 发布历史（含快照，供后台展示 diff） */
  const uiThemeReleases = wrap('uiThemeReleases', async (ctx, actor) => {
    assertAdmin(actor);
    const limitRaw = Number(param(ctx, 'limit') ?? 20);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;

    const rows = await db.getRepository('pageThemeReleases').find({
      filter: { scope: UI_THEME_SCOPE },
      sort: ['-version'],
      limit,
      appends: ['published_by_user'],
    });

    ok(ctx, {
      releases: (rows ?? []).map((row: any) => {
        const p = typeof row.toJSON === 'function' ? row.toJSON() : row;
        const user = p.published_by_user
          ? typeof p.published_by_user.toJSON === 'function'
            ? p.published_by_user.toJSON()
            : p.published_by_user
          : null;
        return {
          version: Number(p.version),
          doc: p.doc,
          published_at: p.published_at ? new Date(p.published_at).toISOString() : null,
          published_by: user ? String(user.nickname ?? user.username ?? user.email ?? '') : null,
          note: p.note ?? null,
          rolled_back_from: p.rolled_back_from ?? null,
        };
      }),
    });
  });

  /** 签发预览凭证（10 分钟，绑定签发者与当前 revision） */
  const uiThemePreview = wrap('uiThemePreview', async (ctx, actor) => {
    assertAdmin(actor);
    const draft = await readDraftUiTheme(db, UI_THEME_SCOPE);
    if (!draft) {
      fail(ctx, 422, 'UI_THEME_NO_DRAFT', '还没有草稿可预览（请先保存一次）');
      return;
    }
    const minted = mintPreviewToken({
      userId: Number(actor.userId),
      revision: draft.revision,
      scope: UI_THEME_SCOPE,
    });
    ok(ctx, {
      token: minted.token,
      expires_at: minted.expires_at,
      revision: draft.revision,
    });
  });

  /**
   * **消费**预览凭证（受控、需登录、需 hq_admin）。
   *
   * 为什么不在匿名接口上消费：
   *   匿名接口只能验 HMAC —— 凭证被复制到别处仍可用，且无法回答"是谁在看"。
   *   这里强制：① 已登录；② `CAPABILITY.ADMIN`（hq_admin）；③ **签发者 == 当前登录人**；
   *   ④ revision 仍是最新（否则 409）。四条同时成立才返回草稿。
   *
   * 页面侧（后台 iframe）拿到 doc 后用 `postMessage` 交给 H5 ——
   * 凭证因此**从不进入 H5 页面上下文**，也不会出现在 URL / 日志 / Referer 里。
   */
  const uiThemePreviewDoc = wrap('uiThemePreviewDoc', async (ctx, actor) => {
    assertAdmin(actor);
    const presence = paramPresence(ctx, ['token']);
    const token = presence.present ? String(presence.raw ?? '') : '';
    const view = await readPreviewUiTheme(db, token, Number(actor.userId));
    ok(ctx, {
      preview: true,
      revision: view.revision,
      expires_at: view.expires_at,
      store: view.store,
      doc: {
        version: 0,
        schema_version: view.doc.schema_version,
        brand: view.doc.brand,
        theme: view.doc.theme,
        copy: view.doc.copy,
        modules: view.doc.modules,
      },
    });
  });

  return {
    uiThemeDraft,
    uiThemeSave,
    uiThemePublish,
    uiThemeRollback,
    uiThemeReleases,
    uiThemePreview,
    uiThemePreviewDoc,
  };
}
