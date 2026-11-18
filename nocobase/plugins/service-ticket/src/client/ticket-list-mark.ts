/**
 * ticket-list-mark.ts —— 给「工单列表」这块表格打上作用域标记（R2.1.1 收口）
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 本轮为了让最右的「操作」列在第一屏可见，用了两条收紧表格宽度的规则：
 *   1. `table-layout: fixed`
 *   2. `colgroup col { width: auto }`
 *
 * 这两条如果写成 `body:has(.ant-table)` —— 只要当前页有表格就命中，
 * 会连带改掉本插件下**任何** antd 表格的列宽分配（历史档案、账号列表、导入预览……）。
 * 用户明确要求：**仅作用于本次工单列表区域，不全局覆写其他 Ant Design 表格的宽度规则**。
 *
 * ===========================================================================
 * 判据必须是「数据」而不是「路由」
 * ===========================================================================
 * 按路由 / 页签写死（比如 pathname 里有 /admin/tujyw08ec1d）有三个问题：
 *   · 生产与隔离环境的 schemaUid 不同 ⇒ 上线后规则静默失效（本项目已踩过）；
 *   · 用户可能新建视图、复制页签 ⇒ 新页面拿不到样式；
 *   · 页面配置差异本身就是"代码发了、UI 没生效"的成因之一。
 *
 * 所以这里改为识别**内容**：表格表头里同时出现
 * 「工单号」与「工单状态」这两列，才认定这是工单列表，然后给它的容器打上
 * `data-svc-ticket-list="1"`。判据落到**精确列名**上（不是"有表格就算"，也不是
 * 含「工单」二字的模糊匹配 —— 那会命中「工单类型」这类列而错伤详情页里的表）。
 *
 * ===========================================================================
 * 已知边界（如实记录，不隐瞒）
 * ===========================================================================
 * · 工单详情抽屉里如果也嵌了一张含「工单号 + 工单状态」的表，会被误标 —— 实际不会：
 *   抽屉里的表是字段明细（标签/值），没有表头行，判据要求 `thead th` 文案命中。
 * · 这是**展示层标记**，不参与任何权限或业务判断，误标最多导致列宽分配方式变化。
 * · 任何异常都吞掉：后台是 SPA，这里抛错会导致白屏。
 */

/**
 * 认定「这是工单列表」所必需的列名（表头文案，去空格后精确比对）。
 *
 * ⚠️ 第一版写的是 ['工单号', '工单状态']，实测**永不命中** ——
 *    该列表的状态列表头就叫「状态」，不叫「工单状态」（_r211-scopecheck 实测值）。
 *    这正是"判据太宽 = 假绿、太窄 = 假红"的老坑，这里落在实测文案上。
 */
const REQUIRED_COLUMNS = ['工单号', '状态'];

/** 容器标记属性 */
export const TICKET_LIST_ATTR = 'data-svc-ticket-list';

/** 列语义标记属性：写在 th / td 上，值见 COL_SEMANTICS */
export const COL_ATTR = 'data-svc-col';

/**
 * 需要保底的列 —— 按**表头文案**认列，绝不按列序号。
 *
 * 🔴 2026-11-18 生产事故（DEV-270）：上一版 CSS 用 `nth-child(2)` 写死工单号列。
 *    本地隔离环境表头 9 列，生产表头 **13 列**（多出首列复选框与末列空占位），
 *    ⇒ 同一序号在生产指向「操作」列，工单号列只剩 87px，
 *      页面上被压成 "FW20261117-0…"。
 *    根因不是 CSS 写错，而是**判据用了环境相关的量（序号）去表达环境无关的语义（哪一列）**。
 *    ⇒ 改成：这里读表头文案，把语义写到 th/td 上；CSS 只认 `[data-svc-col='no']`。
 */
const COL_SEMANTICS: Record<string, string> = {
  工单号: 'no',
  操作: 'op',
};

/** 已经处理过的容器，避免每轮 MutationObserver 重复计算 */
const marked = new WeakSet<object>();

/** 表头文案集合（去所有空白字符） */
function headerTexts(table: any): string[] {
  const ths = table.querySelectorAll('thead th');
  const out: string[] = [];
  ths.forEach((th: any) => {
    const t = String(th?.innerText || '')
      .replace(/\s+/g, '')
      .trim();
    if (t) out.push(t);
  });
  return out;
}

/**
 * 按**表头文案**把列语义写到每一个 th / td 上（与列数、列序无关）。
 *
 * 返回本表被标注的列语义列表。找不到的列就不标，CSS 那边自然不生效 —— 
 * 宁可少标，也不按序号猜。
 */
function markColumns(table: any): string[] {
  const ths = table.querySelectorAll('thead th');
  if (!ths || !ths.length) return [];

  // 先在第 0 行 th 上建立「列序号 → 语义」
  const idxToSem: Record<number, string> = {};
  ths.forEach((th: any, i: number) => {
    const t = String(th?.innerText || '')
      .replace(/\s+/g, '')
      .trim();
    const sem = COL_SEMANTICS[t];
    if (!sem) return;
    idxToSem[i] = sem;
    if (th.getAttribute(COL_ATTR) !== sem) th.setAttribute(COL_ATTR, sem);
  });

  const sems = Object.keys(idxToSem);
  if (!sems.length) return [];

  // 再把同样的语义写到每一行的同序号 td 上
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach((tr: any) => {
    const tds = tr.querySelectorAll('td');
    Object.keys(idxToSem).forEach((k) => {
      const td = tds[Number(k)];
      if (!td) return;
      const sem = idxToSem[Number(k)];
      if (td.getAttribute(COL_ATTR) !== sem) td.setAttribute(COL_ATTR, sem);
    });
  });

  return Object.keys(idxToSem).map((k) => idxToSem[Number(k)]);
}

/**
 * 给符合条件的表格打标记。返回本次**新增标记的数量**（0 = 没有新命中）。
 *
 * 标记打在「表格外层容器」而不是 body 上，是为了让 CSS 的后代选择器
 * `[data-svc-ticket-list] .ant-table table` 只覆盖这一棵子树。
 *
 * ⚠️ 参数/局部变量一律 `any`：`tsconfig.check.json` 是 `types: []` 且无 `lib.dom`，
 *    `Element` / `ParentNode` 这类 **DOM 类型**在类型态不存在（TS2304 会被门禁判红）。
 *    按本文件既有纪律（见 types/ambient-stubs.d.ts 末段），**不**把 DOM 类型
 *    搬进 ambient —— 那会把"真拼错"吞成 any。这里用 any 并写明原因。
 */
export function markTicketListTables(root: any = document): number {
  let n = 0;
  if (!root?.querySelectorAll) return n;
  const tables = root.querySelectorAll('table');
  tables.forEach((table: any) => {
    const heads = headerTexts(table);
    if (!REQUIRED_COLUMNS.every((c) => heads.includes(c))) return;

    // 标记点：优先 .ant-table（wrapper 内层），退回 table 的父节点。
    // 用 .ant-table 是因为 fixed 布局要同时命中 .ant-table-content 内的 table。
    const box = table.closest('.ant-table') || table.parentElement;
    if (!box) return;
    if (!marked.has(box)) marked.add(box);
    if (!box.hasAttribute(TICKET_LIST_ATTR)) {
      box.setAttribute(TICKET_LIST_ATTR, '1');
      n += 1;
    }

    // 列语义标记（每次都要跑：切页签会重建 tbody，新行没有属性）
    try {
      markColumns(table);
    } catch {
      /* 列标记失败不影响容器标记 */
    }
  });
  return n;
}

/**
 * 启动标记器。
 *
 * 用 MutationObserver 而不是 `setInterval`：NocoBase 表格是异步渲染的，
 * 首屏 8~13 秒才出首行（实测）。轮询会白跑几百次；MutationObserver 只在
 * DOM 真变化时触发，且能覆盖「切页签重渲染」后的新表格。
 */
export function installTicketListMark(): void {
  if (typeof document === 'undefined') return;

  const run = (): void => {
    try {
      markTicketListTables(document);
    } catch {
      /* 不影响页面 */
    }
  };

  run();

  const ObserverCtor = (globalThis as any).MutationObserver;
  if (!ObserverCtor) return;
  let pending = false;
  const observer = new ObserverCtor(() => {
    if (pending) return;
    pending = true;
    const g: any = globalThis as any;
    const defer = g?.requestAnimationFrame || ((f: () => void) => setTimeout(f, 16));
    defer(() => {
      pending = false;
      run();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
