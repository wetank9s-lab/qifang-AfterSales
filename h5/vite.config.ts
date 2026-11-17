import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 生产构建**排除开发专用工件**。
 *
 * `public/` 下的文件会被原样复制进 `dist` —— 包括 `xss-test.html`。
 * 它是开发期的 XSS 验证页（引用同一份 archive-render.js 注入攻击串），
 * 虽然不含敏感数据，但它是**测试工件**，不应出现在对外站点上。
 *
 * 为什么用构建钩子而不是"记得手动删"：
 *   手动步骤在忙的时候一定会漏，而漏掉的后果是一个能公开访问的测试页面。
 *   放在构建里，任何人 `npm run build` 都会得到干净的产物。
 */
function stripDevOnlyArtifacts() {
  return {
    name: 'strip-dev-only-artifacts',
    apply: 'build' as const,
    closeBundle() {
      const target = path.resolve(__dirname, 'dist/xss-test.html');
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log('[build] 已移除开发专用工件：dist/xss-test.html');
      }
    },
  };
}

/**
 * 客户端 H5 构建配置。
 *
 * 关键点只有一条：`base: '/h5/'`。
 * nginx 侧是 `location ^~ /h5/ { alias /usr/share/nginx/html/h5/; ... }`，
 * 也就是说浏览器请求 `/h5/assets/xxx.js`，磁盘上是 `<dist>/assets/xxx.js`。
 * 若这里用默认的 `base: '/'`，产物会写死 `/assets/xxx.js` ——
 * 那个路径在 nginx 上落到 `location /`（反代给 NocoBase），
 * 表现是"页面能打开、样式和 JS 全 404"，且控制台不会指向真正的原因。
 *
 * `emptyOutDir: true` 是必须的：h5/dist 是 bind mount 的宿主目录，
 * 里面**还要留一个 .gitkeep**（见 .gitignore 的说明），所以不能整个删掉目录，
 * 只能清空内容 —— Vite 默认行为正是清空内容而非删除目录。
 */
export default defineConfig({
  base: '/h5/',
  plugins: [vue(), stripDevOnlyArtifacts()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    // 覆盖到 iOS 12 / Android 7 级别的 WebView：门店客户扫码进来的机器普遍偏旧
    target: 'es2019',
    sourcemap: false,
    // 单入口，不需要分包；关掉体积告警阈值噪音
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    // 开发态直连本地 docker 的 nginx 入口，避免跨域与手改 base
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
