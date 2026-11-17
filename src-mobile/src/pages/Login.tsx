/**
 * 登录页。
 *
 * ===========================================================================
 * 为什么移动端要单独登录一次（这是要用户裁决的那一项，这里是它的实现）
 * ===========================================================================
 *   员工在 NocoBase 后台已登录，但那是**另一个源**的 Cookie/JWT。
 *   本应用是独立 H5，且必须自持 Bearer（Cookie token 只对文件访问 + GET/HEAD 生效，
 *   业务 POST 一律 EMPTY_TOKEN）。
 *
 *   三条可行的衔接方式，本实现选了第 ①：
 *     ① **独立登录页**（本文件）：用同一个 `/api/auth:signIn`，账号体系一字未动。
 *        代价是员工要输一次密码。
 *     ② 从后台跳转时带一次性签名票据换取 token —— 需要在后端加签发/核销接口
 *        （用户已明确"本次不新增后端"），所以不做。
 *     ③ 读后台 localStorage 的 token —— 跨源读不到，同源也会因为
 *        storage 分区（iOS 17+ / 微信）不可靠。
 *
 *   ⇒ 若用户后续批准 ②，只需把 `signInWith` 换成票据兑换，**本文件以上全部不变**。
 */

import { useState } from 'react';
import { AppShell } from '../components/AppShell';
import { useSession } from '../app/session-context';
import { BusyButton } from '../components/Feedback';
import { Field, FieldGroup } from '../components/Form';

export function LoginPage() {
  const { signInWith, loginError } = useSession();
  const [account, setAccount] = useState('');
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const canSubmit = account.trim().length > 0 && pwd.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setLocal(null);
    try {
      await signInWith(account, pwd);
      // 成功后 SessionProvider 会把 status 切到 authenticated，
      // AppRouter 随之渲染工作台 —— 这里不需要 navigate。
    } catch (e) {
      setLocal(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const err = local ?? loginError;

  return (
    <AppShell>
      <div className="px-6 pt-14 pb-6">
        <div className="text-svc-brand text-[28px] font-semibold tracking-tight">服务工作台</div>
        <div className="text-svc-ink-2 mt-1.5 text-[13px]">请使用门店或总部的现有账号登录</div>
      </div>

      <FieldGroup>
        <Field
          label="账号"
          value={account}
          onChange={setAccount}
          autoComplete="username"
          placeholder="手机号 / 工号"
          testId="login-account"
        />
        <Field
          label="密码"
          value={pwd}
          onChange={setPwd}
          type="password"
          autoComplete="current-password"
          placeholder="请输入密码"
          testId="login-password"
          onEnter={submit}
        />
      </FieldGroup>

      {err ? (
        <div className="px-4" data-testid="login-error">
          <div className="bg-svc-danger-soft text-svc-danger rounded-svc px-3 py-2 text-[13px]">{err}</div>
        </div>
      ) : null}

      <div className="px-4 pt-4">
        <BusyButton busy={busy} onClick={submit} data-testid="login-submit">
          {busy ? '登录中…' : '登录'}
        </BusyButton>
      </div>

      <div className="text-svc-ink-3 px-6 pt-4 text-center text-[11px] leading-relaxed">
        账号与权限沿用现有后台体系。
        <br />
        停用账号、撤销角色或解除门店绑定后，下一次操作会立即失效。
      </div>
    </AppShell>
  );
}
