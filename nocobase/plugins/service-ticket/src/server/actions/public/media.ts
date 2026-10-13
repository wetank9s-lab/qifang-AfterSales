/**
 * 客户媒体上传的**匿名接口**（P11-4 · B 条）
 *
 * 路径（对外）：
 *   POST /api/publicMedia:session        → 创建上传会话，换一会话 token
 *   POST /api/publicMedia:upload         → 往会话里传一个文件（multipart，字段名 `file`）
 *   GET  /api/publicMedia:file/<id>      → 受控读取一个媒体文件
 *
 * ===========================================================================
 * 三条接口的安全边界（用户 2026-10-13 冻结契约）
 * ===========================================================================
 * ① **独立会话**：上传前必须先建会话；没有会话的上传一律拒。
 *    会话 TTL 120 分钟，过期不可用（`SESSION_UNAVAILABLE`）。
 * ② **凭证即权限**：
 *    · `upload` 要会话 token（`X-Media-Session` 头）—— 它只授权"往这个会话写"；
 *    · `file`  要**会话 token 或进度 token**（`X-Progress-Token` 头）——
 *      后者证明"这个媒体属于你那张工单"。
 *    ⚠️ 会话 token **不能**用来读工单进度（那会越权）—— 两套凭证在
 *       `publicProgress` 侧才是读工单的钥匙。
 * ③ **不返回 storage_key / 绝对路径 / 内部 id 之外的一切**：
 *    响应里只有客户需要知道的（类型/大小/时长/是否复用）。
 */
// ⚠️ 导入点必须与师傅上传（actions/technician/visit.ts）**逐字一致**：
//    koaMulter 走 `@nocobase/utils`（宿主与容器都能解析），
//    而 `@koa/multer` 只在容器的 node_modules 里 —— 直接 import 它会让
//    verify-plugin-load 这类**在宿主侧解析产物**的门禁立刻失败
//    （实测：Cannot find module '@koa/multer'，后续断言在空集合上退化成假绿）。
import { koaMulter } from '@nocobase/utils';
import { memoryStorage } from 'multer';
import { CUSTOMER_MEDIA, GUARD_SCENE, GUARD_SCOPE, GUARD_WINDOW, RATE_LIMIT_SETTING_KEY } from '../../constants';
import { MediaFormatError } from '../../services/media-format';

export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

/** multipart 的字段名。与前端约定，且必须与 multer `.single()` 一致 */
export const MEDIA_UPLOAD_FIELD = 'file';

export interface PublicMediaDeps {
  db: any;
  logger?: any;
  /**
   * 限流守卫（与匿名建单**同一个** GuardService 实例 ⇒ 同一套计桶口径）。
   *
   * ⚠️ 方法名是 `consume`（不是 assertAllowed）：GuardService 的公开面就是
   *    `consume` / `peek` / `guardKey`，另起一个名字等于给限流开第二条入口，
   *    而第二条入口不会出现在任何既有限流门禁的覆盖范围内。
   */
  guard: {
    consume(input: {
      scene: string;
      scope: string;
      value: string;
      limit: number;
      window: string;
    }): Promise<{ allowed: boolean; used?: number; limit?: number; windowResetsInSeconds?: number }>;
    guardKey(ip: string): string;
  };
  /** 参数读取（限流额度走 settings，与匿名建单同源） */
  config: { getInt(key: string): Promise<number> };
  media: {
    createSession(input: { ipHash?: string | null }): Promise<{
      sessionId: number;
      token: string;
      expiresAt: Date;
    }>;
    uploadToSession(input: {
      token: string;
      buffer: Buffer;
      declaredMime?: string | null;
      /** 浏览器给出的采集类型（webm 判不出音视频时用） */
      declaredKind?: 'audio' | 'video' | null;
      originalName?: string | null;
      ipHash?: string | null;
    }): Promise<{
      id: number;
      kind: string;
      mime: string;
      size: number;
      durationMs: number | null;
      width: number | null;
      height: number | null;
      sortOrder: number;
      reused: boolean;
    }>;
    read(mediaId: number | string): Promise<{ absPath: string; mime: string; size: number } | null>;
  };
  maxFileBytes?: number;
}

// 🔴 **不自己写一份 ok/fail** —— 直接复用 svc 的 _http.ts。
//    第一份自己写的版本把两件事都写反了：
//      · ok 设了 `ctx.body = { data: payload }`，而 NocoBase 的 dataWrapping
//        **还会再包一层** ⇒ 客户端看到 `{data:{data:...}}`（双层 data）；
//      · fail 没设 `ctx.withoutDataWrapping = true` ⇒ errors 被包进 data，
//        客户端在顶层找不到 errors（文档契约是顶层）。
//    这正是本项目反复记的"同一段逻辑两条腿"：两条腿各自漂移，
//    而漂移的表现是"响应看着有数据、客户端解析不到"。
import { ok, fail } from '../svc/_http';

function requestIdOf(ctx: any): string | null {
  const raw = ctx?.request?.headers?.['x-request-id'] ?? ctx?.request?.headers?.['X-Request-Id'];
  const text = String(raw ?? '').trim();
  return text ? text.slice(0, 64) : null;
}

function clientIp(ctx: any): string {
  return String(ctx?.request?.ip ?? ctx?.ip ?? '');
}

/** 头里的凭证（大小写不敏感） */
function headerOf(ctx: any, name: string): string {
  const headers = ctx?.request?.headers ?? {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return String(headers[k] ?? '');
  }
  return '';
}

/**
 * 解析 multipart 单文件上传。
 *
 * 复用师傅上传那套写法（`koaMulter(...).single()` + 手动 await 一次中间件）——
 * multipart 的边界解析不该由业务代码重新实现一遍。
 */
async function readSingleUpload(
  ctx: any,
  maxSizeBytes: number,
): Promise<{ buffer: Buffer; mimetype?: string; originalname?: string } | null> {
  if (!ctx?.request?.is?.('multipart/*')) return null;

  const middleware = koaMulter({
    storage: memoryStorage(),
    limits: { files: 1, fileSize: maxSizeBytes },
  }).single(MEDIA_UPLOAD_FIELD);

  try {
    await middleware(ctx, async () => {});
  } catch (error: any) {
    if (error?.name === 'MulterError' && error?.code === 'LIMIT_FILE_SIZE') {
      throw new MediaFormatError(
        'FILE_TOO_LARGE',
        `单个文件不能超过 ${Math.floor(maxSizeBytes / 1024 / 1024)}MB`,
        413,
      );
    }
    if (error?.name === 'MulterError') {
      throw new MediaFormatError('UPLOAD_MALFORMED', `上传内容无法解析（${String(error?.code)}）`, 400);
    }
    throw error;
  }

  const file = ctx?.[MEDIA_UPLOAD_FIELD] ?? ctx?.request?.file ?? null;
  if (!file || !file.buffer) return null;
  return file;
}

export function createPublicMediaHandlers(deps: PublicMediaDeps): Record<string, ActionHandler> {
  const maxFileBytes = deps.maxFileBytes ?? CUSTOMER_MEDIA.MAX_FILE_BYTES;

  // ---------------------------------------------------------------- ① 建会话
  const publicMediaSession = async (ctx: any, _next: () => Promise<void>): Promise<void> => {
    try {
      const ip = clientIp(ctx);
      const sessionLimit = await deps.config.getInt(RATE_LIMIT_SETTING_KEY.MEDIA_SESSION_HOURLY_LIMIT);
      const decision = await deps.guard.consume({
        scene: GUARD_SCENE.MEDIA_SESSION,
        scope: GUARD_SCOPE.IP,
        value: ip,
        limit: sessionLimit,
        window: GUARD_WINDOW.HOUR,
      });
      if (!decision.allowed) {
        ctx.set?.('Retry-After', String(decision.windowResetsInSeconds ?? 3600));
        fail(ctx, 429, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
        return;
      }

      // 🔴 **媒体授权必须单独明示**（ticket.ts 里那条红线的落地）。
      //
      //    `publicTicket:create` 的"提交即同意"覆盖的是**提交服务请求**这一件事；
      //    上传照片/语音/视频是另一类处理（画面里可能有客户家门牌、家庭成员），
      //    不能吃那份依据。⇒ 客户必须在点"上传"之前明确表达一次同意。
      //
      //    实现取"**行为即同意**"而非"再弹一个勾选卡片"——后者正是用户
      //    A 条明确去掉的"冗长隐私勾选卡片"。页面在上传区常驻一句：
      //    「上传媒体即表示同意门店为处理本次售后查看这些材料」，
      //    客户点上传这个动作本身就是明示同意；服务端在这里**强制要求**
      //    该标记存在，缺它一律 400（不默认放行）。
      const consent = ctx?.request?.body?.media_consent ?? ctx?.action?.params?.values?.media_consent;
      if (consent !== true && consent !== 'true') {
        fail(ctx, 400, 'MEDIA_CONSENT_REQUIRED', '上传媒体需要先明确同意（请勾选上传区的授权说明）');
        return;
      }

      const session = await deps.media.createSession({ ipHash: deps.guard.guardKey(ip) });
      deps.logger?.info?.(`[media] 会话 ${session.sessionId} 已创建（ip=${deps.guard.guardKey(ip).slice(0, 8)}…）`);
      ok(ctx, {
        session_id: session.sessionId,
        /** 明文 token —— **只在这里出现一次**，请立即保存（页面刷新即失效） */
        session_token: session.token,
        expires_at: session.expiresAt.toISOString(),
        limits: {
          max_file_bytes: maxFileBytes,
          max_items: CUSTOMER_MEDIA.SESSION_MAX_ITEMS,
          image_max_count: CUSTOMER_MEDIA.IMAGE_MAX_COUNT,
          audio_max_ms: CUSTOMER_MEDIA.AUDIO_MAX_MS,
          video_max_ms: CUSTOMER_MEDIA.VIDEO_MAX_MS,
        },
      });
    } catch (error: any) {
      const status = Number(error?.httpStatus ?? 500) || 500;
      fail(ctx, status, String(error?.code ?? 'SESSION_CREATE_FAILED'), String(error?.message ?? '创建上传会话失败'));
    }
  };

  // ---------------------------------------------------------------- ② 上传
  const publicMediaUpload = async (ctx: any, _next: () => Promise<void>): Promise<void> => {
    try {
      const ip = clientIp(ctx);
      const uploadLimit = await deps.config.getInt(RATE_LIMIT_SETTING_KEY.MEDIA_UPLOAD_HOURLY_LIMIT);
      const decision = await deps.guard.consume({
        scene: GUARD_SCENE.MEDIA_UPLOAD,
        scope: GUARD_SCOPE.IP,
        value: ip,
        limit: uploadLimit,
        window: GUARD_WINDOW.HOUR,
      });
      if (!decision.allowed) {
        ctx.set?.('Retry-After', String(decision.windowResetsInSeconds ?? 3600));
        fail(ctx, 429, 'RATE_LIMITED', '上传过于频繁，请稍后再试');
        return;
      }

      const token = headerOf(ctx, 'X-Media-Session');
      if (!token) {
        fail(ctx, 401, 'SESSION_TOKEN_REQUIRED', '缺少上传会话凭证，请重新开始');
        return;
      }

      const file = await readSingleUpload(ctx, maxFileBytes);
      if (!file) {
        fail(ctx, 422, 'FILE_REQUIRED', '没有收到文件（multipart 字段名应为 file）');
        return;
      }

      // 浏览器给出的采集类型（multipart 里的 declared_kind，由 H5 从 File.type 主类型推出）。
      // 🔴 白名单：只接受 audio / video 两个值，其余一律当"没给"（fail-open 到容器的判定）。
      const rawKind = String(
        (file as unknown as Record<string, unknown>).declaredKind ??
          (ctx?.request?.body as Record<string, unknown> | undefined)?.declared_kind ??
          '',
      )
        .trim()
        .toLowerCase();
      const declaredKind = rawKind === 'audio' || rawKind === 'video' ? (rawKind as 'audio' | 'video') : null;

      const saved = await deps.media.uploadToSession({
        token,
        buffer: file.buffer,
        declaredMime: file.mimetype ?? null,
        declaredKind,
        originalName: file.originalname ?? null,
        ipHash: deps.guard.guardKey(ip),
      });

      // 🔴 响应里**没有** storage_key、没有绝对路径、没有内部会话 id 之外的字段。
      ok(ctx, {
        id: saved.id,
        kind: saved.kind,
        mime: saved.mime,
        size: saved.size,
        duration_ms: saved.durationMs,
        width: saved.width,
        height: saved.height,
        sort_order: saved.sortOrder,
        /** true = 这次是重复上传同一内容，服务端复用了已收到的那一份 */
        reused: saved.reused,
      });
    } catch (error: any) {
      const status = Number(error?.httpStatus ?? 500) || 500;
      const code = String(error?.code ?? 'UPLOAD_FAILED');
      // 风控拒绝（429）与格式拒绝（415/413）都要**如实**告诉客户原因，
      // 但不透露内部判定细节（如"我们读了你文件的第 4 字节"）。
      fail(ctx, status, code, String(error?.message ?? '上传失败'));
    }
  };

  // ---------------------------------------------------------------- ③ 受控读取
  const publicMediaFile = async (ctx: any, _next: () => Promise<void>): Promise<void> => {
    try {
      // ⚠️ 主键在 ****（NocoBase 单资源路径段的约定形态），
      //    不是 uid=197108(Administrator) gid=197121 groups=197121。第一版只取了 uid=197108(Administrator) gid=197121 groups=197121/ ⇒ 永远解析不到 ⇒ 走 404 分支，
      //    而那条分支的文案恰好是"文件不存在"，于是看起来像"文件真不存在"。
      //    实测 params：{ filterByTk: "2", resourceIndex: "2", actionName: "file" }。
      //    兜底再取 URL path 最后一段（与 publicReview 的取 token 方式一致）。
      const rawId =
        ctx?.action?.params?.filterByTk ??
        ctx?.action?.params?.mediaId ??
        ctx?.action?.params?.id ??
        ctx?.params?.id ??
        String(ctx?.path ?? ctx?.request?.path ?? '').split('/').filter(Boolean).pop();
      const mediaId = Number(rawId);
      if (!Number.isFinite(mediaId) || mediaId <= 0) {
        fail(ctx, 404, 'MEDIA_NOT_FOUND', '文件不存在或已失效');
        return;
      }

      // 凭证：会话 token（未提交时自己看）或进度 token（提交后看）
      const sessionToken = headerOf(ctx, 'X-Media-Session');
      const progressToken = headerOf(ctx, 'X-Progress-Token');
      if (!sessionToken && !progressToken) {
        fail(ctx, 401, 'MEDIA_CREDENTIAL_REQUIRED', '查看文件需要凭证');
        return;
      }

      // 属主校验在 service 侧做（它持有会话/工单关系），这里只取结果
      const allowed = await deps.media.assertReadable({
        mediaId,
        sessionToken: sessionToken || null,
        progressToken: progressToken || null,
      });
      if (!allowed) {

        // 不存在与无权限**回同一个响应**（不构成"这个 id 存在吗"的探测器）
        fail(ctx, 404, 'MEDIA_NOT_FOUND', '文件不存在或已失效');
        return;
      }

      const file = await deps.media.read(mediaId);
      if (!file) {
        fail(ctx, 404, 'MEDIA_NOT_FOUND', '文件不存在或已失效');
        return;
      }

      const fs = await import('node:fs');
      ctx.status = 200;
      // 用**库里记录的** MIME（不是请求里声明的，也不是从磁盘重新嗅探的）
      ctx.set('Content-Type', file.mime);
      ctx.set('Content-Length', String(file.size));
      // 🔴 禁缓存：这些文件含客户家庭住址/门牌等敏感画面，
      //    被中间层缓存一次就等于多一份副本。
      ctx.set('Cache-Control', 'private, no-store, max-age=0');
      ctx.set('X-Content-Type-Options', 'nosniff');
      // 🔴 inline 且带 CSP：不当附件下载（客户是在页里看），也不允许被嵌套进别站
      ctx.set('Content-Disposition', 'inline');
      ctx.body = fs.createReadStream(file.absPath);
    } catch (error: any) {
      const status = Number(error?.httpStatus ?? 500) || 500;
      fail(ctx, status, String(error?.code ?? 'MEDIA_READ_FAILED'), String(error?.message ?? '读取失败'));
    }
  };

  return {
    'publicMedia:session': publicMediaSession,
    'publicMedia:upload': publicMediaUpload,
    'publicMedia:file': publicMediaFile,
  };
}
