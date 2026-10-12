/**
 * 历史 Excel 导入 —— **纯文本 CSV 守卫**。
 *
 * ⚠️ 本文件很小，但它挡的是一类**很难发现**的问题：CSV 公式注入。
 *
 * 真实场景：门店表里某一格被写成 `=1+1` 或 `@SUM(...)`，或者客户名被写成
 * `=HYPERLINK("http://evil","点我")`。读的时候 SheetJS **不会执行**公式（安全），
 * 但如果我们把原值原样导出成 CSV/Excel 再发给别人，对方用 Excel 打开就会**执行**它。
 *
 * ⇒ 规则：**只在"输出到电子表格"这一刻**给危险首字符加单引号前缀；
 *    **库里存的、报告里显示的仍是原值**（可追溯性优先，见 normalize.ts 头部）。
 *
 * 危险首字符：`=` `+` `-` `@` 以及制表符/回车开头的"分隔符逃逸"。
 */
const RISKY_LEAD = /^[=+\-@\t\r]/;

/** 输出到电子表格时的转义（**不改变库里存的值**） */
export function escapeForSpreadsheet(value: string): string {
  if (!value) return value;
  return RISKY_LEAD.test(value) ? `'${value}` : value;
}

/** 该值在导出时是否会被转义（供报告统计"有多少格被保护"） */
export function needsSpreadsheetEscape(value: string): boolean {
  return Boolean(value) && RISKY_LEAD.test(value);
}
