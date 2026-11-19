/**
 * C 页：客户档案摘要查询（**匿名可用**）。
 *
 * ===========================================================================
 * 这是全应用唯一一个"不登录也能用"的员工侧页面
 * ===========================================================================
 *   它调的是服务端 `publicArchive:queryByMobile`（匿名 ACL + handler 内限流）。
 *   ⇒ 本页**不能**依赖 `/m` 的登录会话：门店柜台上，客户自己拿手机打开这个页面
 *     查进度是很正常的用法。
 *
 * ===========================================================================
 * 三条产品硬约束（用户明令，实现在服务端，前端只负责别把它们搞坏）
 * ===========================================================================
 *   ① **不选门店、不发验证码**：输入手机号直接查，由服务端自动匹配有效门店；
 *   ② **只回最小摘要**：`{ mobile_masked, groups: [{ store_name, archives: [
 *        { archive_type_label, progress_label } ] }], total }`
 *      —— 服务端投影里**没有**档案号、姓名、地址、机型。前端不许"顺手"再要一份；
 *   ③ **限流是服务端的事**：每 IP / 每手机号 60 秒 3 次。
 *      前端要做的是**正确呈现 429**（显示 Retry-After 倒计时并禁用按钮），
 *      而不是自己再拦一道（自己拦会让"服务端还能查但前端不让查"的错觉出现）。
 *
 * ===========================================================================
 * 一个绝不能犯的错：手机号不进 URL
 * ===========================================================================
 *   不用 `?mobile=138...` 这种地址。原因不是"怕被看见"——
 *   而是 URL 会进浏览器历史、进 Referer、进中间层访问日志、被分享出去。
 *   查询参数只活在组件 state 里，一次性用完即走。
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from 'konsta/react';
import { AppShell, PageHeader } from '../components/AppShell';
import { EmptyState, ErrorState, LoadingState, ServiceStatusBadge } from '../components/Feedback';
import { Field, FieldGroup, validators } from '../components/Form';
import { request, ApiError } from '../api/http';

/** 服务端摘要的形状（与 `queryByMobileSummary` 的返回**逐字段**对应） */
interface SummaryArchive {
  archive_type: string;
  archive_type_label: string;
  progress: string;
  progress_label: string;
}
interface SummaryGroup {
  store_id: number;
  store_name: string;
  archives: SummaryArchive[];
}
interface Summary {
  mobile_masked: string;
  groups: SummaryGroup[];
  total: number;
}

type Phase = 'idle' | 'loading' | 'done' | 'error';

export function ArchiveQueryPage() {
  const [mobile, setMobile] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // 429 的倒计时由服务端的 retry_after_seconds 驱动
  const [cooldown, setCooldown] = useState(0);
  /**
   * ⚠️ "剩余秒数"只在**服务端真的给了** `retry_after_seconds` 时才值得显示。
   *
   *   原来的写法是 `Number(... ?? 60) || 60` —— 拿不到就默认 60。
   *   后果：一个**猜出来的** 60 秒倒计时冒充服务端规则，用户等满 60 秒后
   *   可能仍然被拒（真实窗口可能是按服务端时钟算的、也可能已经过去了几秒）。
   *   "等到了还是不行"比"不知道等多久"更伤信任。
   *   ⇒ 记下服务端是否真的给过值，没给就只说"请稍后再试"，不给倒计时。
   */
  const [hasServerRetryAfter, setHasServerRetryAfter] = useState(false);
  const tick = useRef<number | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    tick.current = window.setInterval(() => {
      setCooldown((n) => {
        if (n <= 1) {
          if (tick.current) window.clearInterval(tick.current);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => {
      if (tick.current) window.clearInterval(tick.current);
    };
  }, [cooldown]);

  const query = async () => {
    const e = validators.mobile(mobile);
    if (e) {
      setFieldError(e);
      return;
    }
    setFieldError(null);
    setPhase('loading');
    setError(null);
    try {
      const r = await request<Summary>('/publicArchive:queryByMobile', {
        method: 'POST',
        body: { mobile: mobile.trim() },
        skipAuthRedirect: true,
        timeoutMs: 20_000,
      });
      setSummary(r);
      setPhase('done');
    } catch (err) {
      if (err instanceof ApiError && err.isRateLimited) {
        /**
         * ⚠️ 只认服务端显式给出的数值。
         *    `retry_after_seconds` 可能是字符串（HTTP 头转来的），
         *    用 `Number.isFinite` 判有效，而不是 `|| 60` 兜底 —— 兜底值会
         *    让"服务端没给"与"服务端说 60"变成同一个界面。
         */
        const raw = (err.detail as any)?.retry_after_seconds;
        const ra = Number(raw);
        if (Number.isFinite(ra) && ra > 0) {
          setCooldown(Math.ceil(ra));
          setHasServerRetryAfter(true);
        } else {
          setCooldown(0);
          setHasServerRetryAfter(false);
        }
      }
      setError(err);
      setPhase('error');
    }
  };

  const disabled = phase === 'loading' || cooldown > 0;

  return (
    <AppShell>
      <PageHeader title="查进度" back />

      {/*
        🔴 R2.2.1 §十：本页**只保留三样东西** —— 标题「查进度」、
           字段「手机号」、按钮「查询」。两段说明文字全部删除：
             ① 字段上方那段「输入登记服务时用的手机号，就能查。」
             ② 按钮下方那段「为保护隐私，同一手机号 1 分钟内最多查询 3 次」
           （以及页脚「为保护隐私，这里只显示门店与进度。」— 见下方）

           ⚠️ 「删文字不等于取消限流」（用户原话）：
              服务端 `publicArchive:queryByMobile` 的 `consumeSliding` 一行没动，
              每 IP / 每手机号 60 秒 3 次照旧执行。这里删掉的只是**文案**
              —— 而文案本来就不该是"规则声明"，它只会让客户觉得被质疑。
              达限时显示指定的那一句：「查询太频繁，请稍后再试。」
      */}
      <div className="pt-4">
        <FieldGroup>
          <Field
            label="手机号"
            value={mobile}
            onChange={(v) => {
              setMobile(v.replace(/\s/g, ''));
              setFieldError(null);
            }}
            type="tel"
            inputMode="numeric"
            maxLength={11}
            placeholder="请输入 11 位手机号"
            error={fieldError}
            onEnter={() => {
              if (!disabled) void query();
            }}
            testId="query-mobile"
          />
        </FieldGroup>
      </div>

      <div className="px-4 pt-3">
        {/*
          ⚠️ 按钮文案保持「查询」不变。
              旧实现在倒计时里把按钮改成「N 秒后可再查」—— 那是把**禁用原因**
              塞进了按钮本身：客户点"查询"得到的反馈是"查询"两字没变但点不动，
              而屏幕上没有任何一句话解释为什么。现在原因写在 429 提示块里。
        */}
        <Button large disabled={disabled} onClick={() => void query()} data-testid="query-submit">
          {phase === 'loading' ? '查询中…' : '查询'}
        </Button>
      </div>

      <div className="pt-4 pb-10">
        {phase === 'loading' ? <LoadingState rows={2} label="正在查询…" /> : null}

        {phase === 'error' ? (
          error instanceof ApiError && error.isRateLimited ? (
            /**
             * 429 的主文案是**指定的业务话术**：「查询次数过多，请稍后再试。」
             *
             * ⚠️ 原来写的是"查询过于频繁"，并在下面用一整段解释服务端限流规则
             *    （"同一手机号或同一网络 1 分钟内最多 3 次"）。
             *    客户不需要知道限流的实现细节 —— 那句话对他是"你在质疑我乱点"，
             *    而他可能只是忘了刚才已经查过。⇒ 只说"稍后再试"。
             *
             * ⚠️ 剩余等待时间**只在服务端给了可靠值时才显示**（见 hasServerRetryAfter）。
             */
            <div className="px-4" data-testid="query-rate-limited">
              <div className="bg-svc-warning-soft rounded-svc px-4 py-4 text-center">
                {/* 🔴 §十 指定话术，一字不改 */}
                <div className="text-svc-ink qf-foot font-medium">查询太频繁，请稍后再试。</div>
                {hasServerRetryAfter && cooldown > 0 ? (
                  <div className="text-svc-ink-2 mt-1 qf-foot">{cooldown} 秒后可再次查询</div>
                ) : null}
              </div>
            </div>
          ) : (
            <ErrorState error={error} onRetry={() => void query()} />
          )
        ) : null}

        {phase === 'done' && summary ? (
          summary.total === 0 ? (
            <EmptyState
              title="没有查到服务记录"
              description={`手机号 ${summary.mobile_masked} 在已发布的服务档案中没有匹配记录。请确认号码与购买时预留的一致。`}
            />
          ) : (
            <div data-testid="query-result">
              <div className="text-svc-ink-3 px-4 pb-2 qf-caption">
                {summary.mobile_masked} · 共 {summary.total} 条记录，分布在 {summary.groups.length} 家门店
              </div>
              {summary.groups.map((g) => (
                <div key={g.store_id} className="px-4 pb-3">
                  <div className="bg-svc-surface overflow-hidden rounded-svc border border-svc-line">
                    <div className="border-svc-line border-b px-4 py-2.5">
                      <span className="text-svc-ink qf-foot font-medium">{g.store_name}</span>
                    </div>
                    {g.archives.map((a, i) => (
                      <div
                        key={`${g.store_id}-${i}`}
                        className="border-svc-line flex items-center justify-between gap-2 border-b px-4 py-3 last:border-b-0"
                      >
                        <span className="text-svc-ink-2 qf-foot">{a.archive_type_label}</span>
                        <ServiceStatusBadge label={a.progress_label} tone={progressTone(a.progress)} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </AppShell>
  );
}

/**
 * 进度码 → 色调。
 *
 * ⚠️ 服务端给的是 `progress`（粗粒度码）+ `progress_label`（中文）。
 *    这里**只映射颜色**，文案一律用服务端给的 `progress_label` ——
 *    前端自己写一套进度名称，迟早与服务端对不上（"施工中" vs "施工阶段"）。
 */
function progressTone(code: string): 'success' | 'info' | 'neutral' | 'warning' {
  switch (code) {
    case 'completed':
    case 'accepted':
    case 'done':
      return 'success';
    case 'serving':
    case 'in_progress':
      return 'info';
    case 'pending':
      return 'warning';
    default:
      return 'neutral';
  }
}
