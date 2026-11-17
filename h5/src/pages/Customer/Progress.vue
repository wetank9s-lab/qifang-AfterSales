<template>
  <!--
    客户服务进度页（R1 结构性整改 · 2026-11-14）

    ===========================================================================
    信息顺序（用户裁决，不得随便调整）
    ===========================================================================
      ① 当前状态与下一步提示
      ② 办理进度（**唯一**一套）
      ③ 我提交的说明与附件
      ④ 上门师傅
      ⑤ 服务门店
      ⑥ 评价入口（按实际状态出现）
      ⑦ 次级操作（提交新工单 / 清除本机记录）—— 不抢主视觉

    ===========================================================================
    本轮删掉的三块（用户点名"删除重复"）
    ===========================================================================
      · 「服务时间」整卡 —— 六项时间与②里的节点时间**是同一批事实**，
        并列展示会让客户数两遍、且两处口径稍有出入就成了"页面自相矛盾"。
        ⇒ 时间并入②的每个节点行，原始时间与事件数据仍在库里、也仍下发。
      · 「处理进度」时间线 —— 它把 sms_sent 这类**内部事件**混进客户视野。
      · 「这不是我的工单／清除记录」醒目按钮 —— 降级为底部次级操作。
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
      <!-- ① 当前状态与下一步 ---------------- -->
      <section class="svc-card svc-hero" data-testid="progress-hero">
        <div class="svc-hero-head">
          <span
            class="svc-badge"
            :class="{ 'is-cancelled': view.progress?.stage === 'cancelled' }"
            :data-stage="view.progress?.stage || view.status"
            data-testid="progress-stage-label"
          >{{ view.progress?.stage_label || view.status_label }}</span>
          <span class="svc-hero-no" data-testid="progress-ticket-no">{{ view.ticket_no }}</span>
        </div>
        <p v-if="view.progress" class="svc-hero-text" data-testid="progress-status-text">
          {{ view.progress.status_text }}
        </p>
        <p
          v-if="view.progress"
          class="svc-hero-next"
          :data-owner="view.progress.next_action.owner"
          data-testid="progress-next-action"
        >
          {{ view.progress.next_action.text }}
        </p>
      </section>

      <!-- ② 办理进度（唯一一套） ---------------- -->
      <section v-if="view.progress" class="svc-card" data-testid="progress-block">
        <h2 class="svc-card-title">办理进度</h2>
        <ol class="svc-steps" data-testid="progress-steps">
          <li
            v-for="s in view.progress.steps"
            :key="s.key"
            class="svc-step"
            :class="'is-' + s.state"
            :data-testid="'progress-step-' + s.key"
            :data-state="s.state"
          >
            <span class="svc-step-dot" aria-hidden="true"></span>
            <span class="svc-step-label">{{ s.label }}</span>
          </li>
        </ol>

        <ul v-if="stepsWithTime.length" class="svc-step-times" data-testid="progress-step-times">
          <li v-for="s in stepsWithTime" :key="s.key">
            <span>{{ s.label }}</span>
            <time :data-testid="'progress-step-at-' + s.key">{{ fmt(s.at as string) }}</time>
          </li>
        </ul>

        <p v-if="view.progress.times?.expected_visit_at" class="svc-hint" data-testid="progress-expected">
          预约上门：{{ expectedText }}（具体时间以师傅联系为准）
        </p>
      </section>

      <!-- ③ 我提交的说明与附件 ---------------- -->
      <section class="svc-card" data-testid="progress-submitted">
        <h2 class="svc-card-title">我提交的说明</h2>
        <p class="svc-progress-content">{{ view.submitted.content || '没有填写文字说明' }}</p>

        <div v-if="view.media.length" class="svc-media" data-testid="progress-media">
          <h3 class="svc-card-sub">附件（{{ view.media.length }}）</h3>

          <!-- 图片：直接出缩略图，点击放大 -->
          <div v-if="imageMedia.length" class="svc-thumbs">
            <button
              v-for="m in imageMedia"
              :key="m.id"
              type="button"
              class="svc-thumb"
              :data-testid="'progress-media-image-' + m.id"
              @click="openViewer(m)"
            >
              <img v-if="mediaUrls[m.id]" :src="mediaUrls[m.id]" alt="我上传的图片" loading="lazy" />
              <span v-else class="svc-thumb-ph">{{ mediaFailed[m.id] ? '加载失败' : '加载中' }}</span>
            </button>
          </div>

          <!-- 视频：内嵌播放器，封面用首帧 -->
          <!-- 视频：默认只占一张紧凑封面（R2），点击后才换成播放器 -->
          <div v-for="m in videoMedia" :key="m.id" class="svc-video" :data-testid="'progress-media-video-' + m.id">
            <template v-if="mediaUrls[m.id]">
              <button
                v-if="playingVideoId !== m.id"
                type="button"
                class="svc-video-cover"
                :data-testid="'progress-video-cover-' + m.id"
                @click="playVideo(m.id)"
              >
                <img v-if="videoPosters[m.id]" :src="videoPosters[m.id]" alt="视频封面" />
                <span class="svc-video-play" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
                </span>
                <span class="svc-video-badge">视频{{ durationText(m.duration_ms) }}</span>
              </button>
              <video
                v-else
                :src="mediaUrls[m.id]"
                controls
                autoplay
                playsinline
                preload="metadata"
              ></video>
            </template>
            <p v-else class="svc-hint">{{ mediaFailed[m.id] ? '视频加载失败' : '视频加载中…' }}</p>
          </div>

          <!-- 音频：原生播放控件 -->
          <div v-for="m in audioMedia" :key="m.id" class="svc-audio" :data-testid="'progress-media-audio-' + m.id">
            <audio v-if="mediaUrls[m.id]" :src="mediaUrls[m.id]" controls preload="metadata"></audio>
            <p v-else class="svc-hint">{{ mediaFailed[m.id] ? '语音加载失败' : '语音加载中…' }}</p>
          </div>

          <p v-if="mediaHint" class="svc-hint">{{ mediaHint }}</p>
        </div>
      </section>

      <!-- ④ 上门师傅 ---------------- -->
      <section v-if="tech" class="svc-card" data-testid="progress-tech">
        <h2 class="svc-card-title">{{ techTitle }}</h2>
        <div class="svc-info">
          <span class="svc-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <circle cx="12" cy="8" r="3.6" />
              <path d="M4.5 20c0-3.6 3.4-5.6 7.5-5.6s7.5 2 7.5 5.6" stroke-linecap="round" />
            </svg>
          </span>
          <div class="svc-info-main">
            <strong data-testid="progress-tech-name">{{ tech.name || '服务人员' }}</strong>
            <span class="svc-info-sub" data-testid="progress-tech-status">
              {{ tech.status_label }}<template v-if="tech.visit_no > 1"> · 第 {{ tech.visit_no }} 次上门</template>
            </span>
          </div>
        </div>
        <a
          v-if="tech.callable && tech.phone"
          class="svc-info-action"
          :href="'tel:' + tech.phone"
          data-testid="progress-tech-phone"
        >
          <span class="svc-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M6 3.5h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3c0 1-.8 1.8-1.8 1.7C11.6 18.9 5.1 12.4 4.3 5.3 4.2 4.3 5 3.5 6 3.5z" stroke-linejoin="round" />
            </svg>
          </span>
          <span>{{ tech.phone }}</span>
        </a>
        <p v-else class="svc-hint" data-testid="progress-tech-hint">{{ tech.contact_hint || '请联系门店' }}</p>
      </section>

      <!-- ⑤ 服务门店 ---------------- -->
      <section class="svc-card" data-testid="progress-store">
        <h2 class="svc-card-title">服务门店</h2>
        <div class="svc-info">
          <span class="svc-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M4 9.5V20h16V9.5" stroke-linejoin="round" />
              <path d="M3 9.5 5 4h14l2 5.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" stroke-linejoin="round" />
            </svg>
          </span>
          <div class="svc-info-main">
            <strong data-testid="progress-store-name">{{ view.store_name }}</strong>
            <span v-if="storeAddress" class="svc-info-sub" data-testid="progress-store-address">{{ storeAddress }}</span>
          </div>
        </div>
        <a
          v-if="storePhone"
          class="svc-info-action"
          :href="'tel:' + storePhone"
          data-testid="progress-store-phone"
        >
          <span class="svc-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M6 3.5h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3c0 1-.8 1.8-1.8 1.7C11.6 18.9 5.1 12.4 4.3 5.3 4.2 4.3 5 3.5 6 3.5z" stroke-linejoin="round" />
            </svg>
          </span>
          <span>{{ storePhone }}</span>
        </a>
        <!-- 家电/机型仍在这里（它属于"这单服务的是什么"，不属于门店） -->
        <div v-if="applianceLabel || brandModel" class="svc-info-extra">
          <span class="svc-k">服务对象</span>
          <span>{{ [applianceLabel, brandModel].filter(Boolean).join(' · ') }}</span>
        </div>
      </section>

      <!-- ⑥ 评价入口（组件内部按状态自守卫） ---------------- -->
      <ProgressReview
        :token="token"
        :status="String(view.status || '')"
        :review-status="String((view as any).review?.status || '')"
        :rating="(view as any).review?.rating ?? null"
        :comment="(view as any).review_comment ?? null"
        :charge="(view as any).review?.charge ?? null"
        @submitted="reloadAfterReview"
      />

      <!-- ⑦ 次级操作（不抢主视觉） ---------------- -->
      <div class="svc-secondary" data-testid="progress-secondary">
        <a v-if="newTicketHref" class="svc-secondary-link" :href="newTicketHref" data-testid="progress-new-ticket">
          再提交一单
        </a>
        <button type="button" class="svc-secondary-link" data-testid="progress-forget" @click="forgetThis">
          清除本机记录
        </button>
      </div>

      <p class="svc-hint svc-progress-expiry" data-testid="progress-expiry">{{ expiryText }}</p>
    </template>

    <!-- 图片放大：轻量覆盖层（不引第三方库） -->
    <div v-if="viewerUrl" class="svc-viewer" data-testid="progress-viewer" @click="closeViewer">
      <img :src="viewerUrl" alt="查看大图" />
      <button type="button" class="svc-viewer-close" aria-label="关闭" @click.stop="closeViewer">✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 进度页的三个安全决定：
 *
 * ① **不在页面缓存任何数据**：每次进入都重新查询。客户可能把链接分享给家人，
 *    而"当前进度"必须是实时的；本地缓存会让第二次打开看到旧状态。
 * ② **Token 不进日志/不上报**：本文件刻意不打印 URL。
 * ③ 媒体走**带凭证头的 fetch**（不是 <img src="/api/...">）——
 *    凭证只在请求头里出现一次，不落在地址栏、历史记录或 Referer 里。
 *
 * 🔴 R1（2026-11-14）附件直读：
 *    后端原本就有 `/api/public/media/files/:id`，用 `X-Progress-Token` 校验归属。
 *    之前前端只是"点一下新开窗口"，客户看不到内容长什么样。
 *    现在在说明下方直接出缩略图 / 播放器 —— **没有新增任何无鉴权入口**。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from '../../router';
import { ApiError } from '../../api/http';
import { fetchMediaBlob, fetchProgress, type ProgressMedia, type ProgressView } from '../../api/media';
import ProgressReview from './ProgressReview.vue';
// UX-01D M1：进度页无门店入口 ⇒ 一律使用总部已发布主题（D9 决策）
import { ensureUiConfig, setPageTitle } from '../../ui-state';
import { removeLastOrderByToken } from '../../utils/last-order';
import { APPLIANCE_CATEGORY_OPTIONS } from '../../utils/appliance-options';

const route = useRoute();
const token = String(route.value.params.token ?? '');

const state = ref<'loading' | 'ok' | 'error'>('loading');
const errorText = ref('');
const view = ref<ProgressView | null>(null);
const mediaHint = ref('');

/** 媒体 blob URL（id → objectURL），组件卸载时统一回收 */
const mediaUrls = ref<Record<number, string>>({});
/** 加载失败的媒体（避免"永远转圈"看起来像卡住） */
const mediaFailed = ref<Record<number, boolean>>({});
const viewerUrl = ref('');

/** 视频：默认只显示封面（R2）。点击后记录 id，该条才换成播放器 */
const playingVideoId = ref<number | null>(null);
/** 视频封面（首帧截图 dataURL）；取不到就退回纯色 + 播放按钮 */
const videoPosters = ref<Record<number, string>>({});

function playVideo(id: number): void {
  playingVideoId.value = id;
}

/** 时长文案：只在真有值时出现，不编“0 秒” */
function durationText(ms?: number | null): string {
  if (!ms || ms <= 0) return '';
  const sec = Math.round(ms / 1000);
  return sec > 0 ? ' · ' + sec + ' 秒' : '';
}

/**
 * 抓首帧当封面。
 * 只在**已授权的 blob URL** 上做（来源同 fetchMediaBlob），不新增网络请求、不落盘。
 * 失败（编码不支持 / 元数据缺失）就静默返回空 → 界面退回纯色封面，
 * 不让一张封面图影响附件能否播放。
 */
async function capturePoster(url: string): Promise<string> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = url;
    const done = (out: string) => {
      try { v.removeAttribute('src'); v.load(); } catch { /* noop */ }
      resolve(out);
    };
    const timer = setTimeout(() => done(''), 4000);
    v.onloadedmetadata = () => {
      try { v.currentTime = Math.min(0.3, (v.duration || 1) / 2); } catch { done(''); }
    };
    v.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth || 640;
        canvas.height = v.videoHeight || 360;
        canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
        clearTimeout(timer);
        done(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        clearTimeout(timer);
        done('');
      }
    };
    v.onerror = () => { clearTimeout(timer); done(''); };
  });
}

/**
 * 家电类别的中文标签。
 * ⚠️ 未知值**不回退成机器值**（R1 文案要求：不得出现代码枚举）——
 *    宁可整项不显示，也不让客户看到 kitchen_bath。
 */
const applianceLabel = computed(() => {
  const raw = String(view.value?.submitted?.appliance_category ?? '').trim();
  if (!raw) return '';
  const hit = APPLIANCE_CATEGORY_OPTIONS.find((o) => o.value === raw);
  return hit ? hit.label : '';
});

const brandModel = computed(() => String(view.value?.submitted?.brand_model ?? '').trim());

/** 门店售后电话（服务端按工单归属下发；空则不渲染） */
const storePhone = computed(() => {
  const v = String((view.value as unknown as { store_phone?: string | null })?.store_phone ?? '').trim();
  return v || '';
});
/** 门店地址（R1 新增下发；空则整行不渲染，不写空占位） */
const storeAddress = computed(() => {
  const v = String((view.value as unknown as { store_address?: string | null })?.store_address ?? '').trim();
  return v || '';
});

/** 「再提交一单」入口：服务端下发的门店签名凭据，必须 URL 编码 */
const newTicketHref = computed(() => {
  const k = String((view.value as unknown as { entry_k?: string | null })?.entry_k ?? '').trim();
  return k ? `/h5/report?k=${encodeURIComponent(k)}&skipRestore=1` : '';
});

/** 师傅卡：只在真有姓名或电话时渲染（未派工不得虚构） */
const tech = computed(() => {
  const t = view.value?.technician as (NonNullable<ProgressView['technician']> & { status_label?: string }) | null;
  if (!t) return null;
  if (!t.name && !t.phone) return null;
  return t;
});
const techTitle = computed(() => {
  if (view.value?.progress?.stage === 'reopened') return '此前上门师傅';
  return '上门师傅';
});

const imageMedia = computed(() => view.value?.media.filter((m) => m.kind === 'image') ?? []);
const videoMedia = computed(() => view.value?.media.filter((m) => m.kind === 'video') ?? []);
const audioMedia = computed(() => view.value?.media.filter((m) => m.kind === 'audio') ?? []);

const expiryText = computed(() => {
  if (!view.value) return '';
  if (!view.value.closed) return '本单尚未关闭，关闭后 30 天内仍可查询。';
  if (!view.value.queryable_until) return '本单已结束。';
  return `本单已结束，查询入口保留至 ${fmt(view.value.queryable_until)}。`;
});

/** 只列真实发生过、且有真实时间的节点；skipped 不列（它没发生） */
const stepsWithTime = computed(() =>
  (view.value?.progress?.steps ?? []).filter((s) => !!s.at && s.state !== 'skipped'),
);

const expectedText = computed(() => {
  const at = view.value?.progress?.times?.expected_visit_at;
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
});

function fmt(raw: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 评价提交成功后重新拉取进度 DTO，界面据 review.status 切到"已评价" */
async function reloadAfterReview(): Promise<void> {
  try {
    view.value = await fetchProgress(token);
  } catch {
    /* 拉取失败不覆盖已有内容；下次进入页面还会再查 */
  }
}

/**
 * 清除本机对这一单的记忆，然后回本门店**合法**报修入口。
 * - 只删 localStorage 里 token 完全相等的那条（服务端工单不受影响）
 * - 回入口时带 skipRestore=1，避免"清完又被恢复"的死循环
 */
function forgetThis(): void {
  removeLastOrderByToken(token);
  const k = String((view.value as unknown as { entry_k?: string | null })?.entry_k ?? '').trim();
  window.location.href = k ? `/h5/report?k=${encodeURIComponent(k)}&skipRestore=1` : '/h5/report?skipRestore=1';
}

function openViewer(m: ProgressMedia): void {
  const url = mediaUrls.value[m.id];
  if (url) viewerUrl.value = url;
}
function closeViewer(): void {
  viewerUrl.value = '';
}

/**
 * 逐个拉媒体。
 * ⚠️ 串行 + 失败不阻断：某张图挂了不该让整页看起来"坏了"。
 *    凭证走 `X-Progress-Token`，服务端按工单校验归属 —— 换个 token 拿不到别单的文件。
 */
async function loadMedia(): Promise<void> {
  const list = view.value?.media ?? [];
  for (const m of list) {
    try {
      const url = await fetchMediaBlob(m.id, { progressToken: token });
      mediaUrls.value = { ...mediaUrls.value, [m.id]: url };
      if (m.kind === 'video') {
        const poster = await capturePoster(url);
        if (poster) videoPosters.value = { ...videoPosters.value, [m.id]: poster };
      }
    } catch (error: any) {
      mediaFailed.value = { ...mediaFailed.value, [m.id]: true };
      if (error instanceof ApiError && error.status === 401) {
        mediaHint.value = '查询链接已失效，附件暂时看不了';
        break;
      }
    }
  }
}

onUnmounted(() => {
  for (const url of Object.values(mediaUrls.value)) {
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
  }
});

onMounted(async () => {
  void ensureUiConfig().then(() => setPageTitle('服务进度'));
  try {
    view.value = await fetchProgress(token);
    state.value = 'ok';
    void loadMedia();
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
/* ---------- 通用卡片标题 ---------- */
.svc-card-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--svc-text);
}
.svc-card-sub {
  margin: 14px 0 8px;
  font-size: 15px;
  font-weight: 500;
  color: var(--svc-text-weak);
}
.svc-k {
  font-size: 14px;
  color: var(--svc-text-weak);
}

/* ---------- ① 状态与下一步 ---------- */
.svc-hero {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.svc-hero-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.svc-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--svc-primary-weak);
  color: var(--svc-primary);
  font-size: 14px;
  font-weight: 500;
}
.svc-badge.is-cancelled {
  background: var(--svc-surface-2, #f2f2f7);
  color: var(--svc-text-weak);
}
.svc-hero-no {
  font-size: 14px;
  color: var(--svc-text-weak);
  font-variant-numeric: tabular-nums;
}
.svc-hero-text {
  margin: 0;
  font-size: 17px;
  line-height: 1.5;
  color: var(--svc-text);
}
.svc-hero-next {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--svc-radius-sm);
  background: var(--svc-primary-weak);
  color: var(--svc-text);
  font-size: 15px;
  line-height: 1.5;
}

/* ---------- ② 办理进度 ---------- */
.svc-steps {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
}
.svc-step {
  flex: 1 1 0;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.svc-step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 6px;
  left: 50%;
  width: 100%;
  height: 2px;
  background: var(--svc-border);
  z-index: 0;
}
.svc-step.is-done:not(:last-child)::after {
  background: var(--svc-primary);
}
.svc-step-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--svc-card);
  border: 2px solid var(--svc-border-strong, #c6c6c8);
  position: relative;
  z-index: 1;
}
.svc-step.is-done .svc-step-dot {
  background: var(--svc-primary);
  border-color: var(--svc-primary);
}
.svc-step.is-current .svc-step-dot {
  border-color: var(--svc-primary);
  box-shadow: 0 0 0 3px var(--svc-primary-weak);
}
.svc-step.is-skipped .svc-step-dot {
  border-style: dashed;
}
.svc-step-label {
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--svc-text-weak);
}
.svc-step.is-done .svc-step-label,
.svc-step.is-current .svc-step-label {
  color: var(--svc-text);
  font-weight: 600;
}
.svc-step-times {
  list-style: none;
  margin: 14px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--svc-border);
}
.svc-step-times li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 15px;
  color: var(--svc-text-weak);
}
.svc-step-times time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--svc-text);
}

/* ---------- ③ 说明与附件 ---------- */
.svc-progress-content {
  margin: 0;
  font-size: 17px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--svc-text);
}
.svc-thumbs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.svc-thumb {
  aspect-ratio: 1 / 1;
  padding: 0;
  border: 1px solid var(--svc-border);
  border-radius: var(--svc-radius-sm);
  background: var(--svc-surface-2, #f2f2f7);
  overflow: hidden;
  cursor: pointer;
}
.svc-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.svc-thumb-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  color: var(--svc-text-weak);
}
/* 视频紧凑封面（R2）：默认只占一张 16:9 卡片，点一下才变播放器 */
.svc-video-cover {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  margin-top: 8px;
  padding: 0;
  border: 1px solid var(--svc-border);
  border-radius: var(--svc-radius-sm);
  overflow: hidden;
  background: #000;
  cursor: pointer;
}
.svc-video-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0.86;
}
.svc-video-play {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.svc-video-play svg { width: 26px; height: 26px; margin-left: 3px; }
.svc-video-badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}
.svc-video video {
  width: 100%;
  max-height: 320px;
  border-radius: var(--svc-radius-sm);
  background: #000;
  margin-top: 8px;
}
.svc-audio audio {
  width: 100%;
  margin-top: 8px;
}

/* ---------- ④⑤ 信息卡（师傅 / 门店） ---------- */
.svc-info {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 4px;
}
.svc-ico {
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--svc-text-weak);
  margin-top: 2px;
}
.svc-ico svg {
  width: 100%;
  height: 100%;
}
.svc-info-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.svc-info-main strong {
  font-size: 17px;
  font-weight: 600;
  word-break: break-all;
  color: var(--svc-text);
}
.svc-info-sub {
  font-size: 15px;
  color: var(--svc-text-weak);
  line-height: 1.45;
}
.svc-info-action {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--svc-border);
  min-height: var(--svc-touch);
  color: var(--svc-primary);
  font-size: 17px;
  text-decoration: none;
}
.svc-info-extra {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--svc-border);
  font-size: 15px;
  color: var(--svc-text);
}

/* ---------- ⑦ 次级操作 ---------- */
.svc-secondary {
  display: flex;
  justify-content: center;
  gap: 24px;
  margin: 8px 0 4px;
}
.svc-secondary-link {
  min-height: var(--svc-touch);
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0 4px;
  font-size: 15px;
  color: var(--svc-text-weak);
  text-decoration: underline;
  cursor: pointer;
}
.svc-progress-expiry {
  text-align: center;
}

/* ---------- 图片放大 ---------- */
.svc-viewer {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.svc-viewer img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.svc-viewer-close {
  position: absolute;
  top: calc(8px + env(safe-area-inset-top, 0px));
  right: 12px;
  width: var(--svc-touch);
  height: var(--svc-touch);
  border: none;
  background: none;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
}
</style>
