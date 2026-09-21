<template>
  <div class="svc-page svc-success">
    <div class="svc-mark" aria-hidden="true">✓</div>
    <h1>提交成功</h1>
    <p class="svc-meta-sub">门店会尽快与您联系，请保持手机畅通</p>

    <div class="svc-ticketno">
      <span class="svc-k">工单号（报修时请提供此号）</span>
      <span class="svc-v">{{ ticketNo || '—' }}</span>
    </div>

    <div class="svc-card svc-meta">
      <dl>
        <dt>服务门店</dt>
        <dd>{{ storeName || '—' }}</dd>
        <dt>提交时间</dt>
        <dd>{{ createdAtText }}</dd>
      </dl>
    </div>

    <div v-if="copied" class="svc-alert is-info">工单号已复制</div>

    <button v-if="canCopy" type="button" class="svc-submit" @click="copyTicketNo">复制工单号</button>
    <button
      type="button"
      class="svc-submit"
      style="margin-top: 10px; background: #fff; color: var(--svc-primary); border: 1px solid var(--svc-primary)"
      @click="reportAgain"
    >
      再报一单
    </button>

    <p class="svc-foot">
      如需查询进度或有紧急情况，请直接拨打门店电话。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * `/report/success` 提交成功页（Phase 3-H）。
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
 * 查询串里只有单号/门店名/时间这三个本来就给客户看的值，无敏感信息。
 */
import { computed, ref } from 'vue';
import { navigate, useRoute } from '../../router';

const route = useRoute();

const ticketNo = computed(() => route.value.query.no ?? '');
const storeName = computed(() => route.value.query.store ?? '');
const createdAtRaw = computed(() => route.value.query.at ?? '');

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

/** 回填单页，并清掉 query：避免"再报一单"时把上一单的门店/来源误当成本次的默认值 */
function reportAgain(): void {
  navigate('/report');
}
</script>

<style scoped>
.svc-meta-sub {
  margin: 0;
  color: var(--svc-text-weak);
  font-size: 13.5px;
}

.svc-foot {
  margin-top: 18px;
  font-size: 12.5px;
  color: var(--svc-text-weak);
}
</style>
