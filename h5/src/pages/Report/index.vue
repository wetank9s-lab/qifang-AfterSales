<template>
  <div class="svc-page">
    <header class="svc-header">
      <h1>{{ headline }}</h1>
      <p>{{ subline }}</p>
    </header>

    <!--
      统一错误/提示横幅。
      ⚠️ `:class="'is-' + banner.kind"` —— 加 `is-` 前缀**不是**装饰：
         `base.css` 里的变体选择器是 `.svc-alert.is-error / .is-warn / .is-info`。
         早期版本写的是 `:class="banner.kind"`，于是渲染出的是 class `error`，
         一个变体都没命中 —— 横幅**在页面上没有任何颜色**，而"报错出现了"这件事
         看起来完全正常（文案在、位置在，只是不显眼）。
         这类"样式选择器与生成类名差一个前缀"的缺陷没有任何断言能发现，
         所以把判据钉在**生成出来的 class 字符串**上（见 verify-phase3-h5.mjs）。
    -->
    <div v-if="banner" class="svc-alert" :class="`is-${banner.kind}`" data-testid="submit-banner">
      {{ banner.text }}
    </div>

    <!-- ================= ① 入口解析中 ================= -->
    <div v-if="entryState === 'loading'" class="svc-card" data-testid="entry-loading">
      <p class="svc-hint">正在确认报修门店…</p>
    </div>

    <!-- ================= ② 入口缺失 / 无效 ================= -->
    <!--
      🔴 这里**刻意不给门店选择器**（req 3）。
      旧版的兜底是"拉门店列表让人自己挑" —— 那等于把"门店归属"
      从"服务端校验过的入口"退化成"用户随手点的一个下拉项"，
      而这一次的整项工作就是要把归属权收回到入口上。
      ⇒ 入口不成立时唯一的正确动作是"回去扫正确的码"，不是"在这里补选一个"。
    -->
    <div v-else-if="entryState === 'error'" class="svc-card" data-testid="entry-error">
      <p class="svc-error" data-testid="entry-error-message">{{ entryError }}</p>
      <p class="svc-hint">
        请用手机扫描门店提供的报修二维码进入本页。二维码损坏或扫不开时，请直接联系门店。
      </p>
      <button type="button" class="svc-submit" data-testid="entry-retry" @click="loadEntry">
        重试
      </button>
    </div>

    <!-- ================= ③ 入口有效：锁定的报修门店 + 表单 ================= -->
    <template v-else-if="store">
      <!-- 门店锁定卡：客户进入后第一眼看到的就是"报修给哪家店"（req 3） -->
      <div class="svc-card svc-store-lock" data-testid="store-lock">
        <span class="svc-store-k">报修门店</span>
        <strong class="svc-store-name" data-testid="store-name">{{ store.name }}</strong>
        <span class="svc-store-code" data-testid="store-code">{{ store.code }}</span>
        <p class="svc-hint">
          本次报修只提交给这家门店。若要报修其他门店，请重新扫描那家门店的二维码。
        </p>
      </div>

      <!--
        旧入口的**诚实提示**（req 5）。
        它必须出现在**客户看得见的位置**，而不是只写在文档里：
        客户有权知道自己手上的链接是不是防篡改的那一种。
      -->
      <div
        v-if="isLegacyEntry"
        class="svc-alert is-warn"
        data-testid="legacy-entry-notice"
      >
        您使用的是门店的<strong>早期通用入口</strong>（旧版二维码）：这种链接只带门店编码、
        没有服务端签名校验，<strong>不具备防篡改保护</strong>。请核对上方门店名称是否正确；
        门店下次印制二维码时会换成带签名的专属链接。
      </div>

      <form class="svc-card" novalidate @submit.prevent="onSubmit">
        <!-- 类型 -->
        <div class="svc-field">
          <span class="svc-label">服务类型<span class="svc-req">*</span></span>
          <div class="svc-segment">
            <button
              type="button"
              :class="{ 'is-active': form.ticket_type === 'repair' }"
              data-testid="ticket-type-repair"
              @click="form.ticket_type = 'repair'"
            >
              报修
            </button>
            <button
              type="button"
              :class="{ 'is-active': form.ticket_type === 'complaint' }"
              data-testid="ticket-type-complaint"
              @click="form.ticket_type = 'complaint'"
            >
              投诉
            </button>
          </div>
          <div v-if="fieldErrors.ticket_type" class="svc-error">{{ fieldErrors.ticket_type }}</div>
        </div>

      <!-- 家电类型（Phase 11 / P11-1 §8.2：固定枚举，选填） -->
      <div class="svc-field">
        <label class="svc-label" for="f-category">家电类型<span class="svc-opt">（选填）</span></label>
        <select
          id="f-category"
          v-model="form.appliance_category"
          class="svc-select"
          :class="{ 'is-invalid': fieldErrors.appliance_category }"
          data-testid="appliance-category"
        >
          <option value="">不填写</option>
          <option v-for="opt in APPLIANCE_CATEGORY_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <div v-if="fieldErrors.appliance_category" class="svc-error">
          {{ fieldErrors.appliance_category }}
        </div>
      </div>

      <!-- 品牌 / 型号（§8.1：**一个**自由文本字段，选填） -->
      <div class="svc-field">
        <label class="svc-label" for="f-brand">品牌 / 型号<span class="svc-opt">（选填）</span></label>
        <input
          id="f-brand"
          v-model="form.brand_model"
          class="svc-input"
          :class="{ 'is-invalid': fieldErrors.brand_model }"
          type="text"
          :maxlength="BRAND_MODEL_MAX"
          data-testid="brand-model"
          placeholder="例如：海尔 BCD-216STPT"
        />
        <div v-if="fieldErrors.brand_model" class="svc-error">{{ fieldErrors.brand_model }}</div>
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
          data-testid="content"
          placeholder="例如：冰箱冷藏室不制冷，压缩机一直响，购买约 2 年"
        ></textarea>
        <div class="svc-hint">
          <span>写清现象与型号，师傅上门更快</span>
          <span>{{ contentLength }}/{{ CONTENT_MAX }}</span>
        </div>
        <div v-if="fieldErrors.content" class="svc-error">{{ fieldErrors.content }}</div>
      </div>

      <!--
        服务地址（§8.1：**客户提交选填**；安排上门前由门店补全）。
        ⚠️ 刻意不在客户侧做"必填"：上门地址常常要等门店回电确认（"是老家还是店里？"），
           在匿名页强制填只会拿到假地址。服务端的"安排上门前应有值"是**门店侧**的提示，
           不是这里的门槛。
      -->
      <div class="svc-field">
        <label class="svc-label" for="f-address">服务地址<span class="svc-opt">（选填）</span></label>
        <input
          id="f-address"
          v-model="form.service_address"
          class="svc-input"
          :class="{ 'is-invalid': fieldErrors.service_address }"
          type="text"
          :maxlength="SERVICE_ADDRESS_MAX"
          data-testid="service-address"
          placeholder="上门地址，如：新都区XX路XX号X栋X单元"
        />
        <div v-if="fieldErrors.service_address" class="svc-error">
          {{ fieldErrors.service_address }}
        </div>
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

      <!--
        紧急标记（§8.1 `urgent`）。
        ⚠️ 定位：它是**客户声明的紧急诉求**，是**提示性标记** ——
           不参与状态机、**不改变任何超时/SLA 口径**（本项目只有一套超时判定：
           Phase 8 的 `runSlaScan`；再建一套"紧急单另一套 SLA"就是第二个 SLA 体系，明令禁止）。
           客户勾了之后门店一眼可见，是否加急仍由门店/师傅按现场判断。
        ⚠️ 当前**只有客户建单时可以置位**；门店侧的调整入口属后续项
           （§9「门店人工新建服务单」与本项的收尾一起做），已在 docs/PHASE-11.md 标注。
      -->
      <div class="svc-card">
        <label class="svc-privacy">
          <input v-model="form.urgent" type="checkbox" data-testid="urgent-flag" />
          <span>紧急<em class="svc-hint-inline">（如冰箱彻底不制冷、已影响正常生活，可勾选让门店优先安排）</em></span>
        </label>
      </div>

      <!-- 隐私勾选（独立成卡：视觉上必须与表单字段区分开，它是准入门槛而不是可选项） -->
      <div class="svc-card">
        <label class="svc-privacy" :class="{ 'is-invalid': privacyInvalid }">
          <input
            v-model="privacyAgreed"
            type="checkbox"
            data-testid="privacy-agreed"
            :aria-invalid="privacyInvalid"
          />
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

      <button
        type="button"
        class="svc-submit"
        :class="{ 'is-busy': busy }"
        :disabled="busy"
        data-testid="submit-open-confirm"
        @click="onSubmit"
      >
        {{ busy ? '正在提交' : '提交报修' }}
      </button>
    </template>

    <!-- ================= ④ 提交前确认报修门店（req 3） ================= -->
    <!--
      为什么"确认门店"要在**提交之前**单独拦一次，而不是靠页面顶部那块信息：
      客户是站在门店里扫码的，扫到**隔壁门店**贴的码是真实会发生的事故，
      而它的后果是"师傅跑错门店/整单归属错误"，事后只能靠人工转单。
      一次确认的成本是一秒，代价差一个量级。
      ⚠️ 确认里显示的**不是**表单里可改的值，而是服务端解析出来的门店名
      —— 它是这一页唯一的事实来源，客户没有"改成别家"的入口（req 3）。
    -->
    <div
      v-if="confirmOpen && store"
      class="svc-sheet-mask"
      data-testid="confirm-store-mask"
      @click.self="confirmOpen = false"
    >
      <div class="svc-sheet" role="dialog" aria-modal="true" data-testid="confirm-store-sheet">
        <h2>确认报修门店</h2>
        <div class="svc-confirm-store">
          <span class="svc-store-k">本次报修提交给</span>
          <strong class="svc-store-name" data-testid="confirm-store-name">{{ store.name }}</strong>
          <span class="svc-store-code">{{ store.code }}</span>
        </div>
        <p class="svc-hint">
          提交后门店会尽快与您联系安排上门。如果这<strong>不是</strong>您要报修的门店，
          请点「返回修改」并按返回键，重新扫描正确门店的二维码。
        </p>
        <button
          type="button"
          class="svc-submit"
          :class="{ 'is-busy': busy }"
          :disabled="busy"
          data-testid="submit-confirm"
          @click="doSubmit"
        >
          {{ busy ? '正在提交' : '确认提交' }}
        </button>
        <button
          type="button"
          class="svc-submit svc-submit-ghost"
          :disabled="busy"
          data-testid="submit-cancel"
          @click="confirmOpen = false"
        >
          返回修改
        </button>
      </div>
    </div>

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
 * `/report` 客户报修页。
 *
 * Phase 3-H 建立，Phase 11 / P11-1 **改掉了门店归属的决定方式**。
 *
 * ---------------------------------------------------------------------------
 * 这一版与上一版最根本的差别：门店从"用户选的"变成"入口给的"
 * ---------------------------------------------------------------------------
 * 旧版：进页面 → `fetchStores()` 拉 15 家门店 → 渲染 `<select>` → 用户选 →
 *       把选中的 `store_code` 放进 body。**门店归属 = 用户在那个下拉里的选择。**
 * 新版：进页面 → 读 URL 上的入口值（`?k=…`，来自门店二维码）→
 *       `fetchStoreEntry()` 问服务端"这枚入口是谁" → 显示门店名（**没有下拉**）→
 *       提交时把入口值原样带上，服务端**按入口决定门店**。
 *
 * 为什么必须这么改（req 2 的原文是"不得仅依赖可随意改写的 `store=S01` 参数、
 * 请求 body、隐藏字段、Referer 或前端本地状态确定门店归属"）：
 *   上面那五样**全都是客户端可控的**。把它们中的任何一个当成归属依据，
 *   等于让客户自己决定"这单算谁的" —— 而这不是安全边界的强弱问题，
 *   是"到底谁说了算"的问题。
 *   ⇒ 归属证据必须是**客户端伪造不出来**的东西：服务端用 `SIGN_SECRET`
 *     签出来的入口（`services/store-entry.ts`）。
 *
 * ---------------------------------------------------------------------------
 * 旧二维码为什么还能用（req 5）
 * ---------------------------------------------------------------------------
 * 已经印出去的门店二维码指向 `?store=S01`（裸编码，无签名）。
 * 它们无法召回，所以必须继续能用；但页面要把这个事实**说出来**：
 * `provenance === 'legacy'` 时显示 `data-testid="legacy-entry-notice"` 那条提示。
 * **不得**把它说得和新入口一样安全 —— 那正是 req 5 禁止的那件事。
 *
 * ---------------------------------------------------------------------------
 * 仍然沿用的两条硬约束（Phase 3-H 立的，没有变）
 * ---------------------------------------------------------------------------
 * 1) **提交的唯一出口是 submitter.submit()**，防连点靠 single-flight 而不是
 *    `:disabled`（Vue 的 DOM 更新是异步的，同一轮事件循环里连发 10 次 click
 *    每次都进 handler，disabled 要等下一次 patch 才生效）。
 * 2) **privacy_agreed 只有在勾选后才可能出现 true**。勾选状态是唯一事实来源，
 *    绝不存在"从别处拼一个 true 塞进 body"的路径。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ApiError,
  createTicketSubmitter,
  fetchStoreEntry,
  type StoreEntry,
  type TicketDraft,
  type TicketType,
} from '../../api/public';
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
// Phase 11 / P11-1：家电分类与字段长度上限。
// ⚠️ 这份与后端是**两份副本**，由 `verify-phase3-h5` 的「H5 常量与后端同源」断言逐字比对
//    （`utils/appliance-options.ts` 文件头解释了为什么不能直接 import 后端那份）。
import {
  APPLIANCE_CATEGORY_OPTIONS,
  BRAND_MODEL_MAX,
  SERVICE_ADDRESS_MAX,
  isApplianceCategory,
} from '../../utils/appliance';

/**
 * 用户**真正能改**的字段集合。
 *
 * ⚠️ 它 `Exclude` 掉 `store_code`，不是"少写一个"：
 *    P11-1 起门店由**入口**决定，页面上没有门店输入项，
 *    `form` 上也就没有 `store_code` 这个键。
 *    用 `Exclude` 而不是 `FieldName` 让**类型系统**承担这条约束 ——
 *    将来谁把 `store_code` 加回这个数组，编译期就会红，
 *    而不是等到运行时拼出一句 "门店编码格式不正确" 挂在没有输入框的字段上。
 */
type EditableField = Exclude<FieldName, 'store_code'>;

/**
 * 页面上的**全部**可校验字段。
 *
 * ⚠️ P11-1 新增的三项（服务地址 / 家电类型 / 品牌型号）**不在** `utils/validate.ts` 的
 *    `FieldName` 里 —— 那份文件镜像的是 `parseDto` 的**既有六项**口径，
 *    而新字段的校验规则是"可选 + 长度/枚举"，与它不同构。
 *    把它们塞进 `FieldName` 会让"六项必填规则"与"三项可选规则"混成一张表。
 *    ⇒ 新字段的规则写在 `validateNewFields()` 里，且**上限常量与后端同源比对**。
 */
type PageField = EditableField | 'service_address' | 'brand_model' | 'appliance_category';

const route = useRoute();

// 每个页面实例一个提交器：请求号属于"一次提交意图"，不该跨页面/跨门店复用
const submitter = createTicketSubmitter();

const form = reactive({
  ticket_type: 'repair' as TicketType,
  // Phase 11 / P11-1 新字段（全部选填）
  appliance_category: '',
  brand_model: '',
  content: '',
  service_address: '',
  customer_name: '',
  customer_mobile: '',
  urgent: false,
});

const store = ref<StoreEntry | null>(null);
const entryState = ref<'loading' | 'ok' | 'error'>('loading');
const entryError = ref('');

const privacyAgreed = ref(false);
const privacyInvalid = ref(false);
const noticeOpen = ref(false);
const confirmOpen = ref(false);
const busy = ref(false);
const banner = ref<{ kind: 'error' | 'warn' | 'info'; text: string } | null>(null);
const fieldErrors = reactive<Partial<Record<PageField, string>>>({});

const contentLength = computed(() => form.content.trim().length);
const isLegacyEntry = computed(() => store.value?.provenance === 'legacy');

/** 顶部标题：**有门店名时直接显示门店名**（req 3：客户进入后直接看到正确门店名称） */
const headline = computed(() => {
  if (entryState.value === 'error') return '报修入口不可用';
  return store.value?.name || '服务报修';
});
const subline = computed(() =>
  store.value ? '提交后门店会尽快与您联系安排上门' : '请扫描门店提供的报修二维码',
);

/**
 * 入口值：`?k=…` 是**新入口**（签名），`?store=…` 是**旧二维码**的形态（req 5 兼容）。
 *
 * ⚠️ 这里**只做取值，不做判定**。"这枚入口是真的吗、它属于哪家门店"
 *    一律由服务端回答（`/api/public/store-entry`）——
 *    前端**永远不可能**比服务端更权威地判断签名，自己判还会把签名算法
 *    复制一份到浏览器（req 2 的反面）。
 */
const entryToken = computed(() => {
  const q = route.value.query as Record<string, string>;
  // `k` 优先：新入口一定带 `k`；两者同时存在时以签名的那个为准
  return String(q.k ?? q.store ?? '').trim();
});

function clearFieldErrors(): void {
  (Object.keys(fieldErrors) as PageField[]).forEach((key) => delete fieldErrors[key]);
}

/**
 * P11-1 新增三项的**客户端**校验。
 *
 * ⚠️ 上限与后端**逐字一致**（`SERVICE_ADDRESS_MAX` / `BRAND_MODEL_MAX` /
 *    `APPLIANCE_CATEGORY_OPTIONS`），由 `verify-phase3-h5` 的同源断言盯住。
 *    不一致的后果是"本地通过、提交被 422"——用户完全无法自救。
 *
 * ⚠️ 三项全部**选填**：空值直接放行（与后端 `parseNewModelFields` 同口径）。
 */
function validateNewFields(): void {
  const address = form.service_address.trim();
  if (address.length > SERVICE_ADDRESS_MAX) {
    fieldErrors.service_address = `服务地址最多 ${SERVICE_ADDRESS_MAX} 字，当前 ${address.length} 字`;
  }
  const brand = form.brand_model.trim();
  if (brand.length > BRAND_MODEL_MAX) {
    fieldErrors.brand_model = `品牌/型号最多 ${BRAND_MODEL_MAX} 字，当前 ${brand.length} 字`;
  }
  const category = form.appliance_category.trim();
  // 下拉本来只给合法值；这里挡的是"手改 DOM / 粘贴 / 旧产物残留"的形态。
  if (category && !isApplianceCategory(category)) {
    fieldErrors.appliance_category = '家电类型不在可选范围内，请重新选择';
  }
}

/**
 * 表单字段校验。**只校验用户真正能改的那四个字段。**
 *
 * ⚠️ `store_code` **已经不在用户输入项里**（门店由入口决定），因此它**不能**
 *    出现在这个循环里 —— `form` 上根本没有这个键（TS 会直接报错，这是好事）。
 *    `utils/validate.ts` 里的 `validateField('store_code', …)` 本身仍然保留：
 *    服务端常量与前端规则的对齐断言（`verify-phase3-h5.mjs`）仍在核对它，
 *    删掉就会让"两边常量漂移"失去唯一的守卫。
 */
const USER_EDITABLE_FIELDS: EditableField[] = [
  'ticket_type',
  'content',
  'customer_name',
  'customer_mobile',
];

function collectIssues(): void {
  USER_EDITABLE_FIELDS.forEach((field) => {
    const issue = validateField(field, String(form[field] ?? ''));
    if (issue) fieldErrors[field] = issue.message;
  });
  // P11-1 新增三项（可选字段，规则不同构 ⇒ 单独一处，见 validateNewFields）
  validateNewFields();
}

/** 解析入口 → 得到"报修给哪家门店"。进页面做的第一件事。 */
async function loadEntry(): Promise<void> {
  entryState.value = 'loading';
  entryError.value = '';
  const token = entryToken.value;
  if (!token) {
    entryState.value = 'error';
    entryError.value = '缺少门店入口信息：请扫描门店提供的报修二维码进入本页。';
    return;
  }
  try {
    store.value = await fetchStoreEntry(token);
    entryState.value = 'ok';
  } catch (error) {
    store.value = null;
    entryState.value = 'error';
    entryError.value =
      error instanceof ApiError
        ? error.message
        : (error as Error)?.message || '门店报修入口校验失败';
  }
}

onMounted(loadEntry);

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
      if (ticketNo) goSuccess(ticketNo, String(detail.created_at ?? ''));
      return;
    }
    case 'STORE_ENTRY_INVALID':
    case 'MISSING_STORE_ENTRY':
    case 'INVALID_STORE_ENTRY':
    case 'STORE_NOT_FOUND':
    case 'STORE_INACTIVE':
      // 🔴 入口/门店在用户填单期间失效（门店被停用、或链接被改过）：
      //    **不能**退化成"让用户重选门店" —— 归属权只认入口。
      //    正确动作是就地把页面切回"入口不可用"态，让客户回去重新扫码。
      banner.value = { kind: 'error', text: `${error.message}，已为您重新校验入口。` };
      void loadEntry();
      return;
    case 'STORE_BINDING_CONFLICT':
      // 服务端发现"入口说 A、body 说 B"（req 4 的拒绝路径）。
      // 正常情况下走不到这里（body 的 store_code 就是从入口解析出来的）；
      // 走到了说明请求被改过 —— 如实说出来，不要含糊成"操作失败"。
      banner.value = {
        kind: 'error',
        text: '提交数据与门店入口不一致，请求已被拒绝。请重新扫描门店二维码后再提交。',
      };
      void loadEntry();
      return;
    default: {
      const field = fieldOfCode(error.code);
      if (field && field !== 'store_code') fieldErrors[field] = error.message;
      banner.value = { kind: 'error', text: error.message };
    }
  }
}

function goSuccess(ticketNo: string, createdAt: string): void {
  const params = new URLSearchParams({ no: ticketNo });
  if (store.value?.name) params.set('store', store.value.name);
  if (createdAt) params.set('at', createdAt);
  // ⚠️ 把入口值也带过去：「再报一单」要回到**同一家门店**的报修页（req 3 的延伸）。
  //    不带的话，成功页点"再报一单"会落到"缺少入口信息"，客户凭空丢掉一次续报能力。
  //    入口值本身是公开的（它就印在墙上那张码里），放进 query 不涉及任何泄露。
  if (entryToken.value) params.set('k', entryToken.value);
  // replace：提交成功后不该能"返回"到刚填完的表单，否则极易诱发二次提交
  navigate(`/report/success?${params.toString()}`, { replace: true });
}

let navigated = false;

/**
 * 「提交报修」的点击入口：**先校验、再弹确认**，真正的提交在 `doSubmit()`。
 *
 * 拆两步的理由写在模板里那段注释（扫错门店是真实场景，值得多一次确认）。
 * 注意校验**必须在弹确认之前**做 —— 反过来的话，用户会先确认一遍"送给某家门店"，
 * 再被一句"请检查表单中标红的项"打回去，确认就变成了纯噪音。
 */
function onSubmit(): void {
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

  if (entryState.value !== 'ok' || !store.value) {
    banner.value = { kind: 'error', text: '门店入口尚未校验通过，请先重新扫描门店二维码。' };
    return;
  }

  collectIssues();
  if (Object.keys(fieldErrors).length > 0) {
    const first = Object.keys(fieldErrors)[0] as PageField;
    document.getElementById(FIELD_DOM_ID[first])?.scrollIntoView({ block: 'center' });
    banner.value = { kind: 'error', text: '请检查表单中标红的项' };
    return;
  }

  confirmOpen.value = true;
}

/** 确认弹层里的「确认提交」。到这里所有校验都已通过。 */
async function doSubmit(): Promise<void> {
  if (navigated || busy.value || !store.value) return;

  const draft: TicketDraft = {
    // 入口值：服务端**唯一**的归属依据（req 4）
    entry: entryToken.value,
    // store_code 仍然带上：服务端把它作为**一致性校验**（req 4：伪造的 body 必须被拒）。
    // 它来自入口解析的结果，正常情况下必然一致；不一致就说明请求被改过 ⇒ 服务端 422。
    store_code: store.value.code,
    ticket_type: form.ticket_type,
    content: form.content,
    customer_name: form.customer_name,
    customer_mobile: form.customer_mobile,
    source: (route.value.query as Record<string, string>).source || undefined,
    // ---- Phase 11 / P11-1 新增（全部选填）----
    // 空值由 `api/public.ts` 的 normalize 归一成"不发这个键"（与后端同口径）
    service_address: form.service_address,
    appliance_category: form.appliance_category,
    brand_model: form.brand_model,
    urgent: form.urgent,
  };

  busy.value = true;
  try {
    const created = await submitter.submit(draft);
    navigated = true;
    confirmOpen.value = false;
    goSuccess(created.ticket_no, created.created_at);
  } catch (error) {
    // 失败 ⇒ 关掉确认层，回到表单（错误横幅在表单上方，
    // 留在确认层里会让用户看不到失败原因）
    confirmOpen.value = false;
    mapSubmitError(error);
  } finally {
    busy.value = false;
  }
}

/**
 * 「字段 → 输入框 DOM id」的映射表。
 *
 * ⚠️ 类型用 `FieldName | 新三项`（即**含** `store_code`），而不是 `PageField`：
 *    `PageField` 刻意排除了 `store_code`（它已经不是用户可改的字段），
 *    但这张表要能回答"**任何**报错该滚到哪里" —— 包括历史遗留的 `store_code` 报错
 *    （服务端若因它返回 422，页面必须能优雅处理，而不是抛一个 TS 错误让人把类型放宽）。
 *    给空串 = "没有对应输入框，不滚动"，是**明确**的表达。
 */
type DomField = FieldName | 'service_address' | 'brand_model' | 'appliance_category';

const FIELD_DOM_ID: Record<DomField, string> = {
  // store_code 已经没有对应的输入框（门店由入口决定）⇒ 给空串。
  // 保留这个键是为了 `DomField` 的完备性（TS 会强制齐全）。
  store_code: '',
  // P11-1 新增三项：让"请检查表单中标红的项"能滚到对应输入框
  service_address: 'f-address',
  appliance_category: 'f-category',
  brand_model: 'f-brand',
  ticket_type: '',
  content: 'f-content',
  customer_name: 'f-name',
  customer_mobile: 'f-mobile',
};
</script>

<style scoped>
/* 门店锁定卡：客户进入后第一眼要看的东西，视觉上必须比表单更靠前、更醒目 */
.svc-store-lock {
  text-align: center;
}
.svc-store-k {
  display: block;
  font-size: 12.5px;
  color: var(--svc-text-weak);
  margin-bottom: 4px;
}
.svc-store-name {
  display: block;
  font-size: 20px;
  line-height: 1.3;
  color: var(--svc-text);
}
.svc-store-code {
  display: inline-block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--svc-text-weak);
}
.svc-confirm-store {
  margin: 12px 0;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  text-align: center;
}
.svc-submit-ghost {
  margin-top: 8px;
  background: #fff;
  color: var(--svc-primary);
  border: 1px solid var(--svc-primary);
}
/* 「（选填）」的弱化标注：它必须比必填星号弱，但不能消失（客户要知道可以不填） */
.svc-opt {
  font-weight: 400;
  font-size: 12px;
  color: var(--svc-text-weak);
  margin-left: 2px;
}
.svc-hint-inline {
  font-style: normal;
  font-size: 12.5px;
  color: var(--svc-text-weak);
}
</style>
