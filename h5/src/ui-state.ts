/**
 * 装修配置的**前端状态**（UX-01D M1）。
 *
 * 三条纪律：
 *   1. **接口失败绝不白屏**：拿不到配置就用内置默认值，页面照常可用
 *      （装修是"锦上添花"，不能成为新的单点故障）；
 *   2. **不做 localStorage/sessionStorage 缓存**：缓存会让"发布后要等过期"，
 *      而 HTTP 层已经有 ETag/304 兜住流量（见服务端 `publicUiTheme:get`）；
 *   3. **应用配置只改 CSS 变量与文案绑定**，不重建组件树 ——
 *      所以切换主题/预览刷新**不会清空用户输入、也不会重置上传会话**。
 */
import { reactive } from 'vue';
import { fetchUiConfig } from './api/ui';
import { DEFAULT_UI_DOC, normalizeUiDoc, type UiThemeDoc } from './ui-defaults';

interface UiState {
  doc: UiThemeDoc;
  /** 0 = 从未发布（用默认值） */
  version: number;
  /** 是否处于"后台预览"模式（此时禁止提交与媒体采集） */
  preview: boolean;
  /** 预览凭证对应的草稿修订号 */
  previewRevision: number;
  /** 配置是否已尝试加载过（成功或失败都算，避免重复请求） */
  ready: boolean;
  /** 加载失败时的原因（只用于诊断，不展示给客户） */
  lastError: string;
}

export const ui = reactive<UiState>({
  doc: { ...DEFAULT_UI_DOC },
  version: 0,
  preview: false,
  previewRevision: 0,
  ready: false,
  lastError: '',
});

/** 把一份文档应用到页面：CSS 主题变量 + 页签标题（**不触碰任何表单状态**） */
export function applyUiDoc(raw: unknown): void {
  const doc = normalizeUiDoc(raw);
  ui.doc = doc;
  ui.ready = true;

  // 主题：只切 `data-theme`，具体的颜色变量由 base.css 定义（不允许运行期注入样式字符串）
  const root = document.documentElement;
  if (doc.theme.preset === 'classic-blue') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', doc.theme.preset);

  // 页签标题：先用品牌名兜底；各页面可在加载完成后调 `setPageTitle('服务报修')` 补后缀
  // （`index.html` 里的 static 值只是 JS 未执行时的兜底）
  document.title = doc.brand.name;
}

/**
 * 拉取**已发布**配置（进页面时调用一次）。
 *
 * 静默失败：任何异常都只记录到 `ui.lastError`，页面继续用默认值。
 * 这正是"配置读取失败时使用安全默认值"的落地方式。
 */
export async function ensureUiConfig(entry?: string): Promise<void> {
  if (ui.ready) return;
  try {
    const config = await fetchUiConfig(entry);
    ui.version = Number(config?.version ?? 0);
    applyUiDoc(config);
  } catch (error) {
    ui.ready = true;
    ui.lastError = String((error as Error)?.message ?? error);
    applyUiDoc(DEFAULT_UI_DOC);
  }
}

/** 退出预览态（预览页整页刷新即可，一般不需要显式调用） */
export function exitUiPreview(): void {
  ui.preview = false;
  ui.previewRevision = 0;
}

/** 设置页签标题：`<品牌名> · <页面后缀>`（品牌名始终来自当前生效配置） */
export function setPageTitle(suffix: string): void {
  document.title = suffix ? `${ui.doc.brand.name} · ${suffix}` : ui.doc.brand.name;
}
