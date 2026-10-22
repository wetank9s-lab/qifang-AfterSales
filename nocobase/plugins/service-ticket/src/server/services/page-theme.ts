/**
 * `page-theme` —— 客户 H5 装修配置的**领域服务**（UX-01D M1）。
 *
 * =============================================================================
 * 这个文件是装修配置的**唯一事实来源**
 * =============================================================================
 *   · 默认值（`DEFAULT_UI_DOC`）—— H5 内置兜底与门禁比对都读它；
 *   · 白名单与校验（`normalizeUiDoc`）—— 服务端与后台表单共用同一套规则；
 *   · 差异计算（`diffUiDoc`）—— 发布前的"实际变更"由服务端算，前端只负责显示；
 *   · 发布 / 回滚事务（`publishUiTheme` / `rollbackUiTheme`）—— 原子、幂等、乐观锁；
 *   · 预览凭证（`mintPreviewToken` / `verifyPreviewToken`）—— 短时、绑定签发者与 revision。
 *
 * =============================================================================
 * 三条不可退让的边界
 * =============================================================================
 *   1. **公开面只读已发布快照**：`readPublishedUiDoc()` 只取 `pageThemeReleases`
 *      中 version 最大的那一行；草稿只能经预览凭证读取。这是"改草稿不影响客户"的结构性保证。
 *   2. **不允许任意 CSS / HTML**：`preset` 是**枚举**，文案是纯文本（禁 `<` `>` 与控制字符）。
 *      没有"自定义颜色"、没有 `v-html`、没有样式字符串 —— 本工程没有 CSP 兜底，
 *      任何注入通道都等于开门。
 *   3. **发布必须整份快照切换**：不做"逐字段更新"。否则中途失败会让客户看到
 *      "新品牌 + 旧文案"的混合态，而这种半成品状态最难被发现（页面不报错）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenError, NotFoundError } from './permission-service';
import { StateConflictError, ValidationError } from './ticket-service';

/** 文档结构版本：以后加字段时靠它做兼容（未知键忽略、缺失键补默认） */
export const UI_DOC_SCHEMA_VERSION = 1;

/** v1 只有总部一套（用户 D1 决策：不做门店覆盖） */
export const UI_THEME_SCOPE = 'hq';

/** 主题预设：**唯一事实来源**。H5 侧每个预设对应 `base.css` 里一组 CSS 变量。 */
export const UI_THEME_PRESETS = [
  { value: 'classic-blue', label: '经典蓝', primary: '#2f6fed', contrastOnWhite: 4.55 },
  { value: 'brand-red', label: '品牌红', primary: '#c8362c', contrastOnWhite: 5.22 },
  { value: 'graphite', label: '石墨灰', primary: '#475569', contrastOnWhite: 7.58 },
] as const;

export type UiThemePreset = (typeof UI_THEME_PRESETS)[number]['value'];

export interface UiThemeDoc {
  schema_version: number;
  brand: { name: string; subtitle: string };
  theme: { preset: UiThemePreset };
  copy: { media_help: string };
  modules: { media_help: boolean };
}

/**
 * 默认值 = **今天的 H5 长相**。
 *
 * ⚠️ 改这里等于改"没装修过的门店"的页面。门禁 `verify-ux-01d-config` 会把它与
 *    H5 的 `src/ui-defaults.ts` 逐字段比对 —— 两处漂移会立刻变红。
 */
export const DEFAULT_UI_DOC: UiThemeDoc = {
  schema_version: UI_DOC_SCHEMA_VERSION,
  brand: {
    name: '四川七方连锁售后服务平台',
    subtitle: '',
  },
  theme: {
    preset: 'classic-blue',
  },
  copy: {
    media_help: '也可直接填写文字，任选一种即可说明问题。',
  },
  modules: {
    media_help: true,
  },
};

/** 字段在后台的中文名（发布 diff 与错误提示共用） */
const FIELD_LABELS: Record<string, string> = {
  'brand.name': '平台显示名称',
  'brand.subtitle': '副标题',
  'theme.preset': '主题预设',
  'copy.media_help': '媒体帮助文案',
  'modules.media_help': '显示媒体帮助条',
};

const PRESET_VALUES = UI_THEME_PRESETS.map((p) => p.value) as string[];

function bad(code: string, message: string): never {
  throw new ValidationError(code, message, 422);
}

/** 字符长度按**码点**算（`😀` 算 1 个字符，不是 2） */
function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 单行文本校验。
 *
 * 🔴 拒绝 `<` `>` 不是"洁癖"：本工程**没有 CSP**（后台是低代码动态渲染，
 *    `nginx/conf.d/service.conf` 里明确记录了这一取舍）。即便 H5 现在只用
 *    `{{ }}` 插值，也不能给未来留一条"某天有人加了 v-html"的引信。
 */
function normalizeText(
  raw: unknown,
  opts: { field: string; label: string; min: number; max: number },
): string {
  if (raw === undefined || raw === null) bad('UI_DOC_FIELD_MISSING', `「${opts.label}」不能为空`);
  if (typeof raw !== 'string') bad('UI_DOC_FIELD_TYPE', `「${opts.label}」必须是文本`);
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    bad('UI_DOC_FIELD_CHARS', `「${opts.label}」不能包含换行、制表符等控制字符`);
  }
  if (/[<>]/.test(text)) {
    bad('UI_DOC_FIELD_CHARS', `「${opts.label}」不能包含 < 或 >（页面按纯文本渲染）`);
  }
  const len = charLength(text);
  if (len < opts.min) {
    bad('UI_DOC_FIELD_RANGE', `「${opts.label}」至少 ${opts.min} 个字符（当前 ${len}）`);
  }
  if (len > opts.max) {
    bad('UI_DOC_FIELD_RANGE', `「${opts.label}」最多 ${opts.max} 个字符（当前 ${len}）`);
  }
  return text;
}

function assertPlainObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    bad('UI_DOC_FIELD_TYPE', `「${label}」必须是对象`);
  }
  return value as Record<string, any>;
}

function assertKnownKeys(obj: Record<string, any>, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      bad('UI_DOC_UNKNOWN_FIELD', `${path}${key} 不是可配置项（M1 只允许白名单内的字段）`);
    }
  }
}

/**
 * 校验并归一化一份文档。
 *
 * 允许**部分提交**（缺的段/键用默认值补齐）—— 但**不允许未知键**：
 * "多传一个键"往往意味着前端版本比服务端新，静默忽略会让管理员以为改生效了。
 */
export function normalizeUiDoc(input: unknown): UiThemeDoc {
  const root = assertPlainObject(input, '配置');
  assertKnownKeys(root, ['schema_version', 'brand', 'theme', 'copy', 'modules'], '');

  if (root.schema_version !== undefined && root.schema_version !== UI_DOC_SCHEMA_VERSION) {
    bad(
      'UI_DOC_SCHEMA_UNSUPPORTED',
      `配置结构版本 ${JSON.stringify(root.schema_version)} 不受支持（当前 ${UI_DOC_SCHEMA_VERSION}）`,
    );
  }

  const brand = root.brand === undefined ? {} : assertPlainObject(root.brand, '品牌');
  assertKnownKeys(brand, ['name', 'subtitle'], 'brand.');
  const theme = root.theme === undefined ? {} : assertPlainObject(root.theme, '主题');
  assertKnownKeys(theme, ['preset'], 'theme.');
  const copy = root.copy === undefined ? {} : assertPlainObject(root.copy, '文案');
  assertKnownKeys(copy, ['media_help'], 'copy.');
  const modules = root.modules === undefined ? {} : assertPlainObject(root.modules, '模块');
  assertKnownKeys(modules, ['media_help'], 'modules.');

  const name = normalizeText(brand.name ?? DEFAULT_UI_DOC.brand.name, {
    field: 'brand.name',
    label: '平台显示名称',
    min: 2,
    max: 20,
  });
  const subtitle =
    brand.subtitle === undefined
      ? DEFAULT_UI_DOC.brand.subtitle
      : normalizeText(brand.subtitle, {
          field: 'brand.subtitle',
          label: '副标题',
          min: 0,
          max: 24,
        });

  const preset = String(theme.preset ?? DEFAULT_UI_DOC.theme.preset);
  if (!PRESET_VALUES.includes(preset)) {
    bad(
      'UI_DOC_FIELD_ENUM',
      `主题预设只能是 ${PRESET_VALUES.join(' / ')}（实际「${preset}」）`,
    );
  }

  const mediaHelp =
    copy.media_help === undefined
      ? DEFAULT_UI_DOC.copy.media_help
      : normalizeText(copy.media_help, {
          field: 'copy.media_help',
          label: '媒体帮助文案',
          min: 0,
          max: 40,
        });

  const showMediaHelp =
    modules.media_help === undefined ? DEFAULT_UI_DOC.modules.media_help : modules.media_help;
  if (typeof showMediaHelp !== 'boolean') {
    bad('UI_DOC_FIELD_TYPE', '「显示媒体帮助条」必须是布尔值');
  }

  return {
    schema_version: UI_DOC_SCHEMA_VERSION,
    brand: { name, subtitle },
    theme: { preset: preset as UiThemePreset },
    copy: { media_help: mediaHelp },
    modules: { media_help: showMediaHelp },
  };
}

/** 结构相等（用于幂等回放判定；顺序固定，不做通用 deepEqual） */
export function sameUiDoc(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(normalizeUiDoc(a)) === JSON.stringify(normalizeUiDoc(b));
  } catch {
    return false;
  }
}

export interface UiDocDiffItem {
  field: string;
  label: string;
  from: string;
  to: string;
}

/** 发布前给管理员看的**真实变更**（只列变化项，按固定顺序） */
export function diffUiDoc(prev: unknown, next: unknown): UiDocDiffItem[] {
  const before = normalizeUiDoc(prev ?? DEFAULT_UI_DOC);
  const after = normalizeUiDoc(next);
  const items: UiDocDiffItem[] = [];

  const push = (field: string, from: unknown, to: unknown, stringify = (v: unknown) => String(v)) => {
    const f = stringify(from);
    const t = stringify(to);
    if (f !== t) items.push({ field, label: FIELD_LABELS[field] ?? field, from: f, to: t });
  };

  push('brand.name', before.brand.name, after.brand.name);
  push('brand.subtitle', before.brand.subtitle, after.brand.subtitle, (v) =>
    String(v ?? '') === '' ? '（空）' : String(v),
  );
  push(
    'theme.preset',
    before.theme.preset,
    after.theme.preset,
    (v) => UI_THEME_PRESETS.find((p) => p.value === v)?.label ?? String(v),
  );
  push('copy.media_help', before.copy.media_help, after.copy.media_help);
  push(
    'modules.media_help',
    before.modules.media_help,
    after.modules.media_help,
    (v) => (v ? '显示' : '隐藏'),
  );
  return items;
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

function plain(row: any): any {
  return typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row ?? {}) };
}

export interface PublishedUiTheme {
  version: number;
  doc: UiThemeDoc;
  published_at: string | null;
}

/** 读**最新已发布**快照。没有发布记录 ⇒ 返回 null（调用方用默认值兜底）。 */
export async function readPublishedUiTheme(
  db: any,
  scope = UI_THEME_SCOPE,
  transaction?: any,
): Promise<PublishedUiTheme | null> {
  const row = await db.getRepository('pageThemeReleases').findOne({
    filter: { scope },
    sort: ['-version'],
    ...(transaction ? { transaction } : {}),
  });
  if (!row) return null;
  const p = plain(row);
  return {
    version: Number(p.version),
    doc: normalizeUiDoc(p.doc),
    published_at: p.published_at ? new Date(p.published_at).toISOString() : null,
  };
}

/** 公开接口的响应体（**白名单字段**，不带 id / 操作人 / 内部编码） */
export function publicPayloadOf(version: number, doc: UiThemeDoc) {
  return {
    version,
    schema_version: doc.schema_version,
    brand: { ...doc.brand },
    theme: { ...doc.theme },
    copy: { ...doc.copy },
    modules: { ...doc.modules },
  };
}

export interface DraftView {
  doc: UiThemeDoc;
  revision: number;
  base_version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export async function readDraftUiTheme(db: any, scope = UI_THEME_SCOPE): Promise<DraftView | null> {
  const row = await db.getRepository('pageThemeDrafts').findOne({
    filter: { scope },
    appends: ['updated_by_user'],
  });
  if (!row) return null;
  const p = plain(row);
  const user = p.updated_by_user ? plain(p.updated_by_user) : null;
  return {
    doc: normalizeUiDoc(p.doc),
    revision: Number(p.revision),
    base_version: Number(p.base_version ?? 0),
    updated_at: p.updated_at ? new Date(p.updated_at).toISOString() : null,
    updated_by: user ? String(user.nickname ?? user.username ?? user.email ?? '') : null,
  };
}

// ---------------------------------------------------------------------------
// 写：保存草稿 / 发布 / 回滚（全部在调用方的事务里执行）
// ---------------------------------------------------------------------------

/** 取行锁（唯一一行）；没有行返回 null */
async function lockDraft(db: any, t: any, scope: string): Promise<any> {
  const model = db.getCollection('pageThemeDrafts')?.model;
  if (!model || typeof model.findOne !== 'function') {
    throw new ValidationError('UI_THEME_MODEL_UNAVAILABLE', '装修草稿表模型不可用', 500);
  }
  return model.findOne({
    where: { scope },
    transaction: t,
    lock: t.LOCK?.UPDATE,
  });
}

export interface SaveDraftResult {
  revision: number;
  base_version: number;
  replayed: boolean;
}

/**
 * 保存草稿（事务内调用）。
 *
 * 并发语义：`expected_revision` 与行内 `revision` 不等 ⇒ 409 `UI_THEME_DRAFT_CONFLICT`。
 * 幂等语义：同 `request_id` + **内容相同** ⇒ 回放；**内容不同** ⇒ 409 `IDEMPOTENT_PAYLOAD_MISMATCH`。
 */
export async function saveUiThemeDraft(
  db: any,
  params: {
    t: any;
    doc: UiThemeDoc;
    expectedRevision: number;
    requestId: string;
    actorUserId?: number | null;
    scope?: string;
  },
): Promise<SaveDraftResult> {
  const scope = params.scope ?? UI_THEME_SCOPE;
  const repo = db.getRepository('pageThemeDrafts');
  const existing = await lockDraft(db, params.t, scope);
  const published = await readPublishedUiTheme(db, scope, params.t);

  if (!existing) {
    if (params.expectedRevision !== 0) {
      throw new StateConflictError(
        '草稿尚未创建（当前修订号为 0），请刷新后重试',
        'UI_THEME_DRAFT_CONFLICT',
        { current_revision: 0 },
      );
    }
    try {
      const created = await repo.create({
        values: {
          scope,
          revision: 1,
          base_version: published?.version ?? 0,
          doc: params.doc,
          updated_by_user_id: params.actorUserId ?? null,
          request_id: params.requestId,
        },
        transaction: params.t,
      });
      const p = plain(created);
      return { revision: Number(p.revision ?? 1), base_version: Number(p.base_version ?? 0), replayed: false };
    } catch (error: any) {
      // 并发首次保存：另一个请求先插入 ⇒ 唯一约束挡住。按"冲突"回答，不伪造成功。
      if (String(error?.name ?? '').includes('Unique') || String(error?.parent?.code) === '23505') {
        throw new StateConflictError(
          '另一位管理员刚刚创建了草稿，请刷新后重试',
          'UI_THEME_DRAFT_CONFLICT',
          { current_revision: 1 },
        );
      }
      throw error;
    }
  }

  const p = plain(existing);
  const currentRevision = Number(p.revision);
  const currentDoc = normalizeUiDoc(p.doc);

  if (String(p.request_id ?? '') === params.requestId) {
    if (sameUiDoc(currentDoc, params.doc)) {
      return { revision: currentRevision, base_version: Number(p.base_version ?? 0), replayed: true };
    }
    throw new StateConflictError(
      '同一个 X-Request-Id 被用于不同内容（请求号必须唯一标识一次操作）',
      'IDEMPOTENT_PAYLOAD_MISMATCH',
      { request_id: params.requestId },
    );
  }

  if (params.expectedRevision !== currentRevision) {
    throw new StateConflictError(
      '草稿已被其他管理员修改，请刷新后重试',
      'UI_THEME_DRAFT_CONFLICT',
      { current_revision: currentRevision },
    );
  }

  const model = db.getCollection('pageThemeDrafts')?.model;
  // 条件更新：把 revision 压进 WHERE，避免"读到 3、写回时已是 4"的丢失更新（DEV-203 的反面）
  const [affected] = await model.update(
    {
      doc: params.doc,
      revision: currentRevision + 1,
      request_id: params.requestId,
      updated_by_user_id: params.actorUserId ?? null,
    },
    {
      where: { scope, revision: currentRevision },
      transaction: params.t,
      validate: false,
      hooks: false,
      individualHooks: false,
    },
  );
  if (Number(affected) !== 1) {
    throw new StateConflictError(
      '草稿保存冲突（并发写入被拒绝），请刷新后重试',
      'UI_THEME_DRAFT_CONFLICT',
      { current_revision: currentRevision },
    );
  }
  return { revision: currentRevision + 1, base_version: Number(p.base_version ?? 0), replayed: false };
}

export interface PublishResult {
  version: number;
  published_at: string;
  replayed: boolean;
}

/**
 * 发布草稿（事务内调用）：**整份快照**插入一条新 release。
 *
 * 顺序很重要：
 *   ① 先处理 request_id 幂等（避免"重放被当成并发冲突"）；
 *   ② 再比对 expected_revision；
 *   ③ 最后才分配版本号并插入。
 */
export async function publishUiTheme(
  db: any,
  params: {
    t: any;
    expectedRevision: number;
    requestId: string;
    actorUserId?: number | null;
    note?: string;
    scope?: string;
  },
): Promise<PublishResult> {
  const scope = params.scope ?? UI_THEME_SCOPE;
  const draft = await lockDraft(db, params.t, scope);
  if (!draft) {
    throw new ValidationError('UI_THEME_NO_DRAFT', '还没有草稿，无法发布（请先保存一次）', 422);
  }
  const d = plain(draft);
  const doc = normalizeUiDoc(d.doc);
  const revision = Number(d.revision);

  const releases = db.getRepository('pageThemeReleases');
  const prior = await releases.findOne({
    filter: { request_id: params.requestId },
    transaction: params.t,
  });
  if (prior) {
    const pp = plain(prior);
    if (sameUiDoc(pp.doc, doc)) {
      return {
        version: Number(pp.version),
        published_at: new Date(pp.published_at).toISOString(),
        replayed: true,
      };
    }
    throw new StateConflictError(
      '同一个 X-Request-Id 被用于不同内容的发布（请求号必须唯一标识一次操作）',
      'IDEMPOTENT_PAYLOAD_MISMATCH',
      { request_id: params.requestId },
    );
  }

  if (params.expectedRevision !== revision) {
    throw new StateConflictError(
      '草稿已被修改，请刷新后再发布（避免把别人刚改的内容发出去）',
      'UI_THEME_DRAFT_CONFLICT',
      { current_revision: revision },
    );
  }

  const last = await releases.findOne({
    filter: { scope },
    sort: ['-version'],
    transaction: params.t,
  });
  const nextVersion = Number(plain(last).version ?? 0) + 1;
  const publishedAt = new Date();

  await releases.create({
    values: {
      scope,
      version: nextVersion,
      doc,
      published_by_user_id: params.actorUserId ?? null,
      published_at: publishedAt,
      note: params.note ? String(params.note).slice(0, 200) : null,
      request_id: params.requestId,
    },
    transaction: params.t,
  });

  const model = db.getCollection('pageThemeDrafts')?.model;
  // 🔴 发布**必须同时推进草稿修订号**（并把它压进 WHERE）：
  //    · 否则"同一版草稿"可以被连续发布两次 —— 两个管理员同时点发布会各自插一条
  //      release（v11、v12），而两次都返回 200，**没有任何断言会红**（实测踩到）；
  //    · 推进 revision 后，第二次的 `expected_revision` 必然过时 ⇒ 409。
  //    · 条件更新兜住多实例：`where revision` 不匹配 ⇒ affected=0 ⇒ 409。
  const [consumed] = await model.update(
    { base_version: nextVersion, revision: revision + 1 },
    { where: { scope, revision }, transaction: params.t, validate: false, hooks: false },
  );
  if (Number(consumed) !== 1) {
    throw new StateConflictError(
      '发布冲突：草稿刚刚被其他管理员发布或修改，请刷新后重试',
      'UI_THEME_DRAFT_CONFLICT',
      { current_revision: revision },
    );
  }

  return { version: nextVersion, published_at: publishedAt.toISOString(), replayed: false };
}

/**
 * 回滚 = **以旧快照再发一版**（不改写历史）。
 *
 * 同时把草稿同步为该快照（`revision+1`）—— 否则管理员打开装修页会看到
 * "线上是 v2，编辑器里还是 v5 的内容"，下一次发布会悄悄把 v2 覆盖回去。
 */
export async function rollbackUiTheme(
  db: any,
  params: {
    t: any;
    toVersion: number;
    requestId: string;
    actorUserId?: number | null;
    note?: string;
    scope?: string;
  },
): Promise<PublishResult & { rolled_back_from: number }> {
  const scope = params.scope ?? UI_THEME_SCOPE;
  const releases = db.getRepository('pageThemeReleases');
  const target = await releases.findOne({
    filter: { scope, version: params.toVersion },
    transaction: params.t,
  });
  if (!target) {
    throw new NotFoundError(`发布版本 v${params.toVersion} 不存在`);
  }
  const targetDoc = normalizeUiDoc(plain(target).doc);

  const draft = await lockDraft(db, params.t, scope);
  if (!draft) {
    throw new ValidationError('UI_THEME_NO_DRAFT', '还没有草稿，无法回滚（请先保存一次）', 422);
  }
  const d = plain(draft);

  const prior = await releases.findOne({
    filter: { request_id: params.requestId },
    transaction: params.t,
  });
  if (prior) {
    const pp = plain(prior);
    if (sameUiDoc(pp.doc, targetDoc)) {
      return {
        version: Number(pp.version),
        published_at: new Date(pp.published_at).toISOString(),
        replayed: true,
        rolled_back_from: params.toVersion,
      };
    }
    throw new StateConflictError(
      '同一个 X-Request-Id 被用于不同的回滚（请求号必须唯一标识一次操作）',
      'IDEMPOTENT_PAYLOAD_MISMATCH',
      { request_id: params.requestId },
    );
  }

  const last = await releases.findOne({ filter: { scope }, sort: ['-version'], transaction: params.t });
  const nextVersion = Number(plain(last).version ?? 0) + 1;
  const publishedAt = new Date();
  const note = params.note ? String(params.note).slice(0, 200) : `回滚到 v${params.toVersion}`;

  await releases.create({
    values: {
      scope,
      version: nextVersion,
      doc: targetDoc,
      published_by_user_id: params.actorUserId ?? null,
      published_at: publishedAt,
      note,
      rolled_back_from: params.toVersion,
      request_id: params.requestId,
    },
    transaction: params.t,
  });

  const model = db.getCollection('pageThemeDrafts')?.model;
  // 同样把 revision 压进 WHERE：回滚也是一次"消费草稿"的状态迁移
  const [restored] = await model.update(
    {
      doc: targetDoc,
      revision: Number(d.revision) + 1,
      base_version: nextVersion,
      request_id: params.requestId,
      updated_by_user_id: params.actorUserId ?? null,
    },
    { where: { scope, revision: Number(d.revision) }, transaction: params.t, validate: false, hooks: false },
  );
  if (Number(restored) !== 1) {
    throw new StateConflictError(
      '回滚冲突：草稿刚刚被其他管理员修改，请刷新后重试',
      'UI_THEME_DRAFT_CONFLICT',
      { current_revision: Number(d.revision) },
    );
  }

  return {
    version: nextVersion,
    published_at: publishedAt.toISOString(),
    replayed: false,
    rolled_back_from: params.toVersion,
  };
}

// ---------------------------------------------------------------------------
// 预览凭证
// ---------------------------------------------------------------------------

/** 预览凭证有效期（用户 D7 决策：10 分钟） */
export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

interface PreviewPayload {
  /** 签发者 user id */
  u: number;
  /** 绑定的草稿 revision */
  r: number;
  /** 过期时间（epoch ms） */
  e: number;
  /** 作用域 */
  s: string;
}

function previewSecret(): string {
  const secret = String(process.env.SIGN_SECRET ?? '').trim();
  if (!secret) {
    // fail-closed：没有密钥就不签发、不校验（与入口签名同一纪律）
    throw new ValidationError('UI_PREVIEW_SECRET_MISSING', '预览凭证密钥未配置，预览不可用', 500);
  }
  return secret;
}

function signPreview(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(`ui-preview:${payloadB64}`).digest('base64url');
}

/** 签发短时预览凭证（调用方已确认 hq_admin） */
export function mintPreviewToken(params: {
  userId: number;
  revision: number;
  scope?: string;
  now?: number;
}): { token: string; expires_at: string } {
  const payload: PreviewPayload = {
    u: Number(params.userId),
    r: Number(params.revision),
    e: (params.now ?? Date.now()) + PREVIEW_TOKEN_TTL_MS,
    s: params.scope ?? UI_THEME_SCOPE,
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${b64}.${signPreview(b64, previewSecret())}`;
  return { token, expires_at: new Date(payload.e).toISOString() };
}

export type PreviewVerifyResult =
  | { ok: true; payload: PreviewPayload }
  | { ok: false; code: 'PREVIEW_INVALID' | 'PREVIEW_EXPIRED' };

/** 校验预览凭证：签名 → 结构 → 过期 → 作用域 */
export function verifyPreviewToken(token: unknown, now = Date.now()): PreviewVerifyResult {
  const raw = String(token ?? '').trim();
  if (!raw || !raw.includes('.')) return { ok: false, code: 'PREVIEW_INVALID' };
  const [b64, sig] = raw.split('.');
  if (!b64 || !sig) return { ok: false, code: 'PREVIEW_INVALID' };

  let expected: string;
  try {
    expected = signPreview(b64, previewSecret());
  } catch {
    return { ok: false, code: 'PREVIEW_INVALID' };
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'PREVIEW_INVALID' };

  let payload: PreviewPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'PREVIEW_INVALID' };
  }
  if (
    !payload ||
    !Number.isInteger(payload.u) ||
    !Number.isInteger(payload.r) ||
    !Number.isFinite(payload.e) ||
    payload.s !== UI_THEME_SCOPE
  ) {
    return { ok: false, code: 'PREVIEW_INVALID' };
  }
  if (payload.e <= now) return { ok: false, code: 'PREVIEW_EXPIRED' };
  return { ok: true, payload };
}

/**
 * 预览响应里的**合成门店**：预览**不查** `stores`，因此不可能带出真实门店资料。
 * 名称/电话/地址都显式标注"示例"，避免管理员误以为看到的是某家真店。
 */
export const PREVIEW_STORE = {
  code: 'PREVIEW',
  name: '示例门店（预览）',
  phone: '0833-0000000',
  address: '示例地址（预览不读取真实门店资料）',
};

/**
 * 读取预览内容（凭证校验 + revision 绑定）。
 *
 * ⚠️ `revision` 已变化 ⇒ **409 `PREVIEW_STALE`**，而不是"返回最新草稿"。
 *    后者会让管理员以为自己在看旧版的排版，实际却在看另一份内容 —— 预览就失去意义了。
 */
export async function readPreviewUiTheme(
  db: any,
  token: unknown,
  /**
   * **当前登录人**（必传，用于"签发者绑定"）。
   *
   * 为什么单验 HMAC 不够：凭证是一段可复制的字符串，10 分钟内谁拿到都能用。
   * 只验签名 ⇒ 任何登录用户（甚至脱离登录态在别处重放）都能看到草稿。
   * 因此消费端必须同时满足：签名有效 + 未过期 + **revision 仍最新** + **签发者 == 当前登录人**。
   */
  expectedUserId?: number | null,
): Promise<{
  doc: UiThemeDoc;
  revision: number;
  expires_at: string;
  store: typeof PREVIEW_STORE;
}> {
  const verified = verifyPreviewToken(token);
  if (!verified.ok) {
    throw new ValidationError(
      verified.code,
      verified.code === 'PREVIEW_EXPIRED' ? '预览已过期，请在后台重新打开预览' : '预览凭证无效',
      401,
    );
  }
  if (expectedUserId != null && Number(verified.payload.u) !== Number(expectedUserId)) {
    throw new ForbiddenError(
      'PREVIEW_ISSUER_MISMATCH',
      '这个预览凭证不是当前登录账号签发的，已拒绝（预览只对签发者本人有效）',
    );
  }

  const draft = await readDraftUiTheme(db);
  if (!draft) {
    throw new ValidationError('UI_THEME_NO_DRAFT', '还没有草稿可预览', 404);
  }
  if (Number(verified.payload.r) !== draft.revision) {
    throw new StateConflictError(
      '草稿已更新，这个预览已过期，请在后台重新打开预览',
      'PREVIEW_STALE',
      { token_revision: verified.payload.r, current_revision: draft.revision },
    );
  }
  return {
    doc: draft.doc,
    revision: draft.revision,
    expires_at: new Date(verified.payload.e).toISOString(),
    store: PREVIEW_STORE,
  };
}
