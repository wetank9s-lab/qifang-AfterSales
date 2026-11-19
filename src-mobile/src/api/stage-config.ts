/**
 * 暖通施工阶段的显示配置（R2.2.1 §八 / §六）
 *
 * ===========================================================================
 * 为什么阶段名必须走接口，而不是打包进 bundle
 * ===========================================================================
 *   用户原话：「改显示名不重写档案数据、不改员工备注、不删历史；
 *              **配置修改不需要重建移动端**」。
 *
 *   只要阶段名是 bundle 里的常量，改一个名字就得重新构建、重新发版 ——
 *   而 `src-mobile/dist` 是随插件一起部署的静态产物，那意味着一次"改名"
 *   要走完整的构建 + 重启流程。所以这里每次进页面**真读一次接口**。
 *
 * ===========================================================================
 * 三条容错规则（都是"宁可显示旧名字，也不要空着"）
 * ===========================================================================
 *   ① **请求失败不抛**：返回默认名并要求"下次再试"。
 *      阶段名是装饰性信息，读不到不该让整页 500 —— 档案的日期、照片、
 *      完成状态才是业务事实，它们走的是另一条链路。
 *   ② **服务端少给某个 code** ⇒ 该阶段回退代码默认名，**不补空串**
 *      （空名字会渲染成"没有标题的一行"，员工会以为那一行坏了）。
 *   ③ **同一页面内缓存一次**：详情页一次渲染要读六次阶段名，
 *      但配置是一个请求。组件级 useState + 一个模块级 in-flight 去重，
 *      避免"六个阶段各发一次请求"。
 *
 * ⚠️ 不做 TTL 缓存：销售在现场刚改完配置、切回档案页要**立刻**看到新名字。
 *    多一次 200ms 的请求，换"改了不生效"的困惑，这笔账很划算。
 */

import { request } from './http';
import {
  HVAC_STAGE_META,
  HVAC_STAGE_ORDER,
  type HvacStageConfig,
} from '../design/qf-tokens';

export interface StageConfigResult {
  stages: HvacStageConfig[];
  /** 配置来源：`database` = 后台改过；`default` = 从未配置 */
  source: 'database' | 'default';
  updated_at: string | null;
  /**
   * 读取是否真的成功。
   * ⚠️ `false` 时 `stages` 是**代码默认名**，不是服务端事实 ——
   *    调用方要据此决定"要不要在界面上提示配置暂不可用"。
   */
  ok: boolean;
}

/** 代码默认名（服务端 `ARCHIVE_STAGE_LABEL` 的同源副本，仅作降级用） */
export function defaultStageConfig(): HvacStageConfig[] {
  return HVAC_STAGE_ORDER.map((code, i) => ({
    code,
    order: i + 1,
    name: HVAC_STAGE_META[code]?.label ?? code,
    description: '',
  }));
}

/**
 * 归一化：按 `order` 排序、补齐缺失的 code、丢弃未知的 code。
 *
 * 这三件事必须**在客户端再做一遍**，不能信任响应形状：
 * 后端某次改动把 `stages` 改成 `{ items: [...] }` 时，
 * 不做归一化就会渲染出六个 `undefined` 名字，而接口是 200。
 */
export function normalizeStageConfig(raw: unknown): HvacStageConfig[] {
  const list = Array.isArray(raw) ? raw : [];
  const byCode = new Map<string, HvacStageConfig>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const code = String((item as any).code ?? '');
    if (!(HVAC_STAGE_ORDER as readonly string[]).includes(code)) continue;
    const name = String((item as any).name ?? '').trim();
    byCode.set(code, {
      code,
      order: Number((item as any).order) || HVAC_STAGE_ORDER.indexOf(code as any) + 1,
      name: name || HVAC_STAGE_META[code]?.label || code,
      description: String((item as any).description ?? ''),
    });
  }

  return defaultStageConfig()
    .map((d) => byCode.get(d.code) ?? d)
    .sort((a, b) => a.order - b.order);
}

/** 模块级 in-flight 去重：同一时刻多个组件挂载只发一次 */
let inflight: Promise<StageConfigResult> | null = null;
let memo: StageConfigResult | null = null;

export async function fetchStageConfig(force = false): Promise<StageConfigResult> {
  if (!force && memo) return memo;
  if (!force && inflight) return inflight;

  inflight = (async (): Promise<StageConfigResult> => {
    try {
      const r = await request<any>('/svc:archiveStageConfigGet', { timeoutMs: 12_000 });
      const out: StageConfigResult = {
        stages: normalizeStageConfig(r?.stages),
        source: r?.source === 'database' ? 'database' : 'default',
        updated_at: typeof r?.updated_at === 'string' ? r.updated_at : null,
        ok: true,
      };
      memo = out;
      return out;
    } catch {
      // 见文件头 ①：不抛、不弹错，退回默认名
      return { stages: defaultStageConfig(), source: 'default', updated_at: null, ok: false };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** 测试/登出用：清掉缓存，避免下一个账号看到上一个账号的配置 */
export function resetStageConfigCache(): void {
  memo = null;
  inflight = null;
}
