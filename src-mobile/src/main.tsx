/**
 * 移动端应用入口。
 *
 * ⚠️ 这里刻意**不引入 antd、不引入任何 NocoBase 客户端包** ——
 *    这是"双 React 风险归零"的物理保证：构建产物里根本没有宿主的那份 React。
 *    一旦有人为了"复用某个组件"而从 `@nocobase/client` import，
 *    这条约束就被打破了。见 vite.config 顶部关于架构选择的说明。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { AppRouter } from './AppRouter';

const el = document.getElementById('svc-root');
if (!el) {
  // 根节点缺失说明 index.html 与构建产物不匹配（通常是 nginx 配错了 location）。
  // 直接抛错比静默白屏好：白屏时用户只会"再点一次"，而这里至少留下一条日志。
  throw new Error('#svc-root not found —— index.html 与构建产物不匹配');
}

/**
 * 主题：**恒为浅色**（2026-11-14 产品裁决）
 *
 *   原 `bootTheme()` 会读 localStorage 与 `prefers-color-scheme`，
 *   给 `<html>` 挂 `.dark`。用户明确取消深色模式：
 *   "无论手机系统设置如何，业务界面保持统一浅色。"
 *
 *   ⇒ 这里只做一件事：**确保没有任何 `.dark` 残留**。
 *     不是"什么都不做" —— 老用户浏览器里可能存着上一版的
 *     `svc.mobile.theme=dark`，而 index.html 也可能带着旧 class。
 *     显式清掉，避免升级后出现"只有某些用户是深色"的幽灵问题。
 */
function enforceLightTheme() {
  document.documentElement.classList.remove('dark');
  try {
    // 旧版本残留的偏好键，留着只会在下次恢复深色时"复活"
    localStorage.removeItem('svc.mobile.theme');
  } catch {
    /* 隐私模式下 localStorage 可能抛错 —— 忽略，class 已经清掉了 */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#F2F2F7');
}
enforceLightTheme();

createRoot(el).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
