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
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 本文件唯一不可退让的约束：**`load()` 绝不抛出。**
 *
 *   客户端插件处在后台 SPA 启动的关键路径上，这里抛一个错就是整页
 *   "App error"（与上面那段事故同型）。而 H3/H6 依赖的引擎 API 是**运行时
 *   动态取得**的（不同小版本未必导出 `ActionModel`），拿不到就静默降级 ——
 *   宁可"按钮没出现"，也绝不能"后台打不开"。
 */
import { Plugin } from '@nocobase/client';

// flow-engine 的客户端 API。运行时可解析（已取证：内置插件
// @nocobase/plugin-action-export 的 UMD 依赖数组里就有 `@nocobase/flow-engine`）。
import * as flowEngineModule from '@nocobase/flow-engine';

import { buildTicketActionModels } from './ticket-actions';

/** 行级动作要挂进去的动作组（表格行内 / 工具栏 / 表单） */
const ACTION_GROUP_MODELS = [
  'RecordActionGroupModel',
  'CollectionActionGroupModel',
  'FormActionGroupModel',
];

/**
 * 客户端插件类。
 *
 * `load()` 里注册的都是**界面层增强**；任何业务规则都不在这里实现 ——
 * 服务端才是唯一事实来源（这也是 H 步反复强调"前端不传 store_id 过滤"的原因：
 * 门店隔离必须由服务端权限决定，前端只负责展示服务端已经裁剪过的数据）。
 */
export default class ServiceTicketClient extends Plugin {
  async load(): Promise<void> {
    // 一切都包在 try 里：这里的任何异常都会让整个后台渲染失败，
    // 而漏掉几个按钮只是功能缺失 —— 两者的严重性差一个数量级。
    try {
      this.registerTicketActions();
    } catch (error) {
      // 只打到控制台：不要因为按钮没注册上就把后台弄崩。
      // 这条日志也是排障时唯一能看出"引擎 API 变了"的线索。
      // eslint-disable-next-line no-console
      console.error('[service-ticket] 客户端动作注册失败（后台其余功能不受影响）：', error);
    }
  }

  private registerTicketActions(): void {
    const app: any = this.app;
    const engine: any = app?.flowEngine;
    if (!engine) {
      throw new Error('app.flowEngine 不存在，无法注册业务动作');
    }

    // 基类优先从模块取，取不到再问引擎要已注册的模型类 ——
    // 两条路都走，是为了在 flow-engine 的小版本差异下仍能工作。
    const mod: any = flowEngineModule ?? {};
    const ActionModel = mod.ActionModel ?? engine.getModelClass?.('ActionModel');
    const ActionSceneEnum = mod.ActionSceneEnum ?? { record: 'record', collection: 'collection' };
    if (!ActionModel) {
      throw new Error('取不到 ActionModel 基类，跳过业务动作注册');
    }

    const apiClient: any = app.apiClient;
    if (!apiClient?.request) {
      throw new Error('app.apiClient.request 不存在，无法调用业务接口');
    }

    /**
     * 统一的请求函数。
     *
     * 走 `apiClient` 而不是裸 `fetch`：它带着登录态与 401 处理。
     * 不这么做的话，"登录过期"会表现为一个看不懂的 401，而不是自动跳登录页。
     *
     * ⚠️ 第四个参数的 `headers` 是**必需能力**而不是可选增强：
     *    服务端六个内部写动作都要求合法的 UUID v4 的 `X-Request-Id`，
     *    它同时是链路追踪锚点与幂等键（同一请求重放不会产生第二条 Visit / Token / 短信）。
     *    这里不依赖任何"框架会不会自动加"的隐式行为 —— 请求号由「按钮那一次点击」
     *    生成并一路传到这里（见 ticket-actions.tsx 的 newRequestId）。
     *
     * `apiClient.request()` 在没有 `resource` 时直接把 config 交给 axios，
     * 因此 `headers` 原样透传（容器内 @nocobase/sdk/lib/APIClient.js 已取证）。
     */
    const request = async (
      url: string,
      method = 'get',
      body?: unknown,
      options?: { headers?: Record<string, string> },
    ): Promise<any> => {
      const res = await apiClient.request({
        url,
        method,
        ...(body !== undefined ? { data: body } : {}),
        ...(options?.headers ? { headers: options.headers } : {}),
      });
      return (res as any)?.data ?? res;
    };

    const models = buildTicketActionModels({ ActionModel, ActionSceneEnum, request });
    const names = Object.keys(models);
    if (names.length === 0) return;

    // ① 注册模型类本身
    if (typeof engine.registerModels === 'function') {
      engine.registerModels(models);
    }

    // ② 挂到各个动作组 —— 不挂的话后台"配置动作"菜单里选不到它们。
    //    与内置插件（plugin-action-custom-request）的做法一致。
    for (const groupName of ACTION_GROUP_MODELS) {
      const GroupModel = engine.getModelClass?.(groupName);
      if (typeof GroupModel?.registerActionModels === 'function') {
        GroupModel.registerActionModels(models);
      }
    }

    // 排障用：控制台能直接看到注册了哪些动作
    // eslint-disable-next-line no-console
    console.debug('[service-ticket] 已注册客户端动作：', names.join(', '));
  }
}
