<template>
  <!--
    客户媒体上传区（P11-4 · B 条）。

    设计约束（用户 2026-10-13 冻结契约）：
      · 图片 1~3 张 · 语音 ≤60s · 视频 ≤30s · 文字或媒体至少一种 · 地址仍选填；
      · **不给客户增加无关必填字段** —— 这一整块是选填增强；
      · 客户端进度条**不代替**服务端确认：以服务端响应为准；
      · 断网/重试不产生重复关联（服务端按内容哈希幂等，这里只做"重试同一个文件"）。
  -->
  <div class="svc-media" data-testid="media-uploader">
    <div class="svc-media-head">
      <span class="svc-label">添加照片 / 语音 / 视频<span class="svc-opt">（选填）</span></span>
    </div>

    <!-- 明示媒体授权：不能吃"提交即同意"那份依据（服务端强制 media_consent） -->
    <p class="svc-media-consent">
      上传媒体即表示同意门店为处理本次售后查看这些材料。
      <span class="svc-hint">请勿上传包含他人隐私的画面。</span>
    </p>

    <!-- 已选文件 -->
    <ul v-if="items.length" class="svc-media-list">
      <li v-for="it in items" :key="it.key" class="svc-media-item" :data-testid="'media-item-' + it.kind">
        <img v-if="it.kind === 'image' && it.previewUrl" :src="it.previewUrl" alt="已选照片预览" class="svc-media-thumb" />
        <span v-else class="svc-media-glyph" aria-hidden="true">{{ it.kind === 'audio' ? '🎤' : '🎬' }}</span>
        <span class="svc-media-meta">
          <span class="svc-media-name">{{ it.label }}</span>
          <span class="svc-media-state" :class="'is-' + it.state">
            {{ stateText(it) }}
          </span>
        </span>
        <button type="button" class="svc-media-remove" :aria-label="'移除 ' + it.label" @click="remove(it)">×</button>
      </li>
    </ul>

    <!-- 上传中进度（只表示"正在传"） -->
    <div v-if="uploading" class="svc-media-progress" data-testid="media-progress">
      <div class="svc-media-bar"><i :style="{ width: progress + '%' }"></i></div>
      <span>{{ progress }}%</span>
    </div>

    <p v-if="mediaError" class="svc-error" data-testid="media-error">{{ mediaError }}</p>

    <div class="svc-media-actions">
      <label class="svc-media-btn">
        图片
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          :disabled="uploading || !canAddImage"
          data-testid="media-pick-image"
          @change="onPick($event, 'image')"
        />
      </label>
      <label class="svc-media-btn">
        语音
        <input
          type="file"
          accept="audio/webm,audio/mp4,audio/ogg,audio/wav"
          :disabled="uploading || !canAddAny"
          data-testid="media-pick-audio"
          @change="onPick($event, 'audio')"
        />
      </label>
      <label class="svc-media-btn">
        视频
        <input
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          :disabled="uploading || !canAddAny"
          data-testid="media-pick-video"
          @change="onPick($event, 'video')"
        />
      </label>
    </div>

    <p class="svc-hint">
      图片最多 {{ limits.image_max_count }} 张，语音最长 {{ limits.audio_max_ms / 1000 }} 秒，视频最长
      {{ limits.video_max_ms / 1000 }} 秒。上传中断可重新选择同一文件，不会重复计入。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 上传组件的三个关键决定：
 *
 * ① **会话按需创建**：客户第一次选文件时才建会话。不选文件就不建 ——
 *    那样库里不会留下"从没被使用的会话"（未完成上传清理的入口就那么大）。
 * ② **token 只在内存**：不写 localStorage（见 api/media.ts 头部注释）。
 * ③ **重复选择同一文件 ⇒ 服务端幂等**：这里不做"这个文件传过了"的判断，
 *    那是服务端按内容哈希的职责；前端再判一份就会有两条腿。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { ApiError } from '../api/http';
import {
  createMediaSession,
  uploadMedia,
  type MediaLimits,
  type UploadedMedia,
} from '../api/media';

const props = defineProps<{ modelValue: { id: number; token: string } | null }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: { id: number; token: string } | null): void;
  (e: 'change', count: number): void;
}>();

const limits = ref<MediaLimits>({
  max_file_bytes: 8 * 1024 * 1024,
  max_items: 5,
  image_max_count: 3,
  audio_max_ms: 60_000,
  video_max_ms: 30_000,
});

interface Item {
  key: string;
  kind: 'image' | 'audio' | 'video';
  label: string;
  file: File;
  state: 'pending' | 'uploading' | 'done' | 'failed';
  error?: string;
  previewUrl?: string;
  mediaId?: number;
  reused?: boolean;
}

const items = ref<Item[]>([]);
const uploading = ref(false);
const progress = ref(0);
const mediaError = ref('');
let session: { id: number; token: string } | null = props.modelValue ?? null;

const imageCount = computed(() => items.value.filter((i) => i.kind === 'image').length);
const canAddImage = computed(() => imageCount.value < limits.value.image_max_count && items.value.length < limits.value.max_items);
const canAddAny = computed(() => items.value.length < limits.value.max_items);

function stateText(it: Item): string {
  if (it.state === 'pending') return '待上传';
  if (it.state === 'uploading') return '正在上传…';
  if (it.state === 'failed') return it.error ?? '上传失败，请重试';
  return it.reused ? '已上传（服务端已收过同一份）' : '已上传';
}

function remove(it: Item): void {
  const idx = items.value.findIndex((x) => x.key === it.key);
  if (idx >= 0) items.value.splice(idx, 1);
  if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  if (items.value.length === 0) {
    session = null;
    emit('update:modelValue', null);
  }
  emit('change', items.value.filter((i) => i.state === 'done').length);
}

const EXT_BY_KIND: Record<Item['kind'], string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  audio: ['webm', 'm4a', 'mp4', 'ogg', 'wav'],
  video: ['mp4', 'webp', 'mov'],
};

/**
 * 客户端**形态**预检（大小 + 扩展名粗筛）。
 *
 * ⚠️ 扩展名这一层**只是体验**：让客户刚选错文件时就看到提示，
 *    而不是等整个文件传完才被服务端 415 拒。**真正的类型判定永远在服务端
 *    magic bytes**（见 api/media.ts 头部）—— 前端判断不是安全边界，
 *    把 .exe 改名成 .jpg 仍然会被服务端拒。
 */
function precheck(file: File, kind: Item['kind']): string | null {
  if (file.size === 0) return '文件是空的';
  if (file.size > limits.value.max_file_bytes) {
    return `单个文件不能超过 ${Math.floor(limits.value.max_file_bytes / 1024 / 1024)}MB`;
  }
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const label = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '视频';
  if (ext && !EXT_BY_KIND[kind].includes(ext)) {
    return `这个文件看起来不是${label}（${ext.toUpperCase()}），请重新选择`;
  }
  return null;
}

async function onPick(event: Event, kind: Item['kind']): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  mediaError.value = '';

  const problem = precheck(file, kind);
  if (problem) {
    mediaError.value = problem;
    return;
  }

  const item: Item = {
    key: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label: file.name || (kind === 'image' ? '照片' : kind === 'audio' ? '语音' : '视频'),
    file,
    state: 'pending',
  };
  if (kind === 'image') item.previewUrl = URL.createObjectURL(file);
  items.value.push(item);

  try {
    uploading.value = true;
    progress.value = 0;

    // ⓵ 会话按需创建（只在第一次需要时）
    if (!session) {
      const created = await createMediaSession();
      session = { id: created.session_id, token: created.session_token };
      limits.value = created.limits ?? limits.value;
      emit('update:modelValue', session);
    }

    // ⓶ 上传（进度条只表示"正在传"）
    item.state = 'uploading';
    const { promise } = uploadMedia(session.token, file, item.label, (p) => {
      progress.value = p;
    });
    const saved: UploadedMedia = await promise;
    item.state = 'done';
    item.mediaId = saved.id;
    item.reused = saved.reused;
    emit('change', items.value.filter((i) => i.state === 'done').length);
  } catch (error: any) {
    item.state = 'failed';
    const apiErr = error instanceof ApiError ? error : null;
    // 429 是限流、409 是会话失效/超量、415 是格式 —— 都如实翻译成客户能懂的一句话
    item.error =
      apiErr?.code === 'SESSION_UNAVAILABLE'
        ? '上传会话已失效，请刷新页面重新选择'
        : apiErr?.code === 'RATE_LIMITED'
          ? '上传太频繁，请稍候再试'
          : apiErr?.code === 'NETWORK_ERROR'
            ? '网络中断了，请重新选择这个文件再试'
            : (apiErr?.message ?? '上传失败，请重试');
    mediaError.value = item.error;
    // 会话失效时把内存里的 session 也丢掉，下一次选择会重建
    if (apiErr?.code === 'SESSION_UNAVAILABLE') {
      session = null;
      emit('update:modelValue', null);
    }
  } finally {
    uploading.value = false;
    progress.value = 0;
  }
}

onBeforeUnmount(() => {
  for (const it of items.value) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
});

defineExpose({
  /** 已成功上传的数量（提交前由页面判断"文字或媒体至少一种"） */
  doneCount: () => items.value.filter((i) => i.state === 'done').length,
});
</script>

<style scoped>
.svc-media {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--svc-border, #e5e7eb);
}
.svc-media-head {
  margin-bottom: 6px;
}
.svc-media-consent {
  font-size: 12px;
  color: var(--svc-muted, #6b7280);
  margin: 0 0 8px;
}
.svc-media-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.svc-media-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--svc-border, #e5e7eb);
  border-radius: 10px;
}
.svc-media-thumb {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: 8px;
}
.svc-media-glyph {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  font-size: 20px;
  background: #f3f4f6;
  border-radius: 8px;
}
.svc-media-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.svc-media-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc-media-state {
  font-size: 12px;
  color: var(--svc-muted, #6b7280);
}
.svc-media-state.is-failed {
  color: #b42318;
}
.svc-media-remove {
  border: none;
  background: none;
  font-size: 18px;
  color: #9ca3af;
  padding: 4px 8px;
}
.svc-media-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 8px;
}
.svc-media-bar {
  flex: 1;
  height: 6px;
  background: #e5e7eb;
  border-radius: 999px;
  overflow: hidden;
}
.svc-media-bar i {
  display: block;
  height: 100%;
  background: var(--svc-primary, #d4380d);
  transition: width 0.15s linear;
}
.svc-media-actions {
  display: flex;
  gap: 8px;
}
.svc-media-btn {
  flex: 1;
  text-align: center;
  padding: 9px 0;
  border: 1px solid var(--svc-primary, #d4380d);
  color: var(--svc-primary, #d4380d);
  border-radius: 10px;
  font-size: 13px;
  position: relative;
  overflow: hidden;
}
.svc-media-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
}
</style>
