/**
 * 本插件的**类型检查用** ambient 声明（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么需要它（而不是直接跑 tsc）
 * ===========================================================================
 * 插件**不声明依赖**，也不带本地 `node_modules` —— `@nocobase/*`、`koa`、`sequelize`
 * 等在构建时被 esbuild 标记为 **external**（运行时由宿主提供）。
 * ⇒ 直接跑 `tsc` 会得到满屏 `Cannot find module '@nocobase/database'`，
 *   有用的信息被淹没，谁都懒得跑。
 *
 * ⇒ 这里把这些**宿主提供的包**声明成"任意形状"，于是 tsc 能专注检查
 *   **我们自己的代码**。它要挡住的是这一类（本轮真机踩到过）：
 *
 *     · `SERVICE_MODE is not defined` —— 漏 import 一个常量；
 *       esbuild **不做类型检查**，构建照样绿，直到真机走那条业务路径才 ReferenceError → 500。
 *     · 拼错变量名 / 用了未声明的标识符 / 函数调用参数明显不匹配。
 *
 * ⚠️ 能力边界（如实写明，避免把这条门禁当成"类型全对"的证明）：
 *    stubbed 模块的**内部类型**我们看不到 ⇒ 与 NocoBase 类型相关的错误（例如
 *    `db.getCollection()` 返回值的形状、Sequelize 的 options 结构）**检查不到**。
 *    这条门禁负责的是"**标识符层面的低级错误**"，不是"类型系统的完整校验"。
 */
declare module '@nocobase/*';
declare module '@nocobase/database';
declare module '@nocobase/server';
declare module '@nocobase/client';
declare module '@nocobase/utils';
declare module 'node:crypto';
declare module 'crypto';
declare module 'koa';
declare module 'sequelize';
declare module 'lodash';

/** 客户端侧的宿主包（同样由宿主提供，构建时 external） */
declare module 'react';
declare module 'react/jsx-runtime';
declare module 'react-dom';
declare module 'react-dom/client';
declare module 'antd';
declare module '@ant-design/icons';
declare module 'dayjs';

/** Node 内建（tsc 用 `types: []` 时不加载 @types/node，故显式声明用到的几个） */
declare const process: any;
declare const console: any;
declare const Buffer: any;
declare const setTimeout: any;
declare const setInterval: any;
declare const clearTimeout: any;
declare const clearInterval: any;
declare const __dirname: string;
declare const require: any;
/** Node 18+ 的全局 fetch（服务端短信/回执链路在用） */
declare const fetch: any;
declare const Headers: any;
declare const AbortSignal: any;
declare const TextEncoder: any;
declare const TextDecoder: any;

/**
 * 标准 Web/Node 全局。
 *
 * ⚠️ 为什么要显式声明：本配置 `lib: ["ES2020"]`（不含 DOM），而 tsconfig 的
 *    `types` 被清空（不加载 @types/node）⇒ 这些**运行时确实存在**的全局会被
 *    报成 `TS2552 Cannot find name 'URL'`。
 *
 * 🔴 这正是"门禁自己造成的假红"：TS2552 在我们的判据里是**必须判红**的一类
 *    （因为"漏 import 的常量"也报 TS2552），所以缺一个全局声明就会把
 *    **正常的代码**判成"运行时必然 ReferenceError"。
 *    ⇒ 遇到 TS2552 时先分清是"真漏了 import"还是"门禁缺了一个全局声明"，
 *      **不要**为了让门禁变绿去改产品代码。
 */
declare const URL: any;
declare const URLSearchParams: any;
declare const Blob: any;
declare const File: any;
declare const FormData: any;
declare const AbortController: any;
declare const Response: any;
declare const Request: any;
declare const atob: any;
declare const btoa: any;
declare const module: any;
