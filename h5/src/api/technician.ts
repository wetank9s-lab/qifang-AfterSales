/**
 * 师傅作业接口（匿名，凭证是链接路径里的 Token）
 *
 *   GET  /api/technician/visits/:token                 → 作业上下文（最小信息）
 *   POST /api/technician/visits/:token/files           → 上传一张照片（multipart）
 *   POST /api/technician/visits/:token/submit          → 提交回执
 *   GET  /api/technician/visits/:token/photos/:ref     → 受控读取单张照片
 *
 * ===========================================================================
 * 为什么这组接口**不发** `X-Request-Id`
 * ===========================================================================
 * `/api/svc/*` 的内部写动作是真幂等（同号重放回放首次响应，见 docs/API.md §1.2）。
 * 师傅接口**不是**：一次性 Token **本身就是提交边界**。
 *
 * 所以这里刻意不发请求号 —— 发了会暗示"重放是被允许的"，而 P5-1 的 R2 反向测试
 * 明确要求：提交成功后用同一 Token 重放**必须** 401 TOKEN_INVALID。
 * 换句话说，这一层不需要幂等键，因为"第二次"在语义上就不该成功。
 *
 * ===========================================================================
 * 前端校验不是校验
 * ===========================================================================
 * 本文件里所有"上传前先看看大小/张数"的判断都只是**省一次往返、少一次失败**。
 * 真正的闸门在服务端（`PhotoService`：magic bytes、剥 EXIF、原子上限、私有落盘），
 * 而上传时**浏览器给的 MIME 与文件名一律不可信**（服务端按字节判定）。
 * 因此这里的提示文案刻意保守：说"可能不支持"，不说"服务器只接受 JPG"。
 */
import { ApiError } from './http';

/** `get` 返回的作业上下文（字段与 docs/API.md §2.1 一致，**刻意只有这些**） */
export interface TechnicianContext {
  ticket_no: string;
  store_name: string;
  ticket_type: string;
  /** 报修内容 —— 师傅靠它判断带什么工具 */
  content: string;
  expected_visit_at: string | null;
  expires_at: string | null;
  /** 师傅视角状态（投影值，恒为 'pending'：能打开就说明还待作业） */
  status: string;
  visit_status: string;
  photos_count: number;
  photos: TechnicianPhoto[];
  max_photos: number;
  max_photo_size_mb: number;
  /** 表单选项由**服务端下发**，不在这里手抄枚举与中文标签（见 DEV-58/59） */
  service_results: Option[];
  photo_types: Option[];
}

export interface Option {
  value: string;
  label: string;
}

export interface TechnicianPhoto {
  /** 对外句柄（不含内部主键）。读取路径见 `photoUrl()` */
  ref: string;
  photo_type: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface SubmitReceiptInput {
  service_result: string;
  service_note: string;
  is_charged: boolean;
  reported_charge_amount: number | null;
}

/** `submit` 成功后的响应 */
export interface SubmitOutcome {
  ticket_no: string;
  status: string;
  visit_status: string;
  store_confirm_status: string;
  /** **终态文案由服务端给**（唯一事实来源）："已提交，等待门店确认" */
  message: string;
  submitted_at: string | null;
}

const BASE_PATH = '/api/technician/visits';

/**
 * Token 只允许 base64url 字符集。
 *
 * ⚠️ 这里**不校验长度**。长度（43）是服务端常量 `TECHNICIAN_TOKEN.LENGTH`，
 *    在 H5 里再写一遍就是"同一个常量两个副本"——它一漂移，
 *    表现是"合法链接被前端判成非法"（比让服务端去 401 更糟：用户连重试的入口都没有）。
 *    所以前端只做"字符集/明显非法"的粗筛，**合法性一律由服务端回答**。
 */
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

export function assertTokenShape(token: string): string {
  const value = String(token ?? '').trim();
  if (!value || !TOKEN_CHARS.test(value)) {
    throw new ApiError(400, {
      code: 'TOKEN_MALFORMED',
      message: '链接格式不正确，请从门店短信里重新打开',
    });
  }
  return value;
}

/**
 * 照片句柄（ref）的形态闸 —— **数据入口的校验**，不是渲染期校验。
 *
 * 与 token 同理，这里**只查字符集、不查长度**：长度是服务端的常量
 * （`PHOTO_REF_LENGTH`），前端复制一份就会在它漂移时把合法 ref 判成非法，
 * 而照片看起来只是"加载不出来"，没人会往常量漂移上想。
 */
export function isValidPhotoRef(ref: unknown): boolean {
  return typeof ref === 'string' && ref.length > 0 && TOKEN_CHARS.test(ref);
}

/**
 * 单段路径编码（**纯函数**）。
 *
 * 之所以单独抽出来：这样就能**直接**断言"特殊字符不会改变 path/query 语义"，
 * 而不是靠页面渲染去间接证明（DEV-79）。三条必须成立的语义：
 *   `a/b` → `a%2Fb`（否则会多切出一段路径，落到别的 resource 上）
 *   `a?b` → `a%3Fb`（否则后面全变成 query，token 就"消失"了）
 *   `a#b` → `a%23b`（否则变成 fragment，根本不发给服务端）
 */
export function encodePathSegment(segment: unknown): string {
  return encodeURIComponent(String(segment ?? ''));
}

const visitPath = (token: string) => `${BASE_PATH}/${encodePathSegment(assertTokenShape(token))}`;

/**
 * 照片的**唯一**读取 URL。私有目录里的原文件没有任何静态路径可达。
 *
 * ⚠️ 这里刻意**不**走 `visitPath()`，也就是**不做 token 形态校验**。理由具体：
 *    本函数在**渲染路径**上被调用（模板里 `:src="url(p.ref)"`）。渲染函数一旦抛错，
 *    整棵组件树失败 → **白屏**；而"白屏"比"图片 404"难查得多，也更不像"链接有问题"。
 *    校验属于**数据进入客户端的边界**（token 走 `assertTokenShape`，
 *    ref 走 `isValidPhotoRef` —— 都在 API 层完成），渲染阶段只消费已校验的数据。
 */
export function photoUrl(token: string, ref: string): string {
  return `${BASE_PATH}/${encodePathSegment(token)}/photos/${encodePathSegment(ref)}`;
}

/**
 * 把后端 `{errors:[{code,message}]}` 拍平成 `ApiError`。
 * 与 `http.ts` 的同名逻辑同源 —— 但这里必须自己写一遍，
 * 因为 multipart 请求不能走 `request()`（它固定发 JSON）。
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = `请求失败（HTTP ${response.status}）`;
  try {
    const payload = (await response.json()) as { errors?: { code?: string; message?: string }[] };
    const first = payload?.errors?.[0];
    if (first?.code) code = String(first.code);
    if (first?.message) message = String(first.message);
  } catch {
    // 网关返回 HTML（如 nginx 的 413/502 页面）。**不把 HTML 当数据**：
    // 用户看到的是"服务暂时不可用"，而不是一段看不懂的标签。
    message = `服务暂时不可用（HTTP ${response.status}）`;
  }
  return new ApiError(response.status, { code, message });
}

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  const payload = (await response.json()) as { data?: T; errors?: { code: string; message: string }[] };
  if (payload?.errors?.length) {
    throw new ApiError(response.status, payload.errors[0]);
  }
  if (payload?.data === undefined) {
    throw new ApiError(response.status, {
      code: 'MALFORMED_RESPONSE',
      message: '服务响应缺少 data 字段',
    });
  }
  return payload.data;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
}

/**
 * 把服务端返回的照片**收敛成前端形状**，并在**这里**做形态闸。
 *
 * 这是"数据进入客户端的边界"：ref 不合形态就直接**丢弃**（返回 null），
 * 于是渲染层永远拿不到坏 ref —— `photoUrl()` 也就可以安安心心当纯函数。
 *
 * ⚠️ 之前 `fetchVisitContext` 与 `uploadPhoto` 各写了一遍这段映射
 *    （"同一个坑两条腿"）：两边的默认值/校验一旦分叉，
 *    列表里的照片与刚上传的照片行为会不一样，而这极难被发现。
 */
export function normalizePhoto(raw: unknown): TechnicianPhoto | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ref = String(o.ref ?? '');
  if (!isValidPhotoRef(ref)) return null;
  return {
    ref,
    photo_type: String(o.photo_type ?? ''),
    mime: String(o.mime ?? ''),
    size: Number(o.size ?? 0) || 0,
    width: o.width === null || o.width === undefined ? null : Number(o.width),
    height: o.height === null || o.height === undefined ? null : Number(o.height),
  };
}

/** 打开作业页所需的**最小**上下文。失败（含 401）由调用方决定文案 */
export async function fetchVisitContext(
  token: string,
  options: FetchOptions = {},
): Promise<TechnicianContext> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(visitPath(token), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const data = await unwrap<Record<string, unknown>>(response);

  // 与 `public.ts` 同样的"二次收敛"：即使将来服务端多回字段（比如 customer_mobile），
  // 页面也**拿不到**它，自然不会有机会渲染出去。
  // 这是"最小信息"的第二道闸 —— 第一道在服务端（`get` 刻意不查客户资料）。
  return {
    ticket_no: String(data.ticket_no ?? ''),
    store_name: String(data.store_name ?? ''),
    ticket_type: String(data.ticket_type ?? ''),
    content: String(data.content ?? ''),
    expected_visit_at: data.expected_visit_at ? String(data.expected_visit_at) : null,
    expires_at: data.expires_at ? String(data.expires_at) : null,
    status: String(data.status ?? ''),
    visit_status: String(data.visit_status ?? ''),
    photos_count: Number(data.photos_count ?? 0) || 0,
    photos: Array.isArray(data.photos)
      ? (data.photos as unknown[]).map(normalizePhoto).filter((p): p is TechnicianPhoto => p !== null)
      : [],
    max_photos: Number(data.max_photos ?? 0) || 0,
    max_photo_size_mb: Number(data.max_photo_size_mb ?? 0) || 0,
    service_results: normalizeOptions(data.service_results),
    photo_types: normalizeOptions(data.photo_types),
  };
}

function normalizeOptions(raw: unknown): Option[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const o = item as Record<string, unknown>;
      return { value: String(o.value ?? ''), label: String(o.label ?? '') };
    })
    .filter((o) => o.value !== '');
}

export interface UploadResult {
  photo: TechnicianPhoto;
  photos_count: number;
  max_photos: number;
}

/**
 * 上传一张照片。
 *
 * ⚠️ multipart 的这一层是**唯一**没有走 `request()` 的地方，原因很具体：
 *    `request()` 固定 `Content-Type: application/json` 并把 body 序列化成 JSON。
 *    multipart 的 `Content-Type` 必须由浏览器自己写（它要带 boundary），
 *    **手写 `Content-Type: multipart/form-data` 会把 boundary 丢掉**，
 *    服务端的解析器随即报"无法解析"——而现象只是"上传失败"，很难指向真正的原因。
 */
export async function uploadPhoto(
  token: string,
  file: File,
  photoType: string | null,
  options: FetchOptions = {},
): Promise<UploadResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  // 字段名必须与后端 `TECHNICIAN_UPLOAD_FIELD`（`file`）一致
  form.append('file', file, file.name || 'photo.jpg');
  if (photoType) form.append('photo_type', photoType);

  const response = await doFetch(`${visitPath(token)}/files`, {
    method: 'POST',
    // 刻意不设 headers：让浏览器补 multipart 的 boundary
    body: form,
  });
  const data = await unwrap<Record<string, unknown>>(response);
  // 上传的返回值同样过**边界闸**。这里不合形态就抛错（而不是静默丢弃）：
  // 上传"成功"却给了个没法读的句柄，是服务端违约，页面必须知道，
  // 否则它会往列表里塞一张永远加载不出来的照片。
  const photo = normalizePhoto(data.photo);
  if (!photo) {
    throw new ApiError(response.status, {
      code: 'MALFORMED_RESPONSE',
      message: '照片上传成功但返回的句柄不合法，请重试',
    });
  }
  return {
    photo,
    photos_count: Number(data.photos_count ?? 0) || 0,
    max_photos: Number(data.max_photos ?? 0) || 0,
  };
}

/** 提交回执。**不传 requestId** —— 理由见文件头 */
export async function submitReceipt(
  token: string,
  input: SubmitReceiptInput,
  options: FetchOptions = {},
): Promise<SubmitOutcome> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${visitPath(token)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      service_result: input.service_result,
      service_note: input.service_note,
      is_charged: input.is_charged,
      // 不收费时**显式发 null**，而不是省略字段：
      // 省略会让"师傅先填了金额又改回不收费"的残留值在某些实现里被原样采纳。
      // 服务端还会再兜一次（见 submit 的注释），这里让意图在报文上就是明确的。
      reported_charge_amount: input.is_charged ? input.reported_charge_amount : null,
    }),
  });
  const data = await unwrap<Record<string, unknown>>(response);
  return {
    ticket_no: String(data.ticket_no ?? ''),
    status: String(data.status ?? ''),
    visit_status: String(data.visit_status ?? ''),
    store_confirm_status: String(data.store_confirm_status ?? ''),
    message: String(data.message ?? '已提交，等待门店确认'),
    submitted_at: data.submitted_at ? String(data.submitted_at) : null,
  };
}

export { ApiError };
