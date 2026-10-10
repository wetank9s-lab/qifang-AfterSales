/**
 * 客户端公开接口（匿名，无需登录）
 *
 *   GET  /api/public/store-entry?k=<入口>  → 按**门店专属入口**解析门店（P11-1）
 *   GET  /api/public/stores   → 门店下拉（后端只回 code/name，见 docs/API.md §1.1）
 *   POST /api/public/tickets  → 提交报修/投诉（docs/API.md §1.2）
 *
 * ---------------------------------------------------------------------------
 * P11-1 起：**门店归属由入口决定，不再由用户在下拉里挑**（req 2 / req 3）
 * ---------------------------------------------------------------------------
 * 这一条改变了本文件与 `pages/Report/index.vue` 的关系：
 *   · 旧：页面先 `fetchStores()` 拿全部启用门店 → 用户选 → body 带 `store_code`；
 *   · 新：页面拿**入口值**（`?k=…`，来自门店二维码）→ `fetchStoreEntry()` 问服务端
 *     "这枚入口是谁" → 页面显示这个门店名 → 提交时**把入口值原样带上**。
 *
 * ⚠️ `fetchStores()` 仍然保留：它是**门店下拉**这套旧交互的接口，
 *    别的调用方（以及验收脚本）还在用；但它**不再是报修页的入口**。
 *    两件事在服务端是两个 action（`publicStore:list` vs `publicStore:entry`），
 *    暴露面差一个量级（见 verify-plugin-load.mjs 的匿名白名单注释）。
 */
import { ApiError, newRequestId, request } from './http';

export interface StoreOption {
  code: string;
  name: string;
}

/**
 * 门店报修入口解析结果（P11-1）。
 *
 * ⚠️ 只有三个字段 —— 与 `actions/public/store.ts` 的 DTO **逐字对齐**。
 *    没有 `id`、没有电话、没有地址。前端再多要一个字段都不是"顺手"，
 *    而是要把匿名接口的输出面撑大。
 */
export interface StoreEntry {
  code: string;
  name: string;
  /**
   * 入口来源，用于页面**如实**展示安全性差异（req 5）：
   *   · `signed` —— 新入口，带 HMAC 签名，改写会被服务端拒绝；
   *   · `legacy` —— 旧二维码（只带门店编码），**无防篡改保证**。
   */
  provenance: 'signed' | 'legacy';
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
  /**
   * 门店专属入口值（P11-1）。**走 query 而不是 body** —— 见 `submit()` 里那段说明。
   * 服务端用它决定门店归属；body 里的 `store_code` 只作为一致性校验。
   */
  entry?: string;
  // ---- Phase 11 / P11-1：服务单模型升级（§8.1）----
  /** 服务地址（选填；安排上门前由门店补全） */
  service_address?: string;
  /** 家电类型（§8.2 固定枚举；选填） */
  appliance_category?: string;
  /** 品牌 / 型号（选填，单个自由文本字段） */
  brand_model?: string;
  /** 客户声明的紧急标记（提示性；不改变状态机与 SLA 口径） */
  urgent?: boolean;
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

  // ---- Phase 11 / P11-1：四个新字段 ----
  // ⚠️ 与后端 `parseNewModelFields` **同一口径**：
  //    · 文本字段 trim 后为空 ⇒ **不发这个键**（后端也把空归一成 undefined）；
  //    · `urgent` 只在**为 true** 时才发 —— `false` 是列默认值，
  //      每次都发等于让"客户没勾"与"客户明确不勾"在载荷上无法区分（当前语义上等价，
  //      但保持"只发非默认"能让请求体最小）。
  // ⚠️ 家电类型即便为空也**不发**（不是发空串）：空串不在枚举里，会撞 422。
  const serviceAddress = String(draft.service_address ?? '').trim();
  if (serviceAddress) normalized.service_address = serviceAddress;
  const applianceCategory = String(draft.appliance_category ?? '').trim();
  if (applianceCategory) normalized.appliance_category = applianceCategory;
  const brandModel = String(draft.brand_model ?? '').trim();
  if (brandModel) normalized.brand_model = brandModel;
  return normalized;
}

/**
 * 草稿指纹。用**排序后的固定字段**拼串，而不是 JSON.stringify 整个对象：
 * 后者对键顺序敏感，`{a,b}` 与 `{b,a}` 会算出不同指纹，
 * 于是"内容其实没变"被判成"变了" → 重新取号 → 幂等失效。
 * 这里的字段集合是写死的白名单，不存在遗漏新字段的问题。
 *
 * ⚠️ `entry` **必须**进指纹：换了入口就是换了门店，那是**另一次提交**。
 *    漏了它会出现"用户在 S01 挨了 429，改扫 S02 的码重试 → 因指纹相同而回放
 *    S01 那次的失败/结果"，是最难解释的一类串单。
 */
function fingerprint(fields: Record<string, string>, urgent: boolean): string {
  // ⚠️ 新增字段**必须**进这里：指纹的语义是"这次提交意图的内容"。
  //    漏一个字段的表现是"客户改了那一项、再点提交 → 被当成重试而回放上一次的结果"，
  //    即"改了没用"—— 而它不会报错。
  return [
    'entry',
    'store_code',
    'ticket_type',
    'content',
    'customer_name',
    'customer_mobile',
    'source',
    // ---- Phase 11 / P11-1 新增 ----
    'service_address',
    'appliance_category',
    'brand_model',
    // urgent 是布尔，进不了 Record<string,string> ⇒ 单独以 `urgent=1/0` 参与
    'urgent',
  ]
    .map((key) => `${key}=${key === 'urgent' ? (urgent ? '1' : '0') : (fields[key] ?? '')}`)
    .join('\u0001');
}

/**
 * 按**门店专属入口**解析门店（P11-1）。
 *
 * 这是报修页进入后做的**第一件事**，也是"客户直接看到正确门店名称、
 * 不出现门店选择器"（req 3）的实现路径。
 *
 * ⚠️ 入口值用 `encodeURIComponent` 编码后放在 query 里（**不是路径段**）。
 *    原因见 nginx/conf.d/service.conf 那段：`location ^~ /api/public/`
 *    会**跳过同段的所有正则 location**，所以"路径形式"的入口在 nginx 层根本不可达。
 *    同一取舍让 H5 路由（`/h5/report?k=…`）、API（`?k=…`）、服务端解析
 *    （`param(ctx,'k')`）三处**同名同义**。
 */
export async function fetchStoreEntry(
  entry: string,
  options: SubmitterOptions = {},
): Promise<StoreEntry> {
  const token = String(entry ?? '').trim();
  if (!token) {
    // 不发请求：服务端对空入口回 422，前端先给一句能行动的提示更省一次往返。
    // ⚠️ 但**不能**因此认为"前端拦住了就没问题" —— 服务端那条校验依然必须存在
    //    （门禁会直接用空/伪造入口打接口）。
    throw new ApiError(400, {
      code: 'MISSING_STORE_ENTRY',
      message: '缺少门店入口参数，请重新扫描门店报修二维码',
    });
  }
  const data = await request<Record<string, unknown>>(
    `/api/public/store-entry?k=${encodeURIComponent(token)}`,
    { method: 'GET', fetchImpl: options.fetchImpl },
  );
  const provenance = String(data.provenance ?? '');
  return {
    code: String(data.code ?? ''),
    name: String(data.name ?? ''),
    // ⚠️ 认不出的来源一律按 `legacy` 对待（**偏保守**的那一侧）：
    //    服务端将来若新增一种来源，页面会显示"无签名保护"——这是"多提示了一句"，
    //    反过来（默认 signed）会把一个没有防篡改能力的入口说成安全的，那是 req 5
    //    明令禁止的"宣称同等安全"。
    provenance: provenance === 'signed' ? 'signed' : 'legacy',
  };
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
 *
 * ===========================================================================
 * 「连点 10 次只产生 1 张工单」到底靠什么成立
 * ===========================================================================
 * 这是 Phase 3-H 的验收项，也是整个 H5 里**唯一**真正需要设计的地方。
 * 它必须由两层各自独立地成立，任何一层单独都不够：
 *
 *   ① 前端 single-flight（本函数）
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
 *
 * ⚠️ P11-1 起「草稿内容」里多了**入口值**（`k`）：换入口 = 换门店 = 另一次提交。
 *    见 `fingerprint()` 的注释。
 */
export function createTicketSubmitter(options: SubmitterOptions = {}): TicketSubmitter {
  const makeRequestId = options.makeRequestId ?? newRequestId;

  let currentFingerprint: string | null = null;
  let currentRequestId: string | null = null;
  let inFlightPromise: Promise<TicketCreated> | null = null;
  let resolvedFingerprint: string | null = null;
  let resolvedOutcome: TicketCreated | null = null;
  let httpCalls = 0;

  async function send(
    fields: Record<string, string>,
    requestId: string,
    entry: string,
    urgent: boolean,
  ): Promise<TicketCreated> {
    httpCalls += 1;
    // 🔴 入口值走 **query**，不走 body（P11-1 的取舍，别改回去）：
    //    · 它是**URL 级**概念 —— 客户扫的那张二维码编的就是一条带 `?k=` 的 URL，
    //      页面自己的地址栏里也是 `?k=`。三处（二维码/页面/接口）同名同义，
    //      "路由与服务端解析保持一致"由**同一个参数名**保证，不靠三处各自记住一条规则。
    //    · req 2 明确点名**请求 body** 属于"可以随意改写"的一类输入。
    //      把它放在 query 不是因为它更可信（同样不可信），而是为了让
    //      "body 里的 store_code 被伪造"这件事**改变不了任何东西** ——
    //      服务端只认入口，body 的 store_code 仅用于一致性校验（不一致即 422）。
    //    ⚠️ 指纹里已经含 `entry` ⇒ 换了入口必然换请求号（见 fingerprint 的注释）。
    const url = `/api/public/tickets?k=${encodeURIComponent(entry)}`;
    const data = await request<Record<string, unknown>>(url, {
      method: 'POST',
      // privacy_agreed 是**恒定 true**：未勾选时页面根本不会调到这里（见 Report 页）。
      // 不把它做成参数，是为了让"能不能提交"这个判断只有一个入口，
      // 而不是散落在"参数传对了没"上。
      // urgent 与 privacy_agreed 一样**不经 normalize**（它是布尔，不是文本）：
      // 只在客户勾了「紧急」时才出现在 body 里 —— 不勾就是不发这个键，
      // 让"没勾"与"明确不勾"在载荷上保持区分（后端只在收到布尔时置位）。
      body: { ...fields, ...(urgent ? { urgent: true } : {}), privacy_agreed: true },
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
    // 入口值单独持有：它**不进 body**（见 send 的说明），所以不能混进 normalize 的结果里。
    const entry = String(draft.entry ?? '').trim();
    const urgent = draft.urgent === true;
    const fp = fingerprint({ ...fields, entry }, urgent);

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
    const promise = send(fields, requestId, entry, urgent)
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
