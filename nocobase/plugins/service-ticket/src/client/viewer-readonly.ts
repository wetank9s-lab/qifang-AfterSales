/**
 * viewer-readonly.ts —— 只读管理层（viewer）的**按钮展示修正**（BE-01-S0）
 *
 * ===========================================================================
 * 这一层只解决"看得见但点了会 403"的观感问题，**不是安全边界**
 * ===========================================================================
 * 实测（2026-10-20）：
 *   · viewer 调 `svc:followUp` / `svc:internalNote` / `serviceTickets:update`
 *     → **服务端 403**（"缺少权限：write_ticket" / "No permissions"）；
 *   · 但页面上仍然渲染「处理」「跟进」按钮。
 *
 * 所以这是**按钮错误（展示层）**，不是后端越权。安全由服务端保证；
 * 本文件只是让只读角色看不到自己按不动的按钮，避免误以为"系统坏了"。
 *
 * ⚠️ 只对 `roles` 含 `viewer` 的会话生效；角色取不到时**不启用**（宁可少隐藏，不误伤）。
 * ⚠️ 任何异常都必须吞掉：这里是后台 SPA，抛错会让整个后台白屏。
 */

/** 只读角色不该看到的写动作文案（与后台动作矩阵中的 `WRITE` 能力对应） */
const WRITE_BUTTON_LABELS = ['处理', '跟进', '新建服务单', '编辑', '删除'];

/** 隐藏写按钮（幂等；React 重渲染后由 observer 再补一次） */
function hideWriteButtons(): void {
  const nodes = document.querySelectorAll('button, .ant-btn, [role="button"]');
  nodes.forEach((raw) => {
    const node = raw as any;
    const label = String(node.innerText || '').replace(/\s+/g, '').trim();
    if (!WRITE_BUTTON_LABELS.includes(label)) return;
    node.style.display = 'none';
    node.setAttribute('data-svc-readonly-hidden', '1');
  });
}

/**
 * 角色来源优先用 NocoBase 自己写的 `localStorage.NOCOBASE_ROLE`（实测值就是 `viewer`）。
 * 它比 `auth:check` 稳：后者在不同版本可能返回 `{data}` / `{data:{data}}` 等不同形状，
 * 而且我们只需要"是不是 viewer"这一个比特。
 */
function detectViewer(): boolean {
  try {
    const g: any = globalThis as any;
    const raw = g?.localStorage?.getItem('NOCOBASE_ROLE');
    if (typeof raw === 'string' && raw.trim()) {
      return raw
        .split(',')
        .map((x: string) => x.trim())
        .includes('viewer');
    }
  } catch {
    /* 隐私模式等情况：当作不是 viewer */
  }
  return false;
}

export function installViewerReadonly(_apiClient?: any): void {
  if (typeof document === 'undefined') return;

  const start = (): void => {
    const ObserverCtor = (globalThis as any).MutationObserver;
    if (!ObserverCtor) return;
    const observer = new ObserverCtor(() => {
      try {
        hideWriteButtons();
      } catch {
        /* 不影响页面 */
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    hideWriteButtons();
    document.body.setAttribute('data-svc-role', 'viewer');
  };

  /**
   * `load()` 发生在 SPA **首次**启动时，那时通常还在登录页 ——
   * `NOCOBASE_ROLE` 要等登录成功后才写入。所以不能只判一次，必须轮询。
   * 一旦命中就 start() 并停止轮询；60 秒还没登录就放弃（不影响任何功能）。
   */
  const g: any = globalThis as any;
  let tries = 0;
  const tick = (): void => {
    tries += 1;
    try {
      if (detectViewer()) {
        start();
        return;
      }
    } catch {
      /* 忽略 */
    }
    if (tries < 60 && typeof g?.setTimeout === 'function') g.setTimeout(tick, 1000);
  };
  tick();
}
