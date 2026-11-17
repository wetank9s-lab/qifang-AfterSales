/**
 * 会话上下文（AuthContextAdapter 的 React 侧）。
 *
 * ===========================================================================
 * 三个不做
 * ===========================================================================
 *   ① **不判断权限**：`capabilities` 只决定"界面显示什么入口"。
 *      每个请求都仍由服务端按角色与门店重新裁决；
 *      前端判错的后果是"少显示一个按钮"，不是"越权"。
 *
 *   ② **不缓存用户数据**：刷新页面就重新 `auth:check`。
 *      缓存用户会让"角色被撤掉之后界面仍然显示旧按钮"，
 *      用户点了才收到 403 —— 那比一开始就不显示更困惑。
 *
 *   ③ **不放 token 进 React state**：token 只活在 http 层的 localStorage +
 *      内存兜底里。放进 state 会让它出现在 devtools / 错误上报里，
 *      而组件树里根本没有任何地方需要它。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  capabilitiesOf,
  fetchCurrentUser,
  onSessionExpired,
  restoreSession,
  signIn,
  signOut,
  type Capabilities,
  type CurrentUser,
} from '../api/session';
import { getToken } from '../api/http';

interface SessionValue {
  /** `booting` = 正在尝试恢复会话；此时不要渲染登录页，否则会闪一下 */
  status: 'booting' | 'anonymous' | 'authenticated';
  user: CurrentUser | null;
  caps: Capabilities;
  /** 最近一次登录 / 恢复失败的原因（仅用于登录页提示） */
  loginError: string | null;
  signInWith: (account: string, password: string) => Promise<void>;
  signOutNow: () => Promise<void>;
  /** 主动重读账号（例如怀疑角色变了） */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue['status']>('booting');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  // 防止卸载后 setState（登录请求可能比页面存活更久）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const boot = useCallback(async () => {
    // 没有 token 就别发请求：`auth:check` 401 会让 http 层清 token 再回调，
    // 那会在启动时多打一条无意义的 401 日志。
    if (!getToken()) {
      if (alive.current) setStatus('anonymous');
      return;
    }
    const u = await restoreSession();
    if (!alive.current) return;
    setUser(u);
    setStatus(u ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 401 统一回落：由 http 层触发，这里只负责把状态摆正
  useEffect(() => {
    onSessionExpired(() => {
      if (!alive.current) return;
      setUser(null);
      setStatus('anonymous');
      setLoginError('登录已过期，请重新登录');
    });
  }, []);

  const signInWith = useCallback(async (account: string, password: string) => {
    setLoginError(null);
    try {
      const u = await signIn(account, password);
      if (!alive.current) return;
      setUser(u);
      setStatus('authenticated');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '登录失败';
      if (alive.current) setLoginError(msg);
      throw e;
    }
  }, []);

  const signOutNow = useCallback(async () => {
    await signOut();
    if (!alive.current) return;
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refresh = useCallback(async () => {
    const u = await fetchCurrentUser();
    if (!alive.current) return;
    setUser(u);
    setStatus(u ? 'authenticated' : 'anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      caps: capabilitiesOf(user),
      loginError,
      signInWith,
      signOutNow,
      refresh,
    }),
    [status, user, loginError, signInWith, signOutNow, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession 必须在 <SessionProvider> 内使用');
  return v;
}
