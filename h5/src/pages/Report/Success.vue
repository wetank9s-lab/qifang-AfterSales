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

    <div v-if="copied" class="svc-alert is-info">工单号已复制</div>

    <!-- ================= 次要操作：降为文字按钮 ================= -->
    <div class="svc-minor">
      <button v-if="canCopy" type="button" class="svc-link-btn" data-testid="copy-ticket-no" @click="copyTicketNo">
        复制工单号
      </button>
      <span v-if="canCopy" class="svc-dot" aria-hidden="true">·</span>
      <button type="button" class="svc-link-btn" data-testid="report-again" @click="reportAgain">再报一单</button>
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
import { computed, ref } from 'vue';
import { navigate, useRoute } from '../../router';

const route = useRoute();

const ticketNo = computed(() => route.value.query.no ?? '');
/** P11-4：进度 Token（提交响应里一次性下发；无它说明这次没走新链路） */
const progressToken = computed(() => route.value.query.pt ?? '');
const storeName = computed(() => route.value.query.store ?? '');
const createdAtRaw = computed(() => route.value.query.at ?? '');
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

/* 次要操作：一行文字，视觉权重明显低于主按钮 */
.svc-minor {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13.5px;
}

.svc-link-btn {
  border: none;
  background: none;
  padding: 4px 2px;
  color: var(--svc-text-weak);
  font-size: 13.5px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.svc-dot {
  color: var(--svc-text-weak);
}
</style>
