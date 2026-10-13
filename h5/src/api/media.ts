/**
 * 客户媒体上传与服务进度查询（P11-4）。
 *
 * 三个匿名接口 + 一个受控读取：
 *   POST /api/public/media/session        → 建会话（换一会话 token）
 *   POST /api/public/media/upload         → 传文件（multipart，字段名 file）
 *   GET  /api/public/media/files/<id>     → 读文件（会话 token 或进度 token）
 *   GET  /api/public/progress/<token>     → 查进度
 *
 * ---------------------------------------------------------------------------
 * 这一层刻意**不做**的三件事
 * ---------------------------------------------------------------------------
 * ① 不缓存会话 token 到 localStorage：token 明文只活在本次页面会话的内存里。
 *    落盘等于把"可写凭证"留在客户设备上（换个人拿起手机就能往这个会话传文件）。
 * ② 不生成文件 URL 给 <img src>：文件读取一律走带凭证头的 fetch，
 *    再转成 blob URL 预览。直接拼 URL 会把凭证暴露在地址栏/历史记录里。
 * ③ 不用客户端进度条代替服务端确认：上传成功以**服务端响应**为准
 *    （`reused` / `id` 存在），XHR 的 progress 事件只作为"正在传"的提示。
 */
import { ApiError, request } from './http';

export interface MediaLimits {
  max_file_bytes: number;
  max_items: number;
  image_max_count: number;
  audio_max_ms: number;
  video_max_ms: number;
}

export interface MediaSession {
  session_id: number;
  /** 明文会话 token —— **只在这里出现一次**，刷新即失效 */
  session_token: string;
  expires_at: string;
  limits: MediaLimits;
}

export interface UploadedMedia {
  id: number;
  kind: 'image' | 'audio' | 'video';
  mime: string;
  size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  /** true = 服务端复用了已收到的同一内容（重复上传不会变两份） */
  reused: boolean;
}

export interface ProgressMedia {
  id: number;
  kind: string;
  mime: string;
  size: number;
  duration_ms: number | null;
}

export interface ProgressView {
  ticket_no: string;
  store_name: string;
  status: string;
  status_label: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  submitted: {
    ticket_type: string;
    content: string;
    customer_name: string | null;
    service_address: string | null;
    appliance_category: string | null;
    brand_model: string | null;
  };
  media: ProgressMedia[];
  timeline: Array<{ status: string; status_label: string; at: string }>;
  completion_note: string | null;
  review: { status: string; invited_via_sms: boolean };
  queryable_until: string | null;
  closed: boolean;
}

/** 建会话。`media_consent` 必传 —— 服务端强制（媒体授权不能吃"提交即同意"） */
export async function createMediaSession(): Promise<MediaSession> {
  // ⚠️ request() 返回的是 **payload.data 本身**（T），不是 envelope。
  //    第一批写成 request<{ data: MediaSession }> 再 return res.data
  //    ⇒ 拿到 undefined ⇒ 报 'Cannot read properties of undefined (reading session_id)'。
  //    Node 侧冒烟不经过这段代码，所以只有真实浏览器才暴露出来。
  return request<MediaSession>('/api/public/media/session', {
    method: 'POST',
    body: { media_consent: true },
  });
}

/**
 * 上传一个文件到会话。
 *
 * ⚠️ 用 XHR 而不是 fetch：只有 XHR 有 `upload.onprogress`。
 *    但进度条**只表示"正在传"**，真正的成功判据是本函数 resolve
 *    （服务端已收到并落盘）。弱网下 progress 到 100% 后服务端仍可能 409/415。
 */
export function uploadMedia(
  sessionToken: string,
  file: File | Blob,
  fileName: string,
  onProgress?: (percent: number) => void,
): { promise: Promise<UploadedMedia>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append('file', file, fileName);
  // 🔴 `declared_kind`：**浏览器给出的**采集类型（来自 `File.type` / `MediaRecorder.mimeType`
  //    的主类型），不是表单里的用户输入。服务端只在"webm 容器判不出音视频"时用它
  //    （真实 Chrome 录音的 webm 里没有 Tracks —— 见 media-format.ts 的说明）；
  //    容器判得出来时一律以容器为准，伪造它没有用。
  const declaredKind = /^video\//.test(String((file as File).type ?? ''))
    ? 'video'
    : /^audio\//.test(String((file as File).type ?? ''))
      ? 'audio'
      : '';
  if (declaredKind) form.append('declared_kind', declaredKind);

  const promise = new Promise<UploadedMedia>((resolve, reject) => {
    xhr.open('POST', '/api/public/media/upload');
    xhr.setRequestHeader('X-Media-Session', sessionToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError(xhr.status, { code: 'BAD_RESPONSE', message: '服务端返回无法解析' }));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.data) {
        resolve(body.data as UploadedMedia);
        return;
      }
      const err = body?.errors?.[0] ?? { code: 'UPLOAD_FAILED', message: '上传失败' };
      reject(new ApiError(xhr.status, err));
    };
    xhr.onerror = () =>
      reject(new ApiError(0, { code: 'NETWORK_ERROR', message: '网络中断，请检查连接后重试' }));
    xhr.ontimeout = () =>
      reject(new ApiError(0, { code: 'NETWORK_TIMEOUT', message: '上传超时，请重试' }));
    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}

/** 读一个媒体文件（带凭证头，返回 blob URL 供预览） */
export async function fetchMediaBlob(mediaId: number, credential: { sessionToken?: string; progressToken?: string }): Promise<string> {
  const headers: Record<string, string> = {};
  if (credential.sessionToken) headers['X-Media-Session'] = credential.sessionToken;
  if (credential.progressToken) headers['X-Progress-Token'] = credential.progressToken;
  const res = await fetch(`/api/public/media/files/${mediaId}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = 'MEDIA_NOT_FOUND';
    try {
      code = JSON.parse(text)?.errors?.[0]?.code ?? code;
    } catch {
      /* 保持默认 */
    }
    throw new ApiError(res.status, { code, message: '文件不存在或已失效' });
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** 查进度（Token 走**路径**，与评价/师傅接口同一理由：不进 access log） */
export async function fetchProgress(token: string): Promise<ProgressView> {
  // 同上：request() 返回的是 payload.data 本身
  return request<ProgressView>(`/api/public/progress/${encodeURIComponent(token)}`);
}
