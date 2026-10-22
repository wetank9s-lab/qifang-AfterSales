/**
 * 客户 H5 的**装修默认值**（UX-01D M1）。
 *
 * ⚠️ 这份常量必须与后端 `services/page-theme.ts` 的 `DEFAULT_UI_DOC` **逐字段一致**：
 *   · 它承担两个职责：① 接口不可用时的兜底；② "从未发布"时的页面长相。
 *   · 两处漂移的后果是——**同一家门店在"接口正常"与"接口挂了"时长得不一样**，
 *     而这种差异只在弱网/故障时出现，验收时几乎撞不到。
 *   · `scripts/verify-ux-01d-config.mjs` 会读这两个文件做逐字段比对（漂移 ⇒ 门禁红）。
 *
 * 所以改这里的任何值，都必须同步改后端默认值，并重跑门禁。
 */
export interface UiThemeDoc {
  schema_version: number;
  brand: { name: string; subtitle: string };
  theme: { preset: 'classic-blue' | 'brand-red' | 'graphite' };
  copy: { media_help: string };
  modules: { media_help: boolean };
}

export const UI_DOC_SCHEMA_VERSION = 1;

export const DEFAULT_UI_DOC: UiThemeDoc = {
  schema_version: UI_DOC_SCHEMA_VERSION,
  brand: {
    name: '四川七方连锁售后服务平台',
    subtitle: '',
  },
  theme: {
    preset: 'classic-blue',
  },
  copy: {
    media_help: '也可直接填写文字，任选一种即可说明问题。',
  },
  modules: {
    media_help: true,
  },
};

/** 合法预设（服务端也校验；前端只用于"不认识的预设回退默认"） */
export const UI_THEME_PRESETS = ['classic-blue', 'brand-red', 'graphite'] as const;

/**
 * 把服务端返回的文档收敛成**可信形状**。
 *
 * 为什么前端还要收敛一次：接口被中间层改写/版本回退时，页面不能因为
 * "少了一个 key"就白屏。缺的补默认、不认识的枚举回退默认、多出来的键丢弃
 * （**不用** `Object.assign(doc, remote)` —— 那会把未知字段带进渲染逻辑）。
 */
export function normalizeUiDoc(raw: unknown): UiThemeDoc {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const brand = (src.brand && typeof src.brand === 'object' ? src.brand : {}) as Record<string, any>;
  const theme = (src.theme && typeof src.theme === 'object' ? src.theme : {}) as Record<string, any>;
  const copy = (src.copy && typeof src.copy === 'object' ? src.copy : {}) as Record<string, any>;
  const modules = (src.modules && typeof src.modules === 'object' ? src.modules : {}) as Record<string, any>;

  const preset = String(theme.preset ?? '');
  const safePreset = (UI_THEME_PRESETS as readonly string[]).includes(preset)
    ? (preset as UiThemeDoc['theme']['preset'])
    : DEFAULT_UI_DOC.theme.preset;

  return {
    schema_version: Number(src.schema_version ?? UI_DOC_SCHEMA_VERSION),
    brand: {
      name: String(brand.name ?? DEFAULT_UI_DOC.brand.name).trim() || DEFAULT_UI_DOC.brand.name,
      subtitle: String(brand.subtitle ?? DEFAULT_UI_DOC.brand.subtitle),
    },
    theme: { preset: safePreset },
    copy: {
      media_help: String(copy.media_help ?? DEFAULT_UI_DOC.copy.media_help),
    },
    modules: {
      media_help:
        typeof modules.media_help === 'boolean' ? modules.media_help : DEFAULT_UI_DOC.modules.media_help,
    },
  };
}
