import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 服务工作台 · 移动端构建配置
 *
 * ===========================================================================
 * 为什么是**独立构建**而不是 NocoBase 插件内嵌（架构决策，理由见 docs）
 * ===========================================================================
 *   实测 NocoBase 2.2.15 前端运行时是 **react-dom 18.2.0 / antd 5.24.2**，
 *   而 Konsta UI 5.x 的文档面向 React 19。
 *   若把 Konsta 打进插件（走 `dist/client/index.js` 的 AMD lane），
 *   最直接的后果是一个页面里跑两份 React（宿主的 18 + 插件的 19）
 *   ⇒ Hooks 报 "Invalid hook call"，且报错位置与真正原因离得非常远。
 *
 *   独立构建把这个风险**从根上消除**：
 *   · 本应用有自己的 <html>、自己的 React、自己的 CSS 管线；
 *   · 与 NocoBase 后台唯一的交集是 `/api/*`（HTTP，不是 JS 模块）；
 *   · 因此不存在双 React、不存在样式污染、不需要动 NocoBase 的构建。
 *
 *   代价：独立部署（静态文件）与一套独立的会话桥接（见 src/api/session.ts）。
 *   收益：可以自由用 Tailwind 4 + Konsta，而不必等 NocoBase 升 React。
 */

/**
 * 输出目录。
 *
 * ⚠️ 刻意**不**放在 `h5/dist` 里 —— H5 那套是 Vue 应用且已被生产使用，
 *    混进去会让 `h5` 的 `emptyOutDir` 把我们删掉（或反过来）。
 *    本应用的产物单独落盘，发布时再由 nginx 配到独立 location。
 */
const OUT_DIR = process.env.SVC_MOBILE_OUT_DIR || 'dist';

export default defineConfig({
  /**
   * `/m/` 前缀：与 `/h5/`、`/admin/` 并列，互不抢占。
   *
   * ⚠️ 必须与 Nginx location 一致。写错的表现是「页面能打开、JS/CSS 全 404」，
   *    而控制台不会告诉你真实原因（它只会报 404）。
   */
  base: '/m/',

  plugins: [
    react(),
    /**
     * Tailwind 4 官方 Vite 插件。
     *
     * ⚠️ 关键：Konsta 的类名（`k-card`、`mx-safe-4`、`text-[17px]` 等）
     *    **写在 node_modules/konsta 的 JS 里**，不在我们的源码里。
     *    Tailwind 4 默认只扫描项目源码；必须显式 `@source` 声明
     *    node_modules 下的库，否则那些类**一个都不会被生成** ——
     *    结果是"组件结构对、样式全无"，且构建**不报任何错**。
     *    对应声明见 src/styles/app.css 顶部的 `@source`。
     */
    tailwindcss(),
  ],

  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    /**
     * 现代移动浏览器目标。
     *
     * 用户已明确：**不需要兼容旧版 iPhone**。
     * 因此可以放心用 ES2020 + 原生 CSS 嵌套（Tailwind 4 产物本身就要求）。
     * 这省掉了一大块 polyfill 体积，也让 bundle 小很多。
     */
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /**
         * 分包策略：**按"变更频率"拆，不按"文件大小"拆**。
         *
         * · react-vendor：几乎永不变化 ⇒ 长缓存
         * · konsta：随 Konsta 版本变化 ⇒ 中缓存
         * · app：每次发布都变 ⇒ 短缓存
         *
         * 这样日常发版时用户只需重下 app 那一段。
         */
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/konsta') || id.includes('node_modules/tailwind-merge')) {
            return 'konsta';
          }
          return undefined;
        },
      },
    },
  },

  server: {
    port: 5273,
    /**
     * 开发态直连本地 nginx（8080 → 443），
     * 这样 `/api` 与本应用**同源**，会话 Cookie 才能被带上。
     *
     * ⚠️ 用 `127.0.0.1:8080` 而不是 `https://127.0.0.1`：
     *    本地 nginx 的 80 会 301 到 443，而 443 用的是自签证书。
     *    Vite 代理到 http 再让服务端 301 会丢 Cookie（跨协议）。
     *    因此这里直接指向 443 并放开证书校验（仅开发态）。
     */
    proxy: {
      '/api': {
        target: 'https://127.0.0.1',
        changeOrigin: false,
        secure: false,
        /**
         * ⚠️ `secure: false` 只在本机开发时接受自签证书。
         *    这段配置**不会**进入构建产物（vite 的 server 段只在 dev 用）。
         */
      },
    },
  },
});
