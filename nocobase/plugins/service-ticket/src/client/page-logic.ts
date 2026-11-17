/**
 * page-logic.ts —— 两个后台页面的**纯逻辑**（无 React、无 DOM、无网络）
 *
 * 为什么单独拆一个文件：
 *  · 这些判断（短信状态矩阵、错误码中文、工单状态/异常类型文案）是**业务规则**，
 *    不是样式。混在 tsx 里就只能靠"截图看着对不对"来验，而截图验不了 6 种组合；
 *  · 拆出来之后可以用 Node 直接跑 `.tmp-verify/be03-ux-state.test.mjs`（零依赖、零网络），
 *    把「总开关 × 场景开关 × 通道」的矩阵逐格断言 —— 这正是本轮验收 A~E 项的机器判据；
 *  · 门禁要能变红：故意改错一格映射，测试必须红（见该文件的变异模式）。
 *
 * ⚠️ 本文件**不得**引入样式或组件；一旦引入，上面的"可机器验证"就不成立了。
 */

/** 三态：true / false / null（null = 读不到，**不等于** false） */
export type Tri = boolean | null;

export type Tone = 'ok' | 'paused' | 'blocked' | 'neutral';

export interface StatusView {
  text: string;
  tone: Tone;
}

export interface SmsStateInput {
  /** 短信总开关（sms.enabled）。null = 无法确认 */
  globalEnabled: Tri;
  /** 该场景开关（sms.scene.<scene>.enabled）。null = 无法确认 */
  sceneEnabled: Tri;
  /** 通道必要配置检查是否通过（来自真实诊断 channel_status.effective.canSend） */
  channelReady: Tri;
  /** 通道不可用的**真实原因**（诊断下发，不由前端猜） */
  channelReason?: string | null;
}

export interface SmsStateView {
  /** 场景设置：开启 / 关闭 / 状态无法确认 */
  scene: StatusView;
  /** 当前实际状态：允许发送 / 暂停发送 / 通道未就绪 / 状态无法确认 */
  effective: StatusView;
  /** 一句人话解释，必须与结论一致（用于横幅/提示） */
  reason: string;
  /** 表格单元格用的**短**原因（长句在横幅里已经说过一遍了，表格再重复 7 遍没法扫） */
  shortReason: string;
}

export const UNKNOWN_TEXT = '状态无法确认';
export const EFFECTIVE_ALLOW = '允许发送';
export const EFFECTIVE_PAUSE = '暂停发送';
export const EFFECTIVE_CHANNEL = '通道未就绪';

/**
 * 短信状态矩阵（BE-03-UX-01 §二.2 的 A~F）。
 *
 * 这张表是**唯一**的状态判定来源：页面只渲染它的结果，不另写 if。
 * 语义边界：
 *   · 「允许发送」= 总开关开 + 场景开 + 通道检查通过；
 *     **不等于**已提交、已受理、已送达 —— 文案里必须带这句，否则会被读成"已发出"。
 *   · 任一必要输入读不到 ⇒ 「状态无法确认」，**绝不**默认成开启（旧版就是这么假绿的）。
 */
export function deriveSmsState(input: SmsStateInput): SmsStateView {
  const { globalEnabled, sceneEnabled, channelReady } = input;

  const sceneView = (): StatusView =>
    sceneEnabled === true
      ? { text: '开启', tone: 'ok' }
      : sceneEnabled === false
        ? { text: '关闭', tone: 'paused' }
        : { text: UNKNOWN_TEXT, tone: 'neutral' };

  // F：总开关读不到 ⇒ 整体无法确认（不能因为"场景开着"就说允许发送）
  if (globalEnabled === null || globalEnabled === undefined) {
    return {
      scene: sceneView(),
      effective: { text: UNKNOWN_TEXT, tone: 'neutral' },
      reason: '无法读取短信总开关状态，当前无法判断是否会发送。请检查配置读取权限后刷新。',
      shortReason: '总开关状态读不到',
    };
  }

  // F：场景开关读不到
  if (sceneEnabled === null || sceneEnabled === undefined) {
    return {
      scene: { text: UNKNOWN_TEXT, tone: 'neutral' },
      effective: { text: UNKNOWN_TEXT, tone: 'neutral' },
      reason: '无法读取该场景的开关配置，当前无法判断是否会发送。',
      shortReason: '本场景开关读不到',
    };
  }

  // A / B：总开关关闭
  if (globalEnabled === false) {
    return {
      scene: sceneView(),
      effective: { text: EFFECTIVE_PAUSE, tone: 'paused' },
      reason:
        sceneEnabled === false
          ? '短信总开关和本类通知均已关闭，当前不会发送。'
          : '短信总开关已关闭，当前不会发送。场景设置会在总开关恢复后影响新产生的通知。',
      shortReason: sceneEnabled === false ? '总开关与本场景均关闭' : '总开关关闭',
    };
  }

  // C：总开关开启、场景关闭
  if (sceneEnabled === false) {
    return {
      scene: sceneView(),
      effective: { text: EFFECTIVE_PAUSE, tone: 'paused' },
      reason: '本类通知已关闭，当前不会发送。',
      shortReason: '本场景已关闭',
    };
  }

  // D：都开启且通道就绪
  if (channelReady === true) {
    return {
      scene: sceneView(),
      effective: { text: EFFECTIVE_ALLOW, tone: 'ok' },
      reason: '总开关与本类通知均已开启，通道必要配置检查通过。允许发送不等于已提交、已受理或已送达。',
      shortReason: '条件齐备，可发送',
    };
  }

  // E：都开启但通道不可用（原因来自真实诊断）
  if (channelReady === false) {
    return {
      scene: sceneView(),
      effective: { text: EFFECTIVE_CHANNEL, tone: 'blocked' },
      reason: input.channelReason
        ? `通道未就绪：${humanizeChannelReason(input.channelReason)}`
        : '通道必要配置未通过检查，当前不会发送（原因见通道诊断）。',
      shortReason: '通道未就绪',
    };
  }

  // F：通道诊断读不到 ⇒ 不能声称"允许发送"
  return {
    scene: sceneView(),
    effective: { text: UNKNOWN_TEXT, tone: 'neutral' },
    reason: '无法读取通道诊断结果，当前无法确认是否会发送。',
    shortReason: '通道诊断读不到',
  };
}

/**
 * 发送日志的中文结果 + 原因。
 * ⚠️ `delivery_status` 不在主视图里解释：没有真实回执时它恒为 pending，
 *    把它读成"未送达"会直接误导业务（DEV-204 的教训）。
 */
const SMS_ERROR_TEXT: Record<string, string> = {
  SMS_DISABLED: '总开关关闭，未提交发送',
  SMS_SCENE_DISABLED: '本类通知已关闭',
  SMS_PENDING_ORPHAN_UNREBUILDABLE: '系统重启后无法安全恢复，未自动补发',
  SMS_PENDING_ORPHAN_TOKEN_LOST: '一次性链接已失效，未自动补发',
  SMS_TEMPLATE_NOT_CONFIGURED: '模板配置不完整',
  SMS_CONTENT_EMPTY: '短信内容为空',
  SMS_PROVIDER_NOT_CONFIGURED: '短信通道未配置完整',
  SMS_PROVIDER_NOT_IMPLEMENTED: '短信通道未实现',
  SMSBAO_BAD_CREDENTIAL: '服务商账号或密钥不正确',
  SMSBAO_ACCOUNT_NOT_FOUND: '服务商账号不存在',
  SMSBAO_INSUFFICIENT_BALANCE: '服务商余额不足',
  SMSBAO_ACCOUNT_EXPIRED: '服务商账号已过期',
  SMSBAO_IP_RESTRICTED: '来源地址被服务商限制',
  SMSBAO_ACCOUNT_DISABLED: '服务商账号已被禁用',
  SMSBAO_CONTENT_REJECTED: '内容被服务商判定含敏感词',
  SMSBAO_BAD_MOBILE: '手机号码格式不正确',
  SMSBAO_PARAM_INCOMPLETE: '提交参数不完整',
  SMSBAO_NO_PRODUCT: '没有可用的短信产品',
  SMSBAO_TRIAL_RESTRICTED: '试用账号无权调用',
  SMSBAO_BAD_ACCOUNT: '服务商账号有误',
  SMSBAO_TEMPLATE_INVALID: '服务商模板格式不正确',
  SMSBAO_SIGN_VERIFY_FAILED: '服务商验签失败',
  SMSBAO_SIGN_FORMAT_INVALID: '短信签名格式异常，未提交',
  SMSBAO_TIMEOUT: '提交超时，结果未知',
  SMSBAO_NETWORK_ERROR: '网络异常，结果未知',
  SMSBAO_UNKNOWN_CODE: '服务商返回了未登记的状态码',
  SMSBAO_HTTP_ERROR: '服务商接口异常',
  SMS_TRANSPORT_ERROR: '网络异常，提交失败',
  SMS_TIMEOUT: '提交超时',
  SMS_SCENE_NOT_ALLOWED: '该场景未放行',
  // 🔴 BE-03-SMS-FIX-01：这个码此前**没有登记**，于是后台把一条有明确原因的失败
  //    （"模板尚未通过供应商审核"）显示成"未发送，原因待核实"，逼人去数据库里捞。
  SMS_TEMPLATE_PENDING_REVIEW: '模板待供应商审核，未提交（非故障）',
  SMS_UNRENDERED_VARIABLE: '正文变量未替换，未提交',
  SMS_INTERNAL_ERROR: '系统内部异常',
};

/**
 * 错误码 → 人话。
 *
 * 🔴 BE-03-SMS-FIX-01：未登记的错误码**不再笼统说"原因待核实"**。
 *    原来的兜底是一句结论（"核实中"），它把"我们已经知道原因、只是没翻译"这种
 *    最常见的情况也说成未知 —— 生产上真出现过：运营看到"未发送，原因待核实"，
 *    实际库里有 `error_message` 写得清清楚楚。
 *
 *    现在的兜底改为**承认不知道中文译名，但把原始码亮出来**，并允许调用方把
 *    服务端的 `error_message` 一并透传（见 `smsErrorDetail`）。
 */
export function smsErrorText(code?: string | null): string {
  const key = String(code ?? '').trim();
  if (!key) return '';
  return SMS_ERROR_TEXT[key] ?? `未发送（${key}）`;
}

/**
 * 列表「说明」列的统一取值：**中文译名优先，其次服务端原文，最后才是原始码**。
 *
 * 顺序理由：
 *   ① 译名是给人看的；
 *   ② `error_message` 是服务端当场写下的**具体**原因（含场景名/参数名），
 *      比任何前端映射都准，且新错误码不需要前端跟着发版；
 *   ③ 两者都没有（理论上不会）才退回到"未发送（CODE）"兜底。
 */
export function smsErrorDetail(
  code?: string | null,
  message?: string | null,
  status?: string | null,
): string {
  if (String(status ?? '') === 'accepted') return '已提交给服务商（不代表客户已收到）';
  const translated = smsErrorText(code);
  const raw = String(message ?? '').trim();
  if (translated && !translated.startsWith('未发送（')) return translated;
  if (raw) return raw;
  return translated || '—';
}

/** 日志行的"结果"（发送状态）中文 */
export function smsSendStatusText(status?: string | null): string {
  switch (String(status ?? '')) {
    case 'accepted': return '服务商已受理';
    case 'rejected': return '未发送';
    case 'error': return '提交失败';
    case 'pending': return '排队中';
    default: return '状态不明';
  }
}

/** 发送状态的色标（只用于视觉，不影响语义） */
export function smsSendStatusTone(status?: string | null): Tone {
  switch (String(status ?? '')) {
    case 'accepted': return 'ok';
    case 'error': return 'blocked';
    case 'rejected': return 'paused';
    default: return 'neutral';
  }
}

/** 场景中文名兜底（**权威是 DTO 下发的 label**；这里只防 DTO 漏字段时露出英文） */
const SCENE_LABEL: Record<string, string> = {
  dispatch_customer: '派工通知（客户）',
  technician_task: '师傅任务通知',
  technician_assignment_cancelled: '改派取消通知',
  dispatch_update: '改约通知',
  review_invite: '评价邀请',
  progress_link: '客户报修成功通知',
  progress_update: '客户处理进展通知',
  manual_resend: '人工重发',
};

export function sceneLabel(scene: string, dtoLabel?: string | null): string {
  // 已约定的七个场景：**以本地表为准**。
  // 原因：DTO 里的 label 需要一次服务端部署才更新，若这里优先 DTO，
  // 页面在部署前会继续显示旧措辞（实测出现过"师傅任务取消/改派通知/人工补发"）。
  const known = SCENE_LABEL[scene];
  if (known) return known;
  const fromDto = String(dtoLabel ?? '').trim();
  if (fromDto && fromDto !== scene) return fromDto;
  return '未命名通知';
}

/**
 * 通道诊断原因 → 主视图可读文案（**去掉内部错误码**）。
 *
 * ⚠️ 诊断原文来自服务端 `buildSmsStatus`，形如
 *    「短信功能当前关闭：发送一律记为 SMS_DISABLED（业务不失败）」——
 *    这句话直接贴到主视图就把内部码暴露给运营了。这里给等价业务说法，
 *    **原文仍在"技术详情"里可查**（没有删除任何诊断信息）。
 */
export function humanizeChannelReason(reason?: string | null): string {
  const t = String(reason ?? '').trim();
  if (!t) return '';
  if (t.includes('SMS_DISABLED')) return '短信总开关已关闭，发送一律不会提交';
  if (t.includes('SMS_SCENE_DISABLED')) return '本类通知已关闭';
  if (t.includes('SMS_PROVIDER_NOT_CONFIGURED') || t.includes('未配置完整')) return '通道凭据未配置完整';
  if (t.includes('SMS_PROVIDER_NOT_IMPLEMENTED')) return '当前通道未实现';
  // 兜底：
  //  ① 删掉含错误码的括号说明；② 删掉错误码本体；
  //  ③ **环境变量名/内部键名**（ALIYUN_SMS_ACCESS_KEY_ID / SMSBAO_USERNAME…）不许出现在主视图，
  //     连同"A / B / C"这种枚举一起换成"必要配置项"；原文仍可在「技术详情」里看到。
  return t
    .replace(/[（(][^（()）]*SMS_[A-Z_]{3,}[^（()）]*[）)]/g, '')
    .replace(/\bSMS_[A-Z_]{3,}\b/g, '')
    .replace(/(?:[A-Z][A-Z0-9_]{2,})(?:\s*[/、,]\s*[A-Z][A-Z0-9_]{2,})+/g, '必要配置项')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, '配置项')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[：:]\s*$/, '')
    .trim();
}

/** 服务商中文名（英文名只进技术详情） */
export function providerLabel(name?: string | null): string {
  switch (String(name ?? '').trim().toLowerCase()) {
    case 'smsbao': return '短信宝';
    case 'aliyun': return '阿里云短信';
    case 'mock': return '模拟通道（不真实发送）';
    case '': return '未配置';
    default: return '其它通道';
  }
}

/**
 * 工单状态中文（主视图用；未知值不在主视图暴露原文）。
 * ⚠️ 文案必须与服务端 `TICKET_STATUS_LABEL`（constants.ts:43）**逐字一致** ——
 *    那是全站唯一的状态口径（`NEW` 在界面统一叫「待处理」，不是「待受理」）。
 */
export function ticketStatusText(status?: string | null): string {
  switch (String(status ?? '')) {
    case 'NEW': return '待处理';
    case 'PROCESSING': return '处理中';
    case 'WAIT_STORE_CONFIRM': return '待门店确认';
    case 'WAIT_FEEDBACK': return '待客户评价';
    case 'CLOSED': return '已结束';
    case 'CANCELLED': return '已取消';
    default: return '状态待核实';
  }
}

/** 异常待办类型中文 */
export function alertTypeText(type?: string | null): string {
  switch (String(type ?? '')) {
    case 'overdue': return '超过 24 小时未更新';
    case 'reopened_after_review': return '评价后继续处理';
    case 'wait_store_confirm': return '待门店确认';
    case 'low_rating': return '低分评价';
    default: return '其它异常';
  }
}

/** 异常类型的关注优先级（小的排前面：越靠前越该先处理） */
export function alertPriority(type?: string | null): number {
  switch (String(type ?? '')) {
    case 'reopened_after_review': return 0;
    case 'low_rating': return 1;
    case 'overdue': return 2;
    case 'wait_store_confirm': return 3;
    default: return 9;
  }
}

/**
 * 统计口径文字 → 面向业务人员的说法。
 * 服务端下发的 `range.from` 形如「今日 00:00（Asia/Shanghai）」—— 时区名对售后人员没有意义，
 * 统一改成「今日 00:00（北京时间）」。**只改显示**，不动 DTO。
 */
export function bjRange(from?: string | null): string {
  const raw = String(from ?? '').trim();
  if (!raw || raw === '—') return '—';
  const stripped = raw
    .replace(/\s*[（(]?\s*Asia\/Shanghai\s*[）)]?/gi, '')
    .replace(/\s*[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (stripped.includes('北京时间')) return stripped;
  return `${stripped}（北京时间）`;
}

/** 北京时间（`generated_at` 是 UTC ISO；页面统一显示 +08:00，不依赖运行环境时区） */
export function bjTime(iso?: string | null): string {
  const raw = String(iso ?? '').trim();
  if (!raw) return '—';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
