/**
 * 客户端公开接口（匿名，无需登录）
 *
 *   GET  /api/public/stores   → 门店下拉（后端只回 code/name，见 docs/API.md §1.1）
 *   POST /api/public/tickets  → 提交报修/投诉（docs/API.md §1.2）
 *
 * ===========================================================================
 * 「连点 10 次只产生 1 张工单」到底靠什么成立
 * ===========================================================================
 * 这是 Phase 3-H 的验收项，也是整个 H5 里**唯一**真正需要设计的地方。
 * 它必须由两层各自独立地成立，任何一层单独都不够：
 *
 *   ① 前端 single-flight（本文件 createTicketSubmitter）
 *      10 次点击**共享同一个 Promise**，只发出 1 个 HTTP 请求。
 *      没有它：10 次点击 = 10 个请求 = 10 次频控消费，
 *      在 30 次/分的阈值下，用户自己点两轮就能把整栋楼的人挡在门外。
 *
 *   ② 后端 request_id 幂等（actions/public/ticket.ts）
 *      同号重放返回首次响应，不新建工单、不消耗序号。
 *      没有它：网络抖动下"响应丢了但工单建了"，用户重试就会多一张单 ——
 *      前端**不可能**自己解决这个问题，因为它根本不知道服务端有没有落库。
 *
 * 所以前端这层的正确性是"省请求、省配额"，后端那层才是"不重复建单"的兜底。
 * 验收脚本会分别对两层下断言，不允许把两层混为一谈。
 *
 * ===========================================================================
 * 请求号的归属：一次"提交意图"，不是一次请求
 * ===========================================================================
 * 请求号在「草稿内容变化」时才重新生成：
 *   · 内容没变 → 复用同一个号（重试 = 回放，符合用户"我就想再试一次"的意图）
 *   · 内容变了 → 换新号（这是**另一次**提交，必须真的建单）
 * 若每次请求都现生成新号，"重试"就等价于"再报一单"，
 * 幂等键也就形同虚设了。
 */
import { ApiError, newRequestId, request } from './http';

export interface StoreOption {
  code: string;
  name: string;
}

export type TicketType = 'repair' | 'complaint';

export interface TicketDraft {
  store_code: string;
  ticket_type: TicketType;
  content: string;
  customer_name: string;
  customer_mobile: string;
  /** 来源渠道；后端默认 qr。H5 从 URL 的 ?source= 带过来 */
  source?: string;
}

/** 后端响应体：**恰好**三个字段，不要指望还有别的（docs/API.md §1.2） */
export interface TicketCreated {
  ticket_no: string;
  store_name: string;
  created_at: string;
}

export interface TicketSubmitter {
  submit(draft: TicketDraft): Promise<TicketCreated>;
  /** 是否有请求在途（页面据此置灰按钮）。注意：**置灰不是防连点手段**，只是提示 */
  readonly inFlight: boolean;
  /** 当前提交意图使用的请求号（验收与排障用） */
  readonly currentRequestId: string | null;
  /** 本次意图已发出的 HTTP 请求次数（验收用：连点 10 次时它必须等于 1） */
  readonly httpCalls: number;
  reset(): void;
}

export interface SubmitterOptions {
  fetchImpl?: typeof fetch;
  /** 便于验收注入；生产用 uuid.ts 的实现 */
  makeRequestId?: () => string;
}

/** 只取白名单字段并 trim —— 与后端 parseDto 的取值口径一致 */
function normalize(draft: TicketDraft): Record<string, string> {
  const normalized: Record<string, string> = {
    store_code: String(draft.store_code ?? '').trim(),
    ticket_type: String(draft.ticket_type ?? '').trim(),
    content: String(draft.content ?? '').trim(),
    customer_name: String(draft.customer_name ?? '').trim(),
    customer_mobile: String(draft.customer_mobile ?? '').trim(),
  };
  const source = String(draft.source ?? '').trim();
  // source 缺省不传：后端默认 'qr'。传空串反而会撞 INVALID_SOURCE（空串不在枚举里）
  if (source) normalized.source = source;
  return normalized;
}

/**
 * 草稿指纹。用**排序后的固定字段**拼串，而不是 JSON.stringify 整个对象：
 * 后者对键顺序敏感，`{a,b}` 与 `{b,a}` 会算出不同指纹，
 * 于是"内容其实没变"被判成"变了" → 重新取号 → 幂等失效。
 * 这里的字段集合是写死的白名单，不存在遗漏新字段的问题。
 */
function fingerprint(fields: Record<string, string>): string {
  return ['store_code', 'ticket_type', 'content', 'customer_name', 'customer_mobile', 'source']
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('\u0001');
}

export async function fetchStores(options: SubmitterOptions = {}): Promise<StoreOption[]> {
  const data = await request<StoreOption[]>('/api/public/stores', {
    method: 'GET',
    fetchImpl: options.fetchImpl,
  });
  // 后端契约是"只有 code/name"。这里再收敛一次，
  // 防止将来后端手滑多回字段时，前端直接把敏感值渲染到页面上。
  return data.map((item) => ({ code: String(item.code), name: String(item.name) }));
}

/**
 * 创建一个"提交器"。**每个页面实例一个**：
 * 跨页面共用一个提交器会让两个门店的提交互相顶掉请求号。
 */
export function createTicketSubmitter(options: SubmitterOptions = {}): TicketSubmitter {
  const makeRequestId = options.makeRequestId ?? newRequestId;

  let currentFingerprint: string | null = null;
  let currentRequestId: string | null = null;
  let inFlightPromise: Promise<TicketCreated> | null = null;
  let resolvedFingerprint: string | null = null;
  let resolvedOutcome: TicketCreated | null = null;
  let httpCalls = 0;

  async function send(fields: Record<string, string>, requestId: string): Promise<TicketCreated> {
    httpCalls += 1;
    const data = await request<Record<string, unknown>>('/api/public/tickets', {
      method: 'POST',
      // privacy_agreed 是**恒定 true**：未勾选时页面根本不会调到这里（见 Report 页）。
      // 不把它做成参数，是为了让"能不能提交"这个判断只有一个入口，
      // 而不是散落在"参数传对了没"上。
      body: { ...fields, privacy_agreed: true },
      requestId,
      fetchImpl: options.fetchImpl,
    });

    // 与 fetchStores 同样的收敛：即使将来后端多回一个 `id`/`handler`，
    // 页面也**拿不到**它，自然不会有机会渲染出去（DEV-PLAN Phase 3-B 明文
    // "不返回 id / 处理人"）。收敛放在前端是第二道闸：
    // 后端改了契约而前端没跟上时，表现是"某个字段不显示"，而不是"敏感值泄漏"。
    return {
      ticket_no: String(data.ticket_no ?? ''),
      store_name: String(data.store_name ?? ''),
      created_at: String(data.created_at ?? ''),
    };
  }

  function submit(draft: TicketDraft): Promise<TicketCreated> {
    const fields = normalize(draft);
    const fp = fingerprint(fields);

    // 同一份内容已经成功过 → 直接返回首次结果。
    // 这条挡的是"提交成功后返回键/后退再点一次"：后端重复单检测虽然也能兜住，
    // 但那是 409（一次失败体验），这里给的是与首次完全一致的 200 语义。
    if (resolvedFingerprint === fp && resolvedOutcome) {
      return Promise.resolve(resolvedOutcome);
    }

    if (fp !== currentFingerprint) {
      // 内容变了 → 新的提交意图 → 新号，并丢弃上一次的在途结果
      currentFingerprint = fp;
      currentRequestId = makeRequestId();
      inFlightPromise = null;
      resolvedFingerprint = null;
      resolvedOutcome = null;
    }

    // ---- single-flight：10 次连点在这里被折叠成 1 次 ----
    // 必须在任何 await 之前就完成赋值，否则同步连点会各自走到下面新建请求。
    if (inFlightPromise) return inFlightPromise;

    const requestId = currentRequestId as string;
    const promise = send(fields, requestId)
      .then((outcome) => {
        resolvedFingerprint = fp;
        resolvedOutcome = outcome;
        return outcome;
      })
      .finally(() => {
        // 失败时**保留** currentRequestId：用户重试要回放同一号，
        // 否则"响应丢了"的重试会变成第二张工单。
        inFlightPromise = null;
      });

    inFlightPromise = promise;
    return promise;
  }

  return {
    submit,
    get inFlight() {
      return inFlightPromise !== null;
    },
    get currentRequestId() {
      return currentRequestId;
    },
    get httpCalls() {
      return httpCalls;
    },
    reset() {
      currentFingerprint = null;
      currentRequestId = null;
      inFlightPromise = null;
      resolvedFingerprint = null;
      resolvedOutcome = null;
    },
  };
}

export { ApiError };
