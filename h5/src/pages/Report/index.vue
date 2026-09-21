<template>
  <div class="svc-page">
    <header class="svc-header">
      <h1>服务报修</h1>
      <p>提交后门店会尽快与您联系安排上门</p>
    </header>

    <div v-if="banner" class="svc-alert" :class="banner.kind">{{ banner.text }}</div>

    <form class="svc-card" novalidate @submit.prevent="onSubmit">
      <!-- 门店 -->
      <div class="svc-field">
        <label class="svc-label" for="f-store">服务门店<span class="svc-req">*</span></label>
        <select
          id="f-store"
          v-model="form.store_code"
          class="svc-select"
          :class="{ 'is-invalid': fieldErrors.store_code }"
          :disabled="storesLoading || stores.length === 0"
        >
          <option value="" disabled>{{ storesLoading ? '门店加载中…' : '请选择门店' }}</option>
          <option v-for="s in stores" :key="s.code" :value="s.code">{{ s.name }}</option>
        </select>
        <div v-if="fieldErrors.store_code" class="svc-error">{{ fieldErrors.store_code }}</div>
        <div v-else-if="storesError" class="svc-error">
          {{ storesError }}
          <button type="button" class="svc-link" @click="loadStores">重试</button>
        </div>
      </div>

      <!-- 类型 -->
      <div class="svc-field">
        <span class="svc-label">服务类型<span class="svc-req">*</span></span>
        <div class="svc-segment">
          <button
            type="button"
            :class="{ 'is-active': form.ticket_type === 'repair' }"
            @click="form.ticket_type = 'repair'"
          >
            报修
          </button>
          <button
            type="button"
            :class="{ 'is-active': form.ticket_type === 'complaint' }"
            @click="form.ticket_type = 'complaint'"
          >
            投诉
          </button>
        </div>
        <div v-if="fieldErrors.ticket_type" class="svc-error">{{ fieldErrors.ticket_type }}</div>
      </div>

      <!-- 问题描述 -->
      <div class="svc-field">
        <label class="svc-label" for="f-content">问题描述<span class="svc-req">*</span></label>
        <textarea
          id="f-content"
          v-model="form.content"
          class="svc-textarea"
          :class="{ 'is-invalid': fieldErrors.content }"
          :maxlength="CONTENT_MAX"
          placeholder="例如：冰箱冷藏室不制冷，压缩机一直响，购买约 2 年"
        ></textarea>
        <div class="svc-hint">
          <span>写清现象与型号，师傅上门更快</span>
          <span>{{ contentLength }}/{{ CONTENT_MAX }}</span>
        </div>
        <div v-if="fieldErrors.content" class="svc-error">{{ fieldErrors.content }}</div>
      </div>

      <!-- 联系人 -->
      <div class="svc-field">
        <label class="svc-label" for="f-name">联系人<span class="svc-req">*</span></label>
        <input
          id="f-name"
          v-model="form.customer_name"
          class="svc-input"
          :class="{ 'is-invalid': fieldErrors.customer_name }"
          type="text"
          :maxlength="NAME_MAX"
          autocomplete="name"
          placeholder="怎么称呼您"
        />
        <div v-if="fieldErrors.customer_name" class="svc-error">{{ fieldErrors.customer_name }}</div>
      </div>

      <!-- 手机号 -->
      <div class="svc-field">
        <label class="svc-label" for="f-mobile">手机号<span class="svc-req">*</span></label>
        <input
          id="f-mobile"
          v-model="form.customer_mobile"
          class="svc-input"
          :class="{ 'is-invalid': fieldErrors.customer_mobile }"
          type="tel"
          inputmode="numeric"
          maxlength="11"
          autocomplete="tel"
          placeholder="11 位手机号，用于师傅联系"
        />
        <div v-if="fieldErrors.customer_mobile" class="svc-error">
          {{ fieldErrors.customer_mobile }}
        </div>
      </div>
    </form>

    <!-- 隐私勾选（独立成卡：视觉上必须与表单字段区分开，它是准入门槛而不是可选项） -->
    <div class="svc-card">
      <label class="svc-privacy" :class="{ 'is-invalid': privacyInvalid }">
        <input v-model="privacyAgreed" type="checkbox" :aria-invalid="privacyInvalid" />
        <span>
          我已阅读并同意
          <button type="button" class="svc-link" @click="noticeOpen = true">
            《个人信息处理说明》
          </button>
          ，同意门店为安排上门服务使用我提交的姓名、手机号与问题描述。
        </span>
      </label>
      <div v-if="privacyInvalid" class="svc-error">请先勾选同意后再提交</div>
    </div>

    <button type="button" class="svc-submit" :class="{ 'is-busy': busy }" :disabled="busy" @click="onSubmit">
      {{ busy ? '正在提交' : '提交报修' }}
    </button>

    <!-- 隐私说明弹层 -->
    <div v-if="noticeOpen" class="svc-sheet-mask" @click.self="noticeOpen = false">
      <div class="svc-sheet" role="dialog" aria-modal="true">
        <h2>个人信息处理说明</h2>
        <p class="svc-ver">版本 {{ PRIVACY_NOTICE_VERSION }}</p>
        <section v-for="sec in PRIVACY_NOTICE_SECTIONS" :key="sec.title">
          <h3>{{ sec.title }}</h3>
          <p v-for="(para, i) in sec.paragraphs" :key="i">{{ para }}</p>
        </section>
        <button type="button" class="svc-submit" @click="noticeOpen = false">我已阅读</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * `/report` 客户报修页（Phase 3-H）。
 *
 * 这一页真正需要小心的只有两件事，其余都是排版：
 *
 * 1) **提交的唯一出口是 submitter.submit()**。
 *    「防连点」不靠 `:disabled`：Vue 的 DOM 更新是异步的，
 *    同一轮事件循环里连发 10 次 click，10 次都会进到 handler，
 *    而 disabled 要等下一次 patch 才生效。真正的收敛在 single-flight（api/public.ts）。
 *    所以这里即使被调用 10 次也是安全的 —— 这是刻意设计的，不是巧合。
 *
 * 2) **privacy_agreed 只有在勾选后才可能出现 true**。
 *    勾选状态就是唯一事实来源（见下方 draft），
 *    绝不存在"从别处拼一个 true 塞进 body"的路径。
 *    后端对未勾选回 400 是**网络层**的兜底，不是可以依赖的第一道防线。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ApiError, createTicketSubmitter, fetchStores, type StoreOption, type TicketDraft, type TicketType } from '../../api/public';
import { navigate, useRoute } from '../../router';
import {
  CONTENT_MAX,
  NAME_MAX,
  fieldOfCode,
  validateField,
  type FieldName,
} from '../../utils/validate';
import {
  PRIVACY_NOTICE_SECTIONS,
  PRIVACY_NOTICE_VERSION,
} from '../../utils/privacy';

const route = useRoute();

// 每个页面实例一个提交器：请求号属于"一次提交意图"，不该跨页面/跨门店复用
const submitter = createTicketSubmitter();

const form = reactive({
  store_code: '',
  ticket_type: 'repair' as TicketType,
  content: '',
  customer_name: '',
  customer_mobile: '',
});

const privacyAgreed = ref(false);
const privacyInvalid = ref(false);
const noticeOpen = ref(false);
const busy = ref(false);
const banner = ref<{ kind: 'error' | 'warn' | 'info'; text: string } | null>(null);
const fieldErrors = reactive<Partial<Record<FieldName, string>>>({});

const stores = ref<StoreOption[]>([]);
const storesLoading = ref(true);
const storesError = ref('');

const contentLength = computed(() => form.content.trim().length);

function clearFieldErrors(): void {
  (Object.keys(fieldErrors) as FieldName[]).forEach((key) => delete fieldErrors[key]);
}

function collectIssues(): void {
  (['store_code', 'ticket_type', 'content', 'customer_name', 'customer_mobile'] as FieldName[]).forEach(
    (field) => {
      const issue = validateField(field, String(form[field] ?? ''));
      if (issue) fieldErrors[field] = issue.message;
    },
  );
}

async function loadStores(): Promise<void> {
  storesLoading.value = true;
  storesError.value = '';
  try {
    stores.value = await fetchStores();
    // 门店预填只认"确实存在于下拉里的编码"：
    // 直接把 ?store= 的值写进 form 会让下拉显示空白但值非空，
    // 用户以为选好了、提交却拿到 STORE_NOT_FOUND。
    const wanted = route.value.query.store;
    if (wanted && stores.value.some((s) => s.code === wanted)) {
      form.store_code = wanted;
    } else if (stores.value.length === 1) {
      // 只有一家门店时替用户选上：既少一步操作，也避免"选错了门店"这类派单事故
      form.store_code = stores.value[0].code;
    }
  } catch (error) {
    storesError.value = (error as Error)?.message || '门店列表加载失败';
  } finally {
    storesLoading.value = false;
  }
}

onMounted(loadStores);

function mapSubmitError(error: unknown): void {
  if (!(error instanceof ApiError)) {
    banner.value = { kind: 'error', text: `提交失败：${(error as Error)?.message ?? '未知错误'}` };
    return;
  }

  const detail = (error.detail ?? {}) as Record<string, unknown>;

  if (error.isNetworkError) {
    // 明确说"没有提交成功"而不是"请重试"：用户最怕的是"到底报没报上"。
    // 这里可以负责任地说"没有"，因为网络层失败意味着请求没能拿到响应，
    // 而**即使**服务端其实已经落库，重试也会因同一 request_id 而回放同一张单，
    // 不会产生第二张 —— 这个保证来自 api/public.ts 保留请求号的策略。
    banner.value = { kind: 'error', text: '网络异常，工单没有提交成功，请检查网络后重试。' };
    return;
  }

  switch (error.code) {
    case 'PRIVACY_NOT_AGREED':
      // 属于"不该发生"（前端已拦），但一旦发生要指得准，否则用户只看到一句报错不知道该点哪
      privacyInvalid.value = true;
      banner.value = { kind: 'error', text: '请先阅读并勾选《个人信息处理说明》后再提交。' };
      return;
    case 'RATE_LIMITED': {
      const scope = String(detail.scope ?? '');
      const seconds = Number(detail.window_resets_in_seconds ?? 0);
      const wait = seconds > 0 ? `，约 ${seconds} 秒后可再试` : '';
      banner.value = {
        kind: 'warn',
        text:
          scope === 'mobile'
            ? `该手机号今日提交次数已达上限${wait}。如有紧急情况请直接联系门店。`
            : `提交过于频繁${wait}。请稍等片刻再试，或联系门店处理。`,
      };
      return;
    }
    case 'DUPLICATE_TICKET': {
      // 后端把原单号放在 detail 里，直接带用户去看那张单 ——
      // 比"请勿重复提交"这种死胡同提示有用得多
      const ticketNo = String(detail.ticket_no ?? '');
      banner.value = {
        kind: 'info',
        text: `您刚刚已提交过相同的请求，正在为您打开原单${ticketNo ? ` ${ticketNo}` : ''}。`,
      };
      if (ticketNo) goSuccess(ticketNo, form.store_code, String(detail.created_at ?? ''));
      return;
    }
    case 'STORE_NOT_FOUND':
    case 'STORE_INACTIVE':
      // 门店在用户填单期间被停用：必须重拉下拉，否则用户会一直对着一个选不了的门店重试
      fieldErrors.store_code = error.message;
      banner.value = { kind: 'error', text: `${error.message}，已为您刷新门店列表。` };
      void loadStores();
      return;
    default: {
      const field = fieldOfCode(error.code);
      if (field) fieldErrors[field] = error.message;
      banner.value = { kind: 'error', text: error.message };
    }
  }
}

function goSuccess(ticketNo: string, storeCode: string, createdAt: string): void {
  const storeName = stores.value.find((s) => s.code === storeCode)?.name ?? '';
  const params = new URLSearchParams({ no: ticketNo });
  if (storeName) params.set('store', storeName);
  if (createdAt) params.set('at', createdAt);
  // replace：提交成功后不该能"返回"到刚填完的表单，否则极易诱发二次提交
  navigate(`/report/success?${params.toString()}`, { replace: true });
}

let navigated = false;

async function onSubmit(): Promise<void> {
  if (navigated) return;

  banner.value = null;
  clearFieldErrors();

  // 门槛先判：与后端 ② 在 ③ 之前的顺序一致（docs/DEV-PLAN Phase 3-G「未勾选一律 400」）
  if (!privacyAgreed.value) {
    privacyInvalid.value = true;
    banner.value = { kind: 'error', text: '请先阅读并勾选《个人信息处理说明》后再提交。' };
    return;
  }
  privacyInvalid.value = false;

  collectIssues();
  if (Object.keys(fieldErrors).length > 0) {
    const first = Object.keys(fieldErrors)[0] as FieldName;
    document.getElementById(FIELD_DOM_ID[first])?.scrollIntoView({ block: 'center' });
    banner.value = { kind: 'error', text: '请检查表单中标红的项' };
    return;
  }

  const draft: TicketDraft = {
    store_code: form.store_code,
    ticket_type: form.ticket_type,
    content: form.content,
    customer_name: form.customer_name,
    customer_mobile: form.customer_mobile,
    source: route.value.query.source || undefined,
  };

  busy.value = true;
  try {
    const created = await submitter.submit(draft);
    navigated = true;
    goSuccess(created.ticket_no, form.store_code, created.created_at);
  } catch (error) {
    mapSubmitError(error);
  } finally {
    busy.value = false;
  }
}

const FIELD_DOM_ID: Record<FieldName, string> = {
  store_code: 'f-store',
  ticket_type: '',
  content: 'f-content',
  customer_name: 'f-name',
  customer_mobile: 'f-mobile',
};
</script>
