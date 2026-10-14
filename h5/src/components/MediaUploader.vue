<template>
  <!--
    「描述 + 媒体」**同一个区域**（P11-4 第二批 · 用户 B/C/D/E/F 项）。

    产品契约（逐条对应用户要求）：
      · 文字、有效照片、语音、视频**至少有一种**即可提交 —— 三者同级，不是附件任务；
      · 三个入口在文字框**正下方**：📷 拍照 / 🎤 录音 / 🎬 拍视频；
      · 材料**就地显示**（缩略图 + 播放 + 删除 + 重录），不需要滚到页面底部；
      · 限制只出现在**按钮小字**与**录制计时**里，不堆长说明；
      · 常驻说明只有一句：「照片、录音和视频仅用于本次售后处理。」；
      · 独立媒体授权用**首次一次性确认**完成（不是每次拍摄都弹）。
  -->
  <div class="svc-desc" data-testid="media-uploader">
    <!-- 文字描述（与媒体同级，不是"附件的前提"） -->
    <textarea
      :id="contentId"
      v-model="innerText"
      class="svc-textarea"
      :maxlength="contentMax"
      :placeholder="placeholder"
      :data-testid="contentTestid"
    ></textarea>
    <!--
      ⚠️ 这里**不再有**任何常驻提示（P11-4 第三批 · 用户要求）。
      原句「打字、拍照、录音都可以」既漏了视频，又是多余的 ——
      下面三个按钮（📷拍照 / 🎤录音 / 🎬拍视频）已经把可做的事说清楚了，
      文字框的字数计数保留（它不是"说明"，是输入反馈）。
    -->
    <div class="svc-hint svc-hint-right">
      <span>{{ innerText.length }}/{{ contentMax }}</span>
    </div>

    <!-- 三个采集入口：同级、同排、同样明显 -->
    <div class="svc-capture">
      <button
        type="button"
        class="svc-capture-btn"
        :disabled="uploading || !canAddMore"
        data-testid="capture-photo"
        @click="takePhoto"
      >
        <span class="svc-capture-ico" aria-hidden="true">📷</span>
        <span class="svc-capture-txt">拍照</span>
      </button>

      <button
        type="button"
        class="svc-capture-btn"
        :class="{ 'is-recording': recording }"
        :disabled="uploading || (!canAddMore && !recording)"
        data-testid="capture-audio"
        @click="onRecordClick"
      >
        <span class="svc-capture-ico" aria-hidden="true">🎤</span>
        <span class="svc-capture-txt">{{ recording ? '结束录音' : '录音' }}</span>
        <span v-if="recording" class="svc-capture-timer" data-testid="record-timer">{{ recordClock }}</span>
        <span v-else class="svc-capture-limit">最长 60 秒</span>
      </button>

      <button
        type="button"
        class="svc-capture-btn"
        :disabled="uploading || !canAddMore"
        data-testid="capture-video"
        @click="takeVideo"
      >
        <span class="svc-capture-ico" aria-hidden="true">🎬</span>
        <span class="svc-capture-txt">拍视频</span>
        <span class="svc-capture-limit">最长 30 秒</span>
      </button>
    </div>

    <!-- 次级能力：相册（低视觉权重） -->
    <div class="svc-secondary">
      <label class="svc-secondary-btn">
        从相册选择
        <input
          type="file"
          accept="image/*,video/*,audio/*"
          :disabled="uploading || !canAddMore"
          data-testid="pick-from-album"
          @change="onPickFromAlbum"
        />
      </label>
      <span v-if="limitsHint" class="svc-hint">{{ limitsHint }}</span>
    </div>

    <!-- 材料就地显示 -->
    <ul v-if="items.length" class="svc-mats" data-testid="media-list">
      <li v-for="it in items" :key="it.key" class="svc-mat" :data-testid="'mat-' + it.kind">
        <!-- 图片：缩略图 + 查看/删除 -->
        <template v-if="it.kind === 'image'">
          <img v-if="it.previewUrl" :src="it.previewUrl" alt="已添加照片" class="svc-mat-thumb" @click="preview(it)" />
          <span v-else class="svc-mat-thumb"></span>
          <span class="svc-mat-meta">
            <span class="svc-mat-title">照片</span>
            <span class="svc-mat-state" :class="stateClass(it)" :data-code="it.errorCode ?? ''">{{ stateText(it) }}</span>
          </span>
          <button type="button" class="svc-mat-act" data-testid="mat-view" @click="preview(it)">查看</button>
          <button type="button" class="svc-mat-act" @click="remove(it)">删除</button>
        </template>

        <!-- 录音：时长 + 播放 + 重录 + 删除 -->
        <template v-else-if="it.kind === 'audio'">
          <span class="svc-mat-glyph" aria-hidden="true">🎤</span>
          <span class="svc-mat-meta">
            <span class="svc-mat-title">录音 {{ it.durationText }}</span>
            <span class="svc-mat-state" :class="stateClass(it)" :data-code="it.errorCode ?? ''">{{ stateText(it) }}</span>
          </span>
          <audio v-if="it.previewUrl" :src="it.previewUrl" controls class="svc-mat-audio" data-testid="mat-audio-player"></audio>
          <button type="button" class="svc-mat-act" data-testid="mat-reaudio" @click="remove(it)">重录</button>
          <button type="button" class="svc-mat-act" @click="remove(it)">删除</button>
        </template>

        <!-- 视频：缩略图 + 播放 + 重拍 + 删除 -->
        <template v-else>
          <span v-if="it.previewUrl" class="svc-mat-thumb" data-testid="mat-video-thumb">
            <video :src="it.previewUrl" muted playsinline preload="metadata"></video>
          </span>
          <span class="svc-mat-meta">
            <span class="svc-mat-title">视频 {{ it.durationText }}</span>
            <span class="svc-mat-state" :class="stateClass(it)" :data-code="it.errorCode ?? ''">{{ stateText(it) }}</span>
          </span>
          <button type="button" class="svc-mat-act" data-testid="mat-retake" @click="remove(it)">重拍</button>
          <button type="button" class="svc-mat-act" @click="remove(it)">删除</button>
        </template>
      </li>
    </ul>

    <!-- 唯一的常驻说明（用户 C 项：只保留这一句） -->
    <p class="svc-hint svc-privacy-line">照片、录音和视频仅用于本次售后处理。</p>

    <!-- 进度 / 错误 -->
    <div v-if="uploading" class="svc-up" data-testid="upload-progress">
      <div class="svc-up-bar"><i :style="{ width: progress + '%' }"></i></div>
      <span>{{ progress }}%</span>
    </div>
    <p v-if="errorText" class="svc-error" data-testid="media-error">{{ errorText }}</p>
  </div>

  <!-- 首次一次性媒体授权（用户 C 项：不是每次拍摄都弹） -->
  <div v-if="consentOpen" class="svc-modal" data-testid="media-consent">
    <div class="svc-modal-card">
      <h2>使用相机和麦克风</h2>
      <p>照片、录音和视频仅用于本次售后处理，门店为处理这次上门需要查看它们。</p>
      <p class="svc-hint">只问这一次，之后不再打扰。</p>
      <div class="svc-modal-actions">
        <button type="button" class="svc-submit" data-testid="consent-ok" @click="grantConsent">继续</button>
        <button type="button" class="svc-modal-cancel" data-testid="consent-no" @click="denyConsent">暂不</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 三条采集路径的**真实能力探测**与降级（用户 D/E/F 项）：
 *
 * | 能力 | 主路径 | 降级 | 说明 |
 * |---|---|---|---|
 * | 拍照 | `<input type=file capture=environment>` | 相册 | 主流手机浏览器直接调起**相机**；只弹系统选择器时仍能拍照 |
 * | 录音 | `getUserMedia + MediaRecorder` | 相册里选音频 | **不用 `input type=file` 冒充录音** |
 * | 拍视频 | `<input type=file capture=environment>`（原生录像） | 相册 | 原生录像无法保证 30 秒自动停 ⇒ 时长由**服务端**核验（413 → 提示重录），客户端也会先读一次 metadata |
 *
 * ⚠️ 微信内置浏览器：`MediaRecorder` 在部分版本不可用、`<input capture>` 行为也不一。
 *    这里**如实降级**（提示可用相册/文字），**不声称**支持 `wx.startRecord` ——
 *    公众号 JS-SDK 需要已备案域名 + 接口权限，前置条件未具备时不做"看起来支持"。
 *    真机验证清单见 `docs/P11-4-CUSTOMER-MEDIA.md`（未验证项如实列出）。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { ApiError } from '../api/http';
import { createMediaSession, uploadMedia, type MediaLimits, type UploadedMedia } from '../api/media';

const props = withDefaults(
  defineProps<{
    modelValue: { id: number; token: string } | null;
    text: string;
    contentId: string;
    contentTestid: string;
    placeholder: string;
    contentMax: number;
  }>(),
  { modelValue: null, text: '' },
);
const emit = defineEmits<{
  (e: 'update:modelValue', v: { id: number; token: string } | null): void;
  (e: 'update:text', v: string): void;
  (e: 'change', count: number): void;
}>();

const innerText = computed({
  get: () => props.text,
  set: (v: string) => emit('update:text', v),
});

const DEFAULT_LIMITS: MediaLimits = {
  max_file_bytes: 8 * 1024 * 1024,
  max_items: 5,
  image_max_count: 3,
  audio_max_ms: 60_000,
  video_max_ms: 30_000,
};
const limits = ref<MediaLimits>(DEFAULT_LIMITS);

interface Item {
  key: string;
  kind: 'image' | 'audio' | 'video';
  name: string;
  file: File;
  state: 'pending' | 'uploading' | 'done' | 'failed';
  error?: string;
  /** 失败原因 code —— **只作诊断**（进 data-code 与 console，不进主文案） */
  errorCode?: string | null;
  previewUrl?: string;
  mediaId?: number;
  durationText: string;
}

const items = ref<Item[]>([]);
const uploading = ref(false);
const progress = ref(0);
const errorText = ref('');
const consentOpen = ref(false);
let pendingAction: (() => Promise<void>) | null = null;
let session: { id: number; token: string } | null = props.modelValue ?? null;

const doneCount = computed(() => items.value.filter((i) => i.state === 'done').length);
const canAddMore = computed(() => {
  const live = items.value.filter((i) => i.state !== 'failed');
  const images = live.filter((i) => i.kind === 'image').length;
  return live.length < limits.value.max_items && images < limits.value.image_max_count;
});
const limitsHint = computed(() => {
  const images = items.value.filter((i) => i.kind === 'image' && i.state !== 'failed').length;
  return images >= limits.value.image_max_count ? '照片已满 3 张' : '';
});

function stateText(it: Item): string {
  if (it.state === 'uploading') return '正在上传…';
  if (it.state === 'pending') return '等待上传';
  if (it.state === 'failed') return it.error ?? '失败，可重试';
  return '已就绪';
}
function stateClass(it: Item): string {
  return it.state === 'failed' ? 'is-failed' : it.state === 'done' ? 'is-done' : '';
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 授权（一次性）
const CONSENT_KEY = 'svc-media-consent';
function hasConsent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}
async function withConsent(action: () => Promise<void>): Promise<void> {
  // 🔴 授权**只问一次**（sessionStorage 会话内）。服务端仍要求每次建会话带
  //    media_consent —— 那是接口层的强制，这里是界面层的知情，两者不互相冒充。
  if (hasConsent()) {
    await action();
    return;
  }
  pendingAction = action;
  consentOpen.value = true;
}
function grantConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* 私密模式写不进去：本次会话仍能继续 */
  }
  consentOpen.value = false;
  const action = pendingAction;
  pendingAction = null;
  void action?.();
}
function denyConsent(): void {
  consentOpen.value = false;
  pendingAction = null;
  errorText.value = '没关系的，不上传材料也能提交。';
}

// ---------------------------------------------------------------- 拍照 / 视频
function pickWithCapture(kind: 'image' | 'video'): void {
  const input = document.createElement('input');
  input.type = 'file';
  // 🔴 capture=environment 让手机浏览器**直接调起相机/录像**，而不是文件管理器。
  input.accept = kind === 'image' ? 'image/*' : 'video/*';
  input.setAttribute('capture', 'environment');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.addEventListener(
    'change',
    async () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return;
      await addCaptured(file, kind);
    },
    { once: true },
  );
  input.click();
}
function takePhoto(): void {
  void withConsent(async () => pickWithCapture('image'));
}
function takeVideo(): void {
  void withConsent(async () => pickWithCapture('video'));
}

// ---------------------------------------------------------------- 录音（真录音）
const recording = ref(false);
const recordClock = ref('00:00');
let mediaRecorder: MediaRecorder | null = null;
let recordStream: MediaStream | null = null;
let recordChunks: BlobPart[] = [];
let recordStartedAt = 0;
let recordTimer: number | null = null;

const inWeChat = /MicroMessenger/i.test(navigator.userAgent || '');
const canRecord = computed(
  () =>
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined',
);

/**
 * 录音按钮的统一入口（用户 C 项：首次使用媒体都要过一次授权）。
 * ⚠️ 停止录音**不**再弹授权 —— 那是同一个录音过程的延续，不是"新的使用"。
 */
async function onRecordClick(): Promise<void> {
  if (recording.value) {
    await stopRecording();
    return;
  }
  await withConsent(() => startRecording());
}

async function startRecording(): Promise<void> {
  errorText.value = '';
  if (!canRecord.value) {
    // ⚠️ 不虚构能力：微信内或老浏览器上 MediaRecorder 不可用时，如实说明并给替代路径
    errorText.value = inWeChat
      ? '当前微信版本不支持网页录音，可用文字或照片，也可以从相册选择'
      : '当前浏览器不支持录音，可用文字或照片';
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err: any) {
    // 权限被拒：友好提示，**不让整个表单无法提交**
    errorText.value =
      err?.name === 'NotAllowedError' ? '无法使用麦克风，可改用文字或照片' : '麦克风打开失败，可改用文字或照片';
    return;
  }
  try {
    // 容器选择**跟随浏览器真实产出**：Chrome/Android 出 webm；iOS Safari 出 mp4。
    // ⚠️ 不写死一种 mime —— 写死会让部分机型拿到空录制结果。
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    mediaRecorder = mimeType ? new MediaRecorder(recordStream, { mimeType }) : new MediaRecorder(recordStream);
    recordChunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordChunks.push(e.data);
    };
    mediaRecorder.start();
    recording.value = true;
    recordStartedAt = Date.now();
    recordClock.value = '00:00';
    recordTimer = window.setInterval(() => {
      const elapsed = Date.now() - recordStartedAt;
      recordClock.value = fmtDuration(elapsed);
      // 最长 60 秒到时**自动停止**
      if (elapsed >= limits.value.audio_max_ms) void stopRecording(true);
    }, 250);
  } catch {
    errorText.value = '录音启动失败，可改用文字或照片';
    releaseRecordStream();
    mediaRecorder = null;
    recording.value = false;
  }
}

async function stopRecording(auto = false): Promise<void> {
  if (!mediaRecorder) return;
  const elapsed = Date.now() - recordStartedAt;
  const mime = mediaRecorder.mimeType || 'audio/webm';
  await new Promise<void>((resolve) => {
    mediaRecorder!.onstop = () => resolve();
    try {
      mediaRecorder!.stop();
    } catch {
      resolve();
    }
  });
  const blob = new Blob(recordChunks, { type: mime });
  clearTimers();
  recording.value = false;
  mediaRecorder = null;
  releaseRecordStream();
  if (!auto && elapsed < 800) {
    errorText.value = '录音太短了，再录一次吧';
    return;
  }
  const file = new File([blob], `recording-${Date.now()}.${extOf(mime)}`, { type: mime });
  await addCaptured(file, 'audio', elapsed);
}

function releaseRecordStream(): void {
  recordStream?.getTracks().forEach((t) => t.stop());
  recordStream = null;
  recordChunks = [];
}
function clearTimers(): void {
  if (recordTimer !== null) window.clearInterval(recordTimer);
  recordTimer = null;
}
function extOf(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

// ---------------------------------------------------------------- 相册（次级）
async function onPickFromAlbum(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const kind: 'image' | 'audio' | 'video' = file.type.startsWith('video/')
    ? 'video'
    : file.type.startsWith('audio/')
      ? 'audio'
      : 'image';
  await withConsent(() => addCaptured(file, kind));
}

// ---------------------------------------------------------------- 客户端时长核验
/**
 * 视频/录音的**客户端**时长核验（服务端仍会再核一次）。
 *
 * 为什么双核：原生录像无法保证 30 秒自动停，若只在服务端拒，客户已经拍完一整段
 * 才知道要重拍 ⇒ 白拍。客户端先读一次 metadata，能立刻提示"太长了，重新录"。
 * ⚠️ 客户端判定**不能替代**服务端（用户 E/F 项），服务端永远是最终边界。
 */
async function probeDurationMs(file: File, kind: 'audio' | 'video'): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const el = document.createElement(kind);
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        const d = el.duration;
        resolve(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null);
      };
      el.onerror = () => resolve(null);
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- 入库
async function addCaptured(file: File, kind: Item['kind'], knownDurationMs?: number): Promise<void> {
  errorText.value = '';

  if (file.size === 0) {
    errorText.value = '文件是空的，请重新操作';
    return;
  }
  if (file.size > limits.value.max_file_bytes) {
    errorText.value = `单个文件不能超过 ${Math.floor(limits.value.max_file_bytes / 1024 / 1024)}MB`;
    return;
  }

  const durationMs = knownDurationMs ?? (kind === 'image' ? null : await probeDurationMs(file, kind));
  if (kind === 'audio' && durationMs !== null && durationMs > limits.value.audio_max_ms) {
    errorText.value = '录音最长 60 秒，请重新录制';
    return;
  }
  if (kind === 'video' && durationMs !== null && durationMs > limits.value.video_max_ms) {
    errorText.value = '视频最长 30 秒，请重新录制';
    return;
  }

  const item: Item = {
    key: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    name: file.name || (kind === 'image' ? '照片' : kind === 'audio' ? '录音' : '视频'),
    file,
    state: 'pending',
    durationText: durationMs ? fmtDuration(durationMs) : kind === 'image' ? '' : '—',
    // ⚠️ 音频**也要** blob URL：没有它就没有 <audio> 播放器，客户无法试听
    //    （第一版只给图片/视频生成了，录音只能录完看不到也听不了）。
    previewUrl: URL.createObjectURL(file),
  };
  items.value.push(item);
  await uploadItem(item);
}

async function uploadItem(item: Item): Promise<void> {
  uploading.value = true;
  item.state = 'uploading';
  progress.value = 0;
  try {
    if (!session) {
      const created = await createMediaSession();
      session = { id: created.session_id, token: created.session_token };
      limits.value = created.limits ?? limits.value;
      emit('update:modelValue', session);
    }
    const { promise } = uploadMedia(session.token, item.file, item.name, (p) => {
      progress.value = p;
    });
    const saved: UploadedMedia = await promise;
    item.state = 'done';
    item.mediaId = saved.id;
    if (saved.duration_ms) item.durationText = fmtDuration(saved.duration_ms);
    // 🔴 每次上传成功都**再同步一次会话**（幂等）。
    //    真机上出现过"材料显示已就绪、提交时却没带上 media_session"的不一致
    //    （计数走 `change`、会话走 `update:modelValue`，两条通道各自可能不同步）
    //    ⇒ 提交时服务端按"纯文字"校验，客户看到"请填 5–500 字"却明明传了材料。
    //    这里补一次同步；父组件提交前还会做一次显式校验（见 Report/index.vue）。
    emit('update:modelValue', session);
    emit('change', doneCount.value);
  } catch (error: unknown) {
    item.state = 'failed';
    const e = error instanceof ApiError ? error : null;
    // ⚠️ 非 ApiError 的异常也要能被看见（第一版只写兜底文案，
    // 结果浏览器验收只看到"上传失败"，既不知道是类型、限额还是代码抛错）。
    // 🔴 文案分两层（用户要求："技术 code 只用于诊断，不能成为客户需要理解的主要文案"）：
    //    ① **界面上**只出现可操作的中文；
    //    ② code 走 `data-code` 属性 + console（自动化与排障可读，客户不用看）。
    const ACTIONS: Record<string, string> = {
      AUDIO_TOO_LONG: '录音最长 60 秒，请重新录制',
      VIDEO_TOO_LONG: '视频最长 30 秒，请重新录制',
      SESSION_UNAVAILABLE: '上传已超时，请重新选择这个文件',
      RATE_LIMITED: '操作太频繁，请稍等一会儿再试',
      NETWORK_ERROR: '网络不太稳定，请点「重试」',
      NETWORK_TIMEOUT: '上传超时了，请点「重试」',
      UNSUPPORTED_MEDIA: '这个文件格式不支持，请用手机直接拍照或录音',
      MEDIA_CONSENT_REQUIRED: '请先确认使用相机和麦克风',
      FILE_TOO_LARGE: '文件太大了，请拍短一点或选小一点的',
      KIND_UNREADABLE: '这个文件读不出时长，请重新录制',
      DURATION_UNREADABLE: '这个文件读不出时长，请重新录制',
      IMAGE_COUNT_LIMIT: '照片最多 3 张，请先删掉一张',
      SESSION_ITEM_LIMIT: '材料最多 5 个，请先删掉一个',
    };
    item.errorCode = e?.code ?? null;
    item.error =
      (e?.code ? ACTIONS[e.code] : null) ??
      (e ? '上传没成功，请点「重试」' : '上传失败，请重新选择');
    if (e?.code) console.warn(`[media] 上传失败 code=${e.code} status=${e.status ?? '?'}`);
    if (!e) {
      const raw = String((error as Error)?.message ?? error).slice(0, 80);
      item.error = '上传失败（' + raw + '）';
    }
    errorText.value = item.error;
    if (e?.code === 'SESSION_UNAVAILABLE') {
      session = null;
      emit('update:modelValue', null);
    }
  } finally {
    uploading.value = false;
    progress.value = 0;
  }
}

function remove(item: Item): void {
  const idx = items.value.findIndex((x) => x.key === item.key);
  if (idx >= 0) items.value.splice(idx, 1);
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  emit('change', doneCount.value);
}
function preview(item: Item): void {
  if (item.previewUrl) window.open(item.previewUrl, '_blank', 'noopener');
}

onBeforeUnmount(() => {
  clearTimers();
  releaseRecordStream();
  for (const it of items.value) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
});

defineExpose({
  doneCount: () => doneCount.value,
  /** 当前媒体会话（提交前由父组件核对：有成功材料就必须有会话） */
  currentSession: () => session,
  /** 是否有"上传中"的材料（提交前应等它落地） */
  hasPending: () => items.value.some((i) => i.state === 'uploading'),
});
</script>

<style scoped>
.svc-desc {
  margin-bottom: 4px;
}
.svc-hint-right {
  justify-content: flex-end;
}
/* 三个入口：同级、同排、同样醒目 —— 它们不是"附件任务"，是表达方式 */
.svc-capture {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.svc-capture-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 4px;
  border: 1px solid var(--svc-primary, #d4380d);
  border-radius: 12px;
  background: #fff;
  color: var(--svc-primary, #d4380d);
  font-size: 14px;
  line-height: 1.2;
}
.svc-capture-btn:disabled {
  opacity: 0.45;
  border-color: #d1d5db;
  color: #9ca3af;
}
.svc-capture-btn.is-recording {
  background: var(--svc-primary, #d4380d);
  color: #fff;
}
.svc-capture-ico {
  font-size: 20px;
}
.svc-capture-txt {
  font-weight: 600;
}
.svc-capture-limit,
.svc-capture-timer {
  font-size: 11px;
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
/* 次级能力：相册 —— 低视觉权重 */
.svc-secondary {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.svc-secondary-btn {
  position: relative;
  overflow: hidden;
  font-size: 12.5px;
  color: var(--svc-text-weak, #6b7280);
  text-decoration: underline;
}
.svc-secondary-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
}
/* 材料就地显示 */
.svc-mats {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.svc-mat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}
.svc-mat-thumb {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  object-fit: cover;
  flex: none;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: #f3f4f6;
}
.svc-mat-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.svc-mat-glyph {
  width: 44px;
  text-align: center;
  font-size: 20px;
  flex: none;
}
.svc-mat-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.svc-mat-title {
  font-size: 13px;
}
.svc-mat-state {
  font-size: 11.5px;
  color: var(--svc-text-weak, #6b7280);
}
.svc-mat-state.is-failed {
  color: #b42318;
}
.svc-mat-state.is-done {
  color: #067647;
}
.svc-mat-audio {
  height: 32px;
  max-width: 170px;
}
.svc-mat-act {
  border: none;
  background: none;
  color: var(--svc-primary, #d4380d);
  font-size: 12.5px;
  padding: 4px 2px;
  flex: none;
}
.svc-privacy-line {
  margin: 10px 0 0;
}
.svc-up {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
}
.svc-up-bar {
  flex: 1;
  height: 5px;
  background: #e5e7eb;
  border-radius: 999px;
  overflow: hidden;
}
.svc-up-bar i {
  display: block;
  height: 100%;
  background: var(--svc-primary, #d4380d);
  transition: width 0.15s linear;
}
/* 一次性授权弹层 */
.svc-modal {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.45);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 50;
}
.svc-modal-card {
  background: #fff;
  border-radius: 14px;
  padding: 18px 16px;
  max-width: 320px;
  width: 100%;
}
.svc-modal-card h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.svc-modal-card p {
  margin: 0 0 6px;
  font-size: 13.5px;
  line-height: 1.6;
}
.svc-modal-actions {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.svc-modal-cancel {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 10px 0;
  font-size: 14px;
  color: #6b7280;
}
</style>