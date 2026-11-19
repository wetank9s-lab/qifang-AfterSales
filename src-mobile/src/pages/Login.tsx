/**
 * 登录页（R2.2.1 §三：经典 iOS 浅色 · 手机号 + 密码）
 *
 * ===========================================================================
 * 为什么要单独登录一次（这一步没变，理由保留）
 * ===========================================================================
 *   员工在 NocoBase 后台已登录，但那是**另一个源**的 Cookie/JWT。
 *   本应用是独立 H5，且必须自持 Bearer（Cookie token 只对文件访问 + GET/HEAD 生效，
 *   业务 POST 一律 EMPTY_TOKEN）。
 *
 *   三条可行的衔接方式，本实现选了第 ①：
 *     ① **独立登录页**（本文件）：用同一个 `/api/auth:signIn`，账号体系一字未动。
 *     ② 从后台跳转时带一次性签名票据换取 token —— 需要在后端加签发/核销接口。
 *     ③ 读后台 localStorage 的 token —— 跨源读不到，同源也会因为
 *        storage 分区（iOS 17+ / 微信）不可靠。
 *
 * ===========================================================================
 * §三 的四个硬约束，以及它们在本文件里的落点
 * ===========================================================================
 *   ① 标题固定「七方上门服务系统」
 *      ⇒ `MOBILE_BRAND_FULL`（brand.ts）。它与 `MOBILE_BRAND`（「七方上门服务」，
 *        用于浏览器标签 / 主屏名）**是两个常量**，不是同一个值改两遍 ——
 *        站名短、页内标题长，这是有意的。
 *   ② 字段**只有**「手机号」「密码」
 *      ⇒ 删掉了原「账号 / 手机号 / 工号」那一格。
 *   ③ 页面不得出现技术提醒
 *      ⇒ 删掉了原来那两行「账号与权限沿用现有后台体系 / 停用账号…立即失效」。
 *        那句话对员工没有行动价值，只会让人怀疑"我是不是走错入口了"。
 *   ④ **手机号必须真能登录**
 *      ⇒ 靠**账号命名规则**实现，不靠登录页做转换：
 *        新建销售人员账号时把「用户名」直接设成手机号。
 *        NocoBase 原生 `auth:signIn` 接受任意 username，11 位数字串同样合法。
 *        登录页把输入**原样**提交，不查询、不转换、不猜测。
 *
 *        ⚠️ 2026-11 曾实现过 `POST /api/publicLogin:resolve`（手机号 → username），
 *           已被产品裁决**撤销**：多一个匿名接口就多一个"某号码是否存在"的枚举面，
 *           而"用户名就是手机号"零成本达到同样效果。别再把它加回来。
 *
 * ===========================================================================
 * 控件不是 Konsta 的 ListInput
 * ===========================================================================
 *   设计稿是一个「输入组」：一块白卡包住两行，行间 1px 分隔线，
 *   行内输入框无边框无阴影。Konsta 的 `ListInput` 是独立列表行，
 *   塞进同一张卡后行与行之间会多出一圈自己的分隔线，视觉上像两张表。
 *   ⇒ 用 `.svc-input-group` / `.svc-input-row`（app.css 末尾，同文件管）。
 */
import { useId, useRef, useState } from 'react';
import { MOBILE_BRAND_FULL } from '../brand';
import { AppShell } from '../components/AppShell';
import { useSession } from '../app/session-context';
import { BusyButton } from '../components/Feedback';
import { describeLoginError } from '../api/login';

export function LoginPage() {
  const { signInWith, loginError } = useSession();
  const [mobile, setMobile] = useState('');
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const composing = useRef(false);

  const phoneId = useId();
  const pwdId = useId();

  const canSubmit = mobile.trim().length > 0 && pwd.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setLocal(null);
    try {
      // 原样提交：账号就是员工输入的那串（新账号的用户名 = 手机号）。
      // 这里**不做**任何查询或转换 —— 见文件头 ④。
      await signInWith(mobile, pwd);

      // 成功后 SessionProvider 会把 status 切到 authenticated，
      // AppRouter 随之渲染工作台 —— 这里不需要 navigate。
    } catch (e) {
      // 401 ⇒「账号或密码不正确」；网络/限流必须说真话（否则用户会反复重输密码）
      setLocal(describeLoginError(e));
    } finally {
      setBusy(false);
    }
  };

  // loginError 是 SessionProvider 记录的错误（同样走英文原文），
  // 所以两者都过一遍翻译，保证界面上**永远不会**出现英文。
  const err = local ?? (loginError ? describeLoginError(loginError) : null);

  return (
    <AppShell>
      <div className="px-4 pt-12 pb-6" data-testid="login-head">
        <div className="flex items-center gap-3">
          <div className="svc-brand-mark" aria-hidden="true">
            七方
          </div>
          <div className="min-w-0">
            {/* 27px 来自设计稿，落在 display(28) 一档内；不再自造 27px 字号 */}
            <h1 className="qf-display text-svc-ink font-bold leading-tight">{MOBILE_BRAND_FULL}</h1>
            <div className="qf-foot text-svc-ink-3 mt-1">门店员工登录</div>
          </div>
        </div>
      </div>

      <div className="svc-input-group">
        <div className="svc-input-row">
          <label htmlFor={phoneId}>手机号</label>
          <input
            id={phoneId}
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={20}
            value={mobile}
            placeholder="请输入手机号"
            onChange={(e) => setMobile(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            data-testid="login-account"
          />
        </div>
        <div className="svc-input-row">
          <label htmlFor={pwdId}>密码</label>
          <input
            id={pwdId}
            type="password"
            autoComplete="current-password"
            value={pwd}
            placeholder="请输入密码"
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法回车是"上屏"，不是"提交"
              if (e.key === 'Enter' && !composing.current) void submit();
            }}
            data-testid="login-password"
          />
        </div>
      </div>

      {err ? (
        <div className="px-4 pt-3" data-testid="login-error">
          <div className="bg-svc-danger-soft text-svc-danger rounded-svc qf-foot px-3 py-2">{err}</div>
        </div>
      ) : null}

      <div className="px-4 pt-6">
        <BusyButton busy={busy} onClick={submit} data-testid="login-submit">
          {busy ? '登录中…' : '登录'}
        </BusyButton>
      </div>
    </AppShell>
  );
}
