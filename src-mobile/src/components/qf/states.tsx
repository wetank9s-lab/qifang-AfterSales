/**
 * QF 状态件：空态 / 错误态 / 加载骨架。
 *
 * ===========================================================================
 * 空态必须区分三种，这是**由文案造成的业务事故**的直接修补
 * ===========================================================================
 *   用户第 7.1 条：「空状态必须区分三种：
 *     无任何档案「还没有服务档案」、搜索无结果「没有找到，查看全部」、
 *     网络错误「加载失败，请重试」。
 *     **不得把搜索无结果误判为没有档案**。」
 *
 *   这不是设计偏好，是真实事故：旧版无条件写"还没有服务档案"，
 *   销售搜一个不存在的客户 → 看到"还没有服务档案" → 以为库里真空了
 *   （或者以为刚才建的没存上）→ 顺手再建一条重复档案。
 *
 *   ⇒ 三个组件严格分工：
 *     `QFEmptyState`      —— 真的没有数据（有筛选时由调用方换成"没有找到"文案）
 *     `QFNarrowEmptyState`—— 有筛选但筛出来 0 条
 *     `QFErrorState`      —— 请求失败（**不给"新建"入口**，给了也建不成）
 *
 * ===========================================================================
 * 错误态为什么要区分"能不能重试"
 * ===========================================================================
 *   · 网络错误 / 超时 / 5xx ⇒ 给"重试"
 *   · 403 / 404             ⇒ **不给重试**（重试一万次也一样），只给"返回"
 *   · 429                   ⇒ 显示"X 秒后可再试"
 *
 *   给 403 一个"重试"按钮，用户点几次之后会以为"系统坏了"，
 *   而真实原因是他没这个权限。
 */

import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ 空态 */

export function QFEmptyState({
  title,
  description,
  action,
  icon,
  testId,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center px-8 py-16 text-center"
      data-svc-state="empty"
      data-testid={testId}
    >
      <div className="bg-svc-surface-2 text-svc-ink-3 mb-3 flex h-14 w-14 items-center justify-center rounded-full">
        {icon ?? <ListGlyph />}
      </div>
      <div className="text-svc-ink qf-body font-medium">{title}</div>
      {description ? (
        <div className="text-svc-ink-2 qf-foot mt-1.5 max-w-[17rem] leading-relaxed">{description}</div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * 「有筛选但没结果」—— 与"真的一条都没有"**必须用不同组件**。
 *
 * ⚠️ 用独立组件而不是给 `QFEmptyState` 传不同文案：
 *    传文案的话，下一个人接手时很可能把两处文案改成一样（"简化一下"），
 *    而这两个场景的后续动作完全不同（查看全部 vs 新建档案）。
 *    组件分开 ⇒ 改错一处时至少还看得见另一处。
 */
export function QFNarrowEmptyState({ onClear, keyword, testId }: { onClear: () => void; keyword?: string; testId?: string }) {
  return (
    <QFEmptyState
      title="没有找到"
      description={keyword ? `没有匹配「${keyword}」的档案。换个词试试，或查看全部。` : '换个条件试试，或查看全部。'}
      icon={<SearchGlyph />}
      action={
        <button
          type="button"
          onClick={onClear}
          data-testid={testId}
          className="text-svc-brand-text qf-body qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-3 font-medium"
        >
          查看全部
        </button>
      }
      testId="archive-empty-narrow"
    />
  );
}

/* ------------------------------------------------------------------ 错误 */

export interface QFErrorInfo {
  title: string;
  message: string;
  canRetry: boolean;
  retryAfter: number;
  tone: 'warning' | 'danger' | 'neutral';
}

/**
 * 错误态。
 *
 * ⚠️ `message` **只放中文** —— 用户第 13 条：`Network Error` → 「网络连接失败，请重试」。
 *    调用方负责把任意错误翻译成 `QFErrorInfo`（见 `describeQFError`）。
 */
export function QFErrorState({
  info,
  onRetry,
  onBack,
  testId,
}: {
  info: QFErrorInfo;
  onRetry?: () => void;
  onBack?: () => void;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center px-8 py-14 text-center"
      data-svc-state="error"
      data-testid={testId ?? 'state-error'}
    >
      <div
        className={`mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
          info.tone === 'warning'
            ? 'bg-svc-warning-soft'
            : info.tone === 'neutral'
              ? 'bg-svc-neutral-soft'
              : 'bg-svc-danger-soft'
        }`}
      >
        <span
          className={`text-2xl font-semibold ${
            info.tone === 'warning'
              ? 'text-svc-warning'
              : info.tone === 'neutral'
                ? 'text-svc-neutral'
                : 'text-svc-danger'
          }`}
          aria-hidden="true"
        >
          !
        </span>
      </div>
      <div className="text-svc-ink qf-body font-medium">{info.title}</div>
      <div className="text-svc-ink-2 qf-foot mt-1.5 max-w-[17rem] leading-relaxed">{info.message}</div>
      {info.retryAfter > 0 ? <RetryCountdown seconds={info.retryAfter} onRetry={onRetry} /> : null}
      <div className="mt-5 flex gap-2">
        {info.canRetry && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="state-retry"
            className="bg-svc-brand text-svc-brand-ink qf-control qf-pressable rounded-svc px-5 font-semibold"
          >
            重试
          </button>
        ) : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="bg-svc-surface-2 text-svc-ink qf-control qf-pressable rounded-svc px-5 font-medium"
          >
            返回
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RetryCountdown({ seconds, onRetry }: { seconds: number; onRetry?: () => void }) {
  return (
    <div className="text-svc-ink-3 qf-foot mt-3">
      {seconds > 0 ? `${seconds} 秒后可再次尝试` : '现在可以重试了'}
      {seconds <= 0 && onRetry ? (
        <button type="button" className="text-svc-brand-text ml-1 underline" onClick={onRetry}>
          立即重试
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- 加载骨架 */

/**
 * 加载骨架。
 *
 * ⚠️ 骨架块与真实卡片**同高同结构**（三段：标题/正文/脚注），
 *    这样数据到达时不会有"内容跳一下"的观感 —— 那种跳动会被读成"卡了"。
 *
 * ⚠️ `aria-busy` + `aria-live` 必须有：屏幕阅读器用户需要知道"正在加载"，
 *    否则他们面对的是十几秒的静默。
 */
export function QFLoadingSkeleton({ rows = 3, label = '正在加载' }: { rows?: number; label?: string }) {
  return (
    <div className="px-4 py-3" data-svc-state="loading" aria-busy="true" aria-live="polite">
      <div className="text-svc-ink-3 qf-foot mb-2">{label}</div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="bg-svc-surface mb-2.5 rounded-svc border border-svc-line p-4">
          <div className="svc-skeleton mb-2 h-5 w-1/3" />
          <div className="svc-skeleton mb-2 h-4 w-4/5" />
          <div className="svc-skeleton h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- 错误 → 中文 */

/**
 * 用户第 13 条点名的八个错误码 → **一句人话**。
 *
 * 🔴 为什么必须单独建表，而不是靠下面 `describeQFError` 的兜底：
 *    兜底只能给到「请求未完成 / 出现了意外问题」，那是**废话** —— 员工看到这句话
 *    不知道该改什么、该找谁。这八个码是**真实会撞上的高频分歧点**，
 *    每一个都有明确的下一步动作，所以逐条写死。
 *
 * ⚠️ 这张表**只做文案**，不参与状态码判定：`describeQFError` 里
 *    「429 先于权限判」这类**顺序**是有意为之（限流与无权同时出现时，
 *    告诉用户"太频繁"是对的，让他重试即可，不必惊动管理员）。新增码请**加在表里**，
 *    不要往 `describeQFError` 的 if 链里插 —— 那会把顺序问题重新打开。
 *
 * 判据见 `scripts/verify-error-i18n.mjs`：
 *   ① 八个码**全部**在表里；② 每条 message 是中文、无 ASCII 单词、无英文标点句；
 *   ③ 渲染层不得出现 `e.message` 裸印英文（含 `No permissions` / `Network Error`）。
 */
export const ERROR_CODE_TEXT: Record<string, QFErrorInfo> = {
  // ── 档案（暖通现场操作）─────────────────────────────────────────────────
  ARCHIVE_STAGE_ORDER: {
    title: '这一步还不能操作',
    message: '暖通工程必须按顺序做：勘察 → 方案 → 布管 → 装设备 → 试机 → 验收。请先把上一步做完。',
    canRetry: false,
    retryAfter: 0,
    tone: 'neutral',
  },
  ARCHIVE_STAGE_PHOTO_REQUIRED: {
    title: '这一步必须拍照',
    message: '勘察、布管、装设备、验收这四步都要有照片留档。请先拍照再点完成。',
    canRetry: false,
    retryAfter: 0,
    tone: 'neutral',
  },
  ARCHIVE_STAGE_PHOTO_LIMIT: {
    title: '照片超过上限',
    message: '每个阶段最多 6 张。请删掉不需要的，或者把剩下的拍到一张里。',
    canRetry: false,
    retryAfter: 0,
    tone: 'neutral',
  },
  ARCHIVE_STALE: {
    title: '档案已更新',
    message: '其他人刚改过这条档案，本次操作没有保存。你填的内容还在页面上，请核对后再决定是否重新加载。',
    canRetry: true,
    retryAfter: 0,
    tone: 'warning',
  },
  // ── 查询（客户 H5 与员工端共用 publicArchive）────────────────────────────
  ARCHIVE_QUERY_BAD_MOBILE: {
    title: '手机号格式不对',
    message: '请填写 11 位手机号，只填数字，不要带空格或横线。',
    canRetry: false,
    retryAfter: 0,
    tone: 'neutral',
  },
  ARCHIVE_QUERY_RATE_LIMITED: {
    title: '查得太频繁了',
    message: '为了不让别人的号码被反复试，查询有次数限制。请稍等一会儿再查。',
    canRetry: true,
    retryAfter: 0,
    tone: 'warning',
  },
  ARCHIVE_QUERY_UNAVAILABLE: {
    title: '查询暂时不可用',
    message: '服务正在维护。请稍后再试，或者直接到门店前台查验。',
    canRetry: true,
    retryAfter: 0,
    tone: 'warning',
  },
  // ── 账号 / 门店绑定（用户第 9 条）────────────────────────────────────────
  STORE_USER_NOT_LINKED: {
    title: '账号还没有绑定门店',
    message: '这个账号没有关联任何门店，所以看不到工单和档案。请联系总部管理员在「门店账号管理」里绑定。',
    canRetry: false,
    retryAfter: 0,
    tone: 'neutral',
  },
};

/**
 * 把任意错误翻译成**纯中文**的 `QFErrorInfo`。
 *
 * ⚠️ 用户第 13 条的硬要求：界面上不得出现 `Network Error` / `No permissions`
 *    这类英文串。服务端业务错误已给中文 `message`，但有三类会漏：
 *    ① `fetch` 抛的 `TypeError: Failed to fetch`（断网 / DNS 失败）
 *    ② `<img>` / XHR 的 `Network Error`
 *    ③ NocoBase ACL 的 `No permissions`（403，`message` 就是英文）
 *
 *    ⇒ 这里对这三类做**兜底翻译**，而不是直接把 `e.message` 印出来。
 *      判据：断网 + 无权两种场景截图，界面不得出现英文单词。
 */
export function describeQFError(e: unknown): QFErrorInfo {
  const anyE = e as any;
  const status = Number(anyE?.status ?? 0) || 0;
  const code = String(anyE?.code ?? '');
  const rawMsg = String(anyE?.message ?? (e instanceof Error ? e.message : e ?? ''));

  /** 是否像英文原始错误（不含任何中日韩字符，且含 ASCII 字母） */
  const looksEnglish = /^[\x00-\x7F]*$/.test(rawMsg) && /[A-Za-z]{3,}/.test(rawMsg);

  // ⓪ 第 13 条点名的八个码 —— 优先于任何状态码推断。
  //    例：`ARCHIVE_STAGE_PHOTO_REQUIRED` 常常是 400，走通用 400 分支只会说「请求未完成」。
  if (code && ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];

  // ① 网络层
  if (
    anyE?.isNetworkError ||
    /Failed to fetch|Network Error|ERR_NETWORK|ECONNREFUSED|ETIMEDOUT|timeout/i.test(rawMsg)
  ) {
    return {
      title: '网络连接失败',
      message: '检查手机网络后重试。已填写的内容还在页面上，不会丢失。',
      canRetry: true,
      retryAfter: 0,
      tone: 'warning',
    };
  }

  // ② 限流
  if (status === 429 || anyE?.isRateLimited) {
    const ra = Number(anyE?.detail?.retry_after_seconds ?? 0) || 0;
    return {
      title: '操作过于频繁',
      message: ra > 0 ? `请等 ${ra} 秒后再试。` : '请稍后再试。',
      canRetry: true,
      retryAfter: ra,
      tone: 'warning',
    };
  }

  // ③ 权限
  if (status === 403 || anyE?.isForbidden || /No permissions/i.test(rawMsg)) {
    return {
      title: '当前账号没有操作权限',
      message: '如果需要，请联系门店负责人或总部管理员开通。',
      canRetry: false,
      retryAfter: 0,
      tone: 'neutral',
    };
  }

  // ④ 不存在
  if (status === 404 || code === 'ARCHIVE_NOT_FOUND') {
    return {
      title: '没有找到这条档案',
      message: '它可能已被删除，或者不属于当前门店。',
      canRetry: false,
      retryAfter: 0,
      tone: 'neutral',
    };
  }

  // ⑤ 版本冲突（用户第 13 条点名）
  if (code === 'ARCHIVE_STALE' || status === 409) {
    return {
      title: '档案已更新',
      message: '其他人刚改过这条档案，本次操作没有保存。你填的内容还在页面上，请核对后再决定是否重新加载。',
      canRetry: true,
      retryAfter: 0,
      tone: 'warning',
    };
  }

  // ⑥ 5xx
  if (status >= 500) {
    return {
      title: '服务暂时不可用',
      message: '请稍后重试。如果一直失败，请联系总部管理员。',
      canRetry: true,
      retryAfter: 0,
      tone: 'warning',
    };
  }

  // ⑦ 服务端已给中文 message —— 直接用（那是最准确的业务说明）
  if (rawMsg && !looksEnglish) {
    return { title: '请求未完成', message: rawMsg, canRetry: true, retryAfter: 0, tone: 'danger' };
  }

  // ⑧ 兜底：**不印英文原文**
  return {
    title: '出现了意外问题',
    message: '请重试。如果一直失败，请把当前页面截图发给总部管理员。',
    canRetry: true,
    retryAfter: 0,
    tone: 'danger',
  };
}

/* ----------------------------------------------------------------- 图标 */

function ListGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" strokeLinecap="round" />
    </svg>
  );
}
