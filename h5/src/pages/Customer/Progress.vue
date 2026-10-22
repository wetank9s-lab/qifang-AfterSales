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
      <!-- 单号 + 当前阶段（UX-PROGRESS-01：不再只给"处理中"三个字） -->
      <div class="svc-card svc-progress-hero">
        <span class="svc-k">工单号</span>
        <strong class="svc-v" data-testid="progress-ticket-no">{{ view.ticket_no }}</strong>
        <span
          class="svc-progress-status"
          :class="{ 'is-cancelled': view.progress?.stage === 'cancelled' }"
          :data-stage="view.progress?.stage || view.status"
          data-testid="progress-stage-label"
        >{{ view.progress?.stage_label || view.status_label }}</span>
        <p v-if="view.progress" class="svc-progress-state" data-testid="progress-status-text">
          {{ view.progress.status_text }}
        </p>
      </div>

      <!--
        阶段步骤条（UX-PROGRESS-01）。
        ⚠️ 只渲染服务端算出来的 5 个里程碑，**不显示百分比** ——
           "第 3/5 步 = 60%" 是个假分母（改派、远程解决、驳回都会改变实际步数）。
        时间只给"真的发生过"的节点，没有就整行不出现。
      -->
      <div v-if="view.progress" class="svc-card">
        <span class="svc-k">办理进度</span>
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

        <p
          class="svc-hint svc-progress-next"
          :data-owner="view.progress.next_action.owner"
          data-testid="progress-next-action"
        >
          {{ view.progress.next_action.text }}
        </p>
      </div>

      <!--
        服务师傅（UX-PROGRESS-01）。
        服务端只在**存在有效派工**时返回；改派后旧师傅立即消失、取消后整卡消失。
        无对客电话（当前模型没有该字段/授权）时**不填假号码**，只给"请联系门店"。
      -->
      <div v-if="view.technician" class="svc-card svc-tech-card" data-testid="progress-tech">
        <span class="svc-k">{{ view.technician.role === 'completed' ? '本次服务师傅' : '服务师傅' }}</span>
        <div class="svc-tech-row">
          <strong data-testid="progress-tech-name">
            {{ view.technician.name || '门店已安排服务人员' }}
          </strong>
          <span v-if="view.technician.visit_no > 1" class="svc-tech-nth" data-testid="progress-tech-visit-no">
            第 {{ view.technician.visit_no }} 次上门
          </span>
        </div>
        <a
          v-if="view.technician.callable && view.technician.phone"
          class="svc-tech-phone"
          :href="'tel:' + view.technician.phone"
          data-testid="progress-tech-phone"
        >{{ view.technician.phone }}</a>
        <p v-else class="svc-hint" data-testid="progress-tech-hint">
          {{ view.technician.contact_hint || '请联系门店' }}
        </p>
      </div>

      <!--
        服务时间（UX-PROGRESS-01 真机整改）。
        🔴 六项**各自独立来源**：派工时间不是上门时间、门店确认不是师傅回执时间。
           缺数据的显示"待确认/尚未记录"，不拿别的时间顶替。
      -->
      <div v-if="view.progress?.times" class="svc-card" data-testid="progress-times">
        <span class="svc-k">服务时间</span>
        <dl class="svc-times">
          <dt>提交时间</dt>
          <dd data-testid="time-submitted">{{ fmt(view.progress.times.submitted_at) }}</dd>
          <dt>派工时间</dt>
          <dd data-testid="time-dispatched">{{ fmtOr(view.progress.times.dispatched_at, '尚未派工') }}</dd>
          <dt>预约上门</dt>
          <dd data-testid="time-expected">{{ expectedText }}</dd>
          <dt>实际到场</dt>
          <dd data-testid="time-arrived">尚未记录</dd>
          <dt>师傅回执</dt>
          <dd data-testid="time-tech-submitted">{{ fmtOr(view.progress.times.tech_submitted_at, '尚未提交') }}</dd>
          <dt>门店确认</dt>
          <dd data-testid="time-store-confirmed">{{ fmtOr(view.progress.times.store_confirmed_at, '尚未确认') }}</dd>
        </dl>
        <p class="svc-hint">预约上门只精确到日期，具体时间以师傅联系为准。</p>
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
          <li v-for="(t, i) in view.timeline" :key="i" :data-event="t.event">
            <span class="svc-progress-dot" :class="{ 'is-last': i === view.timeline.length - 1 }"></span>
            <!-- 事件名（客户可读），不再拿"处理中"这种状态当标题 -->
            <span class="svc-progress-t">{{ t.event_label || t.status_label }}</span>
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
// UX-01D M1：进度页无门店入口 ⇒ 一律使用总部已发布主题（D9 决策）
import { ensureUiConfig, setPageTitle } from '../../ui-state';

const route = useRoute();
const token = String(route.value.params.token ?? '');

const state = ref<'loading' | 'ok' | 'error'>('loading');
const errorText = ref('');
const view = ref<ProgressView | null>(null);
const mediaHint = ref('');
let objectUrl: string | null = null;

const expiryText = computed(() => {  if (!view.value) return '';
  if (!view.value.closed) return '本单尚未关闭，关闭后 30 天内仍可查询。';
  if (!view.value.queryable_until) return '本单已关闭。';
  return `本单已关闭，查询入口保留至 ${fmt(view.value.queryable_until)}。`;
});

/**
 * 只把"真实发生过、且有真实时间"的里程碑列出来。
 * skipped（远程解决时跳过的上门步骤）不列时间 —— 它根本没发生。
 */
const stepsWithTime = computed(() =>
  (view.value?.progress?.steps ?? []).filter((s) => !!s.at && s.state !== 'skipped'),
);

function fmt(raw: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 有值就格式化，没值就显示明确的业务态（"尚未派工/尚未提交/尚未确认"），不留空 */
function fmtOr(raw: string | null | undefined, fallback: string): string {
  return raw ? fmt(raw) : fallback;
}

/**
 * 预约上门**只到天**（模型口径：expected_visit_at 存 canonical 正午）。
 * 没有就显示"待确认" —— 绝不拿派工时间或更新时间顶替。
 */
const expectedText = computed(() => {
  const at = view.value?.progress?.times?.expected_visit_at;
  if (!at) return '待确认';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '待确认';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
});

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
  // 主题与数据并行：主题失败不影响进度展示（反之亦然）
  void ensureUiConfig().then(() => setPageTitle('服务进度'));
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
/* UX-PROGRESS-01 真机整改：六项服务时间 */
.svc-times {
  margin: 8px 0 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 13.5px;
}
.svc-times dt {
  color: var(--svc-text-weak, #5f6670);
  white-space: nowrap;
}
.svc-times dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  word-break: break-all;
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

/* ===================== UX-PROGRESS-01：阶段 / 师傅 ===================== */
.svc-progress-state {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--svc-text, #1f2329);
}
.svc-progress-status.is-cancelled {
  background: #f2f3f5;
  color: var(--svc-text-weak, #5f6670);
}
.svc-steps {
  list-style: none;
  margin: 14px 0 0;
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
/* 连接线：画在本步圆点右半边，最后一步不画 */
.svc-step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 6px;
  left: 50%;
  width: 100%;
  height: 2px;
  background: var(--svc-border, #e5e7eb);
  z-index: 0;
}
.svc-step.is-done:not(:last-child)::after {
  background: var(--svc-primary, #d4380d);
}
.svc-step-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-sizing: border-box;
  background: #fff;
  border: 2px solid var(--svc-border, #d1d5db);
  position: relative;
  z-index: 1;
}
.svc-step.is-done .svc-step-dot {
  background: var(--svc-primary, #d4380d);
  border-color: var(--svc-primary, #d4380d);
}
.svc-step.is-current .svc-step-dot {
  border-color: var(--svc-primary, #d4380d);
  box-shadow: 0 0 0 3px rgba(212, 56, 13, 0.16);
}
.svc-step.is-skipped .svc-step-dot {
  border-style: dashed;
}
.svc-step-label {
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--svc-text-weak, #5f6670);
}
.svc-step.is-done .svc-step-label,
.svc-step.is-current .svc-step-label {
  color: var(--svc-text, #1f2329);
  font-weight: 600;
}
.svc-step-times {
  list-style: none;
  margin: 14px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--svc-border, #f0f0f0);
}
.svc-step-times li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 12.5px;
  color: var(--svc-text-weak, #5f6670);
}
.svc-step-times time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.svc-progress-next {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f6ffed;
  color: var(--svc-text, #1f2329);
}
.svc-tech-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.svc-tech-row strong {
  font-size: 16px;
  word-break: break-all;
}
.svc-tech-nth {
  font-size: 12px;
  color: var(--svc-text-weak, #5f6670);
}
.svc-tech-phone {
  display: inline-block;
  margin-top: 8px;
  font-size: 15px;
  color: var(--svc-primary, #d4380d);
  text-decoration: none;
}
</style>
