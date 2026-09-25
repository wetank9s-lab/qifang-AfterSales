<template>
  <ReportPage v-if="route.path === '/report'" />
  <SuccessPage v-else-if="route.path === '/report/success'" />
  <TechnicianVisitPage v-else-if="route.name === 'technician-visit'" :token="route.params.token" />
  <NotFound v-else :path="route.path" />
</template>

<script setup lang="ts">
/**
 * 根组件：只做路由分发。
 *
 * 刻意不引入"布局/导航栏"这一类抽象：几个页面在手机上各自全屏，
 * 没有共享的头部/标签栏，加一层布局容器只会让样式继承关系变复杂。
 *
 * ⚠️ 师傅作业页用 `route.name` 判断，而不是 `route.path` 前缀匹配 ——
 *    路径里带着 Token，前缀匹配会把 `/technician/visit/<token>/whatever`
 *    这类畸形路径也放进去。命名路由由 `router.ts` 的**一条**正则定义，
 *    判定口径只有一处。
 */
import ReportPage from './pages/Report/index.vue';
import SuccessPage from './pages/Report/Success.vue';
import TechnicianVisitPage from './pages/Technician/Visit.vue';
import NotFound from './pages/NotFound.vue';
import { useRoute } from './router';

const route = useRoute();
</script>
