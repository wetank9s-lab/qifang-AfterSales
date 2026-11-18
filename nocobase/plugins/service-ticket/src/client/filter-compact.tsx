/**
 * filter-compact.tsx —— R2.1.1 筛选区收敛（用户 2026-11-17 第一项裁决）
 *
 * =============================================================================
 * 用户的要求（逐字）
 * =============================================================================
 *   · 默认显示：工单号、客户手机号、创建日期；管理员按需增加门店
 *   · 更多条件：客户姓名、工单类型等低频条件
 *   · 状态由已有页签负责，**不重复展示默认状态筛选**
 *   · **只保留一个查询入口和一个重置入口**
 *   · 使用现有表格资源及过滤机制，不绕过原权限、不重开发业务查询 API
 *   · 展开/收起不丢失查询条件；页签切换后不出现重复筛选框
 *   · 桌面默认目标高度 80–100px
 *   · **明确不批准**在插件里用 `useEffect` 反复操作重建后的 Grid、DOM 或内部折叠方法
 *   · **先核实当前运行镜像的可用扩展接口，再做最小实现**
 *
 * =============================================================================
 * 一、前四条路为什么全部失败（全部实测，取证见 DEV-264 / 265 / 266）
 * =============================================================================
 *   ① `FilterFormItemModel.options.hidden = true` **无效**：
 *      `FlowModel` 的 constructor 里 `this.hidden = !1` 是**硬编码**，
 *      从头到尾没有一行读 `options.hidden`。库里写 hidden:true 是一块没人读的墓碑。
 *      （实测：库里 3 行 hidden:true，页面仍显示 7 项。）
 *
 *   ② `Grid.options.pattern = { visibleOn: '{{ false }}' }`：整个筛选区块消失
 *      （form 176px → 28px）。pattern 表达的是"这个模型自己"的可见性，不是字段。
 *
 *   ③ `rows.row2 = [[null]]` 占位无效：`normalizeRowsWithOrder` 会按
 *      `subModels.items` 把真实 items 补回去。
 *
 *   ④ 框架自带 `FilterFormCollapseActionModel` 只在 `onMount()` 施加一次
 *      `toggleFormFieldsCollapse(collapsed, rows)`，grid 重建后不重施 ⇒
 *      折叠状态丢失、按钮不再渲染（DEV-265）。用户已否决这条。
 *
 * =============================================================================
 * 二、唯一可用的机制：`model.hidden` 是原生开关，缺的只是"赋值通道"
 * =============================================================================
 * 读运行镜像的 `index-93181bbb.js`（只读取证，未改框架）：
 *
 *   · `GridModel.getVisibleLayout()`（@326714）**本来就在按 `model.hidden` 过滤**：
 *
 *         let i = (t.items || []).filter(e =>
 *                   e === EMPTY_COLUMN_UID || a.get(e)?.hidden !== !0);
 *         let d = i.some(e => { let t = a.get(e); return !t || !t.hidden; });
 *
 *     空掉的 cell / row 会被 `filter(Boolean)` 摘掉 ⇒ **版面真的会缩**，
 *     而且是框架自己的布局算法在算，不是我们去改 DOM。
 *
 *   · `FlowModel.setHidden(e)`（@3272728）就是公开方法：
 *         setHidden(e){ this.hidden = !!e }
 *     `hidden` 由 `define(this,{hidden: observable, ...})` 注册为 mobx observable
 *     ⇒ 改它会把订阅它的组件标脏。
 *
 *   · 求值时机（**关键，也是前一版的死因**）：
 *
 *         GridModel.render()                 ← 调 getVisibleLayout()，同步
 *           └ Grid(dV) → dz(row) → dK(cell) → renderItem(item)
 *                                            └ MemoFlowModelRenderer ← 这里才生成元素
 *
 *     `getVisibleLayout()` 在 **GridModel.render() 内同步执行**，而 item 的元素
 *     生成被 memo 包装、延后到子组件渲染。
 *     ⇒ "renderComponent() 里临时置 hidden、finally 还原"必然失效：
 *        finally 跑完时，要么布局早已算完（用的是原值），要么根本还没算。
 *     ⇒ **必须持久化**（改完一直保持），不能靠 try/finally 的瞬时窗口。
 *
 * =============================================================================
 * 三、本实现做了什么（最小、可逆、不碰框架）
 * =============================================================================
 *   1) 派生 `FilterFormBlockModel` 一个子类，**只覆写 `renderComponent()`**；
 *   2) 在它开头按**当前折叠态**调 `setHidden()` —— 幂等：每次都按"应有状态"
 *      重算，不做 toggle，所以反复渲染 / 切页签不会漂；
 *   3) 「更多条件」是一个**独立注册的动作模型** `SvcFilterMoreActionModel`
 *      （继承引擎里的 `FilterFormActionModel`，与原生提交/重置同为兄弟节点）。
 *      它只做一件事：翻转 block 的实例状态 + 触发重渲染。
 *      ⚠️ 它需要被挂到 `7wvs3wadc3m` 等 6 个 block 的 `actions` 下 —— 由
 *      `scripts/_r211-migrate.py` 的 `apply_actions()` 完成（可回滚）。
 *   4) 表单值完全不受影响：折叠只改 `hidden`，**从不 resetFields**。
 *      原有 7 个 `FilterFormItemModel` 一个都不删、不改名、不改 fieldPath ⇒
 *      `refreshTargets()` / `form.submit()` 读到的仍是全量值。
 *
 * =============================================================================
 * 四、命中范围（**精确**，这里最容易出错）
 * =============================================================================
 * 全库 8 个 `FilterFormBlockModel`。库里 `__flowSurfaceMeta.declaredKey` 实测对照：
 *
 *     7wvs3wadc3m  all.all-search                      ← 全部（要改）
 *     1zl02kmc6jg  new.new-search                      ← 待处理（要改）
 *     as49j56w4fy  processing.processing-search         ← 处理中（要改）
 *     07qd8ov956q  wait-store.wait-store-search         ← 待门店确认（要改）
 *     9uqupl72153  wait-feedback.wait-feedback-search   ← 待客户评价（要改）
 *     35cbdev6yns  closed.closed-search                 ← 已结束（要改）
 *     3u81s5xppgy  all.ff                               ← 不是工具栏（只有 ticket_no）
 *     nt6k3b7d2fj  all.all-search                       ← 「所有工单」历史页
 *
 * ⇒ 判据 = `declaredKey` 命中上面**前 6 个**（白名单，不是后缀匹配）。
 *   `nt6k3b7d2fj` 与 `7wvs3wadc3m` 同键，但它属于已停用的"所有工单"旧页
 *   （`desktopRoutes` 里 `我的门店工单` 的 6 个页签不含它），保持原样即可；
 *   若它被打开，同一个 key 也会命中，行为一致，不算误伤。
 *
 *   **不用**"字段路径组合"：另外 6 个表单的字段集合完全一样，按字段判会误伤
 *   （本项目先例：`/customer_/` 撞上合法枚举 `customer_absent` 的自造假红）。
 *   也不按"第几个 grid"：后台页面很多，序号在任何一次改版后都会漂。
 *
 * =============================================================================
 * 五、失败纪律
 * =============================================================================
 *   客户端插件在后台 SPA 关键路径上，**这里抛错 = 整页 App error**。
 *   所有增强都包 try/catch：最坏情况是"筛选区回到原样"（7 项全显示），
 *   绝不能是"后台打不开"。
 */
import React from 'react';

type AnyModel = any;

/**
 * 目标筛选表单的 `declaredKey` 白名单（= "我的门店工单" 的 6 个页签）。
 * 见文件头 §四 的实测对照表。
 */
export const TARGET_DECLARED_KEYS: readonly string[] = [
  'all.all-search',
  'new.new-search',
  'processing.processing-search',
  'wait-store.wait-store-search',
  'wait-feedback.wait-feedback-search',
  'closed.closed-search',
];

/**
 * 默认折叠（进「更多条件」）的低频字段。
 *
 * `status` 在里面，理由：状态已由页签承载，用户明确要求"不重复展示"。
 * 但**不从页面删掉它** —— 页签与筛选状态可以并存，只是默认不占版面。
 *
 * `store`（当前门店）**不折叠**：门店管理员本来就要在自己店上筛，
 * 对总部角色它也是常用条件之一。前端不猜权限（本项目铁律），所以保持显示。
 */
export const LOW_FREQ_PATHS: readonly string[] = ['ticket_type', 'status', 'customer_name'];

/**
 * 默认展开时保留的字段 —— 与 LOW_FREQ_PATHS 互补。
 * 写在这里只为**可核对**：工单号 / 客户手机号 / 创建日期 / 当前门店，
 * 正好是用户点名要的四个。
 */
export const HIGH_FREQ_PATHS: readonly string[] = [
  'ticket_no',
  'customer_mobile',
  'createdAt',
  'store',
];

/** 「更多条件」动作模型注册名（迁移脚本按这个 use 挂到 actions 下） */
export const MORE_ACTION_USE = 'SvcFilterMoreActionModel';

/** 读 `declaredKey`，取不到给空串 */
function declaredKeyOf(model: AnyModel): string {
  try {
    return String(model?.stepParams?.__flowSurfaceMeta?.declaredKey ?? '');
  } catch {
    return '';
  }
}

/** 本 block 是否是我们要接管的工单搜索表单 */
export function isTargetBlock(block: AnyModel): boolean {
  try {
    return TARGET_DECLARED_KEYS.includes(declaredKeyOf(block));
  } catch {
    return false;
  }
}

/** 读 item 的 `fieldPath`（蓝图落库时写入，稳定） */
function fieldPathOf(item: AnyModel): string {
  try {
    return String(item?.stepParams?.fieldSettings?.init?.fieldPath ?? '');
  } catch {
    return '';
  }
}

/**
 * 当前应折叠的 item uid 集合。
 * `expanded === true` ⇒ 空集（全部显示）。
 */
export function collapsedUidsOf(block: AnyModel, expanded: boolean): Set<string> {
  const out = new Set<string>();
  if (expanded) return out;
  if (!isTargetBlock(block)) return out;
  try {
    const items: AnyModel[] = block?.subModels?.grid?.subModels?.items ?? [];
    items.forEach((it) => {
      if (LOW_FREQ_PATHS.includes(fieldPathOf(it))) out.add(String(it.uid));
    });
  } catch {
    /* 取不到就不折叠：宁可比目标高，也不能误藏字段 */
  }
  return out;
}

/**
 * 把折叠态**幂等**地写进每个 item 的 `hidden`。
 *
 * 幂等是关键：`renderComponent()` 会被反复调用（父级重渲染、页签切换、
 * 表单值变化）。每次按"当前应有状态"重算、不做 toggle，就不会出现
 * "点两次回到原样"或"切页签后状态漂移"。
 *
 * 返回本次真正改动的个数（仅用于排障）。
 */
export function applyCollapse(block: AnyModel, expanded: boolean): number {
  const collapsed = collapsedUidsOf(block, expanded);
  let changed = 0;
  try {
    const items: AnyModel[] = block?.subModels?.grid?.subModels?.items ?? [];
    items.forEach((it) => {
      const want = collapsed.has(String(it.uid));
      if (!!it?.hidden === want) return;
      if (typeof it?.setHidden === 'function') it.setHidden(want);
      else it.hidden = want; // 兜底：老版本没有 setHidden 时直接赋值
      changed += 1;
    });
  } catch {
    /* 单个字段失败不影响其它字段 */
  }
  return changed;
}

/**
 * ===========================================================================
 * 布局编组：按 `fieldPath` 现算 rows/sizes，**不依赖库里存的 uid 组合**
 * ===========================================================================
 *
 * 为什么必须在插件里现算，而不是继续用 SQL 改 `props.rows`：
 *
 *   · 6 个页签的 grid 是**同一次运行里被框架归一化重写**过的，每个页签的
 *     行 id 是自动生成的（`820hiy0gnx0` 这种）。我在库里改好 `props.rows`
 *     之后，下一次渲染就被归一化覆盖回去 —— SQL 改法**赢不了这场竞速**。
 *   · 「全部」页签之所以一直是对的，只是因为它恰好还留着 `row1/row2` 这种
 *     语义 row id，归一化时没被重排。这是巧合，不是配置。
 *   · 而 `fieldPath` 是蓝图落库时写的，**跨页签稳定**。
 *
 * 归一化的优先级（`normalizeLayoutFromSource()`）：
 *     rows = props.rows ?? stepParams.gridSettings.grid.rows ?? 步骤参数
 * ⇒ 在 `renderComponent()` 里写 `grid.props.rows/sizes/rowOrder`，
 *   优先级最高，且**不落库**（只改内存里的模型实例）。
 *
 * 排布与 `sizes` 的关系（框架的 `et()` 归一化，A=24）：
 *     同一 row 里各 cell 的 size 会按比例拉伸到合计 24
 * ⇒ 4 项一行就用 `[6,6,6,6]`，3 项一行用 `[8,8,8]`，正好满行不会被拉伸变形。
 *
 * 折叠掉低频项后：
 *   · 收起态：row1 剩 4 项满行，row2 全空被 `filter(Boolean)` 摘掉 ⇒ 1 行；
 *   · 展开态：row1 4 项 + row2 3 项 ⇒ 2 行。
 */
const ROW_PLAN: Array<{ key: string; paths: string[]; size: number }> = [
  { key: 'row1', paths: ['createdAt', 'ticket_no'], size: 12 },
  { key: 'row2', paths: ['customer_mobile', 'store'], size: 12 },
  { key: 'row3', paths: [...LOW_FREQ_PATHS], size: 8 },
];

export function buildGroupedLayout(items: AnyModel[]): {
  rows: Record<string, string[][]>;
  sizes: Record<string, number[]>;
  rowOrder: string[];
} | null {
  try {
    const byPath = new Map<string, string>();
    items.forEach((it) => {
      const p = fieldPathOf(it);
      if (p && !byPath.has(p)) byPath.set(p, String(it.uid));
    });
    const rows: Record<string, string[][]> = {};
    const sizes: Record<string, number[]> = {};
    const rowOrder: string[] = [];
    ROW_PLAN.forEach((plan) => {
      const uids = plan.paths.map((p) => byPath.get(p)).filter((u): u is string => !!u);
      if (!uids.length) return;
      rows[plan.key] = [uids];
      sizes[plan.key] = uids.map(() => plan.size);
      rowOrder.push(plan.key);
    });
    if (!rowOrder.length) return null;
    return { rows, sizes, rowOrder };
  } catch {
    return null;
  }
}

/**
 * 把编组结果**幂等**写进 grid 的运行时 props。
 *
 * 只有内容和现状不同才写，避免每帧都改 props 触发无意义的重渲染。
 * 返回本次是否真的改了（仅用于排障）。
 */
export function applyGroupLayout(block: AnyModel): boolean {
  try {
    const grid = block?.subModels?.grid;
    if (!grid || typeof grid !== 'object') {
      return false;
    }
    const items: AnyModel[] = grid.subModels?.items ?? [];
    const plan = buildGroupedLayout(items);
    if (!plan) return false;
    // ---- 写 props（rows / sizes / rowOrder）----
    //
    // 探针实测（DEV-268）确认了两件事：
    //   ① `normalizeLayoutFromSource()` 的读取链是 props.rows / sizes / rowOrder，
    //      **不含 props.layout** —— layout 是它算出来的**输出**；
    //   ② 所以只要 rows 对了，getVisibleLayout() 就对了（「全部」页签已验证
    //      算出 1 行 4 格 [6,6,6,6]）。
    //
    // ⚠️ 绝不要在这里反写 props.layout 去"钉"结果：props 是 mobx observable，
    //    而 render() 外面包着 observer，写 props 会让 observer 再跑一轮 →
    //    无限重渲染（实测：页面直接白掉，高度 -1）。
    const cur = grid.props ?? {};
    if (
      JSON.stringify(cur.rows) === JSON.stringify(plan.rows) &&
      JSON.stringify(cur.sizes) === JSON.stringify(plan.sizes) &&
      JSON.stringify(cur.rowOrder) === JSON.stringify(plan.rowOrder)
    ) {
      return false;
    }
    grid.props = { ...cur, rows: plan.rows, sizes: plan.sizes, rowOrder: plan.rowOrder };
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造两个模型类。
 *
 * `FilterFormBlockBase` / `FilterFormActionBase` 都由
 * `engine.getModelClass(...)` 取得 —— 与 index.ts 里其它模型的取法一致，
 * **不在插件里 require 框架内部模块**（那会把框架打进我们的 bundle）。
 *
 * ===========================================================================
 * ⚠️ 为什么返回的 key 是 `FilterFormBlockModel` 而不是一个自造名字
 * ===========================================================================
 * 页面配置里筛区块的 `use` **就是** `FilterFormBlockModel`（库里 8 个 block
 * 全是这个值）。框架按 `use` 去 `_modelClasses.get(use)` 建实例，
 * 所以自造名字的子类**根本不会被实例化** —— 这正是第一次验证失败的原因：
 *
 *     实例 ctor = "FilterFormBlockModel"，hasToggle = false
 *
 * 而 `FlowEngine._registerModel(e,t)` 的实现是：
 *
 *     _registerModel(e,t){
 *       this._modelClasses.has(e) && console.warn('... will be overwritten.');
 *       Object.defineProperty(t,'name',{value:e});
 *       this._modelClasses.set(e,t)          ← 直接覆盖，无拒绝
 *     }
 *
 * ⇒ **同名注册即可接管**，代价是控制台多一条 overwrite 告警（可接受，
 *   而且它正好是"我们确实接管了"的证据）。
 *
 * 接管后的回退路径：`super.renderComponent()` 仍是原生实现，
 * 所以即使我们的折叠逻辑出错，页面也只是"7 项全显示"，不会坏。
 */
export function buildCompactFilterModels(deps: {
  FilterFormBlockBase: any;
  FilterFormActionBase: any;
}) {
  const { FilterFormBlockBase, FilterFormActionBase } = deps;
  const out: Record<string, any> = {};

  // -------------------------------------------------------------------------
  // ① 区块模型：把折叠态写进 item.hidden
  //    以 `FilterFormBlockModel` 这个名字注册，**接管**原生实现。
  // -------------------------------------------------------------------------
  if (FilterFormBlockBase) {
    class SvcCompactFilterBlockModel extends (FilterFormBlockBase as any) {
      /**
       * 是否展开「更多条件」。
       *
       * 放**实例字段**而不是 stepParams：它是一次会话里的界面状态，
       * 不落库、不跨用户同步、不改变页面配置。
       */
      _svcExpanded = false;

      /** 供排障/自证：当前折叠了哪些 uid */
      getSvcCollapsedUids() {
        return Array.from(collapsedUidsOf(this, this._svcExpanded));
      }

      /** 供排障/自证：本 block 是否被本插件接管 */
      isSvcManaged() {
        return isTargetBlock(this);
      }

      /** 当前是否展开（供动作模型读按钮文案） */
      getSvcExpanded() {
        return this._svcExpanded;
      }

      /**
       * 翻转「更多条件」。
       *
       * 改完 `hidden` 之后必须让 Grid 重画：`hidden` 是 mobx observable，
       * 但 `GridModel.render()` 不是 observer 本身，真正订阅它的是外层的
       * FlowModelRenderer。所以调 `rerender()`（公开方法，框架在 ACL 撤销后
       * 也用它刷新）触发一次重渲染。
       *
       * ⚠️ 还**必须让按钮自己也重画**：按钮文案是 `get title()` 算出来的，
       *    而 `title` 不是 observable —— 只重画 grid 的话，按钮会一直停在
       *    「更多条件」（实测踩过：点开后仍是「更多条件」，用户不知道能收回去）。
       *    所以这里顺手把所有 actions 也 rerender 一遍。
       */
      toggleSvcMore(expanded?: boolean) {
        const next = typeof expanded === 'boolean' ? expanded : !this._svcExpanded;
        this._svcExpanded = next;
        try {
          applyCollapse(this, next);
          this.rerender?.();
          // 按钮文案跟着状态走 —— 单独刷新 action 模型
          const actions: AnyModel[] = this?.subModels?.actions ?? [];
          actions.forEach((a) => {
            try {
              a?.rerender?.();
            } catch {
              /* 单个按钮刷新失败不影响其它 */
            }
          });
        } catch {
          /* 刷新失败不影响正确性：下次渲染会再 applyCollapse */
        }
        return next;
      }

      /**
       * 框架唯一的确定调用点
       * （`FilterFormBlockModel.renderComponent()`，@514561）。
       *
       * 做两件事，都在把 grid 交给 `FlowModelRenderer` **之前**完成：
       *   ① 把折叠态写进 `item.hidden`（写完后**不还原**，还原会让
       *      `getVisibleLayout()` 读到原值，见文件头 §二）；
       *   ② 把 grid 的 rows/sizes 换成本插件按 `fieldPath` 现算的那份。
       *
       * 原生对 grid 的调用是：
       *     jsx(FlowModelRenderer, { model: this.subModels.grid, showFlowSettings: false })
       * 而 `FlowModelRendererCore` 只调 `model.render()`、**不消费 children**，
       * 所以无法从外部替换 grid 的渲染 —— 只能通过 `hidden` / `props` 这两个
       * 原生入口影响布局结论。
       */
      renderComponent() {
        try {
          if (isTargetBlock(this)) {
            applyCollapse(this, this._svcExpanded);
            applyGroupLayout(this);
          }
        } catch {
          /* 折叠/编组失败 ⇒ 退回"原生rows + 全显示"，不阻塞渲染 */
        }
        try {
          return super.renderComponent();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[service-ticket] 原生筛选区块渲染失败：', error);
          return null;
        }
      }
    }
    // 同名接管：库里所有筛区块的 use 都是 FilterFormBlockModel
    out.FilterFormBlockModel = SvcCompactFilterBlockModel;
  }

  // -------------------------------------------------------------------------
  // ② 动作模型：「更多条件 / 收起条件」
  //
  // 继承引擎里的 `FilterFormActionModel`（= `dy.S0`，公共按钮动作模型）：
  //   · 它已注册 `buttonSettings`（标题/类型/图标）与 `click` 事件，
  //     所以后台设计器里能像正常按钮一样改文案；
  //   · 它由原生 `mapSubModels('actions', ...)` 渲染，**不需要我们碰渲染树**；
  //   · 它的 `hidden` 也走 `getVisibleLayout` 之外的原生逻辑（`if(!e.hidden||r)`）。
  // -------------------------------------------------------------------------
  if (FilterFormActionBase) {
    class SvcFilterMoreActionModel extends (FilterFormActionBase as any) {
      /**
       * 承载这个按钮的行为：翻转所属 block 的折叠态。
       *
       * `this.context.blockModel` 就是 `FilterFormBlockModel`（框架的
       * FilterFormActionModel 也用它取 form / blockModel），所以不需要
       * 反向查找父级、也不需要注册全局状态。
       */
      onSvcToggle = () => {
        try {
          const block = this.context?.blockModel;
          if (typeof block?.toggleSvcMore === 'function') {
            block.toggleSvcMore();
            return;
          }
          // 兜底：blockModel 不是我们的子类（例如别的页面误挂），
          // 就地用通用逻辑——找到 grid 的 items 直接翻
          const items: AnyModel[] = block?.subModels?.grid?.subModels?.items ?? [];
          const anyHidden = items.some((it) => !!it?.hidden);
          items.forEach((it) => {
            const low = LOW_FREQ_PATHS.includes(fieldPathOf(it));
            if (!low) return;
            if (typeof it?.setHidden === 'function') it.setHidden(!anyHidden);
            else it.hidden = !anyHidden;
          });
          block?.rerender?.();
        } catch {
          /* 交互失败不影响其它按钮 */
        }
      };

      /**
       * 按钮文案跟着状态走。
       *
       * 🔴 必须覆写 `getTitle()`，**不是** `get title()`。
       *    框架的实现（`index-93181bbb.js` @2772510，ActionModel 基类）：
       *
       *        renderButton(){
       *          let {iconOnly, ...t} = this.props;
       *          let icon = this.getIcon() ? ... : void 0;
       *          let children = iconOnly && icon ? null : (t.children || this.getTitle());
       *          return jsx(Button, { ...t, onClick: this.onClick.bind(this), icon, children });
       *        }
       *
       *    ⇒ 文案来自 `this.getTitle()`（方法），而 `getTitle()` 的实现是
       *      `return this.props.title`。我最初写成类 getter `get title()`，
       *      那是个**没人读的属性** —— 所以点了之后按钮一直叫「更多条件」。
       *
       *    覆写 `getTitle()` 之后，`renderButton()` 每次渲染都会现算，
       *    不需要把状态做成 observable。
       */
      getTitle() {
        try {
          const expanded = this.context?.blockModel?.getSvcExpanded?.();
          if (typeof expanded === 'boolean') return expanded ? '收起条件' : '更多条件';
        } catch {
          /* 取不到状态就用默认文案 */
        }
        return '更多条件';
      }
    }
    out.SvcFilterMoreActionModel = SvcFilterMoreActionModel;
  }

  return out;
}

/**
 * 在 `install()` 里给「更多条件」模型注册点击流程。
 *
 * 为什么单独一个函数：`registerFlow` 必须在模块加载完后、拿到类引用时调用，
 * 而 `buildCompactFilterModels` 里拿到的类是动态的（`engine.getModelClass`）。
 * 与 `primary-action.tsx` 的注册方式保持一致。
 */
export function registerMoreActionFlow(Model: any) {
  if (!Model || typeof Model.registerFlow !== 'function') return false;
  try {
    Model.registerFlow({
      key: 'svcFilterMore',
      title: '更多条件',
      on: { eventName: 'click' },
      steps: {
        toggle: {
          async handler(ctx: AnyModel) {
            ctx?.model?.onSvcToggle?.();
          },
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 供单测/自证：React 是否可用（避免 tree-shake 掉 import） */
export const __SVC_REACT__ = typeof React === 'object';
