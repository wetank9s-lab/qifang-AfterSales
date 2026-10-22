/**
 * sms-status.ts —— 短信通道的**可发送性**判定（UX-01C-R8）。
 *
 * ===========================================================================
 * 为什么要把它做成"服务端算好、前端只显示"
 * ===========================================================================
 * 「凭证是否配置」不是 UI 状态，而是**发送链路的真实前置条件**：
 *   · `AliyunSmsProvider.send()` 在 credentials 不全时返回 `SMS_PROVIDER_NOT_CONFIGURED`；
 *   · `SmsService.deliverOne()` 在非 mock 通道且模板 CODE 为空时返回 `SMS_TEMPLATE_NOT_CONFIGURED`；
 *   · `sms.enabled=false` 时一律 `SMS_DISABLED`。
 * 如果前端自己拼这套判断，一旦与发送链路分叉，就会出现"后台显示正常、实际全被拒"
 * —— 那正是本轮明令禁止的"把不支持的通道显示成可用"。
 *
 * ⚠️ 本模块**只读 env / 参数**，不回显任何凭证值：对外只给"是否齐全 + 缺哪几个键名"。
 *
 * ===========================================================================
 * 已核实的真实能力（2026-10-17）
 * ===========================================================================
 *   · `mock`    ：可用（不需要凭证/模板）
 *   · `aliyun`  ：实现完整；需 3 个凭证 + 每个 scene 的模板 CODE
 *   · `smsbao`  ：**实现存在但当前不可用** —— `SMS_TEMPLATE_ENV_PREFIX` 里没有 smsbao，
 *     于是 `templateCodeFor()` 恒返回空串 ⇒ `deliverOne()` 的模板闸门会把每一条都拒成
 *     `SMS_TEMPLATE_NOT_CONFIGURED`。在补齐之前，后台必须显示"不可用"，不能当可选项。
 */
import {
  SMS_PROVIDER_NAME,
  SMS_SCENE,
  SMS_TEMPLATE_ENV_PREFIX,
  SMS_TEMPLATE_ENV_SUFFIX,
} from '../constants';

export interface ProviderCredentialStatus {
  configured: boolean;
  /** 缺失的环境变量**键名**（不含值） */
  missingKeys: string[];
}

export interface ProviderStatus {
  name: string;
  label: string;
  /** 代码里是否有该通道的实现 */
  implemented: boolean;
  /** 是否**真的能发出去**（凭证 + 模板 + 实现 三项齐全） */
  ready: boolean;
  credentials: ProviderCredentialStatus;
  templates: {
    required: boolean;
    total: number;
    missingScenes: string[];
  };
  /** 人读原因（ready=false 时必填） */
  reason: string;
}

export interface SmsStatus {
  settings: { enabled: boolean; provider: string; retryCount: number };
  providers: ProviderStatus[];
  effective: { canSend: boolean; reason: string };
}

const PROVIDER_META: Record<string, { label: string; implemented: boolean; credentials: string[] }> = {
  [SMS_PROVIDER_NAME.MOCK]: { label: '模拟（不真实发送）', implemented: true, credentials: [] },
  [SMS_PROVIDER_NAME.ALIYUN]: {
    label: '阿里云短信',
    implemented: true,
    credentials: ['ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME'],
  },
  [SMS_PROVIDER_NAME.SMSBAO]: {
    label: '短信宝',
    implemented: true,
    credentials: ['SMSBAO_USERNAME', 'SMSBAO_API_KEY', 'SMSBAO_SIGN_NAME'],
  },
};

/** 需要模板 CODE 的 scene（排除 manual_resend：它是人工重发，继承原场景） */
function templateScenes(): string[] {
  return Object.keys(SMS_TEMPLATE_ENV_SUFFIX).filter((scene) => scene !== SMS_SCENE.MANUAL_RESEND);
}

export function providerStatusOf(
  env: Record<string, string | undefined>,
  name: string,
): ProviderStatus {
  const normalized = String(name ?? '').trim().toLowerCase();
  const meta = PROVIDER_META[normalized];
  const label = meta?.label ?? (normalized || '(空)');

  if (!meta) {
    return {
      name: normalized,
      label,
      implemented: false,
      ready: false,
      credentials: { configured: false, missingKeys: [] },
      templates: { required: false, total: 0, missingScenes: [] },
      reason: `未实现的短信通道「${normalized || '(空)'}」：发送会被记为 SMS_PROVIDER_NOT_IMPLEMENTED`,
    };
  }

  const missingKeys = meta.credentials.filter(
    (key) => String(env[key] ?? '').trim() === '',
  );
  const credentials = { configured: missingKeys.length === 0, missingKeys };

  // mock 不需要模板；真实通道需要每个 scene 的模板 CODE
  const scenes = normalized === SMS_PROVIDER_NAME.MOCK ? [] : templateScenes();
  const prefix = SMS_TEMPLATE_ENV_PREFIX[normalized];
  const missingScenes = scenes.filter((scene) => {
    const suffix = SMS_TEMPLATE_ENV_SUFFIX[scene];
    if (!prefix || !suffix) return true;
    return String(env[`${prefix}${suffix}`] ?? '').trim() === '';
  });

  const templates = {
    required: normalized !== SMS_PROVIDER_NAME.MOCK,
    total: scenes.length,
    missingScenes,
  };

  // smsbao 的特殊缺口（见文件头）：不是"没填模板"，而是**根本没有模板前缀映射**
  if (normalized === SMS_PROVIDER_NAME.SMSBAO && !prefix) {
    return {
      name: normalized,
      label,
      implemented: true,
      ready: false,
      credentials,
      templates: { required: false, total: 0, missingScenes: [] },
      reason:
        '短信宝通道的模板映射缺失（SMS_TEMPLATE_ENV_PREFIX 没有 smsbao）⇒ 发送会被' +
        'SMS_TEMPLATE_NOT_CONFIGURED 拒掉；在补齐映射前不可用',
    };
  }

  if (!credentials.configured) {
    return {
      name: normalized,
      label,
      implemented: true,
      ready: false,
      credentials,
      templates,
      reason: `缺少凭证：${missingKeys.join(' / ')}`,
    };
  }
  if (templates.required && missingScenes.length > 0) {
    return {
      name: normalized,
      label,
      implemented: true,
      ready: false,
      credentials,
      templates,
      reason: `缺少 ${missingScenes.length}/${templates.total} 个场景的模板 CODE（${missingScenes.join(', ')}）`,
    };
  }
  return { name: normalized, label, implemented: true, ready: true, credentials, templates, reason: '' };
}

/** 汇总三个通道 + 当前有效状态。 */
export function buildSmsStatus(
  env: Record<string, string | undefined>,
  settings: { enabled: boolean; provider: string; retryCount: number },
): SmsStatus {
  const names: string[] = [
    SMS_PROVIDER_NAME.MOCK,
    SMS_PROVIDER_NAME.ALIYUN,
    SMS_PROVIDER_NAME.SMSBAO,
  ];
  const providers = names.map((n) => providerStatusOf(env, n));
  const current = providers.find((p) => p.name === String(settings.provider).toLowerCase());

  let reason = '';
  if (!settings.enabled) reason = '短信功能当前关闭：发送一律记为 SMS_DISABLED（业务不失败）';
  else if (!current) reason = `当前通道「${settings.provider}」未实现：发送会被拒`;
  else if (!current.ready) reason = `当前通道「${current.label}」不可发送：${current.reason}`;

  return {
    settings,
    providers,
    effective: { canSend: settings.enabled && Boolean(current?.ready), reason },
  };
}
