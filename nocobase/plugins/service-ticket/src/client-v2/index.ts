/**
 * 客户端入口 **v2**（移动端 / 新版 FlowEngine SPA 专用）。
 *
 * ===========================================================================
 * 为什么必须有这个文件（2026-11-10 实测取证）
 * ===========================================================================
 *   NocoBase 2.2 有两套客户端 lane：
 *     · 旧后台      → `dist/client/index.js`
 *     · 新版 SPA（含 `/v/mobile/*`）→ `dist/client-v2/index.js`
 *
 *   实测：移动页只请求 69 个插件的 `dist/client-v2/index.js`，
 *   本插件的 `dist/client/index.js` **一次都没被请求**。
 *   ⇒ `src/client/index.ts` 里注册的那批模型（SmsCenterModel / StoreWorkbenchBlockModel /
 *     ArchiveCreateBlockModel …）在移动端**统统不存在**，
 *     页面报 `Model class 'ArchiveCreateBlockModel' not found.`
 *
 *   这不是注册 API 用错，是**产物 lane 不对**。本文件是 v2 lane 的入口。
 *
 * ===========================================================================
 * 与 v1 的分工（刻意保持极窄）
 * ===========================================================================
 *   v2 只注册**移动端真正要用的模型**，本轮就是建档区块一个。
 *   不复制 v1 那一大串动作模型 —— 移动端用不到，复制过去只会扩大维护面。
 *   以后有第二个移动端模型再往这里加，不预先铺开。
 *
 * ===========================================================================
 * 失败时"可诊断"而不是"静默"（用户 2026-11-10 §3）
 * ===========================================================================
 *   铁律不变：**`load()` 绝不抛出** —— 它在 SPA 启动的关键路径上，抛错就是整页白屏。
 *   但"不抛"不等于"不留痕"。每个可能失败的阶段都调用 `diagWarn/diagError`：
 *     · 只打 <阶段名 + 错误类型 + 消息首行 + 构建标记>，不含任何请求体/token/客户数据；
 *     · 页面顶多退化成"区块未找到"，其余功能照常。
 *   详见 `./diag.ts` 的文件头。
 */
import { Plugin } from '@nocobase/client-v2';
import * as flowEngineModule from '@nocobase/flow-engine';
import { buildArchiveCreateBlockModel } from '../client/archive-create-block';
import { buildArchiveEditBlockModel } from '../client/archive-edit-block';
import { CLIENT_BUILD_LINE, CLIENT_BUILD_STAMP } from '../client/build-stamp';
import { REQUEST_ID_HEADER } from '../shared/svc-request';
import { diagError, diagWarn, guardedLoad } from './diag';
// ARC-V1 / B-35R：与 v1 同一套角色入口判据（见 src/client/role-entry-redirect.ts）。
//   v2 lane 里通常"已经在该去的页面"，判据会更早返回；装上是为了两条 lane 行为一致
//   —— 本项目曾因 v1/v2 不一致导致 `ArchiveEditBlockModel not found`（B-31），不再重蹈。
import { installRoleEntryRedirect } from '../client/role-entry-redirect';

/** 与 v1 同一套请求器形态（走 apiClient，自带登录态与 401 处理） */
type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/** multipart 通道：`request` 传 FormData 会丢 boundary，必须单独一条 */
// ⚠️ 形参用 `any` 而不是 `FormData`：宿主包把 `FormData` 声明成**值**（`declare var`），
//    当类型用会报 TS2749。运行期它仍是真正的 FormData。
type Uploader = (url: string, formData: any, requestId: string) => Promise<any>;

export default class ServiceTicketClientV2 extends Plugin {
  async load(): Promise<void> {
    // 最外层兜底：连下面的 try/catch 自身出问题也不能把 SPA 带崩
    await guardedLoad(CLIENT_BUILD_STAMP, async () => {
      try {
        const app: any = this.app;
        const engine: any = app?.flowEngine;
        if (!engine || typeof engine.registerModels !== 'function') {
          // 不抛：移动端拿不到引擎时，界面会退化成"区块未找到"，但 SPA 仍可用。
          diagWarn(
            'engine',
            'app.flowEngine 不可用或没有 registerModels()，移动端区块不会注册',
            CLIENT_BUILD_STAMP,
          );
          return;
        }

        const apiClient: any = app?.apiClient;
        if (!apiClient?.request) {
          diagWarn(
            'apiClient',
            'app.apiClient.request 不可用，移动端区块不会注册',
            CLIENT_BUILD_STAMP,
          );
          return;
        }

        const request: Requester = async (url, method = 'get', body, options) => {
          const res = await apiClient.request({
            url,
            method,
            ...(body !== undefined ? { data: body } : {}),
            ...(options?.headers ? { headers: options.headers } : {}),
            ...(options?.responseType ? { responseType: options.responseType } : {}),
            // ⚠️ `params` 必须透传：列表类接口的 pageSize / page / sort / filter 全靠它。
            // 漏了这一项不会报错，只会"参数被静默丢弃" —— 表现为永远拿到默认第一页，
            // 排查时极易误判成"服务端排序有问题"。
            ...((options as any)?.params ? { params: (options as any).params } : {}),
          });
          return (res as any)?.data ?? res;
        };

        /**
         * multipart 上传通道（A5-C 照片）。
         *
         * 为什么**必须**单开一条，而不是复用上面的 `request`：
         *   · `request` 把 body 放进 `data`，axios 会按 `Content-Type` 决定怎么序列化；
         *     传 FormData 时**绝不能**手写 `Content-Type: multipart/form-data` ——
         *     那样会丢掉浏览器自动生成的 boundary，服务端 multer 解析直接失败。
         *   · 所以这里只带 `Authorization` 与 `X-Request-Id`，**不带** Content-Type，
         *     让浏览器/axios 自己补 `multipart/form-data; boundary=...`。
         *
         * 为什么还要 `X-Request-Id`：`svc:archivePhotoAttach` 走的是同一个
         * `requireRequestId` 前置（缺失即 422）。这条链路上的 422 很容易被误读成
         * "文件格式不支持"，所以显式带上并在客户端复用同一号做网络层重试。
         */
        const uploader: Uploader = async (url, formData, requestId) => {
          const res = await apiClient.request({
            url,
            method: 'post',
            data: formData,
            headers: { [REQUEST_ID_HEADER]: requestId },
          });
          return (res as any)?.data ?? res;
        };

        // 🔴 基类必须是**纯 FlowModel**，不能用 MarkdownBlockModel / DataBlockModel：
        //    后者假定自己绑定了 collection，`onInit` 里无条件读
        //    `getStepParams('resourceSettings','init').dataSourceKey` ⇒ 我们这种
        //    "不绑定 collection" 的区块会直接在渲染前抛 TypeError（实测过）。
        const FlowModelBase =
          engine.getModelClass?.('FlowModel') ?? (flowEngineModule as any)?.FlowModel;
        if (!FlowModelBase) {
          diagWarn(
            'base',
            '取不到 FlowModel 基类（engine.getModelClass 与 @nocobase/flow-engine 都没有）',
            CLIENT_BUILD_STAMP,
          );
          return;
        }

        const blockModels = {
          ...buildArchiveCreateBlockModel({ FlowModelBase, request }),
          ...buildArchiveEditBlockModel({ FlowModelBase, request, uploader }),
        };
        const names = Object.keys(blockModels);
        if (names.length === 0) return;

        engine.registerModels(blockModels);

        // eslint-disable-next-line no-console
        console.info(`[service-ticket/v2] 已注册移动端区块模型：${names.join(', ')}`);
        // eslint-disable-next-line no-console
        console.info(CLIENT_BUILD_LINE);
      } catch (error) {
        // 绝不因为"区块没注册上"把整个移动端 SPA 弄崩；
        // 但也绝不静默 —— 至少留下能定位的那一行。
        diagError('registerModels', error, CLIENT_BUILD_STAMP);
      }

      // ARC-V1 / B-35R：角色入口修复（与模型注册**完全独立**）。
      //   放在 registerModels 的 try/catch 之外，是因为两者互不依赖：
      //   模型注册失败不该导致入口判断也不执行，反之亦然。
      try {
        installRoleEntryRedirect({
          apiClient: (this.app as any)?.apiClient,
          tag: '[service-ticket/role-entry/v2]',
        });
      } catch (error) {
        diagWarn('roleEntryRedirect', error, CLIENT_BUILD_STAMP);
      }
    });
  }
}
