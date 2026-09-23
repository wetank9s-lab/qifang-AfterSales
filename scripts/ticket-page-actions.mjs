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
export const TICKET_ACTION_MODELS = [
  { use: 'TicketDetailActionModel', key: 'detail', label: '详情' },
  { use: 'TicketAcceptActionModel', key: 'accept', label: '受理' },
  { use: 'TicketDispatchActionModel', key: 'dispatch', label: '派工' },
  { use: 'TicketReassignActionModel', key: 'reassign', label: '改派' },
  { use: 'TicketRescheduleActionModel', key: 'reschedule', label: '改约' },
];

export const TICKET_ACTION_USES = TICKET_ACTION_MODELS.map((m) => m.use);

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
      __flowSurfaceMeta: { declaredKey: `svc.${model.key}` },
    },
    flowRegistry: {},
    sortIndex,
  };
}
