<template>
  <div class="svc-page svc-success">
    <div class="svc-mark" aria-hidden="true">✓</div>
    <h1 data-testid="success-title">{{ isComplaint ? '投诉提交成功' : '报修提交成功' }}</h1>

    <div class="svc-ticketno">
      <span class="svc-k">工单号</span>
      <span class="svc-v" data-testid="ticket-no">{{ ticketNo || '—' }}</span>
    </div>

    <!--
      「当前进度」**如实**显示：刚建单的工单状态是 `NEW`，
      对客户的口径就是"已提交" —— **不写"已受理"**（那要等门店真的受理了才算，
      提前说等于给客户一个假承诺）。
      ⚠️ 这里不请求接口：本页刻意"只从 URL 取数据"（见文件头说明），
         而刚建的单状态必然是"已提交"，所以不需要为一行文案引入一次匿名查询。
    -->
    <div class="svc-status">
      <span class="svc-k">当前进度</span>
      <span class="svc-v" data-testid="current-status">已提交</span>
    </div>

    <div class="svc-card svc-meta">
      <dl>
        <dt>服务门店</dt>
        <dd>{{ storeName || '—' }}</dd>
        <dt>提交时间</dt>
        <dd>{{ createdAtText }}</dd>
      </dl>
    </div>

    <!--
      ================= 主操作：查看处理进度 =================
      P11-4：这是本页**最醒目**的动作 —— 客户提交完最想知道的就是"接下来会怎样"。
      Token 明文只在这一刻经 URL 出现一次（库里只有哈希），本页把它转成可点的按钮。

      ⚠️ 不给"复制链接"：客户把带 Token 的链接转发出去，等于把查询权限一起给了别人。
         按钮本身是导航，不暴露 URL 文本。

      ⚠️ 跳转用**同源相对路径**（`/customer/progress/<token>`）——
         这样手机从 `https://<局域网IP>` 打开时会留在同一个 host，
         不会因为某个绝对地址而被带到 `localhost` 或不存在的域名。
    -->
    <button
      v-if="progressToken"
      type="button"
      class="svc-submit svc-cta"
      data-testid="goto-progress"
      @click="goProgress"
    >
      查看处理进度
    </button>

    <div v-if="copied" class="svc-alert is-info">已复制</div>

    <!--
      UX-LAST-ORDER-01：**默认不保存**。
      只有客户在这里主动勾选，才会把"本单的进度凭证"写进本浏览器；
      自动进入是第二个独立开关，且必须先勾选"记住"。
      ⚠️ 不保存姓名/手机号/地址/故障描述；只存工单号、Token、门店 code、类型与时间。
    -->
    <div v-if="canRemember" class="svc-card svc-remember" data-testid="remember-card">
      <label class="svc-check">
        <input
          type="checkbox"
          data-testid="remember-order"
          v-model="remember"
          @change="applyRemember"
        />
        <span>在此设备记住这张工单</span>
      </label>
      <label class="svc-check" :class="{ 'is-disabled': !remember }">
        <input
          type="checkbox"
          data-testid="auto-open"
          v-model="autoOpen"
          :disabled="!remember"
          @change="applyAutoOpen"
        />
        <span>下次打开本店页面自动进入上一单</span>
      </label>
      <p class="svc-hint" data-testid="remember-hint">
        只保存在本浏览器，换手机或换浏览器无法找回；公共手机请勿勾选。
      </p>
    </div>
    <p v-else class="svc-hint" data-testid="remember-unavailable">
      本单无法在本设备记住（缺少门店或进度凭证）。
    </p>

    <!--
      ================= 次要操作：两个等宽圆角按钮 =================
      ⚠️ 只改**外观**：点击行为（复制 / 再报一单）与业务契约**一字未动**。
      ⚠️ 视觉层级刻意低于主按钮：
         · 高度 44px（主按钮 48px）—— 达到 iPhone 触控下限，但不压过主按钮；
         · 字号 15px / 字重 500（主按钮 17px / 600）；
         · 白底 + 浅灰边框（主按钮是实心主题色）。
      ⚠️ 圆角/边框/底色**全部复用既有变量**（--svc-radius / --svc-border / --svc-card），
         与页面上的信息卡片同一套风格，不新引入按钮主题。
    -->
    <div class="svc-minor">
      <button
        v-if="canCopy"
        type="button"
        class="svc-minor-btn"
        data-testid="copy-ticket-no"
        @click="copyTicketNo"
      >
        <svg class="svc-minor-ico" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14" />
        </svg>
        <span>复制工单号</span>
      </button>
      <button type="button" class="svc-minor-btn" data-testid="report-again" @click="reportAgain">
        <svg class="svc-minor-ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>再报一单</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * `/report/success` 提交成功页（Phase 3-H / P11-4 第三批重做）。
 *
 * 设计要点：这一页**只从 URL 查询串取数据**，不重新请求接口。
 *
 * 原因有两个，都是真实会踩的坑：
 *  1. 刷新页面（客户习惯性下拉刷新）后如果依赖内存里的响应体，数据就没了，
 *     页面会退化成"提交成功但单号是空的"——比不显示更糟。
 *  2. 重新调接口查"我的单"需要一个能按手机号查的匿名接口，
 *     那等于开放一个手机号 → 工单的遍历面。**不能为了这一页引入这种接口。**
 *
 * 所以单号通过 query 传递（replace 跳转，见 Report 页 goSuccess）。
 * 查询串里只有单号/门店名/时间/业务类型/进度凭证这五个值，无敏感信息。
 *
 * ⚠️ **报修与投诉复用这同一个组件**，只按 `type` 切换业务文案（用户要求：
 *    "投诉提交成功页复用已有成功页组件，文案按投诉业务显示，不另造一套成功页"）。
 */
import { computed, onMounted, ref } from 'vue';
import { navigate, useRoute } from '../../router';
// UX-LAST-ORDER-01：本机最近工单（默认不保存；按门店 code 分区；不含客户资料）
import { removeLastOrder, saveLastOrder, setLastOrderAutoOpen } from '../../utils/last-order';
// UX-01D M1：主题跟着总部配置走（成功页无入口参数 ⇒ 只用 hq 配置）
import { ensureUiConfig, setPageTitle } from '../../ui-state';

const route = useRoute();

// 主题在挂载后异步应用；接口失败时保持默认（页面立即可用，不等待网络）
onMounted(() => {
  void ensureUiConfig().then(() => setPageTitle('提交成功'));
});

const ticketNo = computed(() => route.value.query.no ?? '');
/** P11-4：进度 Token（提交响应里一次性下发；无它说明这次没走新链路） */
const progressToken = computed(() => route.value.query.pt ?? '');
const storeName = computed(() => route.value.query.store ?? '');
const createdAtRaw = computed(() => route.value.query.at ?? '');
/** 服务端解析出的门店 code（Report 页带过来）；缺失则不允许"记住" */
const storeCode = computed(() => String(route.value.query.sc ?? '').trim());
const canRemember = computed(() => Boolean(storeCode.value && ticketNo.value && progressToken.value));
const remember = ref(false);
const autoOpen = ref(false);

/** 用户显式勾选"记住"才落盘；取消勾选立即删除，并强制关闭自动进入 */
function applyRemember(): void {
  const checked = remember.value;
  if (!checked) {
    autoOpen.value = false;
    removeLastOrder(storeCode.value);
    return;
  }
  const saved = saveLastOrder({
    storeCode: storeCode.value,
    ticketNo: ticketNo.value,
    token: progressToken.value,
    ticketType: isComplaint.value ? 'complaint' : 'repair',
    createdAt: createdAtRaw.value,
    autoOpen: autoOpen.value,
  });
  if (!saved) {
    remember.value = false;
    autoOpen.value = false;
  }
}

function applyAutoOpen(): void {
  if (!remember.value) return;
  setLastOrderAutoOpen(storeCode.value, autoOpen.value);
}
const isComplaint = computed(() => route.value.query.type === 'complaint');

const createdAtText = computed(() => {
  const raw = createdAtRaw.value;
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
});

const copied = ref(false);

/**
 * 剪贴板 API 在非 HTTPS 或旧 WebView 下不可用（navigator.clipboard 为 undefined）。
 * 拿不到就不显示按钮 —— 比显示一个点了没反应的按钮好。
 */
const canCopy = computed(() => Boolean(ticketNo.value) && Boolean(globalThis.navigator?.clipboard));

async function copyTicketNo(): Promise<void> {
  try {
    await navigator.clipboard.writeText(ticketNo.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    copied.value = false;
  }
}

/**
 * 去进度页。
 *
 * ⚠️ 用 **replace** 而不是 push：进度页带着 Token，留在历史记录里意味着
 *    "后退"能看到它 —— 而这一页的设计前提就是"Token 只在需要时出现"。
 *
 * ⚠️ 路径是**同源相对**的（`/customer/progress/<token>`）：
 *    手机从局域网地址打开时会留在同一 host，不会跳到 localhost。
 */
function goProgress(): void {
  navigate(`/customer/progress/${encodeURIComponent(progressToken.value)}`, { replace: true });
}

/**
 * 回填单页。
 *
 * ⚠️ P11-1 起**必须把入口值带回去**（`?k=`），否则「再报一单」会落到
 *    "缺少门店入口信息"的错误态 —— 客户刚成功报完一单，紧接着就没法续报，
 *    而这不是任何校验失败，纯粹是把 URL 上的入口丢了。
 *
 * 其余 query（单号/门店名/时间/凭证/类型）仍然清掉：它们描述的是**上一单**，
 * 留在地址里会让客户以为这次提交的还是同一张单。
 */
function reportAgain(): void {
  const k = route.value.query.k ?? '';
  navigate(k ? `/report?k=${encodeURIComponent(k)}` : '/report');
}
</script>

<style scoped>
.svc-meta-sub {
  margin: 0;
  color: var(--svc-text-weak);
  font-size: 13.5px;
}

/* 加粗弱化：数字/编号不适合用 CSS 变量名当键（见 .svc-ticketno） */
.svc-v {
  font-weight: 600;
}

/* 「当前进度」一行：与工单号同构，但语气更"状态条" */
.svc-status {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 10px 0 4px;
}

/**
 * 主操作：最醒目。
 * 在既有主按钮 `.svc-submit` 基础上**加高、加大字号、加阴影**，
 * 让它明显区别于下面的文字操作。
 */
.svc-cta {
  margin-top: 18px;
  padding: 15px 0;
  font-size: 16.5px;
  font-weight: 600;
  box-shadow: 0 6px 18px rgba(212, 56, 13, 0.22);
}

/* 次要操作：两个**等宽**圆角按钮，横排 */
.svc-minor {
  display: grid;
  grid-template-columns: 1fr 1fr; /* 1fr 1fr ⇒ 严格等宽，文字长短不会让其中一个变宽 */
  gap: 10px;
  margin-top: 14px;
}

/**
 * 次要按钮：白底 + 浅灰边框 + 圆角（**全部复用既有变量**，与信息卡片同一套风格）。
 *
 * 与主按钮 `.svc-submit` 的对比刻意拉开：
 *   高度 44 vs 48 · 字号 15 vs 17 · 字重 500 vs 600 · 白底 vs 实心主题色
 * ⇒ 客户一眼能看出"哪个是主要动作"，但两个次要按钮本身仍是**正式的按钮**，
 *   不再是下划线文字。
 *
 * ⚠️ 按要求**不用**夸张阴影 / 渐变 / 动画；也没有下划线。
 */
.svc-minor-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px; /* iPhone 手指触控下限 */
  padding: 0 10px;
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  color: var(--svc-text);
  background: var(--svc-card);
  border: 1px solid var(--svc-border);
  border-radius: var(--svc-radius);
  cursor: pointer;
  text-decoration: none; /* 明确不出现下划线 */
  white-space: nowrap; /* 文字不换行、不挤压 */
}

/* 图标：线性描边、跟随文字颜色，尺寸固定 ⇒ 与文字居中对齐 */
.svc-minor-ico {
  width: 17px;
  height: 17px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.svc-minor-btn:active {
  background: var(--svc-bg); /* 按压反馈用既有底色，不引入动效 */
}
</style>
