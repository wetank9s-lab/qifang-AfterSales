/**
 * SmsProvider —— 短信通道的**抽象边界**
 *
 * 这一层的存在理由只有一条，但足够重要：
 *
 *   > **业务层（TicketService / VisitService）永远不知道短信是怎么发出去的。**
 *
 * 具体说，`TicketService.dispatch()` 里不允许出现任何阿里云的痕迹 ——
 * 不允许 import SDK、不允许拼签名、不允许知道"模板 CODE"长什么样。
 * 它只做一件事：把"该通知谁、什么场景、参数是什么"交给 `SmsService`。
 *
 * 为什么值得为它设一道墙：短信通道是**最容易换**的一环
 * （阿里云 → 腾讯云 → 自建网关 → 短信猫），而换通道这件事一旦渗进业务代码，
 * 就会变成"改一行代码要重新回归全部派工/评价流程"。
 * 抽象之后，换通道只是新增一个 Provider 实现 + 改一个配置值。
 *
 * ⚠️ `SmsSendResult.deliveryStatus` 的类型被**钉死**为 `'pending'`。
 *    这不是过度设计，是把"accepted ≠ delivered"这条纪律写进类型系统：
 *    供应商的 HTTP 响应只能告诉我们"已受理"，
 *    真实送达与否要走**回执**（Phase 8 的 smsCallback）。
 *    任何 Provider 想在 send() 里返回 `delivered` 都会被编译器拦下。
 */
import { createHmac, randomUUID } from 'node:crypto';

import { SMS_PROVIDER_NAME } from '../constants';

/** 一次提交给供应商的完整请求（含明文收件人 —— 脱敏版另存 SmsLog） */
export interface SmsSendRequest {
  /** 明文手机号。**只在传给供应商的这一瞬间存在**，绝不落库、绝不进日志 */
  to: string;
  /** 脱敏收件人（如 138****8000），用于日志与 SmsLog */
  recipientMasked: string;
  /** 收件人身份：customer / technician（见 constants.SMS_RECIPIENT_KIND） */
  recipientKind: string;
  scene: string;
  /** 供应商模板 CODE；mock 通道为空串 */
  templateCode: string;
  /** 模板变量 */
  params: Record<string, string | number>;
  /** 预览文案（真实通道不使用，供 mock 发件箱与日志排障） */
  preview: string;
  /** 业务流水号，同时是回执幂等键（unique(provider, biz_id)） */
  bizId: string;
}

export interface SmsSendResult {
  /** 供应商是否受理。**注意：受理 ≠ 送达** */
  accepted: boolean;
  providerRequestId?: string | null;
  /**
   * 🔴 供应商侧**回执 ID**（阿里云 `SendSms` 返回的 `BizId`）—— RB-8。
   *
   * 它是**回执匹配的唯一键**：官方回执报文里的 `MessageId` 就是这个值
   * （官方 QuerySendDetails：「BizId：发送回执 ID，即调用 SendSms 时返回的 BizId」）。
   *
   * ⚠️ 与 `providerRequestId`（`RequestId`，API 调用追踪号）**不是同一个值**，
   *    两者都不能替代本字段。
   */
  providerBizId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * ⚠️ 恒为 `'pending'`（类型即约束，见文件头）。
   * 送达状态只能由供应商回调更新，禁止任何 Provider 在这里声称 delivered。
   */
  deliveryStatus: 'pending';
}

export interface SmsProvider {
  /** 与 smsLogs.provider 的取值域一致 */
  readonly name: string;
  /** 短信签名（写进预览文案；真实通道下由供应商侧校验，发错签名会被拒） */
  readonly signName: string;
  /**
   * 发送。**实现不得抛错** —— 任何异常都要转成 `accepted:false` 的结果，
   * 因为调用方是"派工已经提交之后"的收尾步骤，此时再抛错已经无法回滚业务，
   * 只会让调用栈里多一个无人处理的异常。
   */
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

export interface SmsProviderOptions {
  env?: Record<string, string | undefined>;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
  /** 注入 fetch（测试用） */
  fetchFn?: typeof fetch;
  /** 提交超时（毫秒），默认 8000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Mock —— 开发/联调通道
// ---------------------------------------------------------------------------

/** mock 发件箱里的一条记录 */
export interface SmsOutboxEntry {
  seq: number;
  at: string;
  scene: string;
  recipientKind: string;
  recipientMasked: string;
  templateCode: string;
  params: Record<string, string | number>;
  preview: string;
  accepted: boolean;
  bizId: string;
}

/** 发件箱容量。够联调与一轮验收扫读，又不会把内存当数据库用。 */
const OUTBOX_CAPACITY = 200;

/**
 * 把短信预览里的**短链 Token 段**替换成 `***`（Phase 7，契约 §2）。
 *
 * 覆盖两条稳定短链：`/t/{technician token}`（作业）与 `/f/{review token}`（评价）。
 * 只保留 `scheme://host` 与路径前缀，因为排障真正需要回答的是
 * "基址配对了没有、用的是哪个入口"，而不是那串凭证本身。
 *
 * ⚠️ 为什么用正则替换而不是"按已知 token 精确替换"：
 *    本函数是**日志出口的最后一道过滤**，它不该依赖调用方把明文交接过来
 *    （交接本身就意味着明文多活了一段）。就地按形状抹掉，是覆盖面最大的做法。
 *
 * ⚠️ 有意**不**做 `**` 之类的花式掩码：日志要有唯一可 grep 的痕迹，
 *    `***` 一眼就知道"这里被脱敏了"，而部分掩码容易被误读成真实链接。
 */
function sanitizeLinkTokens(text: string): string {
  return String(text ?? '').replace(
    /(\/(?:t|f)\/)[A-Za-z0-9_-]{8,256}/g,
    '$1***',
  );
}

/**
 * Mock 通道：不发短信，把内容留在**进程内存**的发件箱里。
 *
 * 为什么需要发件箱而不是只打日志：
 *   师傅作业链接里的 Token 明文**只出现在短信里**（库里只有 sha256）。
 *   没有取回通道，"师傅打开链接"这条链路在本地就永远走不通，
 *   验收只能退化成"直接查库里的哈希"——那是测试自己伪造凭证，证明不了任何事。
 *
 * 为什么放内存而不是写文件/写库：
 *   ① 写文件会把**可用凭证**持久化到磁盘，比留在内存里危险得多；
 *   ② 写库要把 token 明文塞进 sms_logs，直接违背"明文不入库"的设计；
 *   ③ 内存版天然随进程重启清空，不会积攒历史凭证。
 *   代价是"重启后取不回旧链接"——联调场景下重新派一次即可。
 *
 * 对外暴露的唯一入口是 `svc:smsOutbox`（已登录 + 总部特权 + **仅 mock 通道存在**，
 * 见 actions/svc/dispatch.ts），切到真实通道后该接口自行 404。
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = SMS_PROVIDER_NAME.MOCK;
  readonly signName: string;

  private readonly outbox: SmsOutboxEntry[] = [];
  private seq = 0;
  private readonly logger?: SmsProviderOptions['logger'];

  constructor(options: SmsProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.signName = String(env.MOCK_SMS_SIGN_NAME ?? '模拟通道').trim() || '模拟通道';
    this.logger = options.logger;
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    this.seq += 1;
    this.outbox.push({
      seq: this.seq,
      at: new Date().toISOString(),
      scene: request.scene,
      recipientKind: request.recipientKind,
      recipientMasked: request.recipientMasked,
      templateCode: request.templateCode,
      params: request.params,
      preview: request.preview,
      accepted: true,
      bizId: request.bizId,
    });
    if (this.outbox.length > OUTBOX_CAPACITY) {
      this.outbox.splice(0, this.outbox.length - OUTBOX_CAPACITY);
    }

    // ⚠️ 这里把**预览正文**写进 debug 日志：mock 通道下它含作业/评价链接，
    //    是目前唯一不依赖 HTTP 的取回手段。仅 mock，且开发期 LOGGER_LEVEL 通常是 info，
    //    所以默认不会落盘；需要时开 debug 取链接。
    //
    // ⚠️⚠️ **Phase 7 起必须脱敏**（契约 §2 的 5 个泄漏面之一）：
    //    评价 Token 是**一次性**凭证，且明文"不得进任何日志"是用户明令。
    //    作业链接（`/t/`）此前已在用同一条 debug 日志，但评价链接是**新加**的，
    //    因此不能沿用"反正只 debug"的理由 —— 一条 debug 日志在排障时可能被长期打开。
    //    这里只还原 scheme://host 部分，把 token 段替换成 `***`：
    //    "链接点不开"这类排障真正需要的是"基址配对了没有"，不是那串 token。
    //    ⚠️ 注意：**发件箱里的 preview 保持原样**（那是 mock 取回凭证的唯一通路，
    //    且只在进程内存里）；只有**日志这一路**被脱敏。两者是不同的面，别一起改。
    this.logger?.debug?.(
      `[sms:mock] → ${request.recipientMasked}（${request.scene}）${sanitizeLinkTokens(request.preview)}`,
    );

    return {
      accepted: true,
      providerRequestId: `mock-${request.bizId}`,
      errorCode: null,
      errorMessage: null,
      deliveryStatus: 'pending',
    };
  }

  /** 最近 N 条（时间倒序）。`sinceSeq` 用于只取"本次新增"，避免历史噪声干扰断言 */
  list(limit = 20, sinceSeq = 0): SmsOutboxEntry[] {
    const filtered = this.outbox.filter((entry) => entry.seq > sinceSeq);
    return filtered.slice(-Math.max(1, Math.min(limit, OUTBOX_CAPACITY))).reverse();
  }

  /** 当前最大序号（调用方记下它，下一轮用 sinceSeq 只读增量） */
  get lastSeq(): number {
    return this.seq;
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 阿里云 —— 真实通道
// ---------------------------------------------------------------------------

const ALIYUN_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const ALIYUN_API_VERSION = '2017-05-25';

/**
 * 阿里云短信（Dysmsapi SendSms，RPC 风格 v1.0 签名）。
 *
 * 用 `fetch` 手写签名而**不引入官方 SDK**：
 *   ① 本项目的依赖面刻意保持最小（package.json 里没有 HTTP SDK 类依赖）；
 *   ② 签名算法是**公开且稳定**的（阿里云 RPC 风格十年未变），
 *      而成品 SDK 会带一堆用不到的客户端/凭据链逻辑；
 *   ③ 签名三行就能写清（见 buildSignedBody），可读性不比 SDK 差。
 *
 * 凭据缺失时**不抛错**（见工厂注释）：把失败留在 send() 里，
 * 让它在 SmsLog 上表现为 rejected + 明确的 error_code —— 运维能查，
 * 而应用不会因为一个配置项没填就起不来。
 */
export class AliyunSmsProvider implements SmsProvider {
  readonly name = SMS_PROVIDER_NAME.ALIYUN;
  readonly signName: string;

  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly regionId: string;
  private readonly logger?: SmsProviderOptions['logger'];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SmsProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.accessKeyId = String(env.ALIYUN_SMS_ACCESS_KEY_ID ?? '').trim();
    this.accessKeySecret = String(env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '').trim();
    this.signName = String(env.ALIYUN_SMS_SIGN_NAME ?? '').trim();
    this.regionId = String(env.ALIYUN_SMS_REGION_ID ?? 'cn-hangzhou').trim() || 'cn-hangzhou';
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 8000;

    const globalFetch = (globalThis as any).fetch;
    if (!options.fetchFn && typeof globalFetch !== 'function') {
      // Node < 18 才会走到这里；本项目的镜像基准远高于此。
      throw new Error('[sms:aliyun] 运行环境没有全局 fetch，无法发送短信');
    }
    this.fetchFn = options.fetchFn ?? globalFetch;
  }

  /** 凭据/签名是否齐备（工厂与 SmsService 用它决定"能不能真发"） */
  get configured(): boolean {
    return Boolean(this.accessKeyId && this.accessKeySecret && this.signName);
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    if (!this.configured) {
      return this.reject(
        SMS_MISCONFIGURED,
        '阿里云短信未配置完整（需要 ACCESS_KEY_ID / ACCESS_KEY_SECRET / SIGN_NAME），本次未提交',
      );
    }
    if (!request.templateCode) {
      return this.reject(SMS_TEMPLATE_MISSING, '未配置该场景的模板 CODE，本次未提交');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = buildSignedBody({
        accessKeyId: this.accessKeyId,
        accessKeySecret: this.accessKeySecret,
        params: {
          Action: 'SendSms',
          Version: ALIYUN_API_VERSION,
          RegionId: this.regionId,
          PhoneNumbers: request.to,
          SignName: this.signName,
          TemplateCode: request.templateCode,
          TemplateParam: JSON.stringify(request.params ?? {}),
          // OutId 回带在回执里，用来把供应商侧的记录与我们的 bizId 对上
          OutId: request.bizId,
        },
      });

      const response = await this.fetchFn(ALIYUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = safeJson(text);

      // 阿里云 HTTP 状态恒为 200，成败看 body 的 Code 字段 —— 这一点很容易写错：
      // 只看 response.ok 会把"签名错误""余额不足"全部当成成功。
      const code = String(payload?.Code ?? '').trim();
      const providerRequestId = String(payload?.RequestId ?? '').trim() || null;
      // 🔴 RB-8：`BizId` 才是回执匹配键（回执报文的 MessageId 就是它）。
      //    缺了它，回执永远匹配不上 → delivered 永远停在 pending 且**不报任何错**。
      const providerBizId = String(payload?.BizId ?? '').trim() || null;
      const message = String(payload?.Message ?? '').trim();

      if (response.ok && code === 'OK') {
        return {
          accepted: true,
          providerRequestId,
          providerBizId,
          errorCode: null,
          errorMessage: null,
          deliveryStatus: 'pending',
        };
      }

      return {
        accepted: false,
        providerRequestId,
        providerBizId,
        errorCode: code || `HTTP_${response.status}`,
        errorMessage: message || truncate(text, 200),
        deliveryStatus: 'pending',
      };
    } catch (error) {
      const aborted = (error as any)?.name === 'AbortError';
      return this.reject(
        aborted ? 'SMS_TIMEOUT' : 'SMS_TRANSPORT_ERROR',
        aborted
          ? `提交超时（>${this.timeoutMs}ms）`
          : String((error as Error)?.message ?? error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private reject(errorCode: string, errorMessage: string): SmsSendResult {
    this.logger?.warn?.(`[sms:aliyun] 未提交：${errorCode} —— ${errorMessage}`);
    return { accepted: false, providerRequestId: null, errorCode, errorMessage, deliveryStatus: 'pending' };
  }
}

/** 凭据不全（不是代码缺陷，是配置问题，因此单独给一个码便于运维检索） */
export const SMS_MISCONFIGURED = 'SMS_PROVIDER_NOT_CONFIGURED';
/** 该场景没有模板 CODE */
export const SMS_TEMPLATE_MISSING = 'SMS_TEMPLATE_NOT_CONFIGURED';

// ---------------------------------------------------------------------------
// 未实现通道（占位实现，只为了让"配置写错"有一个响亮的失败）
// ---------------------------------------------------------------------------
/**
 * 尚未实现的通道（当前只有腾讯云）。
 *
 * 为什么不直接抛错：`sms.provider` 是**后台可改的参数**。
 * 运营在后台把它改成 tencent 之后，应用不该因此起不来；
 * 正确的表现是"派工照常成功，短信一条条落 rejected + error_code=SMS_PROVIDER_NOT_IMPLEMENTED"，
 * 并在启动日志里明确警告。这样问题在一个可查的位置，而不是变成启动失败。
 */
export class NotImplementedSmsProvider implements SmsProvider {
  readonly name: string;
  readonly signName = '';

  constructor(name: string) {
    this.name = name;
  }

  async send(): Promise<SmsSendResult> {
    return {
      accepted: false,
      providerRequestId: null,
      errorCode: 'SMS_PROVIDER_NOT_IMPLEMENTED',
      errorMessage: `短信通道 "${this.name}" 本版本未实现（见 .env.example 第 6 节注释）`,
      deliveryStatus: 'pending',
    };
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 按名字造一个 Provider。**永不抛错**（理由见 NotImplementedSmsProvider）。
 * 未知名字同样退化成"响亮失败"的占位实现，而不是回退到 mock ——
 * 静默回退到 mock 意味着"生产环境以为发了短信、其实一条都没发"。
 */
// ---------------------------------------------------------------------------
// 短信宝（smsbao）—— 官方文档：https://www.smsbao.com/openapi/213.html
// ---------------------------------------------------------------------------

/**
 * 短信宝返回码 → 我们的 errorCode。
 *
 * ⚠️ **来源**：官方《发送国内短信接口API》的错误代码列表（原样照抄，没有推断）：
 *    30 错误密码 · 40 账号不存在 · 41 余额不足 · 43 IP地址限制 ·
 *    50 内容含有敏感词 · 51 手机号码不正确。
 *    官方对返回值的原话是：**"返回 '0' 视为发送成功，其他内容为错误提示内容"**。
 */
const SMSBAO_ERROR_CODES: Record<string, { code: string; message: string }> = {
  '30': { code: 'SMSBAO_BAD_CREDENTIAL', message: '短信宝：用户名与 ApiKey 不匹配（错误密码）' },
  '40': { code: 'SMSBAO_ACCOUNT_NOT_FOUND', message: '短信宝：账号不存在' },
  '41': { code: 'SMSBAO_INSUFFICIENT_BALANCE', message: '短信宝：余额不足' },
  '43': { code: 'SMSBAO_IP_RESTRICTED', message: '短信宝：来源 IP 被限制（后台 IP 白名单）' },
  '50': { code: 'SMSBAO_CONTENT_REJECTED', message: '短信宝：内容含敏感词，被拒' },
  '51': { code: 'SMSBAO_BAD_MOBILE', message: '短信宝：手机号码不正确' },
};

/** 通用短信产品（不填 `g` 时的默认产品），用于可读性，不是必填值 */
const SMSBAO_ENDPOINT = 'https://api.smsbao.com/sms';

export class SmsbaoProvider implements SmsProvider {
  readonly name = SMS_PROVIDER_NAME.SMSBAO;
  readonly signName: string;

  private readonly username: string;
  private readonly apiKey: string;
  private readonly productId: string;
  private readonly logger?: SmsProviderOptions['logger'];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SmsProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.username = String(env.SMSBAO_USERNAME ?? '').trim();
    // ⚠️ 只用 **ApiKey**：官方明确"推荐使用更安全"，且明确它可替代"登录密码 MD5"。
    //    ⇒ 本项目**不实现**"密码 MD5"那条旧路径（不为旧示例增加一段哈希处理）。
    this.apiKey = String(env.SMSBAO_API_KEY ?? '').trim();
    this.signName = String(env.SMSBAO_SIGN_NAME ?? '').trim();
    // `g` 只在客户使用**专用通道产品**时才需要；不填走通用产品。
    this.productId = String(env.SMSBAO_PRODUCT_ID ?? '').trim();
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 8000;

    const globalFetch = (globalThis as any).fetch;
    if (!options.fetchFn && typeof globalFetch !== 'function') {
      throw new Error('[sms:smsbao] 运行环境没有全局 fetch，无法发送短信');
    }
    this.fetchFn = options.fetchFn ?? globalFetch;
  }

  /** 凭据与签名是否齐备（工厂与 SmsService 用它决定"能不能真发"） */
  get configured(): boolean {
    return Boolean(this.username && this.apiKey && this.signName);
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    if (!this.configured) {
      return this.reject(
        SMS_MISCONFIGURED,
        '短信宝未配置完整（需要 SMSBAO_USERNAME / SMSBAO_API_KEY / SMSBAO_SIGN_NAME），本次未提交',
      );
    }

    // 🔴 短信宝收发的是**完整正文**（`c`），所以直接用渲染好的预览文案，
    //    **不查 templateCode**（这正是"不为它重建 TemplateCode 映射"的落点）。
    //    签名已在 `renderPreview()` 里按 `【{sign}】` 渲染 —— 官方要求正文必须含
    //    `【公司签名】`，两者一致，因此**不需要再加一次签名**。
    const content = String(request.preview ?? '').trim();
    if (!content) {
      return this.reject('SMS_CONTENT_EMPTY', '短信正文为空，本次未提交');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // ⚠️ `c` 需 UTF-8 URL ENCODE —— URLSearchParams 已按 UTF-8 百分号编码 ✓
      const query = new URLSearchParams({ u: this.username, p: this.apiKey, m: request.to, c: content });
      if (this.productId) query.set('g', this.productId); // 仅专用通道产品才带
      query.set('f', 'json'); // 按用户要求请求 JSON；但**解析必须兼容纯文本返回**（见下）
      const url = `${SMSBAO_ENDPOINT}?${query.toString()}`;

      const response = await this.fetchFn(url, {
        method: 'GET',
        // 🔴 不跟随重定向：这是 GET + URL 携带凭据的接口，
        //    跟随重定向可能把 ApiKey 与手机号转发到第三方地址。
        redirect: 'error',
        signal: controller.signal,
      });

      const text = (await response.text()).trim();

      // ---- 解析：官方"返回 0 视为成功，其他为错误提示" ⇒ 以文本为准 ----
      //    同时兼容 JSON 形态（某些接入方会拿到 `{"code":0,...}`），两种都认。
      let rawCode = '';
      let rawMessage = '';
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          rawCode = String((parsed as any).code ?? (parsed as any).status ?? '').trim();
          rawMessage = String((parsed as any).message ?? (parsed as any).msg ?? '').trim();
        }
      } catch {
        /* 非 JSON ⇒ 走下面的纯文本分支 */
      }
      if (!rawCode) {
        // 纯文本：整行可能只是 "0" / "50"，也可能带错误描述
        const m = text.match(/^(-?\d+)/);
        rawCode = m ? m[1] : '';
        rawMessage = text.replace(/^-?\d+\s*/, '').trim();
      }

      if (rawCode === '0') {
        // ⚠️ 官方原文："返回 '0' 视为**发送成功**" —— 但按本项目口径，这只代表
        //    **供应商受理了提交**，**不代表客户已收到**（deliveryStatus 仍为 pending，
        //    类型层面已强制，见 SmsSendResult）。
        return { accepted: true, providerRequestId: null, providerBizId: null };
      }

      const mapped = SMSBAO_ERROR_CODES[rawCode];
      if (mapped) {
        return this.reject(mapped.code, mapped.message);
      }

      // 未知返回码：**不回显原始响应体**（它可能包含我们发出去的内容片段）
      if (!response.ok) {
        return this.reject(
          'SMSBAO_HTTP_ERROR',
          `短信宝返回 HTTP ${response.status}（明细见供应商后台，不在日志中回显）`,
        );
      }
      return this.reject(
        'SMSBAO_UNKNOWN_CODE',
        `短信宝返回未在官方文档中列出的代码「${rawCode || '(空)'}」${rawMessage ? '，请对照官方文档核对' : ''}`,
      );
    } catch (error) {
      // 🔴 **安全要点**：这是 GET + URL 携带 ApiKey/手机号/正文的接口，
      //    而 Node 的 fetch 异常消息常常**内嵌完整请求 URL**（`fetch failed: https://…?p=KEY&m=…`）。
      //    ⇒ 这里**绝不**把 `error.message` 写进日志或错误消息，只输出我们自己构造的固定文案。
      const aborted = (error as { name?: string })?.name === 'AbortError';
      // 结果**未知**（可能对方已受理）⇒ 只标记 `accepted:false`，交由既有 outbox / B-16 策略处理；
      // **本 provider 不自行重试**（不开发第二套重试队列）。
      return this.reject(
        aborted ? 'SMSBAO_TIMEOUT' : 'SMSBAO_NETWORK_ERROR',
        aborted
          ? `短信宝请求超时（>${this.timeoutMs}ms），提交结果未知，交由既有重试/恢复策略处理`
          : '短信宝请求失败（连接/证书/网络错误），提交结果未知，交由既有重试/恢复策略处理',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private reject(errorCode: string, errorMessage: string): SmsSendResult {
    // ⚠️ 这里也**只记我们的固定文案**，绝不拼接 URL / 手机号 / 正文。
    this.logger?.warn?.(`[sms:smsbao] ${errorCode}：${errorMessage}`);
    return { accepted: false, providerRequestId: null, providerBizId: null, errorCode, errorMessage };
  }
}

export function createSmsProvider(
  name: string,
  options: SmsProviderOptions = {},
): SmsProvider {
  const normalized = String(name ?? '').trim().toLowerCase();

  switch (normalized) {
    case SMS_PROVIDER_NAME.MOCK:
      return new MockSmsProvider(options);
    case SMS_PROVIDER_NAME.ALIYUN:
      return new AliyunSmsProvider(options);
    case SMS_PROVIDER_NAME.SMSBAO:
      return new SmsbaoProvider(options);
    default:
      options.logger?.warn?.(
        `[sms] 未知/未实现的短信通道 "${name}"，短信将一律记为 rejected（不会静默回退到 mock）`,
      );
      return new NotImplementedSmsProvider(normalized || '(空)');
  }
}

// ---------------------------------------------------------------------------
// 内部：阿里云 RPC v1.0 签名
// ---------------------------------------------------------------------------

/**
 * 构造带签名的请求体。
 *
 * 阿里云 RPC 风格签名（`SignatureVersion=1.0`）三步：
 *   ① 除 Signature 外全部参数按 key 字典序排列，拼成 `k=percentEncode(v)` 用 `&` 连接；
 *   ② StringToSign = `POST` + `&` + percentEncode(`/`) + `&` + percentEncode(①的结果)；
 *   ③ Signature = base64(HMAC-SHA1(accessKeySecret + `&`, StringToSign))，
 *      再 percentEncode 后作为最后一个参数拼上去。
 *
 * ⚠️ percentEncode 不是 `encodeURIComponent`：阿里云要求
 *    `+` → `%20`、`*` → `%2A`、`%7E` → `~`。
 *    直接拿 encodeURIComponent 的结果签名会得到 `SignatureDoesNotMatch`，
 *    而且报错信息完全不提示是哪一步错了（这是这套 API 最经典的坑）。
 */
export function buildSignedBody(params: {
  accessKeyId: string;
  accessKeySecret: string;
  params: Record<string, string>;
  /** 注入时间（测试用）；默认当前 UTC */
  at?: Date;
  /** 注入 nonce（测试用） */
  nonce?: string;
}): string {
  const common: Record<string, string> = {
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: params.nonce ?? randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: aliyunTimestamp(params.at ?? new Date()),
    AccessKeyId: params.accessKeyId,
    ...params.params,
  };

  const canonical = Object.keys(common)
    .sort()
    .map((key) => `${key}=${aliyunEncode(common[key])}`)
    .join('&');

  const stringToSign = `POST&${aliyunEncode('/')}&${aliyunEncode(canonical)}`;

  // 延迟 require crypto 的 HMAC，避免顶部再多一个 import 影响 tree-shaking 判断
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const signature = createHmac('sha1', `${params.accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');

  return `${canonical}&Signature=${aliyunEncode(signature)}`;
}

/** 阿里云的 percent-encode（与 encodeURIComponent 有三处差异，见 buildSignedBody 注释） */
export function aliyunEncode(value: string): string {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/** `yyyy-MM-ddTHH:mm:ssZ`（UTC）—— 阿里云要求 ISO8601 UTC，不接受带毫秒 */
export function aliyunTimestamp(at: Date): string {
  return `${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
