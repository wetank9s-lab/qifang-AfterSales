<template>
  <ReportPage v-if="route.path === '/report'" />
  <SuccessPage v-else-if="route.path === '/report/success'" />
  <NotFound v-else :path="route.path" />
</template>

<script setup lang="ts">
/**
 * 根组件：只做路由分发。
 *
 * 刻意不引入"布局/导航栏"这一类抽象：两个页面在手机上各自全屏，
 * 没有共享的头部/标签栏，加一层布局容器只会让样式继承关系变复杂。
 */
import ReportPage from './pages/Report/index.vue';
import SuccessPage from './pages/Report/Success.vue';
import NotFound from './pages/NotFound.vue';
import { useRoute } from './router';

const route = useRoute();
</script>
