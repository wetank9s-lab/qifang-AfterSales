/**
 * TicketTabFilterModel —— 状态 Tab 的**服务端筛选**承载者（Phase 11 / P11-0 · B-15）
 * =============================================================================
 *
 * 为什么需要这个模型（框架侧的能力缺口，已取证）
 * -----------------------------------------------------------------------------
 * 状态 Tab 的筛选条件**早就正确地落库了**：`flowSurfaces:applyBlueprint` 会把
 * 区块的 `defaultFilter` 回填到「筛选动作」的 `props.filterValue` / `props.defaultFilterValue`
 * （库里实测可见：`status $eq PROCESSING` 等）。**问题不在配置，在应用时机**。
 *
 * 读 `@nocobase/app` 客户端产物取证（`FilterActionModel` = `uG`）：
 *
 *   · `filterSettings` 的 `defaultFilter` 步骤，handler 只有两句：
 *       `setProps("defaultFilterValue", …)` + `setProps("filterValue", …)`
 *       —— **没有** `addFilterGroup`。
 *   · 真正把筛选并进请求（`addFilterGroup`）的只有两处，且都挂在**事件**上：
 *       `submitSettings`（on:"submit"）、`resetSettings`（on:"reset"）—— 即用户
 *       点「确定」或「重置」的那一刻。**没有任何一处是在加载时应用的。**
 *   · `props.defaultFilter`（区块级）在 flow-engine 客户端里 **0 处引用**
 *       （它只在 legacy schema 区块的 `doFilter()` 里被消费）。
 *
 * ⇒ **2.2.15 的 flow-engine 会把默认筛选持久化，但不会在打开页面时应用它。**
 *   表现就是：六个 Tab 都只发一条不带 filter 的 `serviceTickets:list`，
 *   六个 Tab 渲染出同一批 20 行 —— 而 `smoke-test` 那条断言只核库里的
 *   `props.defaultFilterValue`，于是"配置在"被当成了"筛选生效"（B-15）。
 *
 * 本模型补的就是缺失的那一环：**在挂载时把筛选交给服务端**。
 *
 * -----------------------------------------------------------------------------
 * 为什么不是"前端过滤当前 20 行"
 * -----------------------------------------------------------------------------
 * 用户明令"不能仅在当前 20 行做前端过滤"。前端过滤的后果是：
 * 分页是假的（第 2 页筛完可能只剩 3 行）、总数不对应、导出/统计口径不一致。
 * 这里走的是 `resource.addFilterGroup()` —— **筛选条件随请求发给服务端**，
 * 由服务端完成过滤、计数与分页，与用户在筛选面板里点「确定」走的是同一条通道。
 *
 * -----------------------------------------------------------------------------
 * 为什么它 `render()` 返回 null
 * -----------------------------------------------------------------------------
 * 它是**行为载体，不是按钮**。界面上不该多出任何一个控件 ——
 * 门店员工看到的仍然是"筛选 / 刷新"两个既有按钮。
 * `render()` 返回 null 在本插件已有先例（`TicketPrimaryActionModel` 对未知状态
 * 同样返回 null），且读产物确认过 `FlowModelRenderer` 就是经 `model.render()` 渲染。
 *
 * ⚠️ 它必须挂在**区块的 `actions`** 下（而不是自定义 subKey）：只有框架会实例化的
 *    subKey 才会走到 `onInit`；挂到不认识的 subKey 上等于永远不执行。
 *
 * -----------------------------------------------------------------------------
 * 失败纪律
 * -----------------------------------------------------------------------------
 * 客户端插件处在后台 SPA 的关键路径上，**这里抛错 = 整页 App error**。
 * 所以全部包 try/catch：最坏情况是"Tab 又不筛了"（回到 B-15 修好之前的状态），
 * 而绝不能是"后台打不开"。
 */

/**
 * 把 flow-engine 的筛选组（`{logic, items:[{path, operator, value}]}`）
 * 转成**服务端接受的**请求形态（`{"status.$eq": "NEW"}` / `{"$and":[…]}`）。
 *
 * ===========================================================================
 * 🔴 形状是**实测**出来的，不是读代码猜的（2026-10-10）
 * ===========================================================================
 * 候选形状有三，用管理员令牌直接打 `serviceTickets:list` 逐个验：
 *
 *   · 原始组     `{"$and":[{"logic":"$and","items":[{path,operator,value}]}]}` → **500**
 *                 `Invalid value { path: 'status', operator: '$eq', value: 'NEW' }`
 *   · 点号键     `{"$and":[{"status.$eq":"NEW"}]}`                            → **200** ✅
 *   · 嵌套对象   `{"$and":[{"status":{"$eq":"NEW"}}]}`                        → **200** ✅
 *
 *   ⇒ **服务端不认 flow-engine 的 `{logic,items}` 组形态**。这一点很反直觉：
 *     框架自己就有 `addFilterGroup(key, new FilterGroup({logic,items}))` 的调用点
 *     （关联筛选），看上去像"直接传组也行"—— 那是因为 `addFilterGroup` 内部对
 *     FilterGroup 实例做了 `toJSON()`，而 **`toJSON()` 正是把组转成点号键的那一步**。
 *     我们传的是**普通对象**，`instanceof` 判定不成立 ⇒ 不会被转 ⇒ 原样发给服务端 ⇒ 500。
 *
 *   ⇒ 所以"最小变换（原样透传）"在这里恰恰是错的：少做一步转换 = 每个 Tab 都 500。
 *     这是本文件唯一一处**必须**自己实现转换的地方，且已由
 *     `verify-store-tab-filter.mjs` 的双向 fixture 钉住（含真实抓包样本）。
 *
 * 为什么不用框架内部的 `transformFilter`：
 *   它是产物里的私有函数（`ed.transformFilter`），不是公开导出 ⇒ 拿不到，也验不了。
 *   自己实现 ⇒ 可被 fixture 双向验证。
 *
 * ===========================================================================
 * 🔴 无 `value` 的项必须**丢弃**，不能补默认值
 * ===========================================================================
 * 「全部 / 全量工单」两张表在蓝图里没有 `defaultFilter`，框架会给它们生成一个
 * **只有 path+operator、没有 value** 的骨架（库里实测：
 * `{"path":"status","operator":"$eq"}`、`{"path":"ticket_no","operator":"$includes"}`）。
 * 若给它们补 `true`，请求就会变成 `{"status.$eq":true}` ——
 * **那不是"不筛"，那是"筛 status 等于 true"，结果是每个 Tab 都空**。
 * ⇒ 丢弃后 items 为空 ⇒ 返回 null ⇒ 不挂筛选，与"全部"语义一致。
 *
 * @returns 请求用 filter；无有效条件时返回 null（⇒ 不筛）
 */
export function toRequestFilter(group) {
  if (!group || typeof group !== 'object') return null;
  const usable = (v) => v !== undefined && v !== null && v !== '';
  const items = Array.isArray(group.items)
    ? group.items.filter(
        (it) =>
          it &&
          typeof it.path === 'string' &&
          it.path !== '' &&
          typeof it.operator === 'string' &&
          it.operator !== '' &&
          'value' in it &&
          usable(it.value),
      )
    : [];
  if (!items.length) return null;

  const clauses = items.map((it) => ({ [`${it.path}.${it.operator}`]: it.value }));
  if (clauses.length === 1) return clauses[0];
  return { [group.logic === '$or' ? '$or' : '$and']: clauses };
}

/**
 * 构造模型类。
 *
 * 与其它动作模型同构：基类 `ActionModel` 是**运行时注入**的（见 index.ts 的说明），
 * 所以这里必须收参数，不能在模块顶层 import。
 */
export function buildTabFilterModel(deps) {
  const { ActionModel } = deps;
  if (!ActionModel) return {};

  class TicketTabFilterModel extends (ActionModel as any) {
    /**
     * 不渲染任何控件 —— 见文件头"为什么 render() 返回 null"。
     */
    render() {
      return null;
    }

    /**
     * 挂载时把筛选交给服务端。
     *
     * 顺序沿用框架自己的 `submitSettings`：`addFilterGroup` → `setFilterActive`。
     * 两者之间**不**插 `setPage(1)`：挂载阶段分页本来就在第 1 页，
     * 多调一次只是多一次无用的状态变更。
     */
    onInit() {
      this.applyTabFilter('onInit');
    }

    /**
     * 兜底：`onInit` 与资源首次取数的先后顺序在不同小版本里未必一致。
     * 幂等（同一个 filterGroup key 重复 add 是覆盖，不是叠加），所以两处都调是安全的。
     */
    onMount() {
      this.applyTabFilter('onMount');
    }

    private appliedAt = null;
    /** 上一次真正应用到请求里的筛选值（用于"筛选没变就不再刷新"，见 applyTabFilter） */
    private appliedSignature = null;

    private applyTabFilter(phase) {
      try {
        const block = (this as any)?.context?.blockModel;
        const res = block?.resource;
        if (!res || typeof res.addFilterGroup !== 'function') {
          // 这一条**必须**打到 console：模型没被实例化 / 拿不到区块资源时，
          // 界面表现是"Tab 又不筛了"，与"筛选值配错了"完全同形。
          // 没有这行日志，排障只能靠猜（本项目已经为"静默失败"付过多次代价）。
          // eslint-disable-next-line no-console
          console.warn(
            `[service-ticket] Tab 筛选模型已加载，但拿不到区块资源（phase=${phase}，block=${block?.uid ?? '<无>'}）`,
          );
          return;
        }

        const filter = toRequestFilter((this as any).props?.filterValue);
        // key 带 uid：同一个区块上若将来挂了别的 FilterGroup，不会互相顶掉
        const key = `svcTabFilter:${(this as any).uid}`;

        if (!filter) {
          // 「全部 / 全量工单」没有状态筛选（筛选项无 value）—— 主动撤掉，
          // 避免上一轮遗留的同 key 筛选把"全部"变成"只筛某个状态"。
          res.removeFilterGroup?.(key);
          block.setFilterActive?.(key, false);
          this.appliedAt = null;
          this.appliedSignature = null;
          return;
        }

        res.addFilterGroup(key, filter);
        block.setFilterActive?.(key, true);

        // 🔴 **筛选没变就不要再刷新**（2026-10-10 真机实测的产物）
        //
        //   现象：控制台出现 `ResponseError: 429` 且其中一条明确指向
        //     `BaseModel.applyFlow: Error executing step 'refresh'`
        //   机制：`onInit` 挂上筛选 → 首次请求回来 → `onMount` 再跑一遍，
        //     此时 `getData()` 已非空 ⇒ 触发 `refresh()` ⇒ **每个 Tab 白搭一次请求**。
        //     叠上首屏那上百个请求后撞到 nginx 限流，429 又让下一个 Tab **取不到数**
        //     （实测「待客户评价」因此渲染 0 行）—— 一次多余的刷新换来了真故障。
        //
        //   ⇒ 筛选值不变 ⇒ 直接返回。`addFilterGroup` 本身是幂等的（Map 覆盖）
        //     且**不发请求**，所以上面那两行照做，只把"重新拉数"这一步收敛掉。
        const signature = JSON.stringify(filter);
        if (this.appliedSignature === signature) return;
        this.appliedSignature = signature;

        // ⚠️ 若资源**已经**取过数（本模型晚于首次请求才初始化），必须重新拉一次 ——
        //    否则界面上显示的仍是未筛选的首屏，"配了筛选却没生效"又回来了。
        //    反之（还没取过数）就不要多这一跳：那会变成每次开 Tab 都发两次请求。
        const data = typeof res.getData === 'function' ? res.getData() : null;
        if (Array.isArray(data) && data.length > 0) {
          try {
            res.setPage?.(1);
          } catch {
            /* 分页状态不是关键路径 */
          }
          res.refresh?.();
        }

        // 自证：浏览器验收靠 Network 判"请求里有没有 filter"，但那条判据
        // **无法区分**"筛选生效"与"筛选压根没跑"。这一行让两者可被区分。
        // 只在**首次**应用时打，避免重复挂载刷屏。
        if (this.appliedAt === null) {
          this.appliedAt = phase;
          // eslint-disable-next-line no-console
          console.info(
            `[service-ticket] Tab 服务端筛选已应用 phase=${phase} block=${block?.uid ?? '<无>'} ` +
              `filter=${JSON.stringify(filter)}`,
          );
        }
      } catch (error) {
        // 只告警，绝不抛出：见文件头"失败纪律"
        // eslint-disable-next-line no-console
        console.warn('[service-ticket] 状态 Tab 服务端筛选应用失败（界面仍可用，但 Tab 不筛状态）：', error);
      }
    }
  }

  return { TicketTabFilterModel };
}
