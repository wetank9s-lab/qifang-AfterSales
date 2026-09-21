/**
 * 客户端 H5 入口。
 *
 * 全站只有两个页面，因此不做懒加载分包 ——
 * 手机扫码进来的场景里，"少一次往返"比"首包小几 KB"重要得多。
 */
import { createApp } from 'vue';
import App from './App.vue';
import './styles/base.css';

createApp(App).mount('#app');
