/**
 * 短信**送达回执**消费器（Phase 10 / RB-8）
 *
 * ===========================================================================
 * 为什么是 MNS 队列消费，而不是 HTTP 回调
 * ===========================================================================
 * 2026-10-05 取证（官方文档原文核对，见 docs/DEVIATIONS.md DEV-100）：
 *
 *   阿里云短信的 **HTTP 批量推送**（SMS webhook）报文只有
 *     To / Status / MessageId / SmsSize / TaskId / SendDate / ReceiveDate / ErrorCode / ErrorDescription
 *   **没有任何签名字段或鉴权头**，成功判定只看 HTTP 200 + {"code":0}。
 *   ⇒ 公开一个 HTTP 端点接它 = 只能靠"我方自签的共享密钥"或"来源 IP"来鉴权，
 *     两者都不是 provider 验签。所以本实现**不开放任何公网入口**。
 *
 *   官方另一条路径 **MNS / 轻量消息队列消费模式** 用 AccessKey 签名读**我们独占**的队列，
 *   鉴权由阿里云签名保证（SmsReport 消息类型）。
 *
 * 官方同时写明：**"回执消息无法保证幂等性"**，且网络异常/超时会导致**重复推送**。
 * ⇒ 幂等必须由我们自己保证（本文件用**条件更新**做，不靠唯一约束硬挡）。
 *
 * ===========================================================================
 * 官方协议要点（本实现的每一条都对应一条官方规定，不是自创）
 * ===========================================================================
 *   · 拉取：`GET /queues/{queueName}/messages?waitseconds=N`（N>0 即长轮询）
 *           返回 XML，含 MessageId / ReceiptHandle / MessageBody / DequeueCount …
 *   · 删除：`DELETE /queues/{queueName}/messages?ReceiptHandle=…` → 204
 *   · 生命周期：ReceiveMessage 后消息进入 Inactive（VisibilityTimeout 内）；
 *           **必须在 VisibilityTimeout 内 DeleteMessage**，否则重新变 Active 并被重复投递。
 *           ⇒ 业务处理成功才 delete；处理失败**不 delete**（让官方重投），这才是正确的失败语义。
 *   · 签名：`Authorization: MNS <AccessKeyId>:<Base64(HMAC-SHA1(AccessSecret, StringToSign))>`
 *           StringToSign = VERB \n CONTENT-MD5 \n CONTENT-TYPE \n DATE \n CanonicalizedMNSHeaders CanonicalizedResource
 *           DATE 必须是 GMT 格式（`Thu, 17 Mar 2012 18:49:58 GMT`），与服务器相差 >15 分钟即 400/408。
 *
 * ===========================================================================
 * 🔴 本消费器**只允许**更新"送达事实"，绝不允许借回执改业务主状态
 * ===========================================================================
 * 允许写：delivery_status（pending → delivered / failed）、delivered_at、error_code、error_message。
 * 禁止写：service_tickets / service_visits 的任何列。
 * 理由：回执是**供应商侧的事实**，不是业务流转依据。让它能改主状态，
 *      等于把"短信到了"变成"工单完成"——那正是项目早期明确禁止的"把调用成功当成业务完成"。
 */
import { createHash, createHmac } from 'node:crypto';
import { SMS_DELIVERY_STATUS } from '../constants';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 阿里云状态报告的 Status 取值（官方 SMS webhook 文档） */
export const ALIYUN_RECEIPT_STATUS = {
  /** 1: The message was sent. —— 已送达终端 */
  SENT: '1',
  /** 2: The message failed to be sent. */
  FAILED: '2',
  /** 6: The message expired. —— 过期（同样属于"没送到"） */
  EXPIRED: '6',
} as const;

export interface MnsConfig {
  /** 形如 https://<accountId>.mns.<region>.aliyuncs.com —— 必须从控制台复制，不猜 */
  endpoint: string;
  queueName: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 单次长轮询等待秒数（官方上限 20，这里保守取小值以免与长轮询并发上限冲突） */
  waitSeconds: number;
  /** 单次 tick 最多处理多少条，避免长尾把一轮任务拖到下一轮 */
  maxMessagesPerTick: number;
}

export interface ReceiptOutcome {
  /** 是否把消息从队列里删掉了（= 不让官方重投） */
  deleted: boolean;
  /** 归一化后的回执事实（**不含手机号**） */
  fact: {
    providerBizId: string;
    deliveryStatus: 'delivered' | 'failed';
    errorCode: string | null;
    errorMessage: string | null;
    receivedAt: Date | null;
  } | null;
  /** 为什么没匹配/没更新（**只记分类，不记手机号与报文原文**） */
  skip: 'applied' | 'unknown_biz_id' | 'malformed' | 'not_terminal_yet' | 'already_terminal' | 'db_error' | null;
}

// ---------------------------------------------------------------------------
// 签名（纯函数，便于离线门禁逐字验证）
// ---------------------------------------------------------------------------

/** GMT 格式的 Date 头，例：`Thu, 17 Mar 2012 18:49:58 GMT` */
export function mnsDateHeader(at: Date = new Date()): string {
  return at.toUTCString();
}

export function md5Base64(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('base64');
}

/**
 * 计算 MNS 请求的 `StringToSign`。
 *
 * ⚠️ `canonicalizedMnsHeaders` 传空串即可：本消费器只用公共头（Date / Content-Type），
 *    不发任何 `x-mns-*` 头。官方规则：没有这类头时该段置空。
 */
export function buildMnsStringToSign(input: {
  verb: string;
  contentMd5: string;
  contentType: string;
  date: string;
  canonicalizedResource: string;
}): string {
  return [
    input.verb,
    input.contentMd5,
    input.contentType,
    input.date,
    '', // CanonicalizedMNSHeaders：无 x-mns-* 头 ⇒ 空
    input.canonicalizedResource,
  ].join('\n');
}

export function signMns(input: {
  accessKeyId: string;
  accessKeySecret: string;
  verb: string;
  contentMd5: string;
  contentType: string;
  date: string;
  canonicalizedResource: string;
}): { authorization: string; stringToSign: string } {
  const stringToSign = buildMnsStringToSign(input);
  const signature = createHmac('sha1', input.accessKeySecret).update(stringToSign, 'utf8').digest('base64');
  return {
    // ⚠️ 官方格式是 `MNS <AccessKeyId>:<Signature>`，Signature **不做 URL 编码**
    authorization: `MNS ${input.accessKeyId}:${signature}`,
    stringToSign,
  };
}

// ---------------------------------------------------------------------------
// 回执报文归一化
// ---------------------------------------------------------------------------

/**
 * 把 MNS `MessageBody` 归一化成回执事实。
 *
 * ⚠️ 为什么容忍两种信封（而不是只认一种）：
 *   官方 HTTP 推送的报文是**回执对象本身**，而 MNS 队列里的 `MessageBody`
 *   是**外层信封**（内含 `content` / `arg` 字符串）。两者都是官方形态，
 *   不是我们的两条腿 —— 归一化在这里是**单一入口**，两种输入进、一种事实出。
 *
 * 🔴 归一化过程**绝不**把 `To`（手机号）带出：本函数只返回匹配键与送达事实。
 */
export function normalizeReceipt(raw: unknown): ReceiptOutcome['fact'] {
  if (typeof raw === 'string') {
    try {
      return normalizeReceipt(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    // 🔴 官方 HTTP 批量推送的报文就是 **JSON 数组**（"The data of a POST request is in
    //    the JSON Array format. Multiple delivery receipts may be pushed at a time"），
    //    MNS 的 MessageBody 也可能是数组形态。
    //    ⇒ 这里取**第一条能归一化成功**的记录；一条都认不出才返回 null。
    //    （第一版漏了数组分支 ⇒ 每条回执都判 malformed ⇒ delivered 永远不变，
    //      而日志只记一行"无法归一化"，看起来像供应商没推送。）
    for (const item of raw) {
      const fact = normalizeReceipt(item);
      if (fact) return fact;
    }
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const outer = raw as Record<string, unknown>;
  // 解信封：content / arg 是 JSON 字符串。
  // ⚠️ 两种开头都要认：官方回执本身是**数组**，所以信封里装的多半是 "[...]" 而不是 "{...}"。
  //    只认 '{' 会让"数组被再包一层信封"的形态整体失明（门禁实测踩到）。
  for (const key of ['content', 'arg']) {
    const inner = outer[key];
    if (typeof inner === 'string' && /^[[{]/.test(inner.trim())) {
      const nested = normalizeReceipt(inner);
      if (nested) return nested;
    }
  }

  // 回执对象本身。字段名用官方文档的大小写（M 开头），同时容忍下划线变体。
  const messageId = str(outer.MessageId ?? outer.message_id ?? outer.biz_id);
  const status = str(outer.Status ?? outer.status);
  if (!messageId || !status) return null;

  // ⚠️ 只在"终结态"才产出事实：官方还有中间态字段（如 0/3/4 之类），
  //    归一化只认文档明确的 1/2/6，避免把中间态误记成终态。
  let deliveryStatus: 'delivered' | 'failed';
  if (status === ALIYUN_RECEIPT_STATUS.SENT) deliveryStatus = 'delivered';
  else if (status === ALIYUN_RECEIPT_STATUS.FAILED || status === ALIYUN_RECEIPT_STATUS.EXPIRED) {
    deliveryStatus = 'failed';
  } else return null;

  const errorCode = str(outer.ErrorCode ?? outer.error_code);
  const errorMessage = str(outer.ErrorDescription ?? outer.error_description);
  const receivedRaw = str(outer.ReceiveDate ?? outer.receive_date);

  return {
    providerBizId: messageId,
    deliveryStatus,
    // 「success」是官方成功回执的占位错误码，不是错误 ⇒ 归一为 null
    errorCode: errorCode && errorCode !== 'success' ? errorCode : null,
    errorMessage:
      errorMessage && errorMessage !== 'success'
        ? errorMessage.slice(0, 255)
        : null,
    receivedAt: parseAliyunDate(receivedRaw),
  };
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * 解析阿里云回执里的时间。
 *
 * 官方样例格式：`Thu, 25 Nov 2021 10:27:33 +0800` —— 这是 **RFC 1123 带数字时区**，
 * 不是 JS 的 `Date.toString()`（`GMT` / `UTC` 两种字面量），`Date.parse` 在 Node 上
 * 对它**能**解析，但为避免依赖实现差异，这里显式规整成 `+0800` → `+08:00`。
 *
 * ⚠️ 解析失败返回 null（调用方据此**不写** delivered_at），绝不臆造一个时间。
 */
export function parseAliyunDate(raw: string): Date | null {
  if (!raw) return null;
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(normalized);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

// ---------------------------------------------------------------------------
// 队列 XML 解析（只取需要的字段，够用即可，不引 XML 依赖）
// ---------------------------------------------------------------------------

export interface MnsMessage {
  messageId: string;
  receiptHandle: string;
  messageBody: string;
  dequeueCount: number;
}

/**
 * 从 MNS 的 XML 响应里取出消息。
 *
 * ⚠️ 为什么用正则而不是 XML 解析器：
 *   ① 容器镜像里没有 xml 解析依赖，且这个响应形状是官方固定的 5 个元素；
 *   ② 引入解析器要为它补一个依赖 + 一份 CVE 跟踪成本，收益不成比例。
 *   ⇒ 代价是**只支持官方这一种形状**；若阿里云改格式，这里会解析不到消息
 *     （表现为"队列有消息但一条都不消费"），因此 §自检里有一条真实 HTTP 用例盯着它。
 */
export function parseMnsMessages(xml: string): MnsMessage[] {
  const out: MnsMessage[] = [];
  const re = /<Message>([\s\S]*?)<\/Message>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const messageId = tag(block, 'MessageId');
    const receiptHandle = tag(block, 'ReceiptHandle');
    const messageBody = tag(block, 'MessageBody');
    if (!messageId || !receiptHandle) continue;
    out.push({
      messageId,
      receiptHandle,
      messageBody,
      dequeueCount: Number(tag(block, 'DequeueCount') || '0') || 0,
    });
  }
  return out;
}

function tag(xml: string, name: string): string {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
  const m = re.exec(xml);
  if (!m) return '';
  return m[1]
    .trim()
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// HTTP 客户端（可注入 fetch —— 门禁用它打到本地桩 MNS 上）
// ---------------------------------------------------------------------------

export interface MnsClientDeps {
  fetchFn: typeof fetch;
  config: MnsConfig;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export class MnsReceiptClient {
  private readonly fetchFn: typeof fetch;
  private readonly cfg: MnsConfig;
  private readonly logger: NonNullable<MnsClientDeps['logger']>;

  constructor(deps: MnsClientDeps) {
    this.fetchFn = deps.fetchFn;
    this.cfg = deps.config;
    this.logger = deps.logger ?? {};
  }

  private base(): string {
    return this.cfg.endpoint.replace(/\/+$/, '');
  }

  private async request(input: {
    verb: string;
    canonicalizedResource: string;
    body?: string;
    contentType?: string;
  }): Promise<{ status: number; text: string }> {
    const date = mnsDateHeader();
    const body = input.body ?? '';
    const contentType = input.contentType ?? '';
    const { authorization } = signMns({
      accessKeyId: this.cfg.accessKeyId,
      accessKeySecret: this.cfg.accessKeySecret,
      verb: input.verb,
      contentMd5: body ? md5Base64(body) : '',
      contentType,
      date,
      canonicalizedResource: input.canonicalizedResource,
    });

    // ⚠️ Date 头必须与签名里用的是**同一个**字符串（官方要求逐字一致）
    const headers: Record<string, string> = { Date: date, Authorization: authorization };
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-MD5'] = md5Base64(body);

    const res = await this.fetchFn(`${this.base()}${input.canonicalizedResource}`, {
      method: input.verb,
      headers,
      body: body || undefined,
    });
    return { status: res.status, text: await res.text() };
  }

  /**
   * 长轮询取一条消息。
   *
   * ⚠️ 官方语义：队列为空时返回 404（MessageNotExist / QueueNotExist），
   *    **不是** 200 空体。所以 404 必须当"没消息"处理，而不是错误。
   */
  async receive(): Promise<MnsMessage | null> {
    const q = encodeURIComponent(this.cfg.queueName);
    const resource =
      `/queues/${q}/messages?waitseconds=${this.cfg.waitSeconds}` +
      `&queueName=${q}`;
    const { status, text } = await this.request({ verb: 'GET', canonicalizedResource: resource });
    if (status === 404) return null;
    if (status !== 200) {
      // ⚠️ 只记状态码与错误分类，**不记响应正文**（官方错误体可能带 request id 之外的信息）
      this.logger.warn?.(`[sms-receipt] MNS ReceiveMessage 非预期状态 ${status}`);
      return null;
    }
    const messages = parseMnsMessages(text);
    return messages[0] ?? null;
  }

  /** 处理成功后必须删除，否则官方会在 VisibilityTimeout 后重投（这正是我们要的重复推送） */
  async deleteMessage(receiptHandle: string): Promise<boolean> {
    const q = encodeURIComponent(this.cfg.queueName);
    const resource =
      `/queues/${q}/messages?ReceiptHandle=${encodeURIComponent(receiptHandle)}&queueName=${q}`;
    const { status } = await this.request({ verb: 'DELETE', canonicalizedResource: resource });
    return status === 204 || status === 200;
  }
}

// ---------------------------------------------------------------------------
// 落库：条件更新（幂等 + 单调性都在这条 SQL 里）
// ---------------------------------------------------------------------------

/**
 * 把一条回执事实写进 `sms_logs`。
 *
 * 🔴 三条语义全部由 WHERE 条件保证，不靠应用层先查后写（那是竞态）：
 *
 *   1. **只匹配回执键**：`provider = :provider AND provider_biz_id = :bizId`
 *      —— 匹配不上就是 `unknown_biz_id`，**不回显任何东西**。
 *   2. **只从 pending 出发**：终态不再被覆盖 ⇒ **重复推送天然幂等**，
 *      第二次以后 `rows.length === 0`，不产生第二次副作用（不写事件、不改时间）。
 *   3. **单调性**：`pending → delivered|failed` 一次成型；
 *      之后任何回执都改不动它（条件不满足）。这钉住了"已送达后又来一条较旧状态"的形态 ——
 *      官方明确说回执可能重复推送，而**先到的终态**才是可信的终态。
 *
 * ⚠️ 绝不写 `service_tickets` / `service_visits`：回执只改送达事实。
 */
export async function applyReceipt(
  db: any,
  input: { provider: string; fact: NonNullable<ReceiptOutcome['fact']> },
): Promise<ReceiptOutcome['skip']> {
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function') return 'db_error';

  const deliveredAt =
    input.fact.deliveryStatus === 'delivered'
      ? input.fact.receivedAt ?? new Date()
      : null;

  try {
    const [rows] = await sequelize.query(
      `UPDATE sms_logs
          SET delivery_status = $3,
              delivered_at = COALESCE($4, delivered_at),
              error_code = COALESCE($5, error_code),
              error_message = COALESCE($6, error_message),
              updated_at = now()
        WHERE provider = $1
          AND provider_biz_id = $2
          AND delivery_status = $7
        RETURNING id`,
      [
        input.provider,
        input.fact.providerBizId,
        input.fact.deliveryStatus,
        deliveredAt,
        input.fact.errorCode,
        input.fact.errorMessage,
        SMS_DELIVERY_STATUS.PENDING,
      ],
    );
    const list = Array.isArray(rows) ? rows : rows?.[0] ?? [];
    return list.length > 0 ? 'applied' : 'unknown_or_terminal';
  } catch {
    return 'db_error';
  }
}

// ---------------------------------------------------------------------------
// 一轮消费
// ---------------------------------------------------------------------------

export interface TickResult {
  received: number;
  applied: number;
  skipped: Record<string, number>;
  /** 🔴 本轮是否有消息**没能删除**（= 官方会重投）—— 必须能被门禁看见 */
  deleteFailed: number;
}

export interface TickDeps {
  client: MnsReceiptClient;
  db: any;
  provider: string;
  /** 单轮最多处理多少条（来自 MnsConfig，避免长尾把一轮拖到下一轮） */
  maxPerTick: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

/**
 * 跑一轮：长轮询最多 `maxMessagesPerTick` 次，逐条处理。
 *
 * ⚠️ 删除时机是本文件最容易写错的一处：
 *   · 解析失败 / 落库失败 ⇒ **不删** ⇒ 官方在 VisibilityTimeout 后重投
 *     （对"数据库抖动"这类可恢复故障，这是唯一正确的行为；删了就永久丢回执）。
 *   · `unknown_biz_id`（匹配不上任何行）⇒ **删**。它重投一万次也不会匹配上，
 *     而留着会把队列堵死。这与"泄露存在性"无关：两条路径对外表现完全一致。
 *   · 成功应用 ⇒ 删。
 */
export async function runReceiptTick(deps: TickDeps): Promise<TickResult> {
  const logger = deps.logger ?? {};
  const result: TickResult = { received: 0, applied: 0, skipped: {}, deleteFailed: 0 };

  for (let i = 0; i < deps.maxPerTick; i++) {
    let msg: MnsMessage | null;
    try {
      msg = await deps.client.receive();
    } catch (err) {
      logger.warn?.(`[sms-receipt] ReceiveMessage 失败：${(err as Error)?.message ?? 'unknown'}`);
      break;
    }
    if (!msg) break;
    result.received += 1;

    const fact = normalizeReceipt(msg.messageBody);
    if (!fact) {
      // 报文不认识 ⇒ 不删（重投），但**不打印原文**（可能含手机号）
      result.skipped.malformed = (result.skipped.malformed ?? 0) + 1;
      logger.warn?.(`[sms-receipt] 回执报文无法归一化（MessageId 长度 ${msg.messageId.length}），不删除、等待重投`);
      continue;
    }

    const skip = await applyReceipt(deps.db, { provider: deps.provider, fact });
    if (skip === 'applied') {
      result.applied += 1;
    } else {
      result.skipped[skip] = (result.skipped[skip] ?? 0) + 1;
    }

    // 匹配不上（含"已是终态"）⇒ 删掉，别堵队列
    if (skip !== 'db_error') {
      const ok = await deps.client.deleteMessage(msg.receiptHandle);
      if (!ok) result.deleteFailed += 1;
    }
  }

  if (result.received > 0) {
    logger.info?.(
      `[sms-receipt] 本轮取到 ${result.received} 条，应用 ${result.applied} 条` +
        (result.deleteFailed > 0 ? `，${result.deleteFailed} 条删除失败（将被重投）` : ''),
    );
  }
  return result;
}
