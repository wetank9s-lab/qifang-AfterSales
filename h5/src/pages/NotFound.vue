<template>
  <div class="svc-page">
    <header class="svc-header">
      <h1>页面不存在</h1>
      <p>地址：{{ path || '/' }}</p>
    </header>
    <div class="svc-card">
      <p style="margin: 0 0 12px">
        请通过门店提供的二维码或链接进入报修页面。若您是从二维码进来的，可能是链接已失效。
      </p>
      <button type="button" class="svc-submit" @click="go">前往报修页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 兜底页。
 *
 * 存在的理由不是为了好看，而是**为了不静默**：
 * SPA 的 nginx 兜底把任何未知路径都回 index.html（`try_files ... /h5/index.html`），
 * 于是"链接拼错了"和"页面正常但数据没加载出来"在用户眼里都是**白屏**。
 * 有一个明确的兜底页，用户至少知道该去找门店要新二维码，而不是反复刷新。
 */
import { navigate } from '../router';

defineProps<{ path: string }>();

function go(): void {
  navigate('/report');
}
</script>
