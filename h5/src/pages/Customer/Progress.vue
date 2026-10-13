<template>
  <!--
    客户服务进度查询页（P11-4 · C 条）。

    ⚠️ 这一页**没有任何需要客户填写的东西** —— 打开即看。
       Token 在 URL 上，服务端校验范围/有效期/撤销；页面只负责展示。
  -->
  <div class="svc-page svc-progress">
    <header class="svc-header">
      <h1>服务进度</h1>
    </header>

    <div v-if="state === 'loading'" class="svc-card" data-testid="progress-loading">
      <p class="svc-hint">正在查询…</p>
    </div>

    <div v-else-if="state === 'error'" class="svc-card" data-testid="progress-error">
      <p class="svc-error" data-testid="progress-error-message">{{ errorText }}</p>
      <p class="svc-hint">请从提交成功页的「查看处理进度」进入，或联系门店协助。</p>
    </div>

    <template v-else-if="view">
      <!-- 单号 + 当前状态 -->
      <div class="svc-card svc-progress-hero">
        <span class="svc-k">工单号</span>
        <strong class="svc-v" data-testid="progress-ticket-no">{{ view.ticket_no }}</strong>
        <span class="svc-progress-status" :data-testid="'progress-status-' + view.status">{{ view.status_label }}</span>
      </div>

      <div class="svc-card">
        <dl class="svc-progress-meta">
          <dt>服务门店</dt>
          <dd>{{ view.store_name }}</dd>
          <dt>提交时间</dt>
          <dd>{{ fmt(view.created_at) }}</dd>
          <dt v-if="view.submitted.appliance_category || view.submitted.brand_model">家电</dt>
          <dd v-if="view.submitted.appliance_category || view.submitted.brand_model">
            {{ [view.submitted.appliance_category, view.submitted.brand_model].filter(Boolean).join(' · ') }}
          </dd>
          <dt v-if="view.submitted.service_address">服务地址</dt>
          <dd v-if="view.submitted.service_address">{{ view.submitted.service_address }}</dd>
        </dl>
      </div>

      <!-- 我提交的说明与媒体 -->
      <div class="svc-card">
        <span class="svc-k">我提交的说明</span>
        <p class="svc-progress-content">{{ view.submitted.content || '（未填写文字）' }}</p>
        <div v-if="view.media.length" class="svc-progress-media" data-testid="progress-media">
          <span class="svc-k">我上传的材料（{{ view.media.length }}）</span>
          <div class="svc-progress-media-row">
            <button
              v-for="m in view.media"
              :key="m.id"
              type="button"
              class="svc-progress-media-btn"
              :data-testid="'progress-media-' + m.kind"
              @click="openMedia(m)"
            >
              {{ m.kind === 'image' ? '图片' : m.kind === 'audio' ? '语音' : '视频' }}
              <span class="svc-hint">{{ m.duration_ms ? Math.round(m.duration_ms / 1000) + 's' : sizeText(m.size) }}</span>
            </button>
          </div>
          <p v-if="mediaHint" class="svc-hint">{{ mediaHint }}</p>
        </div>
      </div>

      <!-- 处理时间线（只有状态与时间；门店给客户的完成说明单独一块） -->
      <div class="svc-card">
        <span class="svc-k">处理进度</span>
        <ol class="svc-progress-timeline" data-testid="progress-timeline">
          <li v-for="(t, i) in view.timeline" :key="i">
            <span class="svc-progress-dot" :class="{ 'is-last': i === view.timeline.length - 1 }"></span>
            <span class="svc-progress-t">{{ t.status_label }}</span>
            <span class="svc-progress-at">{{ fmt(t.at) }}</span>
          </li>
        </ol>
        <p v-if="view.completion_note" class="svc-progress-note" data-testid="progress-completion-note">
          门店说明：{{ view.completion_note }}
        </p>
      </div>

      <p class="svc-hint svc-progress-expiry" data-testid="progress-expiry">
        {{ expiryText }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 进度页的三个安全决定：
 *
 * ① **不在页面缓存任何数据**：每次进入都重新查询。客户可能把链接分享给家人，
 *    而"当前进度"必须是实时的；本地缓存会让第二次打开看到旧状态。
 * ② **Token 不进日志/不上报**：本文件刻意不打印 URL。
 * ③ 媒体预览走**带凭证头的 fetch**（不是 <img src="/api/...">）——
 *    凭证只在请求头里出现一次，不落在地址栏、历史记录或 Referer 里。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from '../../router';
import { ApiError } from '../../api/http';
import { fetchMediaBlob, fetchProgress, type ProgressMedia, type ProgressView } from '../../api/media';

const route = useRoute();
const token = String(route.value.params.token ?? '');

const state = ref<'loading' | 'ok' | 'error'>('loading');
const errorText = ref('');
const view = ref<ProgressView | null>(null);
const mediaHint = ref('');
let objectUrl: string | null = null;

const expiryText = computed(() => {
  if (!view.value) return '';
  if (!view.value.closed) return '本单尚未关闭，关闭后 30 天内仍可查询。';
  if (!view.value.queryable_until) return '本单已关闭。';
  return `本单已关闭，查询入口保留至 ${fmt(view.value.queryable_until)}。`;
});

function fmt(raw: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function openMedia(m: ProgressMedia): Promise<void> {
  mediaHint.value = '';
  try {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = await fetchMediaBlob(m.id, { progressToken: token });
    window.open(objectUrl, '_blank', 'noopener');
  } catch (error: any) {
    mediaHint.value =
      error instanceof ApiError && error.status === 401
        ? '查询链接已失效，这个材料暂时看不了'
        : '这个材料暂时看不了，请稍后再试';
  }
}

onMounted(async () => {
  try {
    view.value = await fetchProgress(token);
    state.value = 'ok';
  } catch (error: any) {
    state.value = 'error';
    errorText.value =
      error instanceof ApiError
        ? error.status === 401
          ? '这个查询链接无效、已过期或已被撤销'
          : error.message
        : '查询失败，请稍后再试';
  }
});
</script>

<style scoped>
.svc-progress-hero {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.svc-k {
  font-size: 12px;
  color: var(--svc-text-weak);
}
.svc-v {
  font-size: 18px;
  letter-spacing: 0.02em;
}
.svc-progress-status {
  margin-top: 4px;
  display: inline-block;
  padding: 3px 12px;
  border-radius: 999px;
  background: #fff2e8;
  color: var(--svc-primary, #d4380d);
  font-size: 13px;
}
.svc-progress-meta {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 13.5px;
}
.svc-progress-meta dt {
  color: var(--svc-text-weak);
}
.svc-progress-meta dd {
  margin: 0;
}
.svc-progress-content {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.svc-progress-media-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.svc-progress-media-btn {
  border: 1px solid var(--svc-border, #e5e7eb);
  background: #fff;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.svc-progress-timeline {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.svc-progress-timeline li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  font-size: 13.5px;
}
.svc-progress-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d1d5db;
  flex: none;
}
.svc-progress-dot.is-last {
  background: var(--svc-primary, #d4380d);
}
.svc-progress-at {
  margin-left: auto;
  font-size: 12px;
  color: var(--svc-text-weak);
}
.svc-progress-note {
  margin: 10px 0 0;
  padding: 8px 10px;
  background: #f6ffed;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.svc-progress-expiry {
  text-align: center;
}
</style>
