<template>
  <div class="svc-page">
    <!-- ================= 头部：只有平台名（用户 A1：不重复门店信息） ================= -->
    <header class="svc-header">
      <h1>四川七方连锁售后服务平台</h1>
    </header>

    <!-- 统一错误/提示横幅（`is-<kind>` 前缀与 base.css 的选择器一致，见下方注释） -->
    <div v-if="banner" class="svc-alert" :class="`is-${banner.kind}`" data-testid="submit-banner">
      {{ banner.text }}
    </div>

    <!-- ================= ① 入口解析中 ================= -->
    <div v-if="entryState === 'loading'" class="svc-card" data-testid="entry-loading">
      <p class="svc-hint">正在确认服务门店…</p>
    </div>

    <!-- ================= ② 入口缺失 / 无效 ================= -->
    <!--
      🔴 这里**刻意不给门店选择器**：门店归属由**入口**决定（服务端签名校验），
      入口不成立时唯一的正确动作是"回去扫正确的码"，不是"在这里补选一个"。
      ⚠️ 但提示语要**面向客户**：用户明确要求不向客户展示签名/防篡改/锁定机制等技术说明，
      所以这里只说"入口无效/已停用，请重新扫描门店二维码"。
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

    <!-- ================= ③ 入口有效：门店信息卡 + 两个入口 ================= -->
    <template v-else-if="store">
      <!--
        门店信息卡：**只**展示 名称 / 电话（可点拨） / 地址（用户 A1 明确列出的三项）。
        ⚠️ 不显示门店编号（S01…）—— 那是内部编码。
        ⚠️ 缺失资料时**不渲染那一行**（库里 15 家的电话目前都是空的，见报告），
           而不是渲染一个空的拨号按钮或"暂无"占位 —— 客户不需要看到系统的缺口。
      -->
      <div class="svc-card svc-store-card" data-testid="store-card">
        <strong class="svc-store-name" data-testid="store-name">{{ store.name }}</strong>
        <a
          v-if="store.phone"
          class="svc-store-phone"
          :href="`tel:${store.phone}`"
          data-testid="store-phone"
        >
          {{ store.phone }}
        </a>
        <p v-if="store.address" class="svc-store-address" data-testid="store-address">
          {{ store.address }}
        </p>
      </div>

      <!-- 两个清楚的入口（用户 A3：报修与投诉真正分开） -->
      <div class="svc-segment svc-mode-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'repair'"
          :class="{ 'is-active': mode === 'repair' }"
          data-testid="mode-repair"
          @click="switchMode('repair')"
        >
          我要报修
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'complaint'"
          :class="{ 'is-active': mode === 'complaint' }"
          data-testid="mode-complaint"
          @click="switchMode('complaint')"
        >
          我要投诉
        </button>
      </div>

      <!-- ================= 报修表单 ================= -->
      <form v-if="mode === 'repair'" class="svc-card" novalidate @submit.prevent="onSubmit">
        <div class="svc-field">
          <label class="svc-label" for="r-name">联系人<span class="svc-req">*</span></label>
          <input
            id="r-name"
            v-model="repairForm.customer_name"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.customer_name }"
            type="text"
            :maxlength="NAME_MAX"
            autocomplete="name"
            data-testid="repair-name"
            placeholder="怎么称呼您"
          />
          <div v-if="fieldErrors.customer_name" class="svc-error">{{ fieldErrors.customer_name }}</div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="r-mobile">手机号码<span class="svc-req">*</span></label>
          <input
            id="r-mobile"
            v-model="repairForm.customer_mobile"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.customer_mobile }"
            type="tel"
            inputmode="numeric"
            maxlength="11"
            autocomplete="tel"
            data-testid="repair-mobile"
            placeholder="11 位手机号，用于师傅联系"
          />
          <div v-if="fieldErrors.customer_mobile" class="svc-error">
            {{ fieldErrors.customer_mobile }}
          </div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="r-content">故障情况<span class="svc-req">*</span></label>
          <textarea
            id="r-content"
            v-model="repairForm.content"
            class="svc-textarea"
            :class="{ 'is-invalid': fieldErrors.content }"
            :maxlength="CONTENT_MAX"
            data-testid="repair-content"
            placeholder="例如：冰箱冷藏室不制冷，压缩机一直响，购买约 2 年"
          ></textarea>
          <div class="svc-hint">
            <span>写清现象与型号，师傅上门更快</span>
            <span>{{ repairContentLength }}/{{ CONTENT_MAX }}</span>
          </div>
          <div v-if="fieldErrors.content" class="svc-error">{{ fieldErrors.content }}</div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="r-category">家电类别<span class="svc-opt">（选填）</span></label>
          <select
            id="r-category"
            v-model="repairForm.appliance_category"
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

        <div class="svc-field">
          <label class="svc-label" for="r-brand">品牌型号<span class="svc-opt">（选填）</span></label>
          <input
            id="r-brand"
            v-model="repairForm.brand_model"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.brand_model }"
            type="text"
            :maxlength="BRAND_MODEL_MAX"
            data-testid="brand-model"
            placeholder="例如：海尔 BCD-216STPT"
          />
          <div v-if="fieldErrors.brand_model" class="svc-error">{{ fieldErrors.brand_model }}</div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="r-address">服务地址<span class="svc-opt">（选填）</span></label>
          <input
            id="r-address"
            v-model="repairForm.service_address"
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

        <!--
          ⚠️ 媒体上传入口**按已交付能力**决定显示：当前 H5 尚未交付任何媒体上传
             （照片/语音/视频属 P11-4）。这里**不渲染** —— 渲染一个点了没反应的入口
             比没有入口更糟（用户 E 条："不用更多技术解释替代简单好用的页面"）。
             能力交付后在此处加一个上传区即可，不需要改本轮任何其它代码。
        -->

        <button
          type="button"
          class="svc-submit"
          :class="{ 'is-busy': busy }"
          :disabled="busy"
          data-testid="submit-repair"
          @click="onSubmit"
        >
          {{ busy ? '正在提交' : '提交报修' }}
        </button>
      </form>

      <!-- ================= 投诉表单（字段与报修**完全不同**） ================= -->
      <form v-else class="svc-card" novalidate @submit.prevent="onSubmit">
        <div class="svc-field">
          <label class="svc-label" for="c-name">联系人<span class="svc-req">*</span></label>
          <input
            id="c-name"
            v-model="complaintForm.customer_name"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.customer_name }"
            type="text"
            :maxlength="NAME_MAX"
            autocomplete="name"
            data-testid="complaint-name"
            placeholder="怎么称呼您"
          />
          <div v-if="fieldErrors.customer_name" class="svc-error">{{ fieldErrors.customer_name }}</div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="c-mobile">手机号码<span class="svc-req">*</span></label>
          <input
            id="c-mobile"
            v-model="complaintForm.customer_mobile"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.customer_mobile }"
            type="tel"
            inputmode="numeric"
            maxlength="11"
            autocomplete="tel"
            data-testid="complaint-mobile"
            placeholder="11 位手机号，便于门店回电"
          />
          <div v-if="fieldErrors.customer_mobile" class="svc-error">
            {{ fieldErrors.customer_mobile }}
          </div>
        </div>

        <div class="svc-field">
          <label class="svc-label" for="c-content">投诉内容<span class="svc-req">*</span></label>
          <textarea
            id="c-content"
            v-model="complaintForm.content"
            class="svc-textarea"
            :class="{ 'is-invalid': fieldErrors.content }"
            :maxlength="CONTENT_MAX"
            data-testid="complaint-content"
            placeholder="请描述您遇到的问题与诉求，我们会尽快核实处理"
          ></textarea>
          <div class="svc-hint">
            <span>写清时间、门店与经过，处理更快</span>
            <span>{{ complaintContentLength }}/{{ CONTENT_MAX }}</span>
          </div>
          <div v-if="fieldErrors.content" class="svc-error">{{ fieldErrors.content }}</div>
        </div>

        <!--
          ⚠️ 用户要求投诉表单"已有能力支持时"可提供**服务单号 / 证据材料**（选填）。
          当前服务端**没有**接收这两项的字段（DTO 白名单里没有），
          ⇒ 按"不制造半成品"的纪律**不渲染**：渲染了却提交不上去，等于骗客户。
          能力交付后在此处加两个选填项即可。
        -->

        <button
          type="button"
          class="svc-submit"
          :class="{ 'is-busy': busy }"
          :disabled="busy"
          data-testid="submit-complaint"
          @click="onSubmit"
        >
          {{ busy ? '正在提交' : '提交投诉' }}
        </button>
      </form>

      <p v-if="banner" class="svc-hint" data-testid="banner-hint"></p>
    </template>

    <!--
      页脚告知（用户 A2：删掉勾选大卡片，但**告知必须仍然可访问**）。
      ⚠️ 这一句就是"行为同意"的载体：客户点提交 = 表达同意。
         审计里如实记 `basis: 'submission'`（见服务端 privacyForAudit）——
         不是"UI 删了所以默认同意"，而是"页面告知了、客户以提交行为表示同意"。
    -->
    <p class="svc-foot" data-testid="privacy-foot">
      提交即表示您已阅读并同意
      <button type="button" class="svc-link" data-testid="privacy-notice-open" @click="noticeOpen = true">
        《个人信息处理说明》
      </button>
      。我们仅为安排上门服务使用您提交的姓名、手机号与问题描述。
    </p>

    <!-- 个人信息处理说明（完整文本，任何时候都可打开） -->
    <div v-if="noticeOpen" class="svc-sheet-mask" @click.self="noticeOpen = false">
      <div class="svc-sheet" role="dialog" aria-modal="true" data-testid="privacy-sheet">
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
 * `/report` 客户报修 / 投诉页。
 *
 * ===========================================================================
 * 2026-10-10 产品决定：**先简化客户页面**（用户 A 段，最高优先级）
 * ===========================================================================
 * 用户的反馈原文是"当前页面重复、啰嗦，报修与投诉混在一起，影响客户操作效率"。
 * 因此本页相对上一版做了五处**减法**（每处都对应一条明确指令）：
 *
 * | # | 删除 / 修改 | 用户原话 |
 * |---|---|---|
 * | 1 | 头部统一为平台名，**不再重复门店名与编号** | 「头部不要再重复显示门店名称和编号」 |
 * | 2 | 门店卡只留 **名称 / 电话（可拨） / 地址**，去掉编号与说明句 | 「只展示：门店名称、门店电话、门店地址」 |
 * | 3 | 删掉"旧链接不具备防篡改保护 / 签名 / 锁定机制"等技术说明 | 「不向客户展示……技术说明。有关安全边界保留在代码、日志和技术文档中」 |
 * | 4 | 删掉**提交前确认弹窗** | 「不再增加重复的确认勾选或额外确认弹窗」 |
 * | 5 | 删掉**隐私勾选大卡片**，改为页脚一句告知 + 可点开的完整说明 | 「删除……大卡片」「不再要求客户完成无必要的额外勾选」 |
 *
 * ⚠️ 这五处**都没有**改动任何服务端校验（用户 D/E 条：界面可以简化，服务端校验不能削弱）：
 *   · 门店归属仍由**入口**决定（`?k=`），坏签名/停用门店仍然被拒；
 *   · 只是 `provenance`（signed/legacy）**不再下发给页面** —— 页面上原来那句提示随之删除，
 *     但服务端**照旧**把来源落进建单事件的 `metadata.entry_provenance` 供审计。
 *     ⇒ 判定没有变少，只是**客户不再需要看到它**。
 *
 * ===========================================================================
 * 报修 / 投诉**真正分开**（用户 A3）
 * ===========================================================================
 * 不是"两个标题 + 同一套字段"，而是**两个独立的表单对象 + 两套校验 + 两个提交器**：
 *   · 字段状态：`repairForm` / `complaintForm`（切换只切 `mode`，两边互不可见）；
 *   · 提交器：`repairSubmitter` / `complaintSubmitter`（**请求号不跨模式复用**）；
 *   · 载荷：由当前模式的表单对象构造 ⇒ **结构上不可能**把报修字段带进投诉。
 * 投诉**不要求**家电类别 / 品牌型号 / 服务地址 / 预约日期 / 故障情况 —— 表单里根本没有它们。
 *
 * ===========================================================================
 * 仍然沿用的一条硬约束（Phase 3-H 立的，没有变）
 * ===========================================================================
 * **提交的唯一出口是 submitter.submit()**：防连点靠 single-flight 而不是 `:disabled`
 * （Vue 的 DOM 更新是异步的，同一轮事件循环里连发 10 次 click 每次都进 handler）。
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
import { CONTENT_MAX, NAME_MAX, validateField, type FieldName } from '../../utils/validate';
import { PRIVACY_NOTICE_SECTIONS, PRIVACY_NOTICE_VERSION } from '../../utils/privacy';
// Phase 11 / P11-1：家电分类与字段长度上限（与后端两份副本，由 verify-phase3-h5 逐字比对）
import {
  APPLIANCE_CATEGORY_OPTIONS,
  BRAND_MODEL_MAX,
  SERVICE_ADDRESS_MAX,
  isApplianceCategory,
} from '../../utils/appliance';

const route = useRoute();

type Mode = 'repair' | 'complaint';

/**
 * 页面上**可校验**的字段（两个表单的并集）。
 *
 * ⚠️ 刻意**不含** `store_code`：门店由入口决定，页面上没有那个输入框。
 * ⚠️ 也**不含** `urgent`：用户明确"普通客户 H5 不展示紧急勾选框"，
 *    且服务端白名单已移除该字段 ⇒ 前端多做一层也没有意义（服务端才是边界）。
 */
type PageField = 'customer_name' | 'customer_mobile' | 'content' | 'appliance_category' | 'service_address' | 'brand_model';

/** 每个模式各自持有一个提交器（请求号不跨模式复用，见文件头） */
const repairSubmitter = createTicketSubmitter();
const complaintSubmitter = createTicketSubmitter();

const mode = ref<Mode>('repair');

/** 报修表单（投诉**不共享**这个对象） */
const repairForm = reactive({
  customer_name: '',
  customer_mobile: '',
  content: '',
  appliance_category: '',
  brand_model: '',
  service_address: '',
});

/** 投诉表单（只有三项。用户要求：投诉不得强制填报修类字段） */
const complaintForm = reactive({
  customer_name: '',
  customer_mobile: '',
  content: '',
});

const store = ref<StoreEntry | null>(null);
const entryState = ref<'loading' | 'ok' | 'error'>('loading');
const entryError = ref('');
const noticeOpen = ref(false);
const busy = ref(false);
const banner = ref<{ kind: 'error' | 'warn' | 'info'; text: string } | null>(null);
const fieldErrors = reactive<Partial<Record<PageField, string>>>({});

const repairContentLength = computed(() => repairForm.content.trim().length);
const complaintContentLength = computed(() => complaintForm.content.trim().length);

/**
 * 入口值：`?k=…`（新签名入口）/ `?store=…`（旧二维码形态）。
 *
 * ⚠️ 这里**只做取值，不做判定**。"这枚入口是真的吗、属于哪家门店"一律由服务端回答
 *   （`/api/public/store-entry`）—— 前端**永远不可能**比服务端更权威地判断签名，
 *   自己判还会把签名算法复制一份到浏览器。
 */
const entryToken = computed(() => {
  const q = route.value.query as Record<string, string>;
  return String(q.k ?? q.store ?? '').trim();
});

function clearFieldErrors(): void {
  (Object.keys(fieldErrors) as PageField[]).forEach((key) => delete fieldErrors[key]);
}

/**
 * 切换入口（报修 ⇄ 投诉）。
 *
 * 🔴 两件必须一起做的事（用户 A3："切换时不能把报修的隐藏字段带进投诉请求"）：
 *   ① **清空另一侧的校验错误** —— 否则切过去会看到"上一张表"的红字，客户以为是自己的问题；
 *   ② **不复用请求号** —— 两个模式各有自己的提交器，且提交载荷只从**当前模式**的表单对象构造
 *      ⇒ "隐藏字段被带过去"在结构上不可能发生（不是靠"记得清空"）。
 * ⚠️ **刻意不自动清空已填内容**：客户在两个表单之间来回看一遍是很常见的
 *   （"我这事到底算报修还是投诉"），清空等于惩罚他。字段状态独立就够安全。
 */
function switchMode(next: Mode): void {
  if (next === mode.value) return;
  mode.value = next;
  clearFieldErrors();
  banner.value = null;
}

/** 解析入口 → 得到"报修给哪家门店"（含名称/电话/地址）。进页面做的第一件事。 */
async function loadEntry(): Promise<void> {
  entryState.value = 'loading';
  entryError.value = '';
  const token = entryToken.value;
  if (!token) {
    entryState.value = 'error';
    entryError.value = '缺少门店入口信息：请扫描门店提供的二维码进入本页。';
    return;
  }
  try {
    store.value = await fetchStoreEntry(token);
    entryState.value = 'ok';
  } catch (error) {
    store.value = null;
    entryState.value = 'error';
    entryError.value =
      error instanceof ApiError ? error.message : (error as Error)?.message || '门店入口校验失败';
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
    // 而**即使**服务端其实已经落库，重试也会因同一 request_id 而回放同一张单。
    banner.value = { kind: 'error', text: '网络异常，工单没有提交成功，请检查网络后重试。' };
    return;
  }

  switch (error.code) {
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
      // 入口/门店在填单期间失效（门店被停用、或链接被改过）：
      // 正确动作是就地把页面切回"入口不可用"态，让客户回去重新扫码 —— **不退化出选择器**。
      banner.value = { kind: 'error', text: `${error.message}，已为您重新校验入口。` };
      void loadEntry();
      return;
    case 'STORE_BINDING_CONFLICT':
      banner.value = {
        kind: 'error',
        text: '提交数据与门店入口不一致，请求已被拒绝。请重新扫描门店二维码后再提交。',
      };
      void loadEntry();
      return;
    default:
      banner.value = { kind: 'error', text: error.message };
  }
}

function goSuccess(ticketNo: string, createdAt: string): void {
  const params = new URLSearchParams({ no: ticketNo });
  if (store.value?.name) params.set('store', store.value.name);
  if (createdAt) params.set('at', createdAt);
  // 把入口值带过去：「再报一单」要回到**同一家门店**的报修页
  if (entryToken.value) params.set('k', entryToken.value);
  // replace：提交成功后不该能"返回"到刚填完的表单，否则极易诱发二次提交
  navigate(`/report/success?${params.toString()}`, { replace: true });
}

/** 校验**当前模式**的表单。返回 true 表示通过。 */
function collectIssues(): boolean {
  clearFieldErrors();
  const active = mode.value === 'repair' ? repairForm : complaintForm;

  // 三项**两边都必填**（联系人 / 手机号 / 事项内容）
  (['customer_name', 'customer_mobile', 'content'] as FieldName[]).forEach((field) => {
    const issue = validateField(field, String((active as Record<string, unknown>)[field] ?? ''));
    if (issue) fieldErrors[field as PageField] = issue.message;
  });

  // 报修侧的可选项（投诉表单没有这些字段 ⇒ 循环不会执行到）
  if (mode.value === 'repair') {
    const address = repairForm.service_address.trim();
    if (address.length > SERVICE_ADDRESS_MAX) {
      fieldErrors.service_address = `服务地址最多 ${SERVICE_ADDRESS_MAX} 字，当前 ${address.length} 字`;
    }
    const brand = repairForm.brand_model.trim();
    if (brand.length > BRAND_MODEL_MAX) {
      fieldErrors.brand_model = `品牌型号最多 ${BRAND_MODEL_MAX} 字，当前 ${brand.length} 字`;
    }
    const category = repairForm.appliance_category.trim();
    if (category && !isApplianceCategory(category)) {
      fieldErrors.appliance_category = '家电类别不在可选范围内，请重新选择';
    }
  }

  return Object.keys(fieldErrors).length === 0;
}

let navigated = false;

/**
 * 提交（**没有确认弹窗** —— 用户 A1 明确要求去掉）。
 *
 * ⚠️ 载荷按**当前模式**构造，字段集合写死在该模式的分支里。
 *    "切换不串字段"不是靠"切换时记得清空"，而是靠**这里根本没有另一侧的键**。
 */
async function onSubmit(): Promise<void> {
  if (navigated || busy.value) return;

  banner.value = null;

  if (entryState.value !== 'ok' || !store.value) {
    banner.value = { kind: 'error', text: '门店入口尚未校验通过，请先重新扫描门店二维码。' };
    return;
  }

  if (!collectIssues()) {
    const first = Object.keys(fieldErrors)[0] as PageField;
    document.getElementById(FIELD_DOM_ID[first])?.scrollIntoView({ block: 'center' });
    banner.value = { kind: 'error', text: '请检查表单中标红的项' };
    return;
  }

  const ticketType: TicketType = mode.value === 'repair' ? 'repair' : 'complaint';
  const source = (route.value.query as Record<string, string>).source || undefined;

  const draft: TicketDraft =
    mode.value === 'repair'
      ? {
          entry: entryToken.value,
          store_code: store.value.code,
          ticket_type: ticketType,
          content: repairForm.content,
          customer_name: repairForm.customer_name,
          customer_mobile: repairForm.customer_mobile,
          source,
          // 三个选填项：空值由 api 层归一成"不发这个键"
          appliance_category: repairForm.appliance_category,
          brand_model: repairForm.brand_model,
          service_address: repairForm.service_address,
          // ⚠️ 这里**没有** urgent：客户侧不设置紧急（用户 A4），
          //    服务端白名单也已移除它 ⇒ 双保险。
        }
      : {
          entry: entryToken.value,
          store_code: store.value.code,
          ticket_type: ticketType,
          content: complaintForm.content,
          customer_name: complaintForm.customer_name,
          customer_mobile: complaintForm.customer_mobile,
          source,
          // ⚠️ 投诉**只有这三项 + 入口**。没有 appliance_category / brand_model /
          //    service_address / 预约日期 / 故障情况 —— 这就是"不串字段"的落点。
        };

  const submitter = mode.value === 'repair' ? repairSubmitter : complaintSubmitter;

  busy.value = true;
  try {
    const created = await submitter.submit(draft);
    navigated = true;
    goSuccess(created.ticket_no, created.created_at);
  } catch (error) {
    mapSubmitError(error);
  } finally {
    busy.value = false;
  }
}

/** 校验失败时"滚到第一个红项"的 DOM id 映射（两个模式共用同一组 id 后缀） */
const FIELD_DOM_ID: Record<PageField, string> = {
  customer_name: 'r-name',
  customer_mobile: 'r-mobile',
  content: 'r-content',
  appliance_category: 'r-category',
  brand_model: 'r-brand',
  service_address: 'r-address',
};
</script>

<style scoped>
/* 门店信息卡：客户进入后第一眼要看的东西（名称 / 电话 / 地址） */
.svc-store-card {
  text-align: center;
}
.svc-store-name {
  display: block;
  font-size: 19px;
  line-height: 1.35;
  color: var(--svc-text);
}
/* 电话做成可点的拨号链接：客户最常做的动作就是"先打个电话问问" */
.svc-store-phone {
  display: inline-block;
  margin-top: 6px;
  font-size: 16px;
  color: var(--svc-primary);
  text-decoration: none;
}
.svc-store-address {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--svc-text-weak);
}
/* 两个入口的切换条：与表单同宽、更醒目（它是这一页的"分叉口"） */
.svc-mode-tabs {
  margin-bottom: 12px;
}
/* 「（选填）」的弱化标注：必须比必填星号弱，但不能消失 */
.svc-opt {
  font-weight: 400;
  font-size: 12px;
  color: var(--svc-text-weak);
  margin-left: 2px;
}
/* 页脚告知 */
.svc-foot {
  margin: 18px 4px 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--svc-text-weak);
}
</style>
