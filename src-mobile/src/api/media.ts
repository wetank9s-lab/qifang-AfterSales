/**
 * 安全媒体适配器（SecureMediaAdapter）。
 *
 * ===========================================================================
 * 私有照片只有一种正确的取法
 * ===========================================================================
 *   `<img src="/api/svc:photo?ref=...">` **必然 401**：
 *   浏览器对 `<img>` 发的请求不带 `Authorization` 头，而本项目会话是 Bearer。
 *
 *   ⇒ 必须 `fetch`（带 token）→ `blob` → `URL.createObjectURL` → `<img src=objectURL>`。
 *
 * ===========================================================================
 * 两个必须记住的泄漏点
 * ===========================================================================
 *   ① **objectURL 不 revoke 就是内存泄漏**：
 *      每张照片占一份解码后的位图（390px 宽屏幕上约 1.5–3 MB），
 *      翻十几张图后低端安卓会明显卡顿，而"卡"不会被当成"内存泄漏"报上来。
 *      `useSecurePhoto()` 在卸载与 ref 变化时都会 revoke。
 *
 *   ② **取消请求后仍可能 setState**：
 *      用户快速滑动相册时，前一张图的请求回来时组件已经卸载。
 *      不取消就会出现"图串到别的卡片上"的错觉（表现是闪一下别人的照片）。
 *      这里用 `AbortController` 显式取消。
 */

import { useEffect, useRef, useState } from 'react';
import { fetchBlob, qs } from './http';

export interface PhotoState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * 把"带鉴权的图片路径"变成可直接放进 `<img>` 的 objectURL。
 *
 * @param path 为 null 时不发起请求（用于"还没有照片"的状态）
 */
export function useSecurePhoto(path: string | null): PhotoState {
  const [state, setState] = useState<PhotoState>({ url: null, loading: Boolean(path), error: null });
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    const ctrl = new AbortController();
    let cancelled = false;
    setState({ url: null, loading: true, error: null });

    fetchBlob(path, { timeoutMs: 20_000 })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url;
        setState({ url, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '图片加载失败';
        setState({ url: null, loading: false, error: msg });
      });

    return () => {
      cancelled = true;
      ctrl.abort();
      if (lastUrl.current) {
        URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = null;
      }
    };
  }, [path]);

  return state;
}

/** 工单客户上传的媒体（后台查看） */
export function ticketMediaFileUrl(mediaId: number): string {
  return qs('/svc:ticketMediaFile', { filterByTk: mediaId });
}

/**
 * 档案照片（员工内部受控读取，含已撤回阶段的历史照片）。
 *
 * 🔴 DEV-271：参数名必须是 `photo_id`，**不是** `filterByTk`。
 *    `svc:archivePhotoFile` 的服务端读的是 `param(ctx, 'photo_id')`；
 *    发 `filterByTk` ⇒ `Number(undefined) === NaN` ⇒ Sequelize 把它拼进 SQL
 *    变成 `column "nan" does not exist` ⇒ 对外只有 500「服务端异常」。
 *    这条链路曾经整条不可用（本地从未跑过真实字节回读，见 DEVIATIONS.md DEV-271）。
 *    服务端现已同时兼容三个名字，但这里仍用主参数名，避免依赖兼容层。
 */
export function archivePhotoFileUrl(photoId: number): string {
  return qs('/svc:archivePhotoFile', { photo_id: photoId });
}


/**
 * 工单现场照片（师傅上传的）。
 *
 * ⚠️ 参数名是 `photo_id`（服务端 `readId(ctx, 'photo_id')`），
 *    **不是** `visit_id + ref` —— 我最初按"visit + 文件名"猜过一次，
 *    结果拿到 404，且因为"越权与不存在统一 404"，看起来像没有权限。
 *    照片 id 来自 `svc:visitDetail` 返回的 photos 列表。
 */
export function visitPhotoUrl(photoId: number): string {
  return qs('/svc:photo', { photo_id: photoId });
}
