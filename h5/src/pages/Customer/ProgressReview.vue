<template>
  <!-- =========================================================================
       P6-E-NO-OTP-01：进度页直接评价（无验证码）。
       -------------------------------------------------------------------------
       🔴 **这是客户评价的唯一正式入口**（2026-11-14 收口核对结论）

       项目里存在两条能让客户评价的路径，核对后确认它们**不是两个功能**：

         ① 本组件 · 进度页内嵌（`/p/{code}`）          ← **正式入口**
            · 凭证是**进度 Token**，可重复打开，客户本来就在看进度；
            · 不消耗任何一次性凭据 ⇒ 客户随时回来都能评。

         ② `pages/Review/index.vue` · 独立评价页（`/f/{token}`） ← **兼容入口**
            · 凭证是**短信下发的一次性评价 Token**；
            · 只能存在一条的原因：旧短信已经发出去了（实测 115 条），
              历史链接必须继续可用，否则客户点开就是死链。

       二者**共用** `services.tickets.submitReview()`：
         · 唯一 winner 由它内部的条件更新决定（同一秒并发双击也只有一条生效）；
         · 提交后写 `review_status=submitted` + `feedback_token_used_at`，
           于是**另一条链接立刻失效**（GET 回 can_review=false，"您已提交过评价"）。
         ⇒ 规则只有一套，不存在"两个入口两套判定"。

       ⚠️ 2026-11-14 之前这一条并不成立：两处**界面各写一套样式**
          （这里是裸星 #ff9f1c，独立页是方星 #f5a623，错误红一边 #d33
           一边 var(--svc-danger)），客户在两条链接里看到的是"两个产品"。
          现在已统一到 `--svc-*` token，两处视觉一致。
       ========================================================================= -->
  <section v-if="showForm || showDone" class="svc-review" data-testid="progress-review">
    <h3 class="svc-review-title">{{ showDone ? '您的评价' : '这次服务怎么样？' }}</h3>

    <template v-if="showDone">
      <p class="svc-review-thanks" data-testid="review-done">感谢您的评价！</p>
      <div v-if="doneRating >= 1" class="svc-review-stars-ro" aria-label="已评分">
        <span v-for="n in 5" :key="n" :class="['svc-star', { on: n <= doneRating }]">★</span>
      </div>
      <p v-if="doneComment" class="svc-review-comment-ro">{{ doneComment }}</p>
      <!-- 已评价但工单仍在处理中：**现在只剩"收费金额不一致"这一种真实原因**。
           2026-11（P0-LOW-RATING-CLOSE）起低分不再重开 ⇒ 这个提示不会因为
           客户打了 1 星就冒出来。判据是**工单真的没关**（status ≠ CLOSED），
           而不是"评分低" —— 说的和做的一致。 -->
      <p v-if="reopened" class="svc-review-reopen" data-testid="review-reopen-note">
        您反馈的收费金额问题门店正在核对，请保持电话畅通。
      </p>
    </template>

    <template v-else>
      <div class="svc-review-stars" role="radiogroup" aria-label="评分">
        <button
          v-for="n in 5" :key="n" type="button" class="svc-star-btn"
          :class="{ on: n <= rating }" :aria-label="`${n} 星`" role="radio"
          :aria-checked="rating === n" :disabled="submitting"
          data-testid="review-star" @click="rating = n"
        >★</button>
      </div>

      <textarea
        v-model="comment" class="svc-review-input" rows="3" maxlength="500"
        placeholder="有什么想告诉门店的？（可不填）" :disabled="submitting"
        data-testid="review-comment"
      />

      <!-- 收费核对：仅在服务端 report required=true 时出现（客户自己的账单事实） -->
      <div v-if="charge && charge.required" class="svc-review-charge" data-testid="review-charge">
        <p class="svc-review-charge-q">本次服务收费{{ chargeText }}，请您确认：</p>
        <label class="svc-radio" data-testid="review-charge-match">
          <input type="radio" value="match" v-model="chargeMatch" :disabled="submitting" />
          <span>金额一致</span>
        </label>
        <label class="svc-radio" data-testid="review-charge-mismatch">
          <input type="radio" value="mismatch" v-model="chargeMatch" :disabled="submitting" />
          <span>金额不一致</span>
        </label>
        <label v-if="chargeMatch === 'mismatch'" class="svc-review-field">
          <span>您实际支付的金额（元）</span>
          <input
            v-model="amount" class="svc-review-amount" inputmode="decimal" type="number"
            min="0" step="0.01" placeholder="例如 150" :disabled="submitting"
            data-testid="review-amount"
          />
        </label>
      </div>
      <p v-else-if="charge && charge.unknown" class="svc-review-hint" data-testid="review-charge-unknown">
        暂时无法确认本次服务的收费情况，建议联系门店后再评价。
      </p>

      <p v-if="errorText" class="svc-review-error" data-testid="review-error">{{ errorText }}</p>

      <button
        type="button" class="svc-btn svc-review-submit"
        :disabled="submitting || !canSubmit"
        data-testid="review-submit"
        @click="submit"
      >{{ submitting ? '提交中…' : '提交评价' }}</button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

type ChargeInfo = { required: boolean; unknown?: boolean; amount?: number | null } | null;

const props = defineProps<{
  token: string;
  status: string;
  reviewStatus: string;
  rating?: number | null;
  comment?: string | null;
  charge?: ChargeInfo;
}>();

const emit = defineEmits<{ (e: 'submitted'): void }>();

const rating = ref(0);
const comment = ref('');
const chargeMatch = ref<'' | 'match' | 'mismatch'>('');
const amount = ref<string>('');
const submitting = ref(false);
const errorText = ref('');

const showDone = computed(() => String(props.reviewStatus) === 'submitted');
const doneRating = computed(() => Number(props.rating ?? 0) || 0);
const doneComment = computed(() => String(props.comment ?? '').trim());
/**
 * 已评价但工单未关闭。
 *
 * 2026-11 起唯一成因是**收费金额不一致**（低分不再重开）。
 * 这里刻意**保留"评分无关"的判据**（只看 status ≠ CLOSED）：
 *  · 历史遗留的低分重开单还没人工关单，客户点开进度页看到「已评价 + 处理中」
 *    已经是真实现状，此时给一句"门店在核对"虽不精准，但比"什么都没说"好；
 *  · 反过来若改成判断"评分低就隐藏"，会出现**工单真没关却装作关了**的更严重误导。
 */
const reopened = computed(
  () => String(props.reviewStatus) === 'submitted' && String(props.status) !== 'CLOSED',
);
const showForm = computed(
  () => String(props.status) === 'WAIT_FEEDBACK' && String(props.reviewStatus) === 'pending',
);
const chargeText = computed(() => {
  const a = props.charge?.amount;
  return a == null ? '' : ` ${a} 元`;
});

/** 提交按钮可用条件：选星 +（收费单必须选核对方式，选"不一致"必须填金额） */
const canSubmit = computed(() => {
  if (rating.value < 1) return false;
  if (props.charge?.required) {
    if (!chargeMatch.value) return false;
    if (chargeMatch.value === 'mismatch') {
      const v = String(amount.value).trim();
      if (!v || !Number.isFinite(Number(v)) || Number(v) < 0) return false;
    }
  }
  return true;
});

const ERR: Record<string, string> = {
  REVIEW_NOT_AVAILABLE: '当前工单不可评价（可能已完成或已评价）',
  INVALID_RATING: '请选择 1–5 星',
  CHARGE_MATCH_REQUIRED: '本次服务已收费，请先确认金额是否一致',
  CHARGE_MATCH_NOT_APPLICABLE: '暂时无法确认本次服务的收费情况，请联系门店',
  AMOUNT_REQUIRED: '选择「金额不一致」时请填写实际支付金额',
  AMOUNT_NOT_ALLOWED: '选择「金额一致」时不需要填写金额',
  REVIEW_ALREADY_SUBMITTED: '这张工单已经评价过了',
};

async function submit(): Promise<void> {
  if (submitting.value || !canSubmit.value) return;
  errorText.value = '';
  submitting.value = true;
  try {
    const body: any = {
      rating: rating.value,
      comment: comment.value.trim() || null,
    };
    if (props.charge?.required) {
      body.charge_match = chargeMatch.value;
      if (chargeMatch.value === 'mismatch') body.customer_reported_amount = Number(amount.value);
    }

    const res = await fetch(`/api/publicProgress:review?token=${encodeURIComponent(props.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const key = String(json?.errors?.[0]?.code ?? '');
      errorText.value = ERR[key] || String(json?.errors?.[0]?.message ?? '') || '提交失败，请稍后再试';
      return;
    }
    emit('submitted');
  } catch {
    errorText.value = '网络不太好，请稍后再试';
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.svc-review { margin: 16px 12px; padding: 16px; border-radius: var(--svc-radius-md); background: var(--svc-card); box-shadow: 0 1px 4px rgba(0,0,0,.06); }
.svc-review-title { margin: 0 0 12px; font-size: 17px; color: var(--svc-text); }
.svc-review-stars, .svc-review-stars-ro { display: flex; gap: 8px; margin-bottom: 12px; }
/* 星级：与独立评价页同款（等分 + 描边 + 选中浅底）——
   整改前是"裸星 44×44"，与独立评价页的"方星等分"外观不同，同一动作两种样子。 */
.svc-star-btn { flex: 1; min-height: var(--svc-touch); padding: 10px 0; font-size: 28px; line-height: 1; color: var(--svc-border); background: var(--svc-card); border: 1px solid var(--svc-border); border-radius: var(--svc-radius-sm); cursor: pointer; -webkit-tap-highlight-color: transparent; transition: color .12s, border-color .12s, background .12s; }
.svc-star-btn:disabled { opacity: .6; cursor: default; }
.svc-star-btn.on, .svc-star.on { color: var(--svc-star); border-color: var(--svc-star); background: var(--svc-star-weak); }
.svc-star { font-size: 26px; line-height: 1.2; color: var(--svc-border); }
.svc-review-input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px; color: var(--svc-text); background: var(--svc-card); border: 1px solid var(--svc-border); border-radius: var(--svc-radius-sm); margin-bottom: 12px; }
.svc-review-charge { border: 1px solid var(--svc-border); background: var(--svc-primary-weak); border-radius: var(--svc-radius-sm); padding: 12px; margin-bottom: 12px; }
.svc-review-charge-q { margin: 0 0 8px; font-size: 15px; color: var(--svc-text); }
.svc-radio { display: flex; align-items: center; gap: 8px; min-height: 36px; font-size: 15px; color: var(--svc-text); }
.svc-radio input { width: 20px; height: 20px; }
.svc-review-field { display: block; margin-top: 8px; font-size: 15px; color: var(--svc-text); }
.svc-review-amount { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; font-size: 16px; padding: 10px; color: var(--svc-text); background: var(--svc-card); border: 1px solid var(--svc-border); border-radius: var(--svc-radius-sm); }
.svc-review-hint { color: var(--svc-warn); font-size: 14px; margin: 0 0 8px; }
.svc-review-error { color: var(--svc-danger); font-size: 14px; margin: 0 0 10px; }
.svc-btn.svc-review-submit { width: 100%; min-height: var(--svc-touch-lg); font-size: 17px; border-radius: var(--svc-radius-md); }
.svc-review-thanks { font-size: 16px; color: var(--svc-ok); margin: 0 0 10px; }
.svc-review-comment-ro { color: var(--svc-text-weak); font-size: 15px; margin: 8px 0 0; }
.svc-review-reopen { margin: 10px 0 0; padding: 10px; border-radius: var(--svc-radius-sm); background: var(--svc-primary-weak); color: var(--svc-warn); font-size: 14px; }
</style>
