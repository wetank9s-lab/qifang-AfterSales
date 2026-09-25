/**
 * 师傅作业接口（Phase 5）—— `technicianVisit` 资源的四个匿名 action。
 *
 * 对外路径（由 nginx 重写，见 DEV-18 与 `nginx/conf.d/service.conf`）：
 *
 *   GET  /api/technician/visits/:token               → `/api/technicianVisit:get?token=…`
 *   POST /api/technician/visits/:token/files         → `/api/technicianVisit:upload?token=…`
 *   POST /api/technician/visits/:token/submit        → `/api/technicianVisit:submit?token=…`
 *   GET  /api/technician/visits/:token/photos/:ref   → `/api/technicianVisit:photo?token=…&ref=…`
 *
 * ⚠️ **对外路径与 NocoBase 内部路径是同一个接口**，不是两套实现
 *    （理由与写法同 `/api/public/`，见该段注释与 DEV-18）。
 *
 * ---------------------------------------------------------------------------
 * 停止线（P5-1 的范围）
 * ---------------------------------------------------------------------------
 * 本文件做到「师傅打开链接 → 传照片 → 提交回执 → 工单进入 `WAIT_STORE_CONFIRM`」为止。
 * **刻意不做**：门店确认/驳回、评价 Token、评价短信、`CLOSED`。
 * 因此 `submit` 的成功文案里不出现"完成"二字 —— 师傅提交 ≠ 工单完成，
 * 后者要等门店确认（Phase 6）。这条口径有断言盯着
 * （`verify-technician-submit.mjs` 的文案用例）。
 *
 * ---------------------------------------------------------------------------
 * 安全边界只有两处，两处都不能绕过
 * ---------------------------------------------------------------------------
 *  ① `withTechnicianAuth()`（`_auth.ts`）—— 四个 action 全部经它进入。
 *     它把"取 token → 格式校验 → `TokenService.verify()` → 失败统一 401"收成
 *     唯一实现。**没有下一步的 handler 能自己决定要不要鉴权**，因为 handler
 *     根本拿不到未通过认证的 ctx。
 *  ② 照片的**属主校验**（本文件的 `photo` handler）—— 见那里的注释：
 *     ref 不可猜，但"不可猜"不是授权，必须显式断言"这张照片属于本 token 的 Visit"。
 *
 * 另外两条用在写路径上：限流（`GuardService.consume`，token/IP 双维度）
 * 与"内容由服务端重新判定"（照片走 `PhotoService`，magic bytes 说了算）。
 */
import { createReadStream } from 'node:fs';

import { koaMulter } from '@nocobase/utils';
import { memoryStorage } from 'multer';

import {
  GUARD_SCENE,
  GUARD_SCOPE,
  GUARD_WINDOW,
  PHOTO_TYPE,
  PHOTO_TYPE_LABEL,
  PHOTO_TYPE_VALUES,
  SERVICE_RESULT_LABEL,
  SERVICE_RESULT_VALUES,
  TECHNICIAN_ACTION,
  TECHNICIAN_SETTING_KEY,
  VISIT_STATUS,
} from '../../constants';
import type { Services } from '../../services';
import { RateLimitedError } from '../../services/guard-service';
import { ValidationError } from '../../services/ticket-service';
import { VisitValidationError } from '../../services/visit-service';
import { PHOTO_REF_PATTERN, photoRefOf } from '../../../shared/photo-ref';
import { clientIpOf, fail, handleError, ok, traceId } from '../svc/_http';
import type { ActionHandler } from '../svc/_request';
import { withTechnicianAuth, type TechnicianActionDeps } from './_auth';

/**
 * 师傅侧看到的作业状态（API.md §2.1 的 `status`）。
 *
 * 为什么是一个新字面量而不是直接回 `visit_status`：
 *   `verify()` 只放行 `visit_status === 'ASSIGNED'` 的 Visit，也就是说**能走到 handler
 *   的请求，作业状态必然是"待师傅作业"**。API.md §2.1 把它写成 `"pending"`，
 *   这里照契约实现。
 *   ⚠️ 它是**投影值**（师傅视角），不是 `VISIT_STATUS` 枚举的成员 ——
 *      别拿它去比对库里的 `visit_status`（那边是 `ASSIGNED`）。
 *      `VISIT_STATUS.ASSIGNED` 是它的来源，两者在 `get` 里同时回显，
 *      便于前端与排障一眼对上。
 */
const TECHNICIAN_JOB_STATUS = {
  PENDING: 'pending',
} as const;

/**
 * 提交成功后的**终态文案**（唯一事实来源）。
 *
 * 措辞是被明确要求过的：`已提交，等待门店确认`。
 * 不能是"工单已完成"、"服务已完成"或任何暗示闭环的说法 ——
 * 师傅这一侧的动作只把工单推到 `WAIT_STORE_CONFIRM`，
 * 后面还有门店确认（Phase 6）与客户评价，工单此时**远未结束**。
 * 说"已完成"会让师傅直接走人、也让客户以为事情办完了。
 */
const SUBMIT_SUCCESS_MESSAGE = '已提交，等待门店确认';

/** 上传 multipart 的字段名。与前端约定，且必须与 multer `.single()` 一致 */
const UPLOAD_FIELD_NAME = 'file';

/** 服务说明长度（与 `VisitService.submit` 的 assertText 上限一致） */
const NOTE_MIN = 1;
const NOTE_MAX = 500;

/**
 * 上报金额上限。
 *
 * ⚠️ 这是**防手滑的合理性上界**，不是业务规则：`reported_charge_amount` 是
 *    `numeric(12,2)`，光按列容量能存到 99 亿。少打一个小数点就变成
 *    "上门费 3000 元"，而门店确认时只能看到这个数字、无从判断真假。
 *    业务若确实需要更高，**改这个常量并同步文档**，别在 handler 里绕。
 */
const MAX_REPORTED_CHARGE = 999_999.99;

export interface TechnicianHandlerDeps extends TechnicianActionDeps {
  /** 计照片数需要直接读 `serviceVisitPhotos`（VisitService 没有这个只读聚合） */
  db: any;
}

export function createTechnicianActionHandlers(
  deps: TechnicianHandlerDeps,
): Record<string, ActionHandler> {
  const { services, logger } = deps;

  /**
   * 把"认证 + 错误映射"合成一个固定形态。
   *
   * 为什么在 `withTechnicianAuth` 外面再包一层：认证层的职责是**只产出 401**
   * （见 `_auth.ts` 文件头：失败体必须逐字节相同）。而认证成功之后，
   * 业务失败要按 `docs/API.md` §0 的信封返回 409/413/415/422/429 ——
   * 那是 `handleError()` 的活。两者混在一层里，就会出现
   * "某条业务校验失败被认证层当成 token 无效、回了 401"，
   * 而师傅看到的是"链接失效"，会去找门店重发链接 —— 排查方向完全错。
   */
  const authed = (
    actionName: string,
    body: (ctx: any, auth: { visit: Record<string, unknown>; token: string }) => Promise<void>,
  ): ActionHandler => {
    return withTechnicianAuth(deps, actionName, async (ctx, auth) => {
      const trace = traceId(ctx);
      try {
        await body(ctx, auth);
      } catch (error) {
        handleError(ctx, error, logger, trace, `technician:${actionName}`);
      }
    });
  };

  /**
   * token / IP 双维度限流（**消费**，不是 peek）。
   *
   * 两个维度都必要，且理由不同：
   *   · **Token 维度**（`security.technician_token_hourly_limit`，默认 60/小时）——
   *     挡住"拿着一条合法链接反复刷"。注意它**不是**防重放的主力
   *     （那是一性 Token 的职责），它挡的是"提交前反复上传/改约后旧链接被扫到"
   *     这类**在配额内合法、但量明显异常**的行为。
   *   · **IP 维度**（复用 `security.ip_minute_limit`）—— 挡住"扫描器拿一堆
   *     无效 token 打接口"。这类请求连 `verify()` 都过不去，
   *     为什么还要在**认证之后**限流？因为认证层的失败路径不该查库写库
   *     （那正是枚举探测最便宜的放大手段）；IP 桶在认证后的写路径上兜底，
   *     配合 nginx 的 `svc_upload` 区形成两层（同 `docs/SECURITY.md` 的分层口径）。
   *
   * ⚠️ 顺序：**先 token 后 IP**。token 是更精确的维度（一个师傅一个桶），
   *    IP 粒度粗（一个门店的 WiFi 下可能同时有好几位师傅）。
   *    先消费精确的，粗粒度的只作为"异常量"的兜底。
   */
  const consumeQuota = async (ctx: any, scene: string, token: string): Promise<void> => {
    const limit = await services.config.getInt(TECHNICIAN_SETTING_KEY.TOKEN_HOURLY_LIMIT, 60);
    const decision = await services.guards.consume({
      scene,
      scope: GUARD_SCOPE.TOKEN,
      // ⚠️ 传**明文 token**：`GuardService.consume` 负责哈希（它的注释明说
      //    "本服务负责哈希，调用方不得自行哈希"）。自行哈希会让"频控桶"与
      //    `guard-quota` 诊断接口读到的桶**不是同一个**。
      value: token,
      limit,
      window: GUARD_WINDOW.HOUR,
    });
    if (!decision.allowed) {
      ctx.set?.('Retry-After', String(decision.windowResetsInSeconds));
      throw new RateLimitedError('操作过于频繁，请稍后再试', {
        scene: decision.scene,
        scope: decision.scope,
        limit: decision.limit,
        used: decision.used,
        window_resets_in_seconds: decision.windowResetsInSeconds,
      });
    }
  };

  /**
   * `GET /api/technician/visits/:token` —— 打开作业页所需的**最小必要信息**。
   *
   * 刻意**不回**的东西（每一条都是"能少给就少给"）：
   *   · `customer_mobile` / `customer_name` —— 师傅联系客户走门店，不由本接口派号
   *     （API.md §2.1：「客户姓名仅在使用需要时返回（默认不返回）」）；
   *   · `visit.id` / `ticket.id` —— 内部主键，匿名接口不回（同 `publicTicket` 的理由）；
   *   · `access_token_hash` / `storage_key` —— 凭据类，任何情况下都不出站。
   *
   * 回显 `max_photos` / `max_photo_size_mb` 是为了让页面**自己**能在上传前先拦一道
   * （体验用）。真正的上限校验在**服务端**（`PhotoService`）——
   * **前端校验不是校验**。
   *
   * P5-1 新增 `photos`：**已上传照片的回显**。它解决的问题很具体 ——
   *   师傅传了 3 张照片、还没填完表单就刷新了页面（手机来电、微信切走、
   *   误触返回都会触发）。若 GET 不回照片，页面会显示"0 张"，
   *   师傅以为白传了，于是**再传一遍**；更糟的是他可能以为"要重新走一遍流程"。
   *   回显后刷新是幂等的：照片挂在 Visit 上，刷新不产生任何新记录。
   */
  const get = authed(TECHNICIAN_ACTION.GET, async (ctx, auth) => {
    const ticketId = Number(auth.visit.ticket_id);
    const visitId = Number(auth.visit.id);

    const ticket = await deps.db
      .getRepository('serviceTickets')
      .findOne({ filter: { id: ticketId } });
    if (!ticket) {
      // 理论上不可达（verify 已确认工单处于进行中）。真出现说明工单在
      // verify 与本行之间被删了 —— 按"链接失效"处理，与其它失效同一种对外表现。
      logger.warn?.(
        `[technician:get] Token 有效但工单 ${ticketId} 不存在（visit=${visitId}），按 TOKEN_INVALID 返回`,
      );
      fail(ctx, 401, 'TOKEN_INVALID', '链接无效或已失效，请联系门店重新获取');
      return;
    }

    const store = ticket.store_id
      ? await deps.db.getRepository('stores').findOne({ filter: { id: Number(ticket.store_id) } })
      : null;

    const tokenHash = String(auth.visit.access_token_hash ?? '');
    const photoRows = await services.visits.listPhotos(visitId);

    const maxPhotos = await services.config.getInt(TECHNICIAN_SETTING_KEY.PHOTO_MAX_COUNT, 6);
    const maxPhotoSizeMb = await services.config.getInt(
      TECHNICIAN_SETTING_KEY.PHOTO_MAX_SIZE_MB,
      5,
    );

    ok(ctx, {
      ticket_no: String(ticket.ticket_no ?? ''),
      store_name: String(store?.name ?? ''),
      ticket_type: String(ticket.ticket_type ?? ''),
      // 报修内容：师傅靠它判断带什么工具，属"作业必需"
      content: String(ticket.content ?? ''),
      expected_visit_at: toIsoOrNull(auth.visit.expected_visit_at),
      expires_at: toIsoOrNull(auth.visit.token_expires_at),
      // 师傅视角状态 + 其来源枚举值（见 TECHNICIAN_JOB_STATUS 注释）
      status: TECHNICIAN_JOB_STATUS.PENDING,
      visit_status: String(auth.visit.visit_status ?? ''),
      photos_count: photoRows.length,
      photos: photoRows.map((row: any) => ({
        // 对外句柄（不含内部主键），读取路径见 photo handler
        ref: photoRefOf(Number(row.id), tokenHash),
        photo_type: String(row.photo_type ?? PHOTO_TYPE.ONSITE),
        mime: String(row.mime ?? ''),
        size: Number(row.size) || 0,
        width: row.width === null || row.width === undefined ? null : Number(row.width),
        height: row.height === null || row.height === undefined ? null : Number(row.height),
      })),
      max_photos: maxPhotos,
      max_photo_size_mb: maxPhotoSizeMb,
      // 表单选项**由服务端下发**，不在 H5 里手抄一份枚举 + 中文标签。
      // 理由就是 DEV-58/59 的教训：同一个枚举在两处维护，漂移时
      // "前端能选、后端拒收"（或反过来"能存但显示不出来"），而两边都不会报错。
      // 顺序即展示顺序（标签表的键序），H5 直接渲染，不重排。
      service_results: SERVICE_RESULT_VALUES.map((value) => ({
        value,
        label: SERVICE_RESULT_LABEL[value] ?? value,
      })),
      photo_types: PHOTO_TYPE_VALUES.map((value) => ({
        value,
        label: PHOTO_TYPE_LABEL[value] ?? value,
      })),
    });

    logger.debug?.(
      `[technician:get] 已返回作业上下文（visit=${visitId} ticket=${String(
        ticket.ticket_no,
      )} photos=${photoRows.length}）`,
    );
  });

  /**
   * `POST /api/technician/visits/:token/files` —— 上传一张现场照片。
   *
   * 字段名固定 `file`（multipart/form-data，单文件）。可选 `photo_type`。
   *
   * 三道**顺序不能换**的处理：
   *   ① 限流（在解析 body 之前）—— 一个被限住的请求不该让我们去读它的 5MB body；
   *   ② **由 multer 限制字节数**（`limits.fileSize`）—— 这是在**流式**阶段拦下的，
   *      不是"收完再判断"。否则一个 2GB 的请求会先把内存吃光，
   *      而"大小校验"根本没有机会执行。这一点在 nginx 侧还有 `client_max_body_size`
   *      兜底，但反向代理不一定永远在前面（容器内直连调试、将来换网关），
   *      应用侧必须自己设。
   *   ③ `PhotoService.save()` —— magic bytes、去 EXIF、原子上限、私有落盘。
   *      注意**没有任何一步信任请求里的 Content-Type 或文件名**。
   */
  const upload = authed(TECHNICIAN_ACTION.UPLOAD, async (ctx, auth) => {
    const visitId = Number(auth.visit.id);
    await consumeQuota(ctx, GUARD_SCENE.TECHNICIAN_UPLOAD, auth.token);

    const maxPhotoSizeMb = await services.config.getInt(
      TECHNICIAN_SETTING_KEY.PHOTO_MAX_SIZE_MB,
      5,
    );
    const maxCount = await services.config.getInt(TECHNICIAN_SETTING_KEY.PHOTO_MAX_COUNT, 6);
    const maxSizeBytes = Math.max(1, maxPhotoSizeMb) * 1024 * 1024;

    const file = await readSingleUpload(ctx, maxSizeBytes);
    if (!file) {
      fail(ctx, 422, 'NO_FILE', `请选择要上传的照片（字段名 ${UPLOAD_FIELD_NAME}）`, {
        field: UPLOAD_FIELD_NAME,
      });
      return;
    }

    const saved = await services.photos.save({
      visitId,
      buffer: file.buffer,
      declaredMime: file.mimetype ?? null,
      originalName: file.originalname ?? null,
      photoType: readPhotoType(ctx),
      // ⚠️ 存哈希不存明文：照片表若带明文 IP，它就成了一张定位表。
      //    哈希算法与频控同源（`GuardService.guardKey`），便于两者交叉核对。
      uploadIpHash: services.guards.guardKey(clientIpOf(ctx)),
      maxCount,
      maxSizeBytes,
    });

    const tokenHash = String(auth.visit.access_token_hash ?? '');
    const photosCount = await services.visits.countPhotos(visitId);

    ok(
      ctx,
      {
        photo: {
          ref: photoRefOf(saved.id, tokenHash),
          photo_type: saved.photoType,
          mime: saved.mime,
          size: saved.size,
          width: saved.width,
          height: saved.height,
        },
        photos_count: photosCount,
        max_photos: maxCount,
      },
      201,
    );
  });

  /**
   * `POST /api/technician/visits/:token/submit` —— 提交回执。
   *
   * 字段（JSON body，经 NocoBase 的 `values` 传入）：
   *   `service_result`          必填，`SERVICE_RESULT` 枚举
   *   `service_note`            必填，1~500 字
   *   `is_charged`              必填布尔
   *   `reported_charge_amount`  `is_charged=true` 时必填（>0，≤ 上限）
   *
   * ⚠️ `is_charged=false` 时**必须把金额当作 0/空**，而不是"忽略这个字段"：
   *    字段可能是上一屏填过、被前端漏删的残留值。若原样入库，
   *    门店会看到"未收费但上报金额 300"这种自相矛盾的回执，
   *    而两个字段各自的校验都是通过的。
   *
   * 真正的落账在 `TicketService.technicianSubmit()` 的**一个事务**里
   * （Visit → Token → Ticket → Event），本 handler 只负责"校验输入 + 调用 + 回话"。
   */
  const submit = authed(TECHNICIAN_ACTION.SUBMIT, async (ctx, auth) => {
    const visitId = Number(auth.visit.id);
    const ticketId = Number(auth.visit.ticket_id);
    await consumeQuota(ctx, GUARD_SCENE.TECHNICIAN_SUBMIT, auth.token);

    const dto = parseSubmitDto(ctx);

    // 照片张数进事件 metadata（审核侧要知道"这次上门有没有带证据"）。
    //
    // ⚠️ **下限 = 1 张**（用户 2026-09-25 拍板，P5-1 范围内补校验，不是新需求）：
    //    业务契约从 Technician H5 设计起就是"技师上传 1–6 张照片，填写结果后提交"，
    //    此前 `docs/PHASE-5.md` §6.2 只写了上限，实测 0 张也能 submit —— 现已定为缺陷。
    //    **服务端是权威校验**（前端只是体验层，不能只靠前端拦）——
    //    尤其要挡住"上传 1 张 → 照片被删除/失效到 0 张 → submit 仍成功"这条路径。
    const photoCount = await services.visits.countPhotos(visitId);
    if (photoCount < 1) {
      throw new ValidationError('PHOTO_REQUIRED', '请至少上传 1 张现场照片后再提交');
    }
    // 上限兜底：正常路径里 `PhotoService` 在上传时就已按 `photo_max_count` 拒掉第 7 张，
    // 这里的判断只在"后台把上限调小 / 数据被人工改动"这类绕过上传闸门的场景下生效。
    const maxPhotos = await services.config.getInt(TECHNICIAN_SETTING_KEY.PHOTO_MAX_COUNT, 6);
    if (photoCount > maxPhotos) {
      throw new ValidationError(
        'PHOTO_LIMIT_REACHED',
        `本次上门最多上传 ${maxPhotos} 张照片`,
      );
    }

    const result = await services.tickets.technicianSubmit({
      visitId,
      ticketId,
      service_result: dto.serviceResult,
      service_note: dto.serviceNote,
      is_charged: dto.isCharged,
      reported_charge_amount: dto.reportedChargeAmount,
      photoCount,
    });

    ok(ctx, {
      ticket_no: String((result.ticket as any)?.ticket_no ?? ''),
      status: String((result.ticket as any)?.status ?? ''),
      visit_status: String((result.visit as any)?.visit_status ?? ''),
      store_confirm_status: String((result.visit as any)?.store_confirm_status ?? ''),
      // 终态文案（见 SUBMIT_SUCCESS_MESSAGE 的注释：不能出现"完成"）
      message: SUBMIT_SUCCESS_MESSAGE,
      submitted_at: toIsoOrNull((result.visit as any)?.submitted_at),
    });
  });

  /**
   * `GET /api/technician/visits/:token/photos/:ref` —— **受控读取**一张照片。
   *
   * 这条 handler 是照片的**最后一道门**，两件事必须都成立：
   *   ① Token 有效（`withTechnicianAuth`）；
   *   ② 请求的 `ref` 对应的照片**属于这个 Token 绑定的 Visit**。
   *
   * ② 不是可有可无的：`ref` 由 `sha256(photoId + access_token_hash)` 派生，
   * 不可猜（见 `shared/photo-ref.ts`），但"不可猜"是**机密性**，不是**授权**。
   * 把两者混为一谈是这类接口最常见的错误 —— 一旦将来 ref 因为某种原因泄漏
   * （日志、截图、浏览器历史），没有属主校验的实现就等于开放了全库照片。
   *
   * 实现方式：对本 Visit 的照片（≤6 张）逐个重算 ref 比对。
   * 为什么不做成"反查表"：那要新增列或新表（本阶段明确不加迁移）；
   * 6 次 sha256 的开销可以忽略。
   */
  const photo = authed(TECHNICIAN_ACTION.PHOTO, async (ctx, auth) => {
    const visitId = Number(auth.visit.id);
    const ref = String(readParam(ctx, 'ref') ?? '').trim();

    // 形态先挡一道：非 22 位 base64url 的 ref 连比对都不必做
    if (!PHOTO_REF_PATTERN.test(ref)) {
      notFoundPhoto(ctx);
      return;
    }

    const tokenHash = String(auth.visit.access_token_hash ?? '');
    const rows = await services.visits.listPhotos(visitId);
    const matched = rows.find((row: any) => photoRefOf(Number(row.id), tokenHash) === ref);
    if (!matched) {
      notFoundPhoto(ctx);
      return;
    }

    const stored = await services.photos.read(Number(matched.id));
    if (!stored) {
      notFoundPhoto(ctx);
      return;
    }

    // 行在但文件没了：回 404 而不是 500 —— 对师傅来说"这张照片打不开"，
    // 与服务端故障是两件事；500 会把运维叫起来却查不出原因（磁盘被清过）。
    if (!(await services.photos.exists(storageKeyOfRow(matched)))) {
      logger.warn?.(
        `[technician:photo] visit=${visitId} photo=${String(matched.id)} 在库但文件缺失（${stored.absPath}）`,
      );
      notFoundPhoto(ctx);
      return;
    }

    // ⚠️ 内容类型取自**数据库里记录的值**（上传时由 magic bytes 判定），
    //    绝不从请求或文件系统推测。再加 `nosniff`：即使有人在字节里夹带了
    //    看起来像 HTML 的内容，浏览器也不会按 HTML 执行 ——
    //    这是本阶段"不做像素级净化"（无解码器，见 media-guard 顶部）的补偿措施。
    ctx.withoutDataWrapping = true;
    ctx.set?.('Content-Type', stored.mime);
    ctx.set?.('X-Content-Type-Options', 'nosniff');
    // 私有内容：禁止任何中间层缓存，也禁止浏览器把它写进磁盘缓存
    ctx.set?.('Cache-Control', 'private, no-store');
    // 文件名固定为 `photo.<ext>`：不把原始文件名（用户可控）回显进响应头，
    // 避免 `Content-Disposition` 的头注入面
    ctx.set?.('Content-Disposition', 'inline');
    ctx.status = 200;
    ctx.body = createReadStream(stored.absPath, (error) => {
      // 流式读取中途出错时响应头已经发出去了，此时只能记日志 + 断开连接。
      // 不抛错（抛了也改不了已发送的响应），但**必须留下痕迹**。
      logger.error?.(`[technician:photo] 读取照片流失败（${stored.absPath}）：${error?.message}`);
    });
  });

  return {
    [TECHNICIAN_ACTION.GET]: get,
    [TECHNICIAN_ACTION.UPLOAD]: upload,
    [TECHNICIAN_ACTION.SUBMIT]: submit,
    [TECHNICIAN_ACTION.PHOTO]: photo,
  };
}

// ---------------------------------------------------------------------------
// 输入解析（全部是"逐字段取值"，不做 mass assignment）
// ---------------------------------------------------------------------------

interface SubmitDto {
  serviceResult: string;
  serviceNote: string;
  isCharged: boolean;
  reportedChargeAmount: number | null;
}

/**
 * 提交回执的入参校验。
 *
 * 为什么每一处都写得这么啰嗦（而不是 `const dto = body as SubmitDto`）：
 *   这是**匿名可写**的接口，body 完全不可信。类型断言在运行期什么都不做，
 *   而这里每一个字段的缺失/类型不对都必须在**进入事务之前**被拒 ——
 *   事务里抛错虽然也会回滚，但那条路径上已经产生了数据库往返与锁，
 *   更容易被用来做资源消耗。
 */
function parseSubmitDto(ctx: any): SubmitDto {
  const values = readValues(ctx);

  const serviceResult = String(values.service_result ?? '').trim();
  if (!SERVICE_RESULT_VALUES.includes(serviceResult as any)) {
    throw new ValidationError(
      'INVALID_SERVICE_RESULT',
      `请选择处理结果（${SERVICE_RESULT_VALUES.map(
        (v) => `${SERVICE_RESULT_LABEL[v] ?? v}`,
      ).join(' / ')}）`,
    );
  }

  const serviceNote = String(values.service_note ?? '').trim();
  if (serviceNote.length < NOTE_MIN) {
    throw new ValidationError('MISSING_SERVICE_NOTE', '请填写处理说明（师傅的现场记录）');
  }
  if (serviceNote.length > NOTE_MAX) {
    throw new ValidationError('SERVICE_NOTE_TOO_LONG', `处理说明不能超过 ${NOTE_MAX} 字`);
  }

  // `is_charged` 必须是**真布尔**或明确的 'true'/'false' 字面量。
  // 不用 `Boolean(values.is_charged)`：字符串 'false' 会被它判成 true，
  // 于是"未收费"被记成"已收费"并要求金额 —— 一个静默的语义翻转。
  const isCharged = parseBoolean(values.is_charged);
  if (isCharged === null) {
    throw new ValidationError('INVALID_IS_CHARGED', '请选择本次是否收费');
  }

  let reportedChargeAmount: number | null = null;
  if (isCharged) {
    const raw = values.reported_charge_amount;
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount)) {
      throw new ValidationError('MISSING_CHARGE_AMOUNT', '已选择收费时请填写收费金额');
    }
    if (amount <= 0) {
      throw new ValidationError('INVALID_CHARGE_AMOUNT', '收费金额必须大于 0');
    }
    if (amount > MAX_REPORTED_CHARGE) {
      throw new ValidationError(
        'CHARGE_AMOUNT_TOO_LARGE',
        `收费金额不能超过 ${MAX_REPORTED_CHARGE} 元，请核对是否多打了数字`,
      );
    }
    // 小数位校验：`numeric(12,2)` 会**静默四舍五入**第三位小数，
    // 于是师傅填的 30.005 入库变成 30.01，而回执上写着 30.005。
    // 宁可让提交失败，也不要让显示值与存储值不一致。
    if (Math.round(amount * 100) / 100 !== amount) {
      throw new ValidationError('CHARGE_AMOUNT_PRECISION', '收费金额最多保留两位小数');
    }
    reportedChargeAmount = amount;
  }

  return { serviceResult, serviceNote, isCharged, reportedChargeAmount };
}

/**
 * 解析 multipart 的单文件上传。
 *
 * 用 `koaMulter(...).single('file')` 后**手动 await 一次中间件**（第三参数是空 next）——
 * 这是 NocoBase 自己 `plugin-file-manager` 的写法（`attachments.js` 里同款调用），
 * 直接照抄而不是自己实现流式解析：multipart 的边界解析（尤其分块编码与
 * 恶意 boundary）不该由业务代码重新踩一遍。
 *
 * `memoryStorage` 而不是 `diskStorage`：文件要先经过 magic bytes 与元数据剥离
 * 才能决定"是什么、叫什么、放哪里"，而这些都在内存里做完最快。
 * 内存风险由 `limits.fileSize` 兜住（默认 5MB，可在后台调小）。
 */
async function readSingleUpload(
  ctx: any,
  maxSizeBytes: number,
): Promise<{ buffer: Buffer; mimetype?: string; originalname?: string } | null> {
  if (!ctx?.request?.is?.('multipart/*')) {
    // 非 multipart 的 POST：直接告诉调用方要用什么形态，
    // 让它自己去挂 `if (!file) fail(422)` 而不是在这里抛一个看不懂的错。
    return null;
  }

  const middleware = koaMulter({
    storage: memoryStorage(),
    limits: {
      // 单文件。多文件字段（`files` 数组）在这里就被拒 —— 本接口一次只收一张，
      // 前端循环调用即可；一次收多张会让"张数上限"的原子性变复杂。
      files: 1,
      fileSize: maxSizeBytes,
    },
  }).single(UPLOAD_FIELD_NAME);

  try {
    await middleware(ctx, async () => {});
  } catch (error) {
    const name = (error as { name?: string })?.name;
    const code = (error as { code?: string })?.code;
    if (name === 'MulterError' && code === 'LIMIT_FILE_SIZE') {
      throw new VisitValidationError(
        'PHOTO_TOO_LARGE',
        `单张照片不能超过 ${Math.floor(maxSizeBytes / 1024 / 1024)}MB，请压缩后重试`,
        413,
      );
    }
    if (name === 'MulterError') {
      throw new ValidationError('UPLOAD_MALFORMED', `上传内容无法解析（${String(code)}）`);
    }
    throw error;
  }

  const file = ctx?.[UPLOAD_FIELD_NAME] ?? ctx?.request?.file ?? null;
  if (!file || !file.buffer) return null;
  return file;
}

function readPhotoType(ctx: any): string {
  const values = readValues(ctx);
  const raw = String(values.photo_type ?? ctx?.action?.params?.photo_type ?? '').trim();
  return raw || PHOTO_TYPE.ONSITE;
}

/** body 里的业务字段（NocoBase 把 body 摊在 `action.params.values` 上） */
function readValues(ctx: any): Record<string, any> {
  const values = ctx?.action?.params?.values;
  return values && typeof values === 'object' ? values : {};
}

/** query 参数（`param()` 会优先看 body，这里只需要 query） */
function readParam(ctx: any, key: string): unknown {
  const fromQuery = ctx?.action?.params?.[key];
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== '') return fromQuery;
  return ctx?.query?.[key];
}

/**
 * 照片读不到时的**统一响应**。
 *
 * 为什么和 401 用不同的 code：这里 Token 是有效的，失败的是"这张照片不存在"
 * 或"不属于你"。用 404 `PHOTO_NOT_FOUND` 表达 —— 两种情况**回同一个响应**，
 * 于是它不构成"这个 ref 存在吗"的探测器（与 `TOKEN_INVALID` 不区分原因同源）。
 * 不外泄"存在但无权限"这一点很重要：那会告诉攻击者 ref 猜对了。
 */
function notFoundPhoto(ctx: any): void {
  fail(ctx, 404, 'PHOTO_NOT_FOUND', '照片不存在或已失效');
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** 从照片行取私有相对路径（读取前判存在用） */
function storageKeyOfRow(row: any): string {
  return String(row?.storage_key ?? '');
}

/**
 * PG 的 `timestamptz` 经 Sequelize 取回来可能是 Date，桩环境可能是字符串。
 * 一律归一成 ISO 字符串输出 —— 直接把 Date 塞进 JSON 也能序列化，
 * 但两种形态混在同一个响应里会让前端与断言各写一套解析。
 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 供断言脚本与文档引用：师傅侧作业状态的合法取值集合 */
export const TECHNICIAN_JOB_STATUS_VALUES = Object.values(TECHNICIAN_JOB_STATUS);

/** 保持与枚举的显式关联，防止有人误以为 `pending` 是 VISIT_STATUS 的成员 */
export const TECHNICIAN_JOB_STATUS_SOURCE = VISIT_STATUS.ASSIGNED;

/** 供断言脚本引用：提交成功文案的唯一事实来源（"完成"二字绝不允许出现） */
export const TECHNICIAN_SUBMIT_SUCCESS_MESSAGE = SUBMIT_SUCCESS_MESSAGE;

/** 供断言脚本引用：上报金额的合理性上界 */
export const TECHNICIAN_MAX_REPORTED_CHARGE = MAX_REPORTED_CHARGE;

/** 供断言脚本引用：multipart 字段名 */
export const TECHNICIAN_UPLOAD_FIELD = UPLOAD_FIELD_NAME;
