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
/* ---------- 筛选栏：控件统一 40px，行内对齐 ---------- */
:where(body:has(.ant-table)) .ant-form-item-control-input {
  min-height: 40px;
}
/* 内部控件统一 40px（不限层级：AntD 会把它们包在 affix/select 里） */
:where(body:has(.ant-table)) .ant-form-item-control-input-content :is(
  .ant-input, .ant-input-affix-wrapper, .ant-select .ant-select-selector, .ant-picker
) {
  min-height: 40px;
}
:where(body:has(.ant-table)) .ant-form-item-control-input-content .ant-select-single .ant-select-selector,
:where(body:has(.ant-table)) .ant-form-item-control-input-content .ant-picker {
  height: 40px;
  display: flex;
  align-items: center;
}
/* ---------- 表格行操作：从"文字链"变成"按钮" ---------- */
:where(body:has(.ant-table)) .ant-table-tbody .ant-btn-link {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 30px;
}
/* 第一个动作 = 最常用动作：实心主按钮 */
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn-link:first-of-type {
  background: var(--ant-color-primary, #1677ff);
  border: 1px solid var(--ant-color-primary, #1677ff);
  color: #fff;
}
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn-link:first-of-type:hover {
  background: var(--ant-color-primary-hover, #4096ff);
  border-color: var(--ant-color-primary-hover, #4096ff);
  color: #fff;
}
/* 其余动作 = 浅蓝填充的次级按钮 */
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn-link:not(:first-of-type) {
  background: var(--ant-color-primary-bg, #e6f4ff);
  border: 1px solid var(--ant-color-primary-border, #91caff);
  color: var(--ant-color-primary, #1677ff);
}
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn-link:not(:first-of-type):hover {
  background: var(--ant-color-primary-bg-hover, #bae0ff);
  color: var(--ant-color-primary, #1677ff);
}

/* 动作之间留一点间距，避免两个按钮粘在一起 */
:where(body:has(.ant-table)) .ant-table-tbody td .ant-btn-link + .ant-btn-link {
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
`;

export function installAdminStyle(): string {
  try {
    if (document.getElementById(STYLE_ID)) return 'already';
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    return 'installed';
  } catch {
    return 'failed';
  }
}
