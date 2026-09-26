<template>
  <div class="svc-page">
    <!-- ============================ 加载中 ============================ -->
    <template v-if="view === 'loading'">
      <header class="svc-header">
        <h1>服务评价</h1>
        <p>正在读取服务信息…</p>
      </header>
    </template>

    <!-- ============================ 链接不可用 / 已过期 / 已评价 ============================ -->
    <!--
      ⚠️ 三种"不能评价"的终态共用一个视图，但**文案与图标各自独立**：
      客户最需要区分的就是这三件事 ——
        · 链接错    → 找门店要新链接
        · 已过期    → 什么都不用做（服务已结单）
        · 已评价    → 什么都不用做（已收到）
      用同一句"不可用"概括，客户会反复点重试（第一类），
      或以为自己的评价丢了（第三类）。
    -->
    <template v-else-if="view === 'blocked'">
      <div class="rv-state" data-review-blocked>
        <div class="rv-state-mark" :class="blocked.markClass" aria-hidden="true">
          {{ blocked.icon }}
        </div>
        <h1>{{ blocked.title }}</h1>
        <p class="rv-state-text">{{ blocked.text }}</p>
        <div v-if="blocked.ticketNo" class="svc-ticketno">
          <span class="svc-k">工单号</span>
          <span class="svc-v">{{ blocked.ticketNo }}</span>
        </div>
        <p v-if="blocked.hint" class="svc-hint">{{ blocked.hint }}</p>
        <!--
          ⚠️ 终态**不给重试按钮**。给出按钮等于暗示"再点一次可能成功"，
          而这三条路径重试一百次都是同一个结果。
        -->
      </div>
    </template>

    <!-- ============================ 提交成功（终态） ============================ -->
    <template v-else-if="view === 'done'">
      <div class="svc-success" data-review-done>
        <div class="svc-success-mark" aria-hidden="true">✓</div>
        <h1>{{ done.title }}</h1>
        <div class="svc-ticketno">
          <span class="svc-k">工单号</span>
          <span class="svc-v">{{ done.ticketNo }}</span>
        </div>
        <p class="svc-meta">{{ done.text }}</p>
        <p class="svc-hint">评价链接已失效，无需重复提交。</p>
      </div>
    </template>

    <!-- ============================ 评价表单 ============================ -->
    <template v-else>
      <div data-review-form>
      <header class="svc-header">
        <h1>服务评价</h1>
        <p>{{ ctx?.store_display_name }}</p>
      </header>

      <div v-if="banner" class="svc-alert" :class="banner.kind">{{ banner.text }}</div>

      <!-- ---- 这一单是哪一单（最小上下文） ---- -->
      <section class="svc-card">
        <div class="svc-row">
          <span class="svc-row-key">工单号</span>
          <span class="svc-row-val svc-ticketno-v">{{ ctx?.ticket_no }}</span>
        </div>
        <div class="svc-row">
          <span class="svc-row-key">服务门店</span>
          <span class="svc-row-val">{{ ctx?.store_display_name }}</span>
        </div>
        <div class="svc-row">
          <span class="svc-row-key">服务事项</span>
          <span class="svc-row-val">{{ ctx?.service_summary }}</span>
        </div>
        <div class="svc-row">
          <span class="svc-row-key">本次收费</span>
          <!--
            ⚠️ `is_charged=false` 时显示「未收费」，**不是**「¥0.00」。
            契约 §5：NULL ≠ 0.00。把"没收费"渲染成 0.00 会让客户
            以为被收了 0 元（或以为系统算错了），进而去核对收费。
          -->
          <span class="svc-row-val">{{ chargeText }}</span>
        </div>
      </section>

      <!-- ---- 评分 ---- -->
      <section class="svc-card">
        <label class="svc-label">
          您对本次服务的满意度
          <span class="svc-req">*</span>
        </label>
        <div class="rv-stars" role="radiogroup" aria-label="服务评分">
          <button
            v-for="n in 5"
            :key="n"
            type="button"
            class="rv-star"
            :class="{ 'is-on': n <= rating }"
            :data-star="n"
            :aria-checked="rating === n"
            role="radio"
            :aria-label="`${n} 星`"
            :disabled="submitting"
            @click="rating = n"
          >
            ★
          </button>
        </div>
        <p class="rv-star-note">{{ ratingNote }}</p>
      </section>

      <!-- ---- 收费核对（服务端权威；页面只是采集） ---- -->
      <section class="svc-card">
        <label class="svc-label">
          收费核对
          <span class="svc-req">*</span>
        </label>

        <!-- 门店确认未收费：客户只能选「未收费」 —— 服务端也只放行这一个值 -->
        <div v-if="!ctx?.is_charged" class="rv-fixed">
          本次服务门店确认未收费。
        </div>

        <!-- 门店确认已收费：一致 / 不一致（不一致才要求填金额） -->
        <template v-else>
          <div class="svc-segment">
            <button
              type="button"
              data-charge="match"
              :class="{ 'is-active': chargeMatch === 'match' }"
              :disabled="submitting"
              @click="chargeMatch = 'match'"
            >
              金额一致
            </button>
            <button
              type="button"
              data-charge="mismatch"
              :class="{ 'is-active': chargeMatch === 'mismatch' }"
              :disabled="submitting"
              @click="chargeMatch = 'mismatch'"
            >
              金额不一致
            </button>
          </div>

          <div v-if="chargeMatch === 'mismatch'" class="svc-field rv-amount">
            <label class="svc-label" for="rv-amount">
              您实际支付的金额（元）
              <span class="svc-req">*</span>
            </label>
            <input
              id="rv-amount"
              v-model="reportedAmount"
              data-charge-amount
              class="svc-input"
              :class="{ 'is-invalid': !!fieldError.amount }"
              type="number"
              inputmode="decimal"
              min="0"
              step="0.01"
              placeholder="例如 120.00"
              :disabled="submitting"
            />
            <p v-if="fieldError.amount" class="svc-error">{{ fieldError.amount }}</p>
          </div>
        </template>
      </section>

      <!-- ---- 评价内容（可选） ---- -->
      <section class="svc-card">
        <label class="svc-label" for="rv-comment">
          补充说明
          <span class="svc-opt">选填</span>
        </label>
        <textarea
          id="rv-comment"
          v-model="comment"
          class="svc-textarea"
          :class="{ 'is-invalid': !!fieldError.comment }"
          rows="4"
          :maxlength="COMMENT_MAX"
          placeholder="服务是否准时、态度如何、有什么想告诉门店的…"
          :disabled="submitting"
        />
        <p class="svc-hint">
          {{ comment.length }} / {{ COMMENT_MAX }} 字
        </p>
        <p v-if="fieldError.comment" class="svc-error">{{ fieldError.comment }}</p>
      </section>

      <!--
        ⚠️ 低分预先说明**后果**（工单会退回门店处理），而不是事后才说。
        客户给 1–2 星时的预期是"评价会被看到"，而实际业务动作是
        reopen 到 PROCESSING（门店要重新处理）。事先说清楚，
        客户才知道自己这个动作会带来什么 —— 否则事后收到门店回访会莫名其妙。
      -->
      <p v-if="reopenForecast" class="svc-hint rv-forecast" data-review-forecast>
        {{ reopenForecast }}
      </p>

      <button
        class="svc-submit"
        type="button"
        data-review-submit
        :disabled="submitting || !canSubmit"
        @click="onSubmit"
      >
        {{ submitting ? '提交中…' : '提交评价' }}
      </button>

      <p class="svc-hint">
        提交后不可修改。请确认评分与描述无误。
      </p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 客户评价页（Phase 7）—— `/h5/customer/review/{token}`
 *
 * ---------------------------------------------------------------------------
 * 本页的定位：**采集 + 呈现**，不做任何规则裁决
 * ---------------------------------------------------------------------------
 * 「能不能评价」「收费核对允许哪些值」「低分要不要重开」**全部由服务端决定**。
 * 页面只做两件事：
 *   ① 把服务端给的最小上下文渲染成人话；
 *   ② 把客户的输入原样提交，然后把服务端的裁决结果（200 / 4xx）翻译成提示。
 *
 * 为什么坚持这条：金额与星级规则如果在前端也判一遍，就出现两份实现 ——
 * 客户改一下 JS 就能绕过前端那份，而**服务端那份才是真的**。
 * 所以这里连"金额框何时显示"都只是 UI 便利（服务端收到不合法组合照样 422）。
 *
 * ---------------------------------------------------------------------------
 * 终态处理：GET 的 200 也可能是"不能评价"
 * ---------------------------------------------------------------------------
 * 服务端对"已评价 / 已过期"的 GET 回 **200 + can_review=false**（契约 §4），
 * 而不是 4xx —— 目的正是让本页能把话说清楚。
 * 因此 `can_review=false` 走 `blocked` 视图，**不是**错误分支。
 * 这与提交时的 409/410 是同一语义的两条路径，话术必须一致
 * （`api/review.ts` 的 `reviewErrorMessageOf` 是唯一定义点）。
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError } from '../../api/http';
import {
  fetchReviewContext,
  reviewErrorMessageOf,
  submitReview,
  type ChargeMatch,
  type ReviewContext,
} from '../../api/review';

/** 与服务端 `REVIEW_COMMENT_MAX` 逐字一致；`maxlength` 只是 UI 便利 */
const COMMENT_MAX = 500;

const props = defineProps<{ token: string }>();

type View = 'loading' | 'form' | 'blocked' | 'done';
const view = ref<View>('loading');
const ctx = ref<ReviewContext | null>(null);
const banner = ref<{ kind: string; text: string } | null>(null);
const fieldError = ref<{ amount?: string; comment?: string }>({});
const submitting = ref(false);

const rating = ref(0);
const comment = ref('');
const chargeMatch = ref<ChargeMatch | ''>('');
/**
 * 客户实际支付金额。
 *
 * ⚠️⚠️ **类型刻意是 `string | number`，不是 `string`** —— 首跑真实缺陷（Phase 7 DEV-90）：
 *   模板上是 `<input type="number" v-model="reportedAmount">`。Vue 的 `vModelText`
 *   对 `type="number"` 会**自动打开 number 修饰**（`looseToNumber`），
 *   于是输入 `60` 时写进 ref 的是**数字 `60`**，不是字符串 `'60'`。
 *   若把 ref 声明成 `string` 并对它调 `.trim()`，就会在客户一输入金额时
 *   **抛 `TypeError: value.trim is not a function`** —— 而且这个 throw 发生在
 *   渲染副作用链上的 computed 里，Vue 会**把整个应用卸载掉**（页面直接变空白）。
 *   ⇒ 对策：**声明的类型必须诚实地反映运行时可能出现的两种形态**（空串 / 数字），
 *     并且统一用一个 `amountText` 归一后再判空。
 *   **不要**改成「声明 `string` 但靠 `as` 骗过类型检查」—— 那只是把运行时崩
 *     藏到编译期后面；也**不要**去掉 `type="number"`（那会丢掉手机数字键盘）。
 */
const reportedAmount = ref<string | number>('');

/** 金额的**文本形态**（判空 / 取值一律走这里，避免在 number 上调字符串方法） */
const amountText = computed(() => {
  const v = reportedAmount.value;
  return v === null || v === undefined ? '' : String(v);
});

const blocked = ref({
  icon: '!',
  markClass: '',
  title: '链接不可用',
  text: '',
  hint: '',
  ticketNo: '',
});

const done = ref({ title: '', text: '', ticketNo: '' });

/**
 * 评分对应的说明文案。
 *
 * ⚠️ 刻意**不预告**"几分会被重开"以外的判断，也不在这里写阈值数字的
 *    第二份副本（阈值来自服务端 `feedback.low_score_threshold`）。
 *    这里只做"1–2 星会被退回门店处理"的**定性**提示 —— 定性说明不容易漂移，
 *    而写死"小于等于 2"会在阈值调整时变成一句骗人的话。
 */
const ratingNote = computed(() => {
  if (rating.value === 0) return '请选择 1–5 星';
  if (rating.value <= 2) return '我们会把这条反馈退回门店重新处理。';
  return '感谢您的认可，我们会继续努力。';
});

/** 提交前就把"低分会重开"说清楚（事后才说会让客户莫名其妙） */
const reopenForecast = computed(() => {
  if (rating.value > 0 && rating.value <= 2) {
    return '提交后该工单会退回门店重新处理，门店可能会再与您联系。';
  }
  if (chargeMatch.value === 'mismatch') {
    return '金额不一致会退回门店核对，门店可能会再与您联系。';
  }
  return '';
});

/** 收费展示：未收费 ≠ 0.00（契约 §5） */
const chargeText = computed(() => {
  const c = ctx.value;
  if (!c) return '—';
  if (!c.is_charged) return '未收费';
  const amount = c.confirmed_charge_amount;
  if (amount === null || amount === undefined) return '已收费（金额以门店确认为准）';
  return `¥${Number(amount).toFixed(2)}`;
});

/**
 * 客户端**最低限度**的可提交判断。
 * ⚠️ 这不是校验权威 —— 服务端那份才是。这里只是别让客户点了注定失败的一下。
 */
const canSubmit = computed(() => {
  if (rating.value < 1 || rating.value > 5) return false;
  const c = ctx.value;
  if (!c) return false;
  if (!c.is_charged) return true; // 未收费 ⇒ not_applicable，无需选择
  if (chargeMatch.value !== 'match' && chargeMatch.value !== 'mismatch') return false;
  if (chargeMatch.value === 'mismatch' && amountText.value.trim() === '') return false;
  return true;
});

function applyBlockedFromState(context: ReviewContext): void {
  // `can_review=false` 的两个来源：已评价 / 已过期。
  // 顺序与服务端 `reviewStateOf` 一致（先判已提交）—— 否则"已评价且恰好也过期"
  // 会在这里被显示成"已过期"，客户以为评价丢了。
  if (context.review_state === 'submitted') {
    blocked.value = {
      icon: '✓',
      markClass: 'is-ok',
      title: '您已提交过评价',
      text: '我们已收到您对本次服务的反馈，感谢您的评价。',
      hint: '同一条服务链接只能评价一次，无需重复提交。',
      ticketNo: context.ticket_no,
    };
    return;
  }
  if (context.review_state === 'expired') {
    blocked.value = {
      icon: '⏱',
      markClass: 'is-warn',
      title: '评价时间已结束',
      text: '本次服务的评价时间已结束，工单已自动结单。',
      hint: '如仍有问题未解决，请联系门店协助处理。',
      ticketNo: context.ticket_no,
    };
    return;
  }
  // 兜底：状态是 pending 但 can_review=false（理论上不可达）
  blocked.value = {
    icon: '!',
    markClass: '',
    title: '暂时无法评价',
    text: '当前工单状态不支持评价，请联系门店。',
    hint: '',
    ticketNo: context.ticket_no,
  };
}

async function load(): Promise<void> {
  view.value = 'loading';
  try {
    const context = await fetchReviewContext(props.token);
    ctx.value = context;

    if (context.can_review) {
      // 未收费 ⇒ 直接锁定 not_applicable（服务端也只接受这个值）。
      // 已收费 ⇒ 不预选，强制客户做一次明确选择（预选"一致"等于替他回答）。
      chargeMatch.value = context.is_charged ? '' : 'not_applicable';
      view.value = 'form';
      return;
    }

    applyBlockedFromState(context);
    view.value = 'blocked';
  } catch (error) {
    view.value = 'blocked';
    const info = reviewErrorMessageOf(error);
    blocked.value = {
      icon: '!',
      markClass: '',
      title: info.terminal === 'submitted' ? '您已提交过评价' : '链接不可用',
      text: info.message,
      hint:
        info.terminal === 'submitted'
          ? '同一条服务链接只能评价一次，无需重复提交。'
          : '请与门店核对后，让门店重新发送一条评价短信。',
      ticketNo: '',
    };
  }
}

async function onSubmit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  banner.value = null;
  fieldError.value = {};

  const c = ctx.value;
  const payload = {
    rating: rating.value,
    comment: comment.value.trim() === '' ? null : comment.value.trim(),
    charge_match: (c?.is_charged ? chargeMatch.value : 'not_applicable') as ChargeMatch,
    // ⚠️ 未收费 / 一致时**不发金额字段**：服务端对"不该带金额却带了"是 422
    //    （`AMOUNT_NOT_ALLOWED`），不做静默忽略。
    //    判空统一走 `amountText`（见其声明处的 DEV-90 说明）。
    customer_reported_amount:
      c?.is_charged && chargeMatch.value === 'mismatch' && amountText.value.trim() !== ''
        ? Number(amountText.value)
        : null,
  };

  try {
    const result = await submitReview(props.token, payload);
    done.value = {
      title: result.reopened ? '已提交，门店会再与您联系' : '感谢您的评价',
      text: result.reopened
        ? '您的反馈已退回门店重新处理，门店可能会电话与您核实。'
        : '您的评价已记录，本次服务已结单。',
      ticketNo: result.ticket_no,
    };
    view.value = 'done';
  } catch (error) {
    const info = reviewErrorMessageOf(error);
    const code = (error as ApiError)?.code ?? '';

    // 终态：切到终态视图（与服务端 GET 的 200+can_review=false 同一话术）
    if (info.terminal === 'submitted' || info.terminal === 'expired') {
      blocked.value = {
        icon: info.terminal === 'submitted' ? '✓' : '⏱',
        markClass: info.terminal === 'submitted' ? 'is-ok' : 'is-warn',
        title: info.terminal === 'submitted' ? '您已提交过评价' : '评价时间已结束',
        text: info.message,
        hint:
          info.terminal === 'submitted'
            ? '同一条服务链接只能评价一次，无需重复提交。'
            : '如仍有问题未解决，请联系门店协助处理。',
        ticketNo: ctx.value?.ticket_no ?? '',
      };
      view.value = 'blocked';
      return;
    }
    if (code === 'REVIEW_NOT_FOUND') {
      blocked.value = {
        icon: '!',
        markClass: '',
        title: '链接不可用',
        text: info.message,
        hint: '请与门店核对后，让门店重新发送一条评价短信。',
        ticketNo: '',
      };
      view.value = 'blocked';
      return;
    }

    // 可修正的字段错误：留在表单上，把错误贴到对应字段
    if (code === 'INVALID_CUSTOMER_AMOUNT' || code === 'MISSING_CUSTOMER_AMOUNT') {
      fieldError.value = { amount: info.message };
    } else if (code === 'INVALID_REVIEW_COMMENT') {
      fieldError.value = { comment: info.message };
    } else if (code === 'CHARGE_MATCH_NOT_APPLICABLE' || code === 'CHARGE_MATCH_REQUIRED') {
      // 服务端说"该选另一个值" ⇒ 同步回表单并提示
      if (ctx.value) chargeMatch.value = ctx.value.is_charged ? '' : 'not_applicable';
      banner.value = { kind: 'is-warn', text: info.message };
    } else {
      banner.value = { kind: 'is-error', text: info.message };
    }
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* ---------------------------------------------------------------------------
   本页专属样式。
   ⚠️ 只写"星级按钮"和"终态卡片"这两块设计系统里没有的东西；
      卡片/标签/输入框/提交按钮一律复用 `styles/base.css` 的 `.svc-*`，
      不在这里重新定义颜色与圆角（那会让主题调整变成两处修改）。
   --------------------------------------------------------------------------- */

.rv-stars {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.rv-star {
  flex: 1;
  padding: 10px 0;
  border: 1px solid var(--svc-border);
  border-radius: var(--svc-radius);
  background: var(--svc-card);
  color: var(--svc-border);
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  -webkit-tap-highlight-color: transparent;
}

.rv-star.is-on {
  color: #f5a623;
  border-color: #f5a623;
  background: #fffaf0;
}

.rv-star:disabled {
  opacity: 0.6;
}

.rv-star-note {
  margin: 8px 0 0;
  color: var(--svc-text-weak);
  font-size: 13px;
}

.rv-fixed {
  padding: 10px 12px;
  border: 1px solid var(--svc-border);
  border-radius: var(--svc-radius);
  background: var(--svc-bg);
  color: var(--svc-text-weak);
  font-size: 14px;
}

.rv-amount {
  margin-top: 12px;
}

.rv-forecast {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: var(--svc-radius);
  background: #fffaf0;
  border: 1px solid #f5dfb0;
  color: var(--svc-warn);
  font-size: 13px;
}

/* ---- 终态卡片（已评价 / 已过期 / 链接错） ---- */
.rv-state {
  padding: 48px 24px 24px;
  text-align: center;
}

.rv-state-mark {
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  line-height: 1;
  background: #fdecec;
  color: var(--svc-danger);
}

.rv-state-mark.is-ok {
  background: #e8f8ef;
  color: var(--svc-ok);
}

.rv-state-mark.is-warn {
  background: #fff5e5;
  color: var(--svc-warn);
}

.rv-state h1 {
  margin: 0 0 12px;
  font-size: 20px;
  color: var(--svc-text);
}

.rv-state-text {
  margin: 0 0 16px;
  color: var(--svc-text-weak);
  font-size: 14px;
  line-height: 1.6;
}

.svc-ticketno-v {
  font-variant-numeric: tabular-nums;
}
</style>
