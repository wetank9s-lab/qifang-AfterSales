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
// Phase 11 / P11-0：门店列表的**每行唯一主动作**（标签与行为随状态变）
import { buildPrimaryActionModel } from './primary-action';
// Phase 11 / P11-0 · B-15：状态 Tab 的**服务端筛选**（补框架缺失的"加载时应用"）
import { buildTabFilterModel } from './tab-filter';
// Phase 11 / P11-1：门店报修入口（链接 + 二维码）—— 后台"复制/下载"那一侧
import { buildStoreEntryActionModel } from './store-entry-action';
// Phase 11 / P11-2：门店人工新建服务单
import { buildTicketCreateActionModel } from './ticket-create-action';
// P11-3 第 3 项：历史 Excel 导入向导（上传 → 映射 → 预览 → 暂存）
import { buildHistoricalImportActionModel } from './historical-import-wizard';
// UX-01A / A2：工单号列 → 可点击链接（派生宿主的 DisplayTextFieldModel；不新增行按钮）
import { buildTicketNoLinkModel } from './ticket-no-link';
// UX-01A / A1：门店售后服务工作台（派生宿主区块模型的自定义区块；不新增页面系统）
import { buildStoreWorkbenchModel } from './store-workbench';
import { buildHistoricalArchivesModel } from './historical-archives-block';
// UX-01C：总部配置项编辑（「服务时效」页的行内「修改」）
import { buildConfigEditActionModel } from './config-edit-action';
// UX-01C-R7：门店资料编辑（「门店报修入口」页的行内「门店资料」）
import { buildStoreProfileActionModel } from './store-profile-action';
// UX-01C-R8：短信通知（自定义区块：通道能力 + 三项配置 + 最近发送记录）
import { buildSmsCenterModel } from './sms-center';
// UX-01D M1：客户页面装修（自定义区块：品牌/主题/文案 + 真实 iframe 预览 + 发布/回滚）
import { buildPageThemeModel } from './page-theme-model';
// SEC-STORE-01：门店账号 ↔ 授权门店（总部管理员）
import { buildStoreAccountsModel } from './store-accounts-model';
import { CLIENT_BUILD_LINE } from './build-stamp';

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
import { installViewerReadonly } from './viewer-readonly';
import { installDateRangeModel } from './date-range-item-model';

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

    // BE-04-DATE / Q2：注册**独立**日期模型（新名字，不覆盖任何框架模型）。
    // 真正把它用到页面上，靠 post-seed 的 `flowModels:update`（见 patch-be04-date-model.mjs）。
    try {
      const status = installDateRangeModel(this.app?.flowEngine);
      // eslint-disable-next-line no-console
      console.log('[service-ticket] BE04 date model:', status);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[service-ticket] BE04 date model 注册失败（后台不受影响）：', error);
    }

    // BE-01-S0：viewer 只读展示修正。
    // ⚠️ **必须独立于上面的 try**：`registerTicketActions()` 一旦抛错（引擎 API 变动、
    //    403 噪声等），排在它后面的代码就不会执行 —— 实测就是这样导致补丁静默失效。
    try {
      installViewerReadonly(this.app?.apiClient);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[service-ticket] viewer 只读展示修正未启用（不影响后台）：', error);
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

    // UX-01A / A2：工单号列的**字段模型**基类（宿主提供）。
    // 取不到就静默跳过（工单号退化为普通文本），绝不因此让后台渲染失败。
    const DisplayTextFieldModel =
      engine.getModelClass?.('DisplayTextFieldModel') ?? (flowEngineModule as any)?.DisplayTextFieldModel;

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
     *
     * ⚠️ `responseType` 是 Phase 6 · P6-0 新增的透传项，**不是可选增强**：
     *    私有照片按 `docs/PHASE-6.md` §4.3a 走"authenticated fetch → Blob"，
     *    而 `<img src>` 无法带 Authorization 头 —— 唯一可行路径就是
     *    用带登录态的请求把图片取成 Blob，再用 `URL.createObjectURL()` 交给 `<img>`。
     *    axios 只有拿到 `responseType: 'blob'` 才会把响应体解析成 Blob
     *    （否则会把二进制当文本处理，得到一张打不开的图）。
     *    与 `headers` 同理：这里**不做任何隐式假设**，由调用方显式声明。
     */
    const request = async (
      url: string,
      method = 'get',
      body?: unknown,
      options?: { headers?: Record<string, string>; responseType?: string },
    ): Promise<any> => {
      const res = await apiClient.request({
        url,
        method,
        ...(body !== undefined ? { data: body } : {}),
        ...(options?.headers ? { headers: options.headers } : {}),
        ...(options?.responseType ? { responseType: options.responseType } : {}),
      });
      // `responseType: 'blob'` 时 `res.data` 就是 Blob 本身，这里原样返回，
      // 由调用方负责 createObjectURL / revokeObjectURL 的生命周期。
      return (res as any)?.data ?? res;
    };

    // ⚠️ 必须在 `models` 之前取：`HistoricalImportEntryBlockModel` 要它当基类，
    //    而 `models` 里的 ActionModel 也由同一次 build 产出（拆成两个键分别注册）。
    const BaseBlockModel =
      engine.getModelClass?.('MarkdownBlockModel') ?? engine.getModelClass?.('TableBlockModel');
    const histImportBuilt = buildHistoricalImportActionModel({
      ActionModel,
      ActionSceneEnum,
      request,
      BaseBlockModel,
    });

    const models = {
      ...buildTicketActionModels({ ActionModel, ActionSceneEnum, request }),
      // Phase 11 / P11-0：主动作模型与其余模型同批注册 ——
      // seed 只挂它，其余模型仍注册（供服务详情内部复用），但**不再出现在列表行上**
      ...buildPrimaryActionModel({ ActionModel, ActionSceneEnum, request }),
      // Phase 11 / P11-0 · B-15：状态 Tab 的服务端筛选承载者（**不渲染任何按钮**）
      ...buildTabFilterModel({ ActionModel }),
      // Phase 11 / P11-1：门店报修入口（req 1）—— 挂在 `stores` 表的行操作列上，
      // 由 `scripts/seed-admin-pages.mjs` 播种。它不渲染在工单表上，
      // 所以与 `ACTION_GROUP_MODELS` 那圈注册无关，但**必须**在本对象里才能被引擎解析。
      ...buildStoreEntryActionModel({ ActionModel, ActionSceneEnum, request }),
      // P11-3：历史 Excel 导入向导（ActionModel 形态，供工具栏挂载；页面入口用下面的 BlockModel）
      HistoricalImportWizardModel: histImportBuilt.HistoricalImportWizardModel,
      // Phase 11 / P11-2：门店人工新建服务单（挂在工单列表**区块工具栏**上）
      ...buildTicketCreateActionModel({ ActionModel, ActionSceneEnum, request }),
      // P11-3：历史 Excel 导入向导（挂在「历史导入批次」表的**区块工具栏**上）
      // UX-01C：配置项编辑（「服务时效」页的行操作列）—— 必须注册，否则页面拿到 use 也解析不到模型
      ...buildConfigEditActionModel({ ActionModel, ActionSceneEnum, request }),
      // UX-01C-R7：门店资料编辑（仅服务端判 hq_admin；前端不猜权限）
      ...buildStoreProfileActionModel({ ActionModel, ActionSceneEnum, request }),
    };
    // UX-01A / A2：**字段级**模型（工单号链接）。与动作模型分开注册：
    //   它不渲染按钮、不进动作组，只作为"某一列的字段模型"被页面引用。
    const fieldModels = buildTicketNoLinkModel({
      BaseFieldModel: DisplayTextFieldModel,
      request,
    });

    // UX-01A / A1：工作台区块模型 —— 基类在上面已取（`BaseBlockModel`）。
    const blockModels = {
      ...buildStoreWorkbenchModel({ BaseBlockModel, request, app }),
      ...buildHistoricalArchivesModel({ BaseBlockModel, request }),
      // UX-01C-R8：短信通知区块（同样派生宿主区块模型，不新增页面系统）
      ...buildSmsCenterModel({ BaseBlockModel, request }),
      // UX-01D M1：客户页面装修区块（同上）
      ...buildPageThemeModel({ BaseBlockModel, request }),
      // BE-02A-S3：历史数据导入页入口（按钮 + 复用同一个 Wizard）
      HistoricalImportEntryBlockModel: histImportBuilt.HistoricalImportEntryBlockModel,

      // SEC-STORE-01：门店账号授权区块
      ...buildStoreAccountsModel({ BaseBlockModel, request }),
    };

    const names = Object.keys(models);
    if (names.length === 0) return;

    // ① 注册模型类本身
    if (typeof engine.registerModels === 'function') {
      engine.registerModels(models);
      // 字段级模型单独注册（不参与下面的动作组注册）
      if (Object.keys(fieldModels).length > 0) {
        engine.registerModels(fieldModels);
      }
      // 区块级模型单独注册（同上：不进动作组）
      if (Object.keys(blockModels).length > 0) {
        engine.registerModels(blockModels);
      }
    }

    // ② 挂到各个动作组 —— 不挂的话后台"配置动作"菜单里选不到它们。
    //    与内置插件（plugin-action-custom-request）的做法一致。
    for (const groupName of ACTION_GROUP_MODELS) {
      const GroupModel = engine.getModelClass?.(groupName);
      if (typeof GroupModel?.registerActionModels === 'function') {
        GroupModel.registerActionModels(models);
      }
    }

    // ① 排障用：控制台能直接看到注册了哪些动作
    // eslint-disable-next-line no-console
    console.debug('[service-ticket] 已注册客户端动作：', names.join(', '));

    // ② 构建标记：**这一行是给真人看的**，用来回答"我的浏览器跑的是不是最新产物"。
    //    用 info 级别（debug 在 DevTools 里默认被过滤掉）。理由见 build-stamp.ts。
    // eslint-disable-next-line no-console
    console.info(CLIENT_BUILD_LINE);
  }
}
