/**
 * SmsService —— 短信的**唯一**出口（scene → 模板 → Provider → SmsLog → 事件）
 *
 * 它把下面四件事收在一处，因为任何一件散出去都会产生"看不出错"的缺陷：
 *
 *  1) **scene 与收件人身份的匹配**。混用一个 scene 给两类人发短信不会报任何错
 *     （供应商只认模板 CODE），所以必须在代码里拦（见 SMS_SCENE_RECIPIENT）。
 *
 *  2) **事务性发件箱**（transactional outbox）。顺序是死的：
 *       ① 业务事务内 `enqueue()`：写一条 `send_status=pending` 的 SmsLog
 *          （含 scene/模板/脱敏收件人/biz_id），**不碰网络**；
 *       ② 业务提交后 `flush()`：才真正调供应商，把状态改成 accepted/rejected/error
 *          并写 `sms_sent` / `sms_failed` 事件。
 *     为什么不能反过来（先发再记）：那样"提交成功但写日志失败"会丢记录，
 *     而"记了日志但业务回滚了"更糟 —— 客户会收到一条指向不存在工单的短信。
 *     为什么不能把发送塞进事务：外部 HTTP 可能几秒，会长时间占住工单行的锁；
 *     更要紧的是 **外部失败不该回滚派工** —— 师傅已经派出去了，那是既成事实。
 *
 *  3) **accepted ≠ delivered**。我们唯一能确定的是"供应商受理了"。
 *     `delivery_status` 在本服务里**永远保持 pending**，只能由回执更新
 *     （Phase 8 的 smsCallback）。见 SmsSendResult.deliveryStatus 的类型约束。
 *
 *  4) **绝不落明文手机号与正文**。SmsLog 只存 `recipient_masked`；
 *     预览正文不进库（它含作业链接里的 Token 明文），只在 mock 通道的内存发件箱里。
 *
 * ⚠️ `flush()` **永不抛错**。它的调用点全部在"业务已经提交"之后，
 *    此时抛错既无法回滚业务，又会让调用栈里多一个无人处理的拒绝。
 *    所有失败都必须表现为 SmsLog 的状态 + `sms_failed` 事件 + warn 日志。
 */
import { randomBytes } from 'node:crypto';

import {
  SMS_PREVIEW_MAX_LENGTH,
  SMS_PROVIDER_NAME,
  SMS_RECIPIENT_ANY,
  SMS_SCENE,
  SMS_SCENE_RECIPIENT,
  SMS_SCENE_VALUES,
  SMS_SEND_STATUS,
  SMS_DELIVERY_STATUS,
  SMS_TEMPLATE_ENV_PREFIX,
  SMS_TEMPLATE_ENV_SUFFIX,
  SMS_TEMPLATE_NOT_CONFIGURED,
  SMS_TEMPLATE_TEXT,
  EVENT_TYPE,
  OPERATOR_KIND,
  isMobile,
} from '../constants';
import { maskMobileText } from './permission-service';
import {
  MockSmsProvider,
  SMS_MISCONFIGURED,
  SMS_TEMPLATE_MISSING,
  createSmsProvider,
  type SmsProvider,
  type SmsSendRequest,
  type SmsSendResult,
} from './sms-provider';
import type { ConfigService } from './config-service';
import type { EventService } from './event-service';

/** 发件箱关闭时的错误码（sms.enabled=false） */
export const SMS_DISABLED = 'SMS_DISABLED';
/** 重试判据：只有**传输层**失败才重试 */
const RETRYABLE_ERROR_CODES = new Set(['SMS_TRANSPORT_ERROR', 'SMS_TIMEOUT']);

export interface EnqueueSmsInput {
  scene: string;
  /** 收件人身份（customer / technician），与 scene 的映射必须一致 */
  recipientKind: string;
  /** 明文手机号（入队后只在内存 PendingSms 里） */
  to: string;
  ticketId?: number | string | null;
  visitId?: number | string | null;
  params: Record<string, string | number>;
  /** 复用既有 biz_id（重发场景），缺省自动生成 */
  bizId?: string;
}

/**
 * 已入队、待发送的短信。
 *
 * ⚠️ 它在**事务提交之后**仍然被使用，因此必须自包含：
 *    不能依赖事务内的任何对象（事务结束即失效）。
 */
export interface PendingSms {
  smsLogId: number | null;
  bizId: string;
  scene: string;
  templateCode: string;
  ticketId: number | null;
  visitId: number | null;
  request: SmsSendRequest;
  /** 事务内写库时是否成功（失败时仍会尝试发送，但会带上告警） */
  persisted: boolean;
}

export interface SmsFlushResult {
  bizId: string;
  scene: string;
  accepted: boolean;
  errorCode: string | null;
  retryCount: number;
}

export interface SmsServiceOptions {
  config: ConfigService;
  events: EventService;
  logger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
    info?: (msg: string) => void;
    /**
     * 只有在**我们自己的代码**出问题时才用它（`flush` 的兜底 catch）。
     * 通知失败（供应商拒绝、通道未就绪）一律用 warn ——
     * 那是业务可继续的事件，记 error 会让"app 日志无 error"这条运维断言失效。
     */
    error?: (msg: string) => void;
  };
  env?: Record<string, string | undefined>;
  /** 注入 Provider（测试用）。不传时按 `sms.provider` 参数惰性构造并缓存。 */
  provider?: SmsProvider;
  /** 注入 fetch（透传给真实 Provider，测试用） */
  fetchFn?: typeof fetch;
}

/** smsLogs.template_code 的 varchar(64) 上限 */
const TEMPLATE_CODE_MAX = 64;
/** smsLogs.biz_id 的 varchar(64) 上限 */
const BIZ_ID_MAX = 64;
/** smsLogs.error_message 的 varchar(255) 上限 */
const ERROR_MESSAGE_MAX = 255;

export class SmsService {
  private readonly db: any;
  private readonly config: ConfigService;
  private readonly events: EventService;
  private readonly logger?: SmsServiceOptions['logger'];
  private readonly env: Record<string, string | undefined>;
  private readonly fetchFn?: typeof fetch;

  /** 已构造的 Provider（按名字缓存 —— 后台改参数后 10s 内换用新实例） */
  private readonly providers = new Map<string, SmsProvider>();
  private readonly injectedProvider?: SmsProvider;

  constructor(db: any, options: SmsServiceOptions) {
    this.db = db;
    this.config = options.config;
    this.events = options.events;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.injectedProvider = options.provider;
    this.fetchFn = options.fetchFn;

    this.assertSceneTablesComplete();
    this.warnIfBaseUrlMissing();
  }

  // -------------------------------------------------------------------------
  // 场景表自检
  // -------------------------------------------------------------------------

  /**
   * 启动期自检：每个 scene 都必须有"收件人身份"与"模板环境变量后缀"。
   *
   * 为什么这必须是**启动失败**而不是告警：
   *   漏了收件人映射 → 运行期发送时才发现（那时业务已在推进）；
   *   漏了模板后缀 → 该场景永远拿不到模板 CODE，短信静默落 rejected，
   *   而 rejected 只是一个"通知没发出去"，很容易在验收时被当成"短信服务商的问题"。
   *   两者都是"加了新场景忘了改配套常量"，在启动期一次性拦住最省事。
   *
   * `manual_resend` 是唯一豁免 template 后缀的场景：它由门店手工指定转发目标与模板。
   */
  private assertSceneTablesComplete(): void {
    const missingRecipient = SMS_SCENE_VALUES.filter(
      (scene) => !SMS_SCENE_RECIPIENT[scene],
    );
    if (missingRecipient.length > 0) {
      throw new Error(
        `[sms] 这些 scene 没有声明收件人身份（constants.SMS_SCENE_RECIPIENT）：${missingRecipient.join(', ')}；` +
          '没有它就无法阻止"用客户模板发给师傅"这类混用',
      );
    }

    const missingTemplate = SMS_SCENE_VALUES.filter(
      (scene) => scene !== SMS_SCENE.MANUAL_RESEND && !SMS_TEMPLATE_ENV_SUFFIX[scene],
    );
    if (missingTemplate.length > 0) {
      throw new Error(
        `[sms] 这些 scene 没有声明模板环境变量后缀（constants.SMS_TEMPLATE_ENV_SUFFIX）：${missingTemplate.join(', ')}；` +
          '漏配的表现是"短信静默落 rejected"，不会报错',
      );
    }

    const unknownText = Object.keys(SMS_TEMPLATE_TEXT).filter(
      (scene) => !SMS_SCENE_VALUES.includes(scene as any),
    );
    if (unknownText.length > 0) {
      throw new Error(`[sms] SMS_TEMPLATE_TEXT 含未知 scene：${unknownText.join(', ')}`);
    }
  }

  /** PUBLIC_BASE_URL 缺失只告警（它会让作业链接不可点，但不该阻断业务） */
  private warnIfBaseUrlMissing(): void {
    const base = String(this.env.PUBLIC_BASE_URL ?? '').trim();
    if (!base) {
      this.logger?.warn?.(
        '[sms] PUBLIC_BASE_URL 未配置：短信里的师傅作业链接将只有路径，师傅无法直接打开',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Provider 解析
  // -------------------------------------------------------------------------

  /** 当前通道名（来自 serviceSettings，可被后台随时改；有 10s 缓存） */
  async currentProviderName(): Promise<string> {
    const name = await this.config.getString('sms.provider', SMS_PROVIDER_NAME.MOCK);
    return String(name ?? '').trim().toLowerCase() || SMS_PROVIDER_NAME.MOCK;
  }

  private async currentProvider(): Promise<SmsProvider> {
    if (this.injectedProvider) return this.injectedProvider;

    const name = await this.currentProviderName();
    const cached = this.providers.get(name);
    if (cached) return cached;

    const provider = createSmsProvider(name, {
      env: this.env,
      logger: this.logger,
      fetchFn: this.fetchFn,
    });
    this.providers.set(name, provider);
    this.logger?.info?.(`[sms] 通道已就绪：${provider.name}`);
    return provider;
  }

  /**
   * 若当前通道是 mock，返回它的发件箱实例；否则 null。
   *
   * 这是 `svc:smsOutbox` 的**自毁闸**：切到真实通道后它返回 null，
   * 上层据此回 404 —— 接口不是"忘了删"，而是"在真实通道下不存在"。
   */
  async mockOutbox(): Promise<MockSmsProvider | null> {
    const provider = await this.currentProvider();
    return provider instanceof MockSmsProvider ? provider : null;
  }

  /** 当前通道是否 mock（`svc:tokenCheck` 与 `svc:smsOutbox` 的同一个闸） */
  async isMockChannel(): Promise<boolean> {
    return (await this.currentProvider()).name === SMS_PROVIDER_NAME.MOCK;
  }

  // -------------------------------------------------------------------------
  // 入队（**必须在业务事务内调用**）
  // -------------------------------------------------------------------------

  /**
   * 把一条短信写进发件箱（`send_status=pending`），**不发送**。
   *
   * @param transaction NocoBase 事务对象。**必传** —— 不传就失去"业务与通知同生共死"
   *                    这条保证：业务回滚了而 SmsLog 留下，客户会收到指向不存在工单的短信。
   */
  async enqueue(input: EnqueueSmsInput, transaction?: unknown): Promise<PendingSms> {
    const scene = String(input.scene ?? '').trim();
    if (!SMS_SCENE_VALUES.includes(scene as any)) {
      throw new Error(
        `[sms] 未知 scene "${scene}"（允许：${SMS_SCENE_VALUES.join(' / ')}）。` +
          'scene 是白名单，新增需走 constants.ts 评审。',
      );
    }

    const expectedKind = SMS_SCENE_RECIPIENT[scene];
    if (expectedKind !== SMS_RECIPIENT_ANY && expectedKind !== String(input.recipientKind)) {
      // 这条断言就是"客户短信与师傅短信必须是两个独立 scene"的可执行版本
      throw new Error(
        `[sms] scene "${scene}" 的收件人是 ${expectedKind}，但调用方声明的收件人身份是 ` +
          `"${input.recipientKind}"。收件人不同必须使用不同 scene —— ` +
          '混用不会报错，但会让某个人收到与他无关的通知。',
      );
    }

    const to = String(input.to ?? '').trim();
    if (!isMobile(to)) {
      // 走到这里说明上游漏了校验（客户手机号在建单时已校验、师傅手机号在派工时已校验）。
      // 抛错是刻意的：这是**代码缺陷**，不该以"短信发不出去"的形式被静默吸收。
      throw new Error(`[sms] scene "${scene}" 的收件人不是合法手机号（上游漏校验？）`);
    }

    const provider = await this.currentProvider();
    const templateCode = await this.templateCodeFor(scene, provider.name);
    const params = normalizeParams(input.params);
    const preview = this.renderPreview(scene, params, provider.signName);
    const bizId = input.bizId
      ? String(input.bizId)
      : makeBizId(scene, input.ticketId ?? null, input.visitId ?? null);

    if (bizId.length > BIZ_ID_MAX) {
      throw new Error(`[sms] biz_id 超过 ${BIZ_ID_MAX} 字符：${bizId}`);
    }

    const request: SmsSendRequest = {
      to,
      recipientMasked: maskMobileText(to),
      recipientKind: String(input.recipientKind),
      scene,
      templateCode,
      params,
      preview,
      bizId,
    };

    const smsLogId = await this.insertPending(request, {
      ticketId: input.ticketId ?? null,
      visitId: input.visitId ?? null,
      provider: provider.name,
      transaction,
    });

    this.logger?.debug?.(
      `[sms] 已入队 ${scene} → ${request.recipientMasked}（biz=${bizId}${smsLogId ? ` log=${smsLogId}` : ''}）`,
    );

    return {
      smsLogId,
      bizId,
      scene,
      templateCode,
      ticketId: toNullableInt(input.ticketId),
      visitId: toNullableInt(input.visitId),
      request,
      persisted: smsLogId !== null,
    };
  }

  private async insertPending(
    request: SmsSendRequest,
    extra: {
      ticketId: number | string | null;
      visitId: number | string | null;
      provider: string;
      transaction?: unknown;
    },
  ): Promise<number | null> {
    const repository = this.db.getRepository('smsLogs');
    const values: Record<string, unknown> = {
      scene: request.scene,
      provider: extra.provider,
      // template_code NOT NULL：拿不到模板时写入一个**自解释的占位值**，
      // 而不是空串 —— 运维在后台看到它就明白"这条不是供应商拒绝，是我们没配模板"。
      template_code: (request.templateCode || SMS_TEMPLATE_NOT_CONFIGURED).slice(
        0,
        TEMPLATE_CODE_MAX,
      ),
      recipient_masked: request.recipientMasked,
      biz_id: request.bizId,
      send_status: SMS_SEND_STATUS.PENDING,
      // ⚠️ 送达状态永远是 pending 起步，只能由回执推进（见文件头第 3 条）
      delivery_status: SMS_DELIVERY_STATUS.PENDING,
      retry_count: 0,
    };

    const ticketId = toNullableInt(extra.ticketId);
    if (ticketId !== null) values.ticket_id = ticketId;
    const visitId = toNullableInt(extra.visitId);
    if (visitId !== null) values.visit_id = visitId;

    const options: Record<string, unknown> = { values };
    if (extra.transaction) options.transaction = extra.transaction;

    const row = await repository.create(options);
    const id = Number((row as any)?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  // -------------------------------------------------------------------------
  // 发送（**必须在业务事务提交之后调用**）
  // -------------------------------------------------------------------------

  /**
   * 把已入队的短信真正发出去。**永不抛错**（见文件头）。
   *
   * 逐条串行发送：短信量在派工场景下是个位数，串行换来的是"日志顺序即业务顺序"，
   * 排障时不用做并发归因。Phase 8 的批量重发任务同样复用本方法。
   */
  async flush(list: PendingSms[]): Promise<SmsFlushResult[]> {
    const results: SmsFlushResult[] = [];
    if (!list || list.length === 0) return results;

    const enabled = await this.config.getBool('sms.enabled', false);
    const retryLimit = await this.config.getInt('sms.retry_count', 1);
    const provider = await this.currentProvider();

    for (const pending of list) {
      try {
        results.push(await this.deliverOne(pending, { enabled, retryLimit, provider }));
      } catch (error) {
        // 单个失败绝不影响其余（短信之间没有依赖）
        this.logger?.error?.(
          `[sms] 发送 ${pending.scene}（biz=${pending.bizId}）出现未预期异常：${(error as Error)?.message}`,
        );
        results.push({
          bizId: pending.bizId,
          scene: pending.scene,
          accepted: false,
          errorCode: 'SMS_INTERNAL_ERROR',
          retryCount: 0,
        });
      }
    }

    return results;
  }

  private async deliverOne(
    pending: PendingSms,
    ctx: { enabled: boolean; retryLimit: number; provider: SmsProvider },
  ): Promise<SmsFlushResult> {
    const { provider } = ctx;

    // ---- 闸 1：通道未就绪（sms.enabled=false）----
    // 刻意"不发送但如实记录"：派工是既成事实，不能因为通知发不出去而失败；
    // 而通知缺失必须留下可查的痕迹（SmsLog.rejected + sms_failed 事件）。
    if (!ctx.enabled) {
      await this.finish(pending, {
        accepted: false,
        errorCode: SMS_DISABLED,
        errorMessage: '短信通道未就绪（参数 sms.enabled=false），本次未提交',
        providerRequestId: null,
        retryCount: 0,
        provider,
      });
      return {
        bizId: pending.bizId,
        scene: pending.scene,
        accepted: false,
        errorCode: SMS_DISABLED,
        retryCount: 0,
      };
    }

    // ---- 闸 2：该场景没有模板 CODE（真实通道才有意义；mock 不需要模板）----
    if (provider.name !== SMS_PROVIDER_NAME.MOCK && !pending.templateCode) {
      await this.finish(pending, {
        accepted: false,
        errorCode: SMS_TEMPLATE_MISSING,
        errorMessage: `未配置场景 ${pending.scene} 的模板 CODE，本次未提交`,
        providerRequestId: null,
        retryCount: 0,
        provider,
      });
      return {
        bizId: pending.bizId,
        scene: pending.scene,
        accepted: false,
        errorCode: SMS_TEMPLATE_MISSING,
        retryCount: 0,
      };
    }

    // ---- 正式提交，最多重试 retry_limit 次（只重试传输层失败）----
    let attempt = 0;
    let last = await safeSend(provider, pending.request, this.logger);

    while (
      !last.accepted &&
      attempt < ctx.retryLimit &&
      RETRYABLE_ERROR_CODES.has(String(last.errorCode ?? ''))
    ) {
      attempt += 1;
      this.logger?.warn?.(
        `[sms] ${pending.scene} 提交失败（${last.errorCode}），第 ${attempt} 次重试（biz=${pending.bizId}）`,
      );
      last = await safeSend(provider, pending.request, this.logger);
    }

    await this.finish(pending, {
      accepted: last.accepted,
      errorCode: last.errorCode ?? null,
      errorMessage: last.errorMessage ?? null,
      providerRequestId: last.providerRequestId ?? null,
      retryCount: attempt,
      provider,
    });

    return {
      bizId: pending.bizId,
      scene: pending.scene,
      accepted: last.accepted,
      errorCode: last.errorCode ?? null,
      retryCount: attempt,
    };
  }

  /**
   * 落状态 + 写事件（**独立事务**，与业务事务无关 —— 此时业务已提交）。
   *
   * 状态语义（这是本项目最容易被写错的一处）：
   *   accepted=true  → `send_status=accepted`（**只表示供应商已受理**），
   *                    `delivery_status` 仍是 `pending`；写 `sms_sent` 事件。
   *   accepted=false → `send_status` = rejected（业务性拒绝，如模板没配）或
   *                    error（传输/超时）；写 `sms_failed` 事件。
   * 两者的 `delivery_status` **都不动** —— 它只能由供应商回执更新。
   */
  private async finish(
    pending: PendingSms,
    outcome: {
      accepted: boolean;
      errorCode: string | null;
      errorMessage: string | null;
      providerRequestId: string | null;
      retryCount: number;
      provider: SmsProvider;
    },
  ): Promise<void> {
    const sendStatus = outcome.accepted
      ? SMS_SEND_STATUS.ACCEPTED
      : isTransportFailure(outcome.errorCode)
        ? SMS_SEND_STATUS.ERROR
        : SMS_SEND_STATUS.REJECTED;

    await this.withTransaction(async (transaction) => {
      if (pending.smsLogId !== null) {
        await this.updateLog(
          pending.smsLogId,
          {
            sendStatus,
            providerRequestId: outcome.providerRequestId,
            errorCode: outcome.errorCode,
            errorMessage: outcome.errorMessage,
            retryCount: outcome.retryCount,
            acceptedAt: outcome.accepted ? new Date() : null,
          },
          transaction,
        );
      }

      if (pending.ticketId !== null) {
        await this.events.write({
          ticketId: pending.ticketId,
          visitId: pending.visitId,
          eventType: outcome.accepted ? EVENT_TYPE.SMS_SENT : EVENT_TYPE.SMS_FAILED,
          operatorKind: OPERATOR_KIND.SYSTEM,
          summary: outcome.accepted
            ? `已提交短信：${sceneSummary(pending.scene)} → ${pending.request.recipientMasked}`
            : `短信未发出：${sceneSummary(pending.scene)} → ${pending.request.recipientMasked}` +
              `（${outcome.errorCode ?? '未知原因'}）`,
          metadata: {
            scene: pending.scene,
            provider: outcome.provider.name,
            template_code: pending.templateCode || null,
            recipient_masked: pending.request.recipientMasked,
            recipient_kind: pending.request.recipientKind,
            biz_id: pending.bizId,
            provider_request_id: outcome.providerRequestId,
            error_code: outcome.errorCode,
            // 只记提交状态，不记送达 —— 事件里出现 "delivered" 会误导报表
            send_status: sendStatus,
            delivery_status: SMS_DELIVERY_STATUS.PENDING,
            retry_count: outcome.retryCount,
            // ⚠️ 刻意不写正文：正文含作业链接里的 Token 明文
          },
          transaction,
        });
      }
    });

    if (outcome.accepted) {
      this.logger?.info?.(
        `[sms] 已受理 ${pending.scene} → ${pending.request.recipientMasked}` +
          `（provider=${outcome.provider.name}，req=${outcome.providerRequestId ?? '-'}）`,
      );
    } else {
      // warn 而非 error：通知失败是**业务可继续**的事件，而且往往成批出现
      // （例如整个通道没配好）。记 error 会让"app 日志无 error"这条运维断言失效。
      this.logger?.warn?.(
        `[sms] 未发出 ${pending.scene} → ${pending.request.recipientMasked}` +
          `（${outcome.errorCode ?? '未知'}：${outcome.errorMessage ?? '-'}）`,
      );
    }
  }

  private async updateLog(
    smsLogId: number,
    values: {
      sendStatus: string;
      providerRequestId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      retryCount: number;
      acceptedAt: Date | null;
    },
    transaction?: unknown,
  ): Promise<void> {
    const [rows] = await this.rawQuery(
      `UPDATE sms_logs
          SET send_status = $2,
              provider_request_id = COALESCE($3, provider_request_id),
              error_code = $4,
              error_message = $5,
              retry_count = $6,
              sent_at = COALESCE(sent_at, $7),
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [
        smsLogId,
        values.sendStatus,
        values.providerRequestId,
        values.errorCode,
        values.errorMessage ? values.errorMessage.slice(0, ERROR_MESSAGE_MAX) : null,
        values.retryCount,
        values.acceptedAt,
      ],
      transaction,
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      // 更新不到行说明 SmsLog 没写成功（见 PendingSms.persisted）。不抛错：
      // 此刻业务已提交，抛错只会多一条无人处理的异常；用 warn 让它可见。
      this.logger?.warn?.(`[sms] SmsLog ${smsLogId} 状态更新未命中任何行`);
    }
  }

  // -------------------------------------------------------------------------
  // 模板与文案
  // -------------------------------------------------------------------------

  /**
   * 取某 scene 在当前通道下的模板 CODE。
   *
   * mock 通道返回空串：它不做模板映射，`template_code` 那一列会写成
   * 自解释的占位值（SMS_TEMPLATE_NOT_CONFIGURED），不影响功能。
   */
  async templateCodeFor(scene: string, providerName?: string): Promise<string> {
    const name = providerName ?? (await this.currentProviderName());
    if (name === SMS_PROVIDER_NAME.MOCK) return '';

    const prefix = SMS_TEMPLATE_ENV_PREFIX[name];
    const suffix = SMS_TEMPLATE_ENV_SUFFIX[scene];
    if (!prefix || !suffix) return '';

    return String(this.env[`${prefix}${suffix}`] ?? '').trim();
  }

  /**
   * 渲染预览文案。
   *
   * 这是**给人看的**（日志、mock 发件箱、联调核对），真实发送时供应商用自己审核过的模板。
   * 两者必须人工保持同步 —— 已在 docs/DEVIATIONS.md 登记为已知双维护点。
   */
  renderPreview(
    scene: string,
    params: Record<string, string | number>,
    signName: string,
  ): string {
    const template = SMS_TEMPLATE_TEXT[scene];
    if (!template) {
      return `【${signName}】${scene}：${JSON.stringify(params)}`;
    }

    const merged: Record<string, string | number> = { ...params, sign: signName };
    let text = template.replace(/\{(\w+)\}/g, (_all, key: string) => {
      const value = merged[key];
      return value === undefined || value === null ? '' : String(value);
    });

    text = text.replace(/\s{2,}/g, ' ').trim();
    if (text.length > SMS_PREVIEW_MAX_LENGTH) {
      text = `${text.slice(0, SMS_PREVIEW_MAX_LENGTH - 1)}…`;
    }
    return text;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async rawQuery(
    sqlText: string,
    bind: unknown[],
    transaction?: unknown,
  ): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[sms] db.sequelize.query 不可用');
    }
    const options: Record<string, unknown> = { bind };
    if (transaction) options.transaction = transaction;
    return (await sequelize.query(sqlText, options)) as [unknown, unknown];
  }

  /** 与 TicketService.withTransaction 同一约定：宿主没有事务能力时退化为直连 */
  private async withTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      return fn(undefined);
    }
    return sequelize.transaction(fn);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 事件 summary 里的场景中文名（后台时间线直接可读） */
export function sceneSummary(scene: string): string {
  const labels: Record<string, string> = {
    [SMS_SCENE.DISPATCH_CUSTOMER]: '派工通知（客户）',
    [SMS_SCENE.TECHNICIAN_TASK]: '派工通知（师傅）',
    [SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED]: '改派取消通知（原师傅）',
    [SMS_SCENE.DISPATCH_UPDATE]: '上门信息更新通知（客户）',
    [SMS_SCENE.REVIEW_INVITE]: '评价邀约（客户）',
    [SMS_SCENE.MANUAL_RESEND]: '手工重发',
  };
  return labels[scene] ?? scene;
}

/**
 * biz_id：同时也是回执幂等键（`unique(provider, biz_id)`）。
 *
 * 为什么必须带 scene：同一张工单、同一条 Visit 会给**两个人**发短信
 * （客户 + 师傅），只用 ticket+visit 生成就会撞唯一约束 ——
 * 而且撞的时机很靠后（第二条短信入队时才炸），现场表现为"派工失败但看不出为什么"。
 */
export function makeBizId(
  scene: string,
  ticketId: number | string | null,
  visitId: number | string | null,
): string {
  const ticket = ticketId === null || ticketId === undefined ? 'x' : String(ticketId);
  const visit = visitId === null || visitId === undefined ? 'x' : String(visitId);
  const suffix = randomBytes(4).toString('hex');
  return `${scene}-${ticket}-${visit}-${suffix}`.slice(0, BIZ_ID_MAX);
}

/** 模板变量只允许标量；对象/数组会被供应商拒（也可能被拼成 [object Object] 发出去） */
function normalizeParams(params: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value ? '1' : '0';
    } else {
      throw new Error(`[sms] 模板变量 ${key} 不是标量（模板变量只能是字符串或数字）`);
    }
  }
  return out;
}

/** Provider.send 绝不抛错这条约定由本包装兜底（第三方实现不遵守时也不会炸调用方） */
async function safeSend(
  provider: SmsProvider,
  request: SmsSendRequest,
  logger?: SmsServiceOptions['logger'],
): Promise<SmsSendResult> {
  try {
    return await provider.send(request);
  } catch (error) {
    logger?.warn?.(`[sms] provider(${provider.name}).send 抛出异常：${(error as Error)?.message}`);
    return {
      accepted: false,
      providerRequestId: null,
      errorCode: 'SMS_PROVIDER_THREW',
      errorMessage: String((error as Error)?.message ?? error),
      deliveryStatus: 'pending',
    };
  }
}

function isTransportFailure(errorCode: string | null): boolean {
  return RETRYABLE_ERROR_CODES.has(String(errorCode ?? '')) || errorCode === 'SMS_PROVIDER_THREW';
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && Number.isInteger(num) && num > 0 ? num : null;
}

/** 供其它模块复用的通道常量（避免到处 import provider 实现） */
export { SMS_MISCONFIGURED, SMS_TEMPLATE_MISSING };
export type { SmsProvider, SmsSendRequest };
