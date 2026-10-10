/**
 * expected-types-surface.mjs —— 宿主包「具名导入可接受面」清单（单一事实来源）
 *
 * ===========================================================================
 * 它挡的是什么（Phase 11 / P11-3 第 1 项）
 * ===========================================================================
 * `types/ambient-stubs.d.ts` 把宿主提供的包声明成**无体环境模块**：
 *
 *     declare module '@nocobase/client';
 *     declare module 'antd';
 *
 * 无体声明下，**该模块的任何成员都解析为 `any`** —— 包括**根本不存在的成员**。
 * 于是这一类错误永远查不出来：
 *
 *     import { message } from '@nocobase/client';   // @nocobase/client 不导出 message
 *     message.success('已标记为紧急');               // 运行期 TypeError: Cannot read properties of undefined
 *
 * 这不是假设 —— 就是 **DEV-147**：P11-2 的详情抽屉里 `message` 从 `@nocobase/client`
 * 取，运行期 `undefined`，catch 里再抛 `reading 'error' of undefined`，
 * 表现为"详情抽屉点不开"，而**构建全绿、接口全绿、tsc 全绿**。
 *
 * 为什么不改用 TS2305（"模块没有导出成员 X"）：
 *   要触发 TS2305，必须给宿主包写**完整真实**的类型声明。而本项目对宿主包的
 *   导出面**没有权威来源** —— 运行镜像里根本不装 `@nocobase/client`（只有编好的
 *   后台 SPA），仓库里也没有它的 `.d.ts`。写不全 ⇒ 大量**假红**（合法的成员被报成
 *   不存在），而假红的下场一向是"给这条门禁加个 || true"，等于没有。
 *   ⇒ 所以改成**显式白名单**：只有**我们核实过确实存在**的成员才允许被导入。
 *     核不实的进不来 —— 这正是这条判据的价值所在。
 *
 * ⚠️ 白名单带来的唯一代价（必须明说，别粉饰）：
 *   将来要导入一个**确实存在但我们没登记**的成员时，会先红一次。
 *   这不是故障，是设计：**先核实、再登记、然后才允许导入**。
 *   登记方式见 verify-types.mjs 的 `--list`（列出代码里实际用到的成员）。
 *
 * ⚠️ 反面纪律（与其它 expected-*.mjs 一致）：
 *    **绝不要**为了让门禁变绿而把成员塞进这里。这份清单的语义是
 *    "已核实存在"，不是"编译得过去"。往这里加一个不存在的成员 =
 *    把一条真断言改成一句谎话。
 */

/**
 * 受管模块 → 允许被具名导入的成员
 *
 * 未列入本表的宿主包（如 `react`、`dayjs`、`@nocobase/flow-engine`…）
 * 仍是无体声明、**不受本判据保护** —— 它们在这张表里"缺席"是诚实的表达：
 * 我们还没核实它们的导出面。不要为了"看起来覆盖全面"而把没有核实的包塞进来。
 */
export const GUARDED_MODULE_SURFACE = {
  /**
   * 依据：
   *   ① **运行时已验证**：本插件 `src/client/index.ts` 的 `class ServiceTicketClient extends Plugin`
   *      是真实跑起来过的 —— 后台能加载本插件客户端产物、Console 能打印
   *      「已注册客户端动作」（见 src/client/index.ts）。若 `Plugin` 不是该包的真实导出，
   *      取值就是 `undefined`，`extends undefined` 直接让整个后台 "App error"。
   *      也就是说：这一条不是"文档说的"，是**我们的产品正在依赖它且没有崩**。
   *   ② 与 NocoBase 2.x「客户端插件默认导出 Plugin 子类」的装载约定一致
   *      （见 src/client/index.ts 头部注释里对 `require('@local/service-ticket')` 的说明）。
   *
   * 扩展方式：先把成员**核实**到手（官方 API 文档 / 容器内核心插件产物里能看到核心代码
   *   在使用它），再登记。核不实就不要加。
   */
  '@nocobase/client': ['Plugin'],

  /**
   * 依据：antd v5 的**顶层具名导出**，本插件 7 个文件实际在用（`DatePicker`/`Typography`
   *   等由 `--list` 从源码实地枚举，不是凭记忆抄的）。
   *   这一条防的是**串包**：例如 `message` 本属于 antd、NocoBase 却把它从
   *   `@nocobase/client` 转出过一次（DEV-147），白名单让"写错来源"在静态检查这一层就红。
   *
   * ⚠️ `antd` 的成员远不止这些。这里只登记**本项目用到的**那一部分 ——
   *   新增 antd 组件时按上面的"先核实、再登记"流程加即可。
   */
  antd: [
    'Alert',
    'Button',
    'Checkbox',
    'DatePicker',
    'Drawer',
    'Empty',
    'Form',
    'Input',
    'Modal',
    'Select',
    'Space',
    'Spin',
    'Tag',
    'Typography',
    'message',
  ],
};
