/**
 * 客户端入口（Phase 4-H）。
 *
 * ⚠️ 这个文件的存在本身就是**必需**的，不只是"以后要加按钮所以先建个壳"。
 *
 * 背景（真机取证，2026-09-21）：
 *   NocoBase 后台 SPA 启动时会向 `GET /api/pm:listEnabled` 要**全部已启用插件**的
 *  客户端入口 URL，然后逐个动态加载：
 *
 *     /static/plugins/@local/service-ticket/dist/client/index.js
 *
 *   而服务端 `listEnabledPlugins()`（@nocobase/server/lib/plugin-manager/options/resource.js）
 *   **不检查该文件是否存在** —— 它只是在文件存在时追加一个 `?hash=` 查询串，
 *   URL 无论如何都会返回给前端。于是"插件只有服务端、没有客户端产物"的后果是：
 *
 *     · 前端 `<script>` 404 → requirejs 抛 `Script error for "@local/service-ticket"`
 *     · 整个后台渲染成 "App error"，**登录页都出不来**
 *     · 但所有 `/api/*` 接口、三套校验脚本**全部照常全绿**
 *
 *   也就是说：本项目此前 Phase 0~4 的后台一直是打不开的，而没有任何断言能发现它
 *   —— 因为断言只打了接口这一侧。这属于典型的"测试覆盖的那一侧全绿、
 *   没覆盖的那一侧全瞎"，也正是 4-H 必须补上的第一课。
 *
 * 产物约定（与镜像内核心插件完全一致，见 @nocobase/plugin-users/dist/client/index.js）：
 *   dist/client/index.js —— AMD/UMD 形态，`define()` 注册模块，
 *   默认导出必须是 `Plugin` 的子类。
 *   由 scripts/build-plugin.mjs 的 buildClient() 生成，不手写。
 */
import { Plugin } from '@nocobase/client';

/**
 * 客户端插件类。
 *
 * `load()` 里注册的都是**界面层增强**；任何业务规则都不在这里实现 ——
 * 服务端才是唯一事实来源（这也是 H 步反复强调"前端不传 store_id 过滤"的原因：
 * 门店隔离必须由服务端权限决定，前端只负责展示服务端已经裁剪过的数据）。
 */
export default class ServiceTicketClient extends Plugin {
  async load(): Promise<void> {
    // Phase 4-H 的区块/动作增强在此注册。
    // 当前阶段先保证"后台能打开"这一件事 —— 见上方注释，这是此前最严重的未交付项。
  }
}
