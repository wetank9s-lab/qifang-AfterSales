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
   * **该通道是否依赖"模板 CODE"**（BE-03-S3）。
   *
   * 为什么是**必填**而不是可选：可选字段一旦漏写就是 `undefined`，
   *   而 `if (provider.requiresTemplateCode)` 会把 undefined 当成"不需要"⇒ **fail-open**，
   *   一个没适配的通道就能绕过模板闸把短信发出去。
   *   ⇒ 声明为必填（编译期强制），运行期判定也坚持 **只有显式 `false` 才豁免**。
   *
   *   · 阿里云：true（服务商按已审核模板渲染，必须有 CODE）
   *   · 短信宝：false（它收发的是**完整正文** `c=request.preview`）
   *   · mock  ：false（不发网络，但同样走正文渲染）
   */
  readonly requiresTemplateCode: boolean;
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
  /** mock 不发网络、也不要求模板 CODE（但正文照常渲染进发件箱） */
  readonly requiresTemplateCode = false;
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
  /** 阿里云按已审核模板渲染 ⇒ 每个场景都必须有模板 CODE */
  readonly requiresTemplateCode = true;
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
  /** 未实现通道：宁可严格（true）也不放行 */
  readonly requiresTemplateCode = true;
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
 * 短信宝返回码 → 我们的 errorCode。**两张表，不能混用**。
 *
 * 🔴 为什么必须按**返回格式**分开：新版官方文档
 *    （https://m.smsbao.com/docs/developer/error-codes ）明确写了两套码表的语义**不同**：
 *      · **txt** 50 = 内容含敏感词、51 = 手机号码不正确；
 *      · **json** 51 = 内容含敏感词、52 = 手机号码格式不正确。
 *    ⇒ 同一串 `51` 在两种格式下指向**完全不同的原因**。若拿 txt 表去解释 JSON 响应，
 *      "内容被敏感词拒"会被记成"手机号不正确"，运维会照着错的原因去改内容/改号码。
 *    这是 S6 复核新版文档时发现的**既存缺陷**（旧实现只有一张表）。
 *
 * ⚠️ 映射只影响"失败原因怎么写"，**不影响是否发送、也不改请求格式**。
 */

/** 文本文档码表（返回纯文本时适用；不填 `f` 时的默认形态） */
const SMSBAO_TXT_ERROR_CODES: Record<string, { code: string; message: string }> = {
  '30': { code: 'SMSBAO_BAD_CREDENTIAL', message: '短信宝：用户名与密码/ApiKey 不匹配（错误密码）' },
  '40': { code: 'SMSBAO_ACCOUNT_NOT_FOUND', message: '短信宝：账号不存在' },
  '41': { code: 'SMSBAO_INSUFFICIENT_BALANCE', message: '短信宝：余额不足' },
  '42': { code: 'SMSBAO_ACCOUNT_EXPIRED', message: '短信宝：账号已过期' },
  '43': { code: 'SMSBAO_IP_RESTRICTED', message: '短信宝：来源 IP 被限制（后台 IP 白名单）' },
  '50': { code: 'SMSBAO_CONTENT_REJECTED', message: '短信宝：内容含敏感词，被拒' },
  '51': { code: 'SMSBAO_BAD_MOBILE', message: '短信宝：手机号码不正确' },
  '60': { code: 'SMSBAO_NO_BALANCE_PLAN', message: '短信宝：尚未充值，接口不可调用' },
};

/** JSON 文档码表（`f=json` 时适用；码义与 txt **不同**，见上） */
const SMSBAO_JSON_ERROR_CODES: Record<string, { code: string; message: string }> = {
  '30': { code: 'SMSBAO_PARAM_INCOMPLETE', message: '短信宝(JSON)：请求参数不全（检查 u/p/m/c）' },
  '40': { code: 'SMSBAO_BAD_CREDENTIAL', message: '短信宝(JSON)：账号或密码错误' },
  '41': { code: 'SMSBAO_INSUFFICIENT_BALANCE', message: '短信宝(JSON)：余额不足' },
  '42': { code: 'SMSBAO_ACCOUNT_EXPIRED', message: '短信宝(JSON)：账号已过期' },
  '43': { code: 'SMSBAO_IP_RESTRICTED', message: '短信宝(JSON)：IP 地址限制' },
  '44': { code: 'SMSBAO_ACCOUNT_DISABLED', message: '短信宝(JSON)：账号已被禁用' },
  '51': { code: 'SMSBAO_CONTENT_REJECTED', message: '短信宝(JSON)：内容含敏感词，被拒' },
  '52': { code: 'SMSBAO_BAD_MOBILE', message: '短信宝(JSON)：手机号码格式不正确' },
  '53': { code: 'SMSBAO_NO_PRODUCT', message: '短信宝(JSON)：没有可用的短信产品（检查 g 或默认产品）' },
  '54': { code: 'SMSBAO_TRIAL_RESTRICTED', message: '短信宝(JSON)：试用账号无权调用此接口' },
  '55': { code: 'SMSBAO_BAD_ACCOUNT', message: '短信宝(JSON)：错误的账号（核对 u 与账号来源）' },
  '70': { code: 'SMSBAO_TEMPLATE_INVALID', message: '短信宝(JSON)：模板格式不正确' },
  '71': { code: 'SMSBAO_SIGN_VERIFY_FAILED', message: '短信宝(JSON)：验签失败（检查密钥/签名算法）' },
};

/**
 * 短信宝的**签名包装形态**（P11-4 · 最小兼容）。
 *
 * 背景：签名用哪种括号，官方资料里**出现过两种写法** ——
 *   · 官方公开接口文档与用户后台《短信签名报备 FAQ》目前都写作 **【公司签名】**；
 *   · 另有一份资料写作 **〖公司签名〗**。
 * ⇒ **本项目不硬编码任一种**，而是**以配置值的形态为准**（运营按审核结果填）：
 *   · `SMSBAO_SIGN_NAME` **不含括号**（推荐，如 `七方售后`）⇒ 按官方文档包成 `【七方售后】`；
 *   · 已含括号（`【七方售后】` 或 `〖七方售后〗`）⇒ **原样使用**。
 *
 * ⚠️ 后一条是必须的：否则会渲染成 `【〖七方售后〗】` —— **重复包装**，
 *    而运营商侧只认一个有效签名，这种正文会被直接拒。
 *
 * ⚠️ 本函数**只被短信宝 provider 使用**，阿里云仍按既有 `【{sign}】` 模板原样发送，
 *    因此**不影响阿里云现有签名行为**。
 */
export function decorateSmsbaoSign(signName: string): string {
  const name = String(signName ?? '').trim();
  if (!name) return '';
  // 已带括号 ⇒ 原样（避免重复包装）
  if (/^【[^】]+】$/.test(name) || /^〖[^〗]+〗$/.test(name)) return name;
  // 未带括号 ⇒ 按官方文档当前的写法包成全角方括号
  return `【${name}】`;
}

/**
 * 还原签名里的"名字"（去掉运营可能一并填进来的括号）。
 *
 * ⚠️ 为什么需要它：`SMSBAO_SIGN_NAME` 的**约定**是不带括号，
 *    但运营很可能直接把后台审核通过的整串（`【七方售后】` 或 `〖七方售后〗`）填进来。
 *    此时如果只按"开头 `【…】`"去替换，会命中 `【【七方售后】` 而**留下多余的 `】`**
 *    （实测产出 `【七方售后】】您的…` —— 这种正文到运营商侧会被拒）。
 */
export function bareSignName(signName: string): string {
  return String(signName ?? '')
    .trim()
    .replace(/^[【〖]+/, '')
    .replace(/[】〗]+$/, '')
    .trim();
}

/** 通用短信产品（不填 `g` 时的默认产品），用于可读性，不是必填值 */
const SMSBAO_ENDPOINT = 'https://api.smsbao.com/sms';

/**
 * `sms_logs.provider_biz_id` 是 `varchar(64)`（见 collections/smsLogs.ts）。
 * 超过就**不能截断**：截断后的 ID 与供应商侧真实 ID 不同，回执永远匹配不上，
 * 而"列里有值"会让运维误以为匹配键是好的 —— 比留空更危险。
 */
const PROVIDER_ID_MAX_LEN = 64;

/**
 * 短信宝**旧版**（http://api.smsbao.com/sms 那一页）响应里**可能**承载"消息标识"的字段名。
 *
 * ⚠️ 旧版文档（openapi/213.html）**没有任何消息 ID 字段** ⇒ 这里列的是**机会性候选名**
 *    （不同接入形态/网关可能回 JSON 并带 ID），**不是**官方契约。取不到就是取不到，**绝不生成**替代值。
 * ⚠️ 新版 JSON 文档里**没有** `msgid`，只有 `data.taskId` —— 后者**不代表回执可匹配**（见 §TaskId 注释）。
 */
const SMSBAO_ID_FIELDS = ['msgid', 'msg_id', 'messageid', 'message_id'] as const;

/**
 * `data.taskId` 的最大接受长度（只用于**日志**，不落库：库里没有对应列）。
 * 留 64 与 `PROVIDER_ID_MAX_LEN` 对齐，避免日志被超长串污染。
 */
const SMSBAO_TASK_ID_MAX_LEN = 64;

export interface SmsbaoParsedBody {
  /**
   * 响应格式（决定用哪张错误码表，**二者不可混用**）：
   *   · `txt` —— 不填 `f` 时的默认形态，返回明文 `0` / `30` / …；
   *   · `json` —— 填 `f=json` 时，返回 `{code,msg,data}`。
   */
  format: 'txt' | 'json';
  /** 供应商返回码（'0' = 已受理） */
  code: string;
  /** 供应商返回的描述（成功时通常为空） */
  message: string;
  /**
   * **旧版** JSON 里可能出现的消息标识（`msgid` 系列）。取不到 ⇒ null（**不编造**）。
   * 这是 `provider_biz_id` 的唯一取值来源。
   */
  messageId: string | null;
  /** 消息标识超长被丢弃（>`PROVIDER_ID_MAX_LEN`）—— 与"本来就没有"必须能分开报 */
  messageIdTooLong: boolean;
  /**
   * 新版 JSON 的 `data.taskId`（官方文档：发送成功时返回的**任务 ID**）。
   *
   * 🔴 **不得**把它当成 RB-8 的"回执匹配键"（`provider_biz_id`）：
   *    官方只说明它是"任务 ID"，**没有说**状态报告会回带它，也没有公开状态报告字段。
   *    在拿到状态报告报文并核对之前，把它写进匹配键＝凭空造一个匹配契约。
   *    ⇒ 本轮定位：**只解析、只记日志（供日后对账）**，不进 `providerBizId`/`providerRequestId`。
   */
  taskId: string | null;
  /** 顶层字段名（**只记键名，不记值**）—— 下次拿真实响应时据此确认真实字段路径 */
  keys: string[];
}

/**
 * 解析短信宝响应（纯函数，便于隔离测试；**零网络**）。
 *
 * 判据：
 *   · 能解析成对象且有 `code`/`status` ⇒ 视为 **json** 格式（新版文档形态）；
 *   · 否则按**纯文本**取行首数字（旧版文档形态，官方原话"返回 '0' 视为发送成功"）。
 *     注意 `{"code":0` 这种**半截 JSON** 会落到 txt 分支并取不到数字 ⇒ `code=''` ⇒ 上层判失败（安全方向）。
 */
export function parseSmsbaoBody(raw: string): SmsbaoParsedBody {
  const text = String(raw ?? '').trim();
  const out: SmsbaoParsedBody = {
    format: 'txt',
    code: '',
    message: '',
    messageId: null,
    messageIdTooLong: false,
    taskId: null,
    keys: [],
  };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.format = 'json';
      const obj = parsed as Record<string, unknown>;
      out.keys = Object.keys(obj).slice(0, 12);
      out.code = String(obj.code ?? obj.status ?? '').trim();
      out.message = String(obj.message ?? obj.msg ?? '').trim();

      // ---- 旧版机会性 `msgid`（唯一可能进 provider_biz_id 的来源）----
      for (const field of SMSBAO_ID_FIELDS) {
        const value = obj[field];
        if (value === undefined || value === null) continue;
        // 只接受标量；对象/数组一律忽略（避免把 `{}` 序列化成 "[object Object]" 存进库）
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const id = String(value).trim();
        if (!id) continue;
        if (id.length > PROVIDER_ID_MAX_LEN) {
          out.messageIdTooLong = true;
          break;
        }
        out.messageId = id;
        break;
      }

      // ---- 新版 `data.taskId`（只解析，不当回执键）----
      const data = obj.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const rawTaskId = (data as Record<string, unknown>).taskId;
        if (typeof rawTaskId === 'string' || typeof rawTaskId === 'number') {
          const taskId = String(rawTaskId).trim();
          if (taskId && taskId.length <= SMSBAO_TASK_ID_MAX_LEN) out.taskId = taskId;
        }
      }
    }
  } catch {
    /* 非 JSON ⇒ 走下面的纯文本分支（旧版官方形态就是纯文本） */
  }

  if (!out.code) {
    // 纯文本：整行可能只是 "0" / "50"，也可能带错误描述
    const m = text.match(/^(-?\d+)/);
    out.code = m ? m[1] : '';
    out.message = text.replace(/^-?\d+\s*/, '').trim();
  }

  return out;
}

export class SmsbaoProvider implements SmsProvider {
  readonly name = SMS_PROVIDER_NAME.SMSBAO;
  /** 短信宝收发的是**最终正文**（`c=`），不看模板 CODE */
  readonly requiresTemplateCode = false;
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
    const raw = String(request.preview ?? '').trim();
    if (!raw) {
      return this.reject('SMS_CONTENT_EMPTY', '短信正文为空，本次未提交');
    }

    // 🔴 把开头的签名换成**短信宝要求的形态**（其余正文一字不动）。
    //    `renderPreview()` 出来的正文固定以 `【{sign}】` 开头，这里**只替换开头那一个**，
    //    因此最终正文里**有且只有一个签名**（未带括号的配置 ⇒ 结果仍是 `【】`，
    //    等价于原样；带括号的配置 ⇒ 变成 `〖〗`，且不会出现 `【〖…〗】`）。
    const decorated = decorateSmsbaoSign(this.signName);
    const bare = bareSignName(this.signName);
    // 枚举"渲染产物开头可能出现的前缀"，取第一个命中的整体替换成 decorated。
    // ⚠️ 用**候选前缀**而不是正则，是为了避开嵌套方括号的匹配陷阱
    //    （正则 `/^【[^】]+】/` 在 `【【七方售后】】` 上会只吃掉前半截，留下多余的 `】`）。
    // 覆盖**全部现实组合**（左：渲染模板的括号【】；右：运营填进配置的括号形态）：
    //   ① 配置不带括号            ⇒ 【名字】
    //   ② 配置带了【】            ⇒ 【【名字】】
    //   ③ 配置带了〖〗（模板已改） ⇒ 〖名字〗
    //   ④ 配置带了〖〗（模板仍是【】）⇒ 【〖名字〗】  ← **当前真实情形**
    const prefixes = [`【${bare}】`, `【【${bare}】】`, `〖${bare}〗`, `【〖${bare}〗】`];
    const hit = bare ? prefixes.find((pre) => raw.startsWith(pre)) : undefined;
    const content = hit ? `${decorated}${raw.slice(hit.length)}` : raw;
    if (!hit) {
      // 理论上不可达（渲染模板恒定以签名开头）；留一条 warn 便于将来模板改动时被发现。
      this.logger?.warn?.('[sms:smsbao] 正文未以签名开头，按原样提交（可能被供应商以缺签名拒绝）');
    }

    // 🔴 BE-03-S6：**生产路径的结构自检**（此前只有联调脚本里有，等于没有）。
    //    S5 干跑时曾差点发出 `【【七方售后】】…`：签名被包了两层，运营商必然拒收，
    //    而脚本的断言是按"子串命中 `【签名】`"写的 ⇒ 假绿。
    //    这里改成**按结构**判：正文里出现相邻双括号就是重复签名。
    //    为什么宁可直接拒发：这种正文 100% 会被供应商/运营商拒，发出去只是
    //    把错误推给一个异步回执（而且不产生可读的 error_code）。
    //    代价是"拒发一条本来也发不成的短信"，换来的是 SmsLog 上一行明确原因。
    if (content.includes('【【') || content.includes('】】')) {
      return this.reject(
        'SMSBAO_SIGN_FORMAT_INVALID',
        '正文出现双层方括号（签名被重复包装），运营商侧会拒收，本次未提交',
      );
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

      // ---- 解析：旧版"返回 0 视为成功" + 新版 `{code,msg,data}` 两种形态都认 ----
      //    ⚠️ 请求格式**本轮未改**（仍是我们既有的 GET + u/p/m/c/f=json），
      //      这里只是把**响应**解析补齐；`f=json` 是否真被账号接受，靠下面的 format 日志揭示。
      const parsed = parseSmsbaoBody(text);
      const rawCode = parsed.code;
      const rawMessage = parsed.message;

      if (rawCode === '0') {
        // ⚠️ 官方原文："返回 '0' 视为**发送成功**" —— 但按本项目口径，这只代表
        //    **供应商受理了提交**，**不代表客户已收到**（deliveryStatus 恒为 pending）。
        //
        // 🔴 BE-03-S6：消息标识（`msgid` → 内部回执键 `provider_biz_id`）
        //    · 为什么落到 `providerBizId` 而不是 `providerRequestId`：
        //      `providerRequestId` 在契约里是"API 调用追踪号"（阿里云 `RequestId`），
        //      `providerBizId` 才是**回执匹配的唯一键**（RB-8）。短信宝若返回消息 ID，
        //      它的用途正是"对账/查状态"，语义与回执键一致；塞进 `providerRequestId`
        //      会让回执匹配拿错列（`sms-receipt-consumer` 只认 `provider_biz_id`）。
        //    · 为什么 `providerRequestId` 保持 null：短信宝没有"调用追踪号"这一概念，
        //      把消息 ID 再抄一份过去等于**给两列赋予同一个假语义** —— 将来谁拿它做幂等
        //      就会以为什么都能对上。空缺是诚实的信息，重复值才是隐患。
        //    · 取不到 ⇒ null + 留痕（下面 warn），**绝不**用 bizId/时间戳/随机串补。
        //
        // 🔴 新版 JSON 的 `data.taskId`：**只记日志、不进任何 ID 列**。
        //    官方只说它是"任务 ID"，没公开状态报告字段 ⇒ 拿它当 RB-8 匹配键就是凭空造契约。
        //    记下来是为了**日后对账时能对上号**，以及看清"账号到底回的是 txt 还是 json"。
        if (parsed.taskId) {
          this.logger?.info?.(`[sms:smsbao] 已受理（format=${parsed.format}）taskId=${parsed.taskId}`);
        } else if (parsed.messageId) {
          this.logger?.info?.(
            `[sms:smsbao] 已受理（format=${parsed.format}），记录供应商消息标识（len=${parsed.messageId.length}）`,
          );
        } else if (parsed.messageIdTooLong) {
          this.logger?.warn?.(
            `[sms:smsbao] 已受理，但消息标识超过 ${PROVIDER_ID_MAX_LEN} 字符，` +
              '按"不截断"原则留空（截断后的 ID 无法用于回执匹配）',
          );
        } else {
          // 只记键名，不记值：既能让下次真实响应暴露真实字段路径，又不落任何业务内容
          this.logger?.warn?.(
            '[sms:smsbao] 已受理但响应未提供任何消息标识 ⇒ provider_biz_id 留空' +
              `（format=${parsed.format}；短信宝公开文档无送达回执接口，属已知限制` +
              `${parsed.keys.length ? `，顶层字段=${parsed.keys.join(',')}` : ''}）`,
          );
        }
        return {
          accepted: true,
          providerRequestId: null,
          providerBizId: parsed.messageId,
          errorCode: null,
          errorMessage: null,
          // 类型即约束：受理 ≠ 送达。
          deliveryStatus: 'pending',
        };
      }

      // 🔴 码表按**返回格式**选：同一串 `51` 在 txt 与 json 下含义不同（见两张表的注释）。
      //    用错表的后果是"原因写错、排查方向被带偏"，而 accepted/failed 的判断仍然正确 ——
      //    所以这类错误**不会**自己冒出来，只能靠这里显式区分。
      const table = parsed.format === 'json' ? SMSBAO_JSON_ERROR_CODES : SMSBAO_TXT_ERROR_CODES;
      const mapped = table[rawCode];
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
        `短信宝返回未在官方文档中列出的代码「${rawCode || '(空)'}」` +
          `（格式=${parsed.format}${rawMessage ? '，请对照官方文档核对' : ''}）`,
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
    return {
      accepted: false,
      providerRequestId: null,
      providerBizId: null,
      errorCode,
      errorMessage,
      // 同 line 612：SmsSendResult.deliveryStatus 是必填字段（TS2741 曾被 esbuild 吞掉）
      deliveryStatus: 'pending',
    };
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
