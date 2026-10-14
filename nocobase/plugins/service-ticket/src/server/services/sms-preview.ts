/**
 * 短信正文渲染（纯函数）—— 从 `SmsService.renderPreview` 原样抽出。
 *
 * 为什么要抽出来：
 *   · 它是"最终发出去的正文长什么样"的**唯一实现**；
 *   · 短信宝要的是**完整正文**（`c` 参数），所以这份渲染结果就是**真实发送内容**；
 *   · 抽成纯函数后，验收可以**直接验证产品的同一份逻辑**，
 *     而不是在测试脚本里再写一遍 `{var}` 替换（那就是"重复造轮子"，
 *     且两份实现迟早漂移）。
 *
 * ⚠️ 行为必须与原来完全一致（含空白压缩与长度截断）。
 */
import { SMS_PREVIEW_MAX_LENGTH, SMS_TEMPLATE_TEXT } from '../constants';

export function renderSmsPreview(
  scene: string,
  params: Record<string, string | number>,
  signName: string,
): string {
  const template = SMS_TEMPLATE_TEXT[scene];
  if (!template) {
    return `【${signName}】${scene}：${JSON.stringify(params)}`;
  }

  const merged: Record<string, string | number> = { ...params, sign: signName };
  let text = template.replace(/\{(\w+)\}/g, (_all, key: string) => {
    const value = merged[key];
    return value === undefined || value === null ? '' : String(value);
  });

  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > SMS_PREVIEW_MAX_LENGTH) {
    text = `${text.slice(0, SMS_PREVIEW_MAX_LENGTH - 1)}…`;
  }
  return text;
}
