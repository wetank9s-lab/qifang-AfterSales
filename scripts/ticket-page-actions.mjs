/**
 * Phase 4-I：把五个自定义 `Ticket*ActionModel` **挂到页面实例上**（幂等）。
 *
 * ⚠️⚠️ 开工前必读：**不能**通过 `applyBlueprint` 的 `actions` / `recordActions` 挂自定义动作。
 *
 *   实测（2026-09-22，NocoBase 2.2.15 容器内源码 + HTTP 双证，详见 DEVIATIONS DEV-68）：
 *     · `POST /api/flowSurfaces:addAction {target:{uid}, type:'link'}`                  → **200**
 *     · `POST /api/flowSurfaces:addAction {target:{uid}, use:'TicketAcceptActionModel'}` → **400**
 *       `flowSurfaces addAction only supports registered action types/uses`
 *   原因：`actions` 只接受**编译期硬编码**的 catalog publicKey（`catalog.js` 的静态
 *   `actionRegistry` + `NODE_CONTRACT_ENTRIES`），而自定义动作**只注册在浏览器引擎**里
 *   （`client/index.ts` 的 `engine.registerModels()`）。**服务端 catalog 与浏览器引擎注册表
 *   是两个互不相通的世界。**
 *
 *   所以本模块**直接在 flowModels 层写入动作模型行** —— 这正是用户要求的
 *   "以 NocoBase 2.2.15 实际生成结果作为事实来源"。
 *
 * 真实生成行（来自 UI Editor 加 `link` 动作后落库，`uid=iyyh8egpcaz`）：
 *   {"uid":"iyyh8egpcaz","name":"iyyh8egpcaz","parentId":"19w3dxgv1eo",
 *    "subKey":"actions","subType":"array","use":"LinkActionModel",
 *    "props":{"type":"link","title":"{{t(\"Link\")}}"},
 *    "decoratorProps":{},
 *    "stepParams":{"buttonSettings":{"general":{"title":"{{t(\"Link\")}}","type":"link"}}},
 *    "flowRegistry":{}}
 *
 * 对照内置 `RefreshActionModel`（同一 TableBlock 下）：
 *   {"parentId":"19w3dxgv1eo","subKey":"actions","subType":"array","use":"RefreshActionModel",
 *    "props":{"title":"{{t(\"Refresh\")}}","icon":"ReloadOutlined"},"decoratorProps":{},
 *    "stepParams":{"buttonSettings":{"general":{...}},
 *                  "__flowSurfaceMeta":{"declaredKey":"all.all-table.refresh_2"}},
 *    "flowRegistry":{}}
 *
 *   即动作行形状 = `{uid, name, parentId, subKey:'actions', subType:'array', use,
 *   props, decoratorProps, stepParams, flowRegistry}`，外加可选 `sortIndex`。
 *
 * ⚠️ **写入/读取 API 的实测边界**（2026-09-22 / 09-23，别踩）：
 *   · **写入用 `flowModels:save`，且 body 必须是「扁平」model 对象本身**（见下方 🔴）
 *   · `flowModels:create` **接受自定义 `use`** → **200**，但**不触发 `afterInsert` 钩子**，
 *     **不写 `flowModelTreePath` 祖先链** → 节点在库里、UI 读树时**完全看不见**。**不要用**。
 *   · `flowModels:create` 重复 uid → **400 `uid already exists`**
 *   · `flowModels:update?filterByTk=<uid>` → **200**
 *   · `flowModels:save {…扁平 model…}` → **200**，返回服务端实际落库的 uid（字符串）
 *   · `flowModels:attach?uid=&parentId=&subKey=&subType=array&position=last` → **200**
 *     ⚠️ 参数**必须走 query string**，放 body 里 → 500 `missing required params`
 *     ⚠️ `position` 只接受 `first` / `last`，传 `afterEnd` → 500 `invalid position`
 *   · `flowModels:list?filter={"uid":...}` → **200**（单条，可靠）
 *   · `flowModels:list?filter={"parentId":...}` → **400**（**不支持**按 parentId 过滤！）
 *   · `flowSurfaces:removeNode {target:{uid}}` → **200**（对称删除；`removeAction` 是 404）
 *   ⇒ 因此**枚举子动作不能靠 filter**。枚举全库用
 *     `flowModels:list?paginate=false`（实测 200，约 1500 条，含 `use` 与 `parentId`），
 *     再在 Node 侧建树；单点读取用 `flowModels:findOne?uid=`。
 *   ⇒ **uid 必须由脚本显式提供**（重跑必然重复，与"不产生重复按钮"冲突）。
 *     故 uid 由 `<tableUid>.<actionKey>` 稳定派生 —— 同表同动作永远同 uid。
 *
 * 🔴🔴🔴 **最致命的一条：`save` 的 payload 不能包 `{values:…}`**
 *   服务端 `save` 是 `const { values } = ctx.action.params; repository.upsertModel(values)`，
 *   而 `upsertModel` → `modelToSingleNodes(model)` 首行是
 *   `const { uid, async, subModels, ...rest } = cloneDeep(model)` ——
 *   **除 `uid`/`async`/`subModels` 外的一切字段被原样摊平进节点行**。
 *
 *   第一版误传 `{values:{…}}`，落库行长这样：
 *     `{"values":{"use":"TicketAcceptActionModel",…},"parentId":"…","subKey":"actions"}`
 *   ——**顶层没有 `use`**。后果：
 *     · 页面树响应里该节点 `use === undefined`
 *     · 客户端解析不出模型类 → **静默不渲染任何按钮**
 *     · 但"这行存在"是事实 → 只数行数的断言**全绿**（最阴的一类假绿）
 *   修正为扁平 payload 后，同一位置立刻渲染出 `详情` 按钮（无头浏览器实测
 *   `btns:["筛 选","重 置","查看","编辑","删除","详情"]`）。
 *
 *   ⇒ 由此得到一条可复用的判据，已写进 `assertTicketActions()`：
 *     **判"动作挂上没有"，看的是「顶层 `use`」而不是「uid 的那行在不在」。**
 */

/** 五个自定义动作模型（顺序即期望的按钮排列顺序）。 */
/**
 * Phase 11 / P11-0：列表行上**只有一个**主动作。
 *
 * 它替代了原来的五个（详情/受理/派工/改派/改约）——用户裁定：
 * 一线同事只需要知道"这张单下一步做什么"，不需要在按钮墙里挑。
 * 标签与行为由**当前状态**决定（见 src/client/row-action-matrix.ts 的 primaryActionOf）。
 *
 * ⚠️ 其余模型类仍然注册（供「处理」窗口与服务详情内部复用），
 *    但**不再挂到列表行上**；重复运行 seed 也不会把它们挂回去。
 */
export const TICKET_ACTION_MODELS = [
  { use: 'TicketPrimaryActionModel', key: 'primary', label: '处理' },
];

/**
 * 这些模型**不得**出现在列表行上（门禁据此做"必须不存在"断言）。
 *
 * 用户明确要求：验收器不能只把"预期模型数 5"改成"1"，
 * **还必须验证旧危险动作确实不存在** —— 这是那份清单的用途。
 */
export const FORBIDDEN_ROW_ACTION_USES = [
  'TicketAcceptActionModel',
  'TicketDispatchActionModel',
  'TicketReassignActionModel',
  'TicketRescheduleActionModel',
  'TicketDetailActionModel',
];

export const TICKET_ACTION_USES = TICKET_ACTION_MODELS.map((m) => m.use);

/**
 * Phase 11 / P11-0 · B-15：状态 Tab 的**服务端筛选**承载者。
 *
 * ⚠️ 它不是按钮 —— `render()` 返回 null（见 `src/client/tab-filter.tsx` 文件头）。
 *    框架会把区块的默认筛选**持久化**但**不在加载时应用**，
 *    这个模型补的就是"加载时把筛选交给服务端"那一环。
 *
 * ⚠️ 挂载点是 **TableBlock 的 `actions`**（不是行操作列）：
 *    筛选是**区块级**行为，要拿 `context.blockModel.resource`；
 *    挂到行操作列下会**每行实例化一次**（20 行 = 20 次），绝不能那么挂。
 */
export const TICKET_TAB_FILTER_USE = 'TicketTabFilterModel';

/** Tab 筛选节点的动作键（与 `actionUid()` 一同决定 uid 与 declaredKey） */
export const TAB_FILTER_KEY = 'tabFilter';

/** 与行级动作同一套派生规则：**同区块 → 同 uid** ⇒ 重跑幂等 */
export function tabFilterUid(blockUid) {
  return actionUid(blockUid, TAB_FILTER_KEY);
}

/**
 * 稳定 uid：由 `<tableUid>.<actionKey>` 派生，保证"同表同动作 → 同 uid"。
 *
 * NocoBase 的 flowModels uid 形如 `19w3dxgv1eo`（11 位 `[0-9a-z]`）。
 * 这里用 FNV-1a 32 位正反两遍凑满 11 位：**目的不是密码学强度，
 * 而是"跨轮重跑稳定 + 与原生 uid 同型"**（避免被长度/字符集校验挡下）。
 *
 * ⚠️ 派生值必须**确定**。任何会随运行变化的输入（时间戳、随机数、进程 id）
 *    都会让幂等失效，进而产生重复按钮 —— 那正是用户明令禁止的四条之一。
 */
export function actionUid(tableUid, actionKey) {
  const seed = `${tableUid}.${actionKey}`;
  const fnv = (str, reverse) => {
    let h = 0x811c9dc5;
    if (reverse) {
      for (let i = str.length - 1; i >= 0; i -= 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    } else {
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h >>> 0;
  };
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  let x = fnv(seed, false);
  for (let i = 0; i < 6; i += 1) {
    out += ALPHABET[x % 36];
    x = Math.floor(x / 36) || fnv(seed + '#' + i, true);
  }
  x = fnv(seed, true);
  for (let i = 0; i < 5; i += 1) {
    out += ALPHABET[x % 36];
    x = Math.floor(x / 36) || fnv(seed + '$' + i, false);
  }
  return out;
}

/**
 * 一个动作行的完整形状（对照真实生成行，见文件头）。
 *
 * `props.children` 是按钮文案（与 `client/ticket-actions.tsx` 里
 * `defaultProps = { children: TICKET_ACTION_LABEL[name] }` 一致）；
 * `props.title` 同时给出以兼容不同渲染路径。
 *
 * ⚠️ 刻意**不写** `type` —— 业务动作不抢主按钮视觉，与内置 `RefreshActionModel` 一致。
 * ⚠️ 状态显隐**不放这里** —— 由客户端 `availableActionsOf()` 决定，
 *    遵守用户"不要创建第二套状态矩阵"的要求。
 *
 * 🔴🔴🔴 **`declaredKey` 必须「每张表的操作列唯一」，不能只按动作派生**
 *    （2026-10-09 实测，Phase 11 / P11-0 页面迁移阻塞的直接根因之一）：
 *
 *    原写法是常量 `svc.${model.key}` —— **6 张工单表的操作列各挂一份同名的 key**，
 *    库里于是有 6 个 `svc.detail` / 6 个 `svc.accept` …… 共 30 行。
 *    于是 `flowSurfaces:applyBlueprint` 在**声明键唯一性校验**上直接 409：
 *      `flowSurfaces applyBlueprint declared key 'svc.detail' is duplicated
 *       on '7hwqyt32r6b' and 'birkrwvfajo'`
 *
 *    为什么之前没炸：同一批页面还先撞上了 `default-field-groups-incomplete`（400），
 *    **校验按顺序短路**，声明键那关根本没走到。把 fieldGroups 补齐后它才浮出水面 ——
 *    典型的"修掉 A 才看见 B"，所以每修一条都要把流程跑到底再宣布通过。
 *
 *    对照内置动作的取名就能看出规范：内置是 `all.all-table.refresh_2`
 *    （**页面.区块.动作**），即**天然带区块前缀**。这里等价地带上操作列 uid：
 *      `svc.<操作列uid>.<动作key>`
 *    构造上不可能撞车，且与 `actionUid()` 用同一组输入 ⇒ **uid 唯一 ⇒ key 唯一**。
 */
export function actionRow(tableUid, model, sortIndex) {
  const uid = actionUid(tableUid, model.key);
  return {
    uid,
    // ⚠️ `name` 与 `uid` 同值 —— 与内置动作一致（内置 `orjt790xo4m` 的
    //    `name` 就是 `orjt790xo4m`）。`flowModels` 表只有 (uid,name,options) 三列。
    name: uid,
    parentId: tableUid,
    subKey: 'actions',
    subType: 'array',
    use: model.use,
    // ⚠️ 逐字段对齐内置 `ViewActionModel` 的形状（实测原样）：
    //    `props: { type:'link', title:..., icon:null }`
    //    `stepParams.buttonSettings.general: { title, icon, type:'link', iconOnly:false }`
    //    少写 `type:'link'` 时页面**依然会渲染**，但为了不给自己埋"和内置长得不一样"
    //    的随机风险，这里保持同构 —— **改这里的字段前先确认内置行长什么样**。
    props: { type: 'link', title: model.label, icon: null },
    decoratorProps: {},
    stepParams: {
      buttonSettings: { general: { title: model.label, icon: null, type: 'link', iconOnly: false } },
      // 溯源标记：与内置动作的 __flowSurfaceMeta 同型，便于人工在库里定位本脚本写的行。
      // ⚠️ 必须**带操作列 uid**（唯一性要求见函数头那段 409 复盘）：
      //    内置同型取值是 `all.all-table.refresh_2`（页面.区块.动作），这里对齐成
      //    `svc.<操作列uid>.<动作key>`。
      __flowSurfaceMeta: { declaredKey: `svc.${tableUid}.${model.key}` },
    },
    flowRegistry: {},
    sortIndex,
  };
}

/**
 * 一个 **Tab 筛选**节点（挂在 **TableBlock 的 `actions`** 下，不是行操作列）。
 *
 * ===========================================================================
 * 🔴 `props.filterValue` 由**页面自己持久化的默认筛选**原样搬来，**本脚本不解释它**
 * ===========================================================================
 * 谁来解释（`{logic,items}` → 服务端认的 `{"status.$eq":"NEW"}`）只有一处：
 * 客户端 `toRequestFilter()`。理由有三：
 *
 *   ① **同一段解析逻辑出现两次 = 同一个坑有两条腿**（项目铁律）。
 *      在 seed 里再写一遍"哪些项有效"的规则，客户端改了它不会跟着改，
 *      于是"库里写对了、请求里却是错的"这种最难查的偏差就有了温床。
 *   ② 服务端**不认** `{logic,items}` 原组形态（实测 500 `Invalid value`），
 *      也不认"无 value 的项"（会变成 `{"status.$eq":true}` ⇒ 筛出空表）。
 *      这类判定的正确版本只能有一份。
 *   ③ 本脚本只需保证"搬到节点里的是不是页面那份配置" —— 这件事可以靠
 *      **相等性**断言（下面 `seedTicketTabFilters` 里的逐块回读），不需要理解内容。
 *
 * ⇒ 于是"全部 / 全量工单"这两张**没有**状态筛选的表，搬进去的是框架生成的
 *    无 value 骨架，客户端 `toRequestFilter()` 返回 null ⇒ **主动撤掉筛选**，
 *    语义天然正确，本脚本不需要知道哪个 Tab 该筛哪个状态。
 */
export function tabFilterRow(blockUid, filterValue, sortIndex = 80) {
  const uid = tabFilterUid(blockUid);
  return {
    uid,
    name: uid,
    // ⚠️ 父是 **表格区块**（不是行操作列）—— 见 `TICKET_TAB_FILTER_USE` 的说明
    parentId: blockUid,
    subKey: 'actions',
    subType: 'array',
    use: TICKET_TAB_FILTER_USE,
    props: { filterValue: filterValue ?? { logic: '$and', items: [] } },
    decoratorProps: {},
    stepParams: {
      // 溯源标记，形状与内置动作同型（页面.区块.动作 ⇒ 这里对齐成区块 uid 前缀）
      __flowSurfaceMeta: { declaredKey: `svc.${blockUid}.${TAB_FILTER_KEY}` },
    },
    flowRegistry: {},
    sortIndex,
  };
}

/**
 * NocoBase **自动注入**的原生行内动作（Phase 11 / P11-0 实测）。
 *
 * 🔴 它们是"按钮墙"的最后一块，且**无法通过蓝图移除**
 *    （`default-block-actions.js` 的 `FLOW_SURFACE_DEFAULT_BLOCK_ACTIONS.table`，
 *     每次 `applyBlueprint` 都会重新注入 —— 见 DEV-53 坑 2）。
 *    实测库里的形态：9 张工单表各有一份 查看/编辑/删除。
 *
 *    后果在真实浏览器里才看得见：操作列渲染出**两个**按钮 ——
 *    原生「查看」在前、我们的主动作在后；而当主动作本身就是「查看」时，
 *    一行里会出现**两个一模一样的「查看」**（WAIT_FEEDBACK / CLOSED / CANCELLED 三态），
 *    一线同事无法区分该点哪个。这正是用户要求"取消原生查看/编辑/删除按钮墙"的落点。
 *
 * ⇒ 唯一的移除路径是 `flowSurfaces:removeNode`（受支持的节点操作），
 *    且必须在 `applyBlueprint` **之后**执行（在它之前删，会被马上重新注入）。
 *
 * ⚠️ 只删**工单表操作列**下的这三类，绝不扩大：
 *    工单事件时间线 / 派工记录 两张表的原生动作保留（那两页没有自定义主动作，
 *    原生查看/编辑/删除就是它们唯一的行内入口 —— 一并删掉等于把页面做成死的）。
 */
export const NATIVE_ROW_ACTION_USES = ['ViewActionModel', 'EditActionModel', 'DeleteActionModel'];

/**
 * **门店报修入口**动作（Phase 11 / P11-1，用户 req 1）。
 *
 * 挂在 `stores` 集合的**行操作列**上（`TableActionsColumnModel`），与工单表的
 * 「处理」完全同构 —— 复用同一套 `flowModels:save` 播种机制与同一条
 * `actionRow()` 形状，不引入任何新的挂载方式。
 *
 * ⚠️ 它**刻意不进** `TICKET_ACTION_USES`：
 *    那个常量被 `reconcileTicketActions()` 用来算"工单表上的动作实例总数"
 *    （`表数 × 模型数`）。把门店表的动作混进去会让那个计数无端多出 1，
 *    而"计数不对"是本项目里最容易把真实缺陷伪装成噪音的判据之一。
 *    两者共用的是**挂载机制**，不是**归属清册**。
 */
export const STORE_ENTRY_ACTION_MODELS = [
  { use: 'StoreEntryActionModel', key: 'storeEntry', label: '报修入口' },
];

export const STORE_ENTRY_ACTION_USES = STORE_ENTRY_ACTION_MODELS.map((m) => m.use);

/**
 * 「这一行是不是本脚本该负责的自定义动作行」——**新动作 ∪ 旧按钮墙 ∪ 门店入口**。
 *
 * 为什么把**旧动作**也算进来：用户要的是"旧动作行数必须为 0"，
 * 而"为 0"这件事只能在**播种前**由播种脚本自己保证（播种后靠 verify 去发现就已经晚了，
 * 那时库里已经是部分迁移状态）。所以 seed 的预清理必须同时扫这三类。
 *
 * @param {any} node flowModels 行（顶层必须有 `use`，见文件头那条判据）
 * @returns {boolean}
 */
export function isSeedManagedActionRow(node) {
  return (
    TICKET_ACTION_USES.includes(node?.use) ||
    FORBIDDEN_ROW_ACTION_USES.includes(node?.use) ||
    node?.use === TICKET_TAB_FILTER_USE ||
    STORE_ENTRY_ACTION_USES.includes(node?.use)
  );
}

/**
 * 本脚本负责的**全部** use（预清理/对账的扫描集合）。
 *
 * ⚠️ Tab 筛选**必须**在扫描集合里：`applyBlueprint(mode='replace')` 每次都会
 *    重建 TableBlock 并换新 uid，上一轮的筛选节点会变成孤儿 ——
 *    与行级动作完全同型，不收敛就会让 `flowModels` 无限膨胀。
 *
 * ⚠️ 门店入口动作（`STORE_ENTRY_ACTION_USES`）同理：它挂在 `stores` 表的操作列上，
 *    而那行 uid 每轮都会变。**必须**在扫描集合里，否则每次重跑都会多留一个孤儿。
 */
export const SEED_MANAGED_USES = [
  ...TICKET_ACTION_USES,
  ...FORBIDDEN_ROW_ACTION_USES,
  TICKET_TAB_FILTER_USE,
  ...STORE_ENTRY_ACTION_USES,
];

/**
 * 本脚本**当前**认可的 declaredKey（用于识别上一版遗留的旧键）。
 *
 * 旧版是 `svc.<动作key>`（无操作列前缀）⇒ 6 张表互相撞车 ⇒ applyBlueprint 409。
 * 判断"要不要清掉"时不能只看 use 对不对，**键的形状也必须对** ——
 * 否则那些"长得对、键是旧的"的行会继续把 409 顶住，而报错里只会报其中一对 uid，
 * 看不出全库还有多少。
 */
export function declaredKeyOf(tableUid, modelKey) {
  return `svc.${tableUid}.${modelKey}`;
}
