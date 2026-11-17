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
/**
 * Node 内建子路径（P11-3 第 1 项补）。
 *
 * ⚠️ 为什么"只是补了几个声明"值得单独写一段：
 *    tsc 用 `types: []` 不加载 @types/node，而这些 `node:` 子路径**没有任何声明**
 *    ⇒ 报 TS2307 `Cannot find module 'node:fs'`。TS2307 不是本门禁的判红码，
 *    所以它一直是"如实打印但不判红"的积压项 —— **每次跑门禁都在输出里刷屏**。
 *    刷屏的实际后果是：真红灯混在 130+ 行噪音里，人就开始只看最后那行 ✅。
 *    ⇒ 补齐声明是**把噪音降下来**，不是把判据放宽（判据、FATAL_CODES 一行未动）。
 *      补完后 TS2307 由 13 条降到 0 条，改的是**输入**而不是**判据**。
 *    ⚠️ 这一点必须写清楚：否则看起来就像"为了让门禁变绿而放宽标准"。
 */
declare module 'node:fs';
declare module 'node:path';
/**
 * ⚠️ `node:buffer` **不能**像其它几个那样写成无体声明。
 *
 *    无体声明下 `import { Buffer } from 'node:buffer'` 拿到的是一个**命名空间形态**的 any，
 *    而本仓库（`src/shared/media-guard.ts`）把 `Buffer` 同时当**值**（`Buffer.from(...)`）
 *    和**类型**（`buf: Buffer`）用 ⇒ 一律报
 *    `TS2709: Cannot use namespace 'Buffer' as a type`，**30 条**。
 *    （实测：写成无体声明后，本文件诊断总数反而从 134 涨到 148。
 *      这就是"补声明"必须**逐项复核诊断数**、不能只看"TS2307 没了"的原因。）
 *    ⇒ 给它一个带体的声明，把值态与类型态**都**写出来。
 */
declare module 'node:buffer' {
  export const Buffer: any;
  export type Buffer = any;
}
/**
 * `multer` / `qrcode`：由宿主/构建期提供，但本仓库没有它们的类型声明。
 *
 * ⚠️ `qrcode` 是**打进产物**的（见 build-plugin.mjs 的 nodePaths 注释），
 *    在这里声明成 any 只是让 tsc 停止报"找不到模块"；
 *    它**不代表**我们放弃了对它的类型检查 —— 是"没有类型可用"，如实声明为无类型。
 */
declare module 'multer';
declare module 'qrcode';
/**
 * P11-3 第 2 项：历史 Excel 解析器（SheetJS Community Edition）。
 *
 * ⚠️ 它是**宿主镜像提供**的（`/app/nocobase/node_modules/xlsx` = 0.20.3），
 *    构建时被标为 external（见 build-plugin.mjs 的 EXTERNALS），
 *    这里声明成 any 只是让 tsc 停止报"找不到模块"。
 * ⚠️ 版本安全性由**运行时守卫**负责，不靠类型声明：
 *    `version-guard.ts` 会在真正解析前校验 `XLSX.version >= 0.20.2`
 *    （CVE-2023-30533 影响 < 0.19.3；CVE-2024-22363 影响 < 0.20.2）。
 */
declare module 'xlsx';
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
/**
 * `Buffer` 既是**值**也是**类型**（`buf: Buffer`）。
 * 只声明 const 会让所有 `: Buffer` 位置报 TS2749/TS2709（P11-3 第 2 项实测 7 条）。
 * ⇒ 类型态单独声明；它与 `declare const Buffer` 同名但处在不同声明空间，合法。
 */
declare const Buffer: any;
declare type Buffer = any;
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

/**
 * 浏览器全局（A5-G 补）。
 *
 * 背景：本插件里**有客户端代码**（`src/client/**`），但 `tsconfig.check.json`
 * 是 `"types": []` 且没有引入 `lib.dom` ⇒ `window` / `CustomEvent` / `EventListener`
 * 一律 TS2304。它们和上面那批 URL / File / FormData 是同一类问题：
 * **运行时一定存在，只是类型态没有声明**。
 *
 * 用法（2026-11-11 A5-G）：建档区块建完档案后派发 `svc:archive-created`
 * 让同页的档案列表刷新 —— 这是真实体验修复，不该因为门禁缺声明而放弃。
 *
 * ⚠️ 只声明**实际用到的**：`window` 取 `any`（用它的 addEventListener /
 *    dispatchEvent / location 等成员，逐个签名没有收益）；`CustomEvent` 与
 *    `EventListener` 同理。**不要**为了省事 `declare const document: any` 之类
 *    把整个 DOM 搬进来 —— 那会让"真的拼错了 `documnt`"也变成 any 而抓不到。
 */
declare const window: any;
declare const CustomEvent: any;
type EventListener = any;

/**
 * `NodeJS.*` 命名空间类型（P11-3 第 1 项补）。
 * 来源：`@types/node` 未加载，而 `NodeJS.ProcessEnv` 在本仓库被用了 3 处
 * （`public-url.ts` ×2、`store-entry.ts` ×1）⇒ 报 TS2503。
 * ⚠️ 只登记**实际用到**的成员，不整包 `declare namespace NodeJS { ... }` 抄一遍 ——
 *    抄全了就等于给所有 NodeJS 类型开了后门，反而看不出用了什么。
 */
declare namespace NodeJS {
  type ProcessEnv = Record<string, string | undefined>;
}

/**
 * 浏览器全局（B-35R 补）。
 *
 * 背景：`src/client/role-entry-redirect.ts` 需要
 *   · `StorageEvent`  —— 监听 `window` 的 `storage` 事件（跨标签页角色变化）
 *   · `PopStateEvent` —— `history.replaceState` 后派发一次，让 React Router 感知
 * 两者都是**运行时一定存在**的 DOM 全局，与上面的 `window` / `CustomEvent`
 * 完全同类：`tsconfig.check.json` 是 `"types": []` 且无 `lib.dom` ⇒ TS2304。
 *
 * ⚠️ 只声明这两个**实际用到**的构造器，不把整个 lib.dom 搬进来。
 * ⚠️ `document` 也一并声明 —— 这个模块只用它的 `visibilityState` 和
 *    `addEventListener/removeEventListener`，用途极窄（见下方注释）。
 *    不声明 `HTMLElement`/`Node` 等其它 DOM 类型，避免把"真拼错"吞成 any。
 */
declare const StorageEvent: any;
declare const PopStateEvent: any;
/**
 * 上面两个既要当**值**用（`new PopStateEvent(...)`）又要当**类型**用
 * （`(e: StorageEvent) => void` 的形参）⇒ 补同名 type 别名。
 * 只声明 `declare const` 会得到 TS2749：'StorageEvent' refers to a value,
 * but is being used as a type here —— 这是 ts-baseline 门禁抓到的（不是构建时发现）。
 */
type StorageEvent = any;
type PopStateEvent = any;
/** 仅用于 visibilitychange 兜底；本插件其他地方不直接用 document */
declare const document: any;

/**
 * 浏览器全局（B-35R 第 2 次修订：同页内角色变化通知）。
 *
 * 背景：`storage` 事件**只在其他标签页**改 localStorage 时触发，本页自己改不会触发，
 * 而 NocoBase 切角色恰好是**同页改写** ⇒ 必须钩 `Storage.prototype.setItem` 才能拿到通知。
 * 同属"运行时一定存在、只是类型态没声明"一类（`types: []` + 无 `lib.dom`）。
 *
 * ⚠️ 只声明 `Storage`（用它的 `prototype.setItem`），不搬其它 DOM 类型。
 */
declare const Storage: any;
