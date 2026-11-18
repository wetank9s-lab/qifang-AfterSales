/**
 * admin-style.ts —— 后台「商用观感」样式收口（R2）
 *
 * =============================================================================
 * 为什么是 CSS 而不是改页面 schema
 * =============================================================================
 *   工单列表的筛选栏与行操作是 NocoBase 页面 schema 里的字段/动作，
 *   改 schema 要么走 `flowSurfaces:applyBlueprint`（需要完整 blueprint，
 *   改错等于整页白屏），要么在后台设计器里手点。
 *   而"控件高度、行内对齐、按钮形态"本来就是**视觉层**的事 ——
 *   用样式收口风险最低、可随时回退（删掉这个 style 标签即恢复）。
 *
 * =============================================================================
 * 作用域纪律
 * =============================================================================
 *   全部规则都挂在 `:has(.ant-table)` 之下 —— 只有"页面上真的有表格"才生效。
 *   这样不会把设置页、表单页的控件高度一起改掉。
 *   （:has 在 Chrome 105+ / Safari 15.4+ 可用；本系统后台只用现代浏览器。）
 */

const STYLE_ID = 'svc-admin-r2-style';

const CSS = `
/* ---------- 筛选栏：控件 32px，行内对齐（R2.1.1 收紧） ----------
 *
 * 为什么要从 40px 收到 32px：
 *   用户裁决的目标是「桌面默认高度 80-100px」。
 *   改前实测结构（1440 视口、「全部」页签）：
 *       form 176 = 两行字段 148（每行 74）+ 按钮行 28
 *   折叠低频字段后变成一行 4 项，实测 102 = 字段行 74 + 按钮行 28 —— 差 2px 进不去。
 *   这 74px 里，控件占 40px、标签占约 22px、form-item 下边距 12px。
 *   控件收到 32px 后字段行 ≈ 66，总计 ≈ 94px，落进 80-100 区间。
 *
 * 为什么只动「筛选栏」而不动表格里的输入控件：
 *   全部规则都挂在 :where(body:has(.ant-table)) 之下，而且限定在 .ant-form 里 ——
 *   表格单元格里没有 .ant-form，抽屉/弹窗里的表单也不在筛选卡片内。
 *   （实测抽屉表单不在表格 DOM 内，且抽屉里有自己的 .ant-table 时才会命中，
 *     概率极低；万一出现，把选择器再收窄到 .ant-card 即可。）
 */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-control-input {
  min-height: 28px !important;
}
/* 内部控件统一 28px（不限层级：AntD 会把它们包在 affix/select 里） */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-control-input-content :is(
  .ant-input, .ant-input-affix-wrapper, .ant-select .ant-select-selector, .ant-picker
) {
  min-height: 28px !important;
}
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-control-input-content .ant-select-single .ant-select-selector,
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-control-input-content .ant-picker {
  height: 28px !important;
  display: flex;
  align-items: center;
}
/* 标签行紧凑一点：去掉 AntD 默认的 8px 标签下间距，行高收到 20px */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-label {
  padding-bottom: 0;
  line-height: 20px;
}
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-label > label {
  height: 16px;
  line-height: 16px;
  font-size: 12px;
  color: #5a6270;
}
/* form-item 下边距：两列栅格里这就是行距，收到 6px
   ⚠️ 必须 !important：AntD 的 .css-17h1pxo 里 margin-bottom:12px 优先级更高，
      不加 !important 这条从来没生效过（实测 54 = 18 标签 + 32 控件 + 12 边距）。 */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item {
  margin-bottom: 6px !important;
}
/* 标签行的最小高度是 AntD 给的 1px + label 18px，再收一点 */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-label > label {
  margin-bottom: 2px;
}

/* ==========================================================================
   筛选栏「两列栅格」—— 降级方案（用户 2026-11-17 第一项裁决授权）
   ==========================================================================
   为什么走到 CSS 这一步（先看结论，别再回头试布局配置）：

   库里的布局配置对**运行时**不起作用，这是实测结论不是猜测：
     6 个 grid 的 props.rows / sizes / rowOrder 被我改成 4 种不同结构
     （[6,6,6,6] 一行、[12,12] 两行、每行 1 item 共 7 行、多 cell 两列），
     每次改完 docker restart svc-app，**页签高度一字不变全是 292**。
     而 getVisibleLayout() 的输出始终是「每项独占一行、size=24」。

   根因（读 index-93181bbb.js @3153177 normalizeGridLayout）：
     · 它先把 rows 过一遍 ea(..., {validUids, seenUids})；
     · seenUids 是**跨 cell 共享**的去重集合：
           filter(e => e === el || (!seenUids.has(e) && (seenUids.add(e), true)))
     · 凡是没在 ea 阶段被吃掉的 item，最后由
           rows.push(en(uid, generateId()))   // en = 单 item 独立一行
       补成「自己一行」。en 生成的 row id 是随机 uid（如 h7965p9p4r8），
       **不是** row1/row2 —— 这正是日志里那些随机行 id 的来源。
     · 「全部」页签之所以 94px，是因为它的 grid 恰好还能算出 1 行 4 格，
       属于历史偶然，不是可复制的配置。

   所以：**不再对抗布局引擎**，改用纯 CSS 让字段横向排布。
   这是用户明文授权的降级路径：
       「如稳定方案无法接入，允许用原生表单的紧凑两行布局作安全降级，
         目标约 120-140px，并说明限制。」

   实现要点：
     · 只用 grid 布局，不改 DOM 结构、不用 JS、不加 useEffect；
     · 折叠逻辑（filter-compact.tsx 的 setHidden）保持不变 —— 收起态只有
       4 个字段参与栅格，自然排成 2 列 x 2 行 = 约 130px；
     · 展开态 7 个字段排成 2 列 x 4 行（最后一行单列）；
     · 只命中筛选卡片里的 form（body:has(.ant-table) + .ant-card 双限）。
   */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-row {
  /* 覆盖 AntD 的行内 flex：让字段按栅格自动排 */
  display: contents !important;
}
/* 每行容器自身不再是"一行"：让所有 cell 落到同一个栅格里 */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-row > [class*='ant-col'] {
  width: 100% !important;
  max-width: 100% !important;
  flex: none !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  display: contents;
}
/* 单元格内部的 form-item 不再纵向堆叠（原布局会把多个 item 塞进一个 cell） */
:where(body:has(.ant-table)) .ant-card .ant-form .ant-row > [class*='ant-col'] > div {
  display: contents;
}
/* 栅格容器：由网格的根 div 承担两列布局 */
:where(body:has(.ant-table)) .ant-card .ant-form [data-grid-root] {
  display: grid !important;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 12px;
  row-gap: 0;
  align-content: start;
}
/* 网格根内部的直接子元素不应再各自成为栅格容器 */
:where(body:has(.ant-table)) .ant-card .ant-form [data-grid-root] > div {
  display: contents !important;
}
/* 窄屏（<720px）退回单列，避免手机上挤成两半 */
@media (max-width: 720px) {
  :where(body:has(.ant-table)) .ant-card .ant-form [data-grid-root] {
    grid-template-columns: minmax(0, 1fr);
  }
}
/* ---------- 表格行操作（R2.1.1 重写，用户 2026-11-17 指令 ②） ----------
 *
 * 改之前的规则是"第一个动作实心蓝、其余浅蓝填充"—— 实测后果：
 *   ① 每行都顶着一块高饱和蓝药丸，一屏十几行全在喊"点我"；
 *   ② 「详情」这种纯查看动作也被染成主色，看与做分不开；
 *   ③ 尺寸是 32px / 8px 圆角，与"30-32px、6px"的冻结规格不符。
 *
 * 现在的分层（按按钮自己的 data-primary-action 判别，不再按"第几个"猜）：
 *   · 实际处理（handle/follow/review）= **蓝色**，那才是这行真要做的事
 *   · 查看（view/detail）             = **中性描边**，一眼看出是"看"
 * 圆角统一 6px，高度 30px（落在 30-32 区间）。
 * ⚠️ 用 data-primary-action 而不是 :first-of-type：后者在"只有详情按钮"的行上
 *    也会命中，于是又把中性按钮染成蓝 —— 这是改前那版最隐蔽的错。
 * ⚠️ 本段注释里**不能出现反引号**：它会把外面那层模板字符串提前闭合（真踩过）。
 *    **也不能出现成对的英文单/双引号包中文**（如 双引号 看你 双引号）：
 *    tsc 会把它们当字符串字面量，进而把 ASCII 引号后面的中文当代码解析，
 *    报一堆 TS1005 / TS1003（位置全落在注释行，极具误导性；真踩过第二次）。
 *    需要强调时用【】或「」。
 */
:where(body:has(.ant-table)) .ant-table-tbody .ant-btn:is(.ant-btn-link, .ant-btn-variant-link) {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 28px;
}
/* 实际处理动作 = 蓝色实心
 * ⚠️ 选择器要写 [data-primary-action] 而不带标签名：实测框架把行内动作渲染成
 *    button 标签（不是 a 标签），写 td a[...] 会一条都匹配不上 ——
 *    改完看着对、页面却没变。这也解释了为什么第一版改完按钮仍是透明白底。
 * ⚠️ 本段全部用【单引号】包裹属性值，不用双引号：本文件整体在模板字符串里，
 *    属性值再套双引号最容易与注释里的中文引号混成一锅（见上方禁忌说明）。 */
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='handle'],
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='follow'],
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='review'] {
  background: var(--ant-color-primary, #1677ff) !important;
  border: 1px solid var(--ant-color-primary, #1677ff) !important;
  color: #fff !important;
}
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='handle']:hover,
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='follow']:hover,
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='review']:hover {
  background: var(--ant-color-primary-hover, #4096ff) !important;
  border-color: var(--ant-color-primary-hover, #4096ff) !important;
  color: #fff !important;
}
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='handle'] span,
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='follow'] span,
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='review'] span {
  color: #fff !important;
}
/* 查看动作 = 中性描边，不抢主色 */
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='view'] {
  background: #fff !important;
  border: 1px solid #d9dde3 !important;
  color: #4e5969 !important;
}
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='view']:hover {
  background: #f7f8fa !important;
  border-color: #c3c9d1 !important;
  color: #1f2329 !important;
}
:where(body:has(.ant-table)) .ant-table-tbody td [data-primary-action='view'] span {
  color: #4e5969 !important;
}

/* 动作之间留一点间距，避免两个按钮粘在一起 */
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn + .ant-btn {
  margin-left: 6px;
}

/* ---------- 状态列：给纯文字加一点承托，便于扫读 ---------- */
:where(body:has(.ant-table)) .ant-table-tbody td[class*="column-status"] > span,
:where(body:has(.ant-table)) .ant-table-tbody td[class*="status"] > span {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--ant-color-fill-quaternary, #f5f5f5);
  font-size: 13px;
}
/* ==========================================================================
   工单列表「操作列进首屏」—— 用户 2026-11-17 第二项裁决的硬性要求
   ==========================================================================
   问题（实测 _r211-colprobe.mjs）：
     表格 1408px，容器只有 1166px，.ant-table-content 的 overflow-x 是 auto
     ⇒ 最右的**操作列被横向裁在可视区外**，第一屏根本看不到。
     这不是「没渲染」：末列里确实有按钮（span 内一个 button，文案「详情」/「处理工单」），
     只是整列被挤出去了。

   解决方向：不改列模型、不删列、不覆写 getColumnProps（用户明文禁止），
   只压缩每列的最小宽度 + 允许内容换行，让总宽落回容器内。

   数值来源：
     · 11 列 × 原来每列 150px ≈ 1408px；
     · 目标 ≤ 1166px ⇒ 平均要 ≤ 106px，所以给常用的窄列 96px、内容列 132px；
     · 状态/工单类型这种两三个字的列 78px 足够；
     · 工单号是链接、要能看清 12 位，给 140px；
     · 操作列（有按钮的那列）给 96px 并禁止换行，保证按钮完整。
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   【作用域收窄 · R2.1.1 收口】表格宽度规则只对「工单列表」生效。

   原写法是 body:has(.ant-table) —— 只要当前页有表格就命中，会连带改掉本插件下
   其它任何 antd 表格的列宽分配。用户明确要求「仅作用于本次工单列表区域，
   不全局覆写其他 Ant Design 表格的宽度规则」。

   收窄手段是「数据驱动」而不是「按路由/页签写死」：
   由 ticket-list-mark.ts 按「表头同时含 工单号 + 状态」给容器打上
   data-svc-ticket-list="1"，CSS 以此为锚点。

   🔴 关键：必须 !important —— antd 把 widths 写在**元素 inline style** 上
   （<table style="width:max-content;min-width:100%;table-layout:fixed">、
     <colgroup><col style="width:150px">），inline 优先级高于任何选择器。
   ==========================================================================
   实测（2026-11-18，_r211-abprobe 四组对照 / 1440px）：
     A 现状（两条规则未命中）       : tblW 1412, 容器 1166, 右侧溢出 246px
     B 摘掉整张插件样式表           : tblW 1408 —— 差 4px，规则**没有效果**
     C 手动打标记让规则命中         : tblW 1393
     D C + 抹掉 col 的 inline 宽度  : tblW 1393 —— 与 C 完全相同
   ⇒ 旧写法的两条规则（无 !important + 前置 :where()）**既无条件命中、
     也压不过 inline**，是本轮最大的自我欺骗。
   ==========================================================================
   即便做成能生效，11 列 × 106px ≈ 1166px 才刚好塞满，而「操作」列的文字
   （"处理工单"/"审核回执"）在 106px 内必被截断 ⇒ 本文件只做**尽量收窄**，
   真正的保证由「操作列左移」承担（见 row-action-matrix）。
   -------------------------------------------------------------------------- */
:where([data-svc-ticket-list]) table,
:where([data-svc-ticket-list]) .ant-table table {
  table-layout: fixed !important;
  width: 100% !important;
  min-width: 0 !important;
}
/* antd 的 col 宽度是 inline style，选择器压不过 inline（非 !important 的 inline
   优先级最高），所以这里必须 !important 才能把 col 让给 fixed 布局分配。 */
:where([data-svc-ticket-list]) .ant-table table colgroup > col,
:where([data-svc-ticket-list]) table colgroup > col {
  width: auto !important;
  min-width: 0 !important;
}
:where(body:has(.ant-table)) .ant-table-thead > tr > th,
:where(body:has(.ant-table)) .ant-table-tbody > tr > td {
  padding: 8px 8px !important;
  white-space: normal;
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* --------------------------------------------------------------------------
   两张「必须保底」的列：工单号 与 操作

   ⚠️ 这两条**必须挂在 [data-svc-ticket-list] 上**（不能沿用 body:has(.ant-table)）：
      否则本插件下其它表格的第 2 列也会被当工单号处理。

   🔴 关键坑（连踩两次）：
      1) 在 table-layout:fixed 下给 td/th 写 min-width **不参与列宽计算**；
      2) 给 colgroup col 写 min-width **也不参与**（实测 12 个 col 全被压成 90px）。
      fixed 布局只认「列宽 = 首行单元格的 width」，min/max 一律忽略。
      判据也必须用对内层：td 的 scrollWidth 反映 td 自身，
      而真正的裁剪发生在带 ellipsis 的 td 的 overflow:hidden 上。
      ⇒ 保底宽度用 **width**（不是 min-width），同时给 col 和首行 td 写，
        让 colgroup 与 cell 都是 112px，任何一侧生效都够。
   -------------------------------------------------------------------------- */
:where([data-svc-ticket-list]) table colgroup > col:nth-child(2),
:where([data-svc-ticket-list]) table thead th:nth-child(2),
:where([data-svc-ticket-list]) table tbody tr:first-child td:nth-child(2) {
  width: 136px !important;
}
:where([data-svc-ticket-list]) table colgroup > col:nth-last-child(2),
:where([data-svc-ticket-list]) table thead th:nth-last-child(2),
:where([data-svc-ticket-list]) table tbody tr:first-child td:nth-last-child(2) {
  width: 84px !important;
}
/* 工单号文字：不换行、字号略小，让 12 位在 112px 内排得下 */
:where([data-svc-ticket-list]) table tbody td:nth-child(2) {
  font-size: 12px;
  letter-spacing: -0.2px;
  white-space: nowrap;
  overflow: visible;
}
/* 内容列允许截断，避免长文本把列撑宽。同样只作用于工单列表。 */
:where([data-svc-ticket-list]) table tbody td {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

/**
 * 装样式。
 *
 * ⚠️ 不能只判「元素在不在」就返回 already —— 那会让**内容变更永远不生效**。
 *    真实踩过：把控件 40px 改成 32px、构建也成功了，但页面高度纹丝不动，
 *    因为标签早就在、内容是旧的（诊断输出里 `含 32px: false` 才暴露出这一点）。
 *    现在改成比较内容：一致才算 already，不一致就整段替换。
 */
export function installAdminStyle(): string {
  try {
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      if (existing.textContent === CSS) return 'already';
      existing.textContent = CSS;
      return 'updated';
    }
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    return 'installed';
  } catch {
    return 'failed';
  }
}
