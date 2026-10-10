/**
 * `svc:storeEntryLinks` —— 后台取「门店报修入口」的链接与二维码（Phase 11 / P11-1）
 * =============================================================================
 *
 * 用户 req 1：**15 家门店分别生成稳定、唯一的 H5 报修链接与二维码；
 * 后台授权人员能够复制链接、下载二维码。**
 *
 * 分工（刻意拆开）
 * -----------------------------------------------------------------------------
 *   · **链接**在服务端生成：它是签名入口（`services/store-entry.ts`），
 *     必须与"服务端校验用的密钥"同源 —— 让前端自己拼，等于把签名算法复制一份到浏览器。
 *   · **二维码**也在服务端生成：`qrcode` 是纯 JS 库，**打进服务端产物**，
 *     于是浏览器侧**零依赖**（不必为了一张二维码给前台加一个 npm 包）。
 *     前端只负责把返回的 SVG 显示出来 / 存成文件。
 *
 * 🔴 数据范围：**按 actor 的门店授权裁剪**（req 6：门店员工只操作授权门店）。
 *    门店售后账号只看得到自己被授权的门店入口；总部按既有角色看全部。
 *    它不引入任何新的权限能力 —— 用的还是 `permissions.applyScope`。
 *
 * ⚠️ 这里回的是**链接**，不是票据：链接本身是公开的（印在墙上），
 *    因此不涉及敏感数据；但仍然**不返回门店 id / 电话 / 地址** ——
 *    匿名入口能少给就少给，后台列表也不需要它们。
 *
 * -----------------------------------------------------------------------------
 * 为什么**不为旧入口**生成二维码（req 5 的诚实处理）
 * -----------------------------------------------------------------------------
 * 旧入口（`?store=S01`，无签名）**已经印出去**了，后台要能看见"它还能用"，
 * 所以 `legacy_url` 照给。但**不给它生成二维码图片**，理由有两条：
 *   ① 同一段文本用不同工具/参数生成的二维码，**像素是不一样的**（掩码与 ECC 不同），
 *      在这里生成一张"新图"会让人以为它就是墙上那张 —— 而墙上那张的原图
 *      **不在本系统里**，这里生成的任何图都无法代表它；
 *   ② 页面提供"下载二维码"这个动作，本身就是一种**推荐**。
 *      推荐一张没有防篡改能力的码，与 req 5「不得宣称为与新签名入口同等安全」相悖。
 * ⇒ 旧入口只以**文本**形式给出（供运维核对"手上那张旧码指向的是不是这个地址"），
 *    并在页面上明确标注它不提供签名保护。
 */
import QRCode from 'qrcode';
import { SVC_ACTION } from '../../constants';
import type { Services } from '../../services';
import { signStoreEntry, signingSecretOf } from '../../services/store-entry';
import { publicBaseUrlOf } from '../../services/public-url';
import { fail, ok, traceId } from './_http';
import { usernameOf, type ActionHandler, type SvcActionDeps } from './_request';

export interface StoreEntryActionDeps extends SvcActionDeps {
  services: Services;
}

/** H5 报修页的路由（与 `h5/src/router.ts` 的 `/report` 一致；挂在 `/h5/` base 下） */
const H5_REPORT_PATH = '/h5/report';

/**
 * 二维码参数。
 *
 * ⚠️ `margin: 4` 不是审美选择，是 **QR 规范的静区（quiet zone）要求**：
 *    静区不足的二维码在**贴着深色边框打印**时会扫不出来 ——
 *    而这张图是要印出来贴墙上的，扫不出来意味着要重新印。
 * ⚠️ `errorCorrectionLevel: 'M'`（约 15% 冗余）：贴在门店墙上会被污损/反光，
 *    比 'L' 稳；比 'Q'/'H' 又不会把码点撑得太密（密集的码对小尺寸打印更不利）。
 *    ⚠️ **改这两个值会让已印出的二维码与新生成的图不一致**（内容同、像素不同）——
 *    这正是上面"不给旧入口生成图"的同一条理由。
 */
const QR_OPTIONS = {
  type: 'svg' as const,
  errorCorrectionLevel: 'M' as const,
  margin: 4,
  width: 320,
};

/**
 * 生成一家门店的入口信息。
 *
 * ⚠️ **旧入口链接也一并给出**（`legacy_url`），因为已经印出去的二维码指向它 ——
 *    后台要能看出"这一版的二维码用的是哪种入口"，否则运维无法判断
 *    "手上这张旧码还能不能用"。两种链接在界面上必须**标注清楚安全性差异**。
 */
async function entryOf(
  store: { code: string; name: string; active: boolean },
  base: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const signed = signStoreEntry(store.code, secret);
  const url = base ? `${base}${H5_REPORT_PATH}?k=${encodeURIComponent(signed)}` : '';
  // base 为空 ⇒ 拼不出可用的 URL（`public-url.ts` 文件头：不能拿相对路径当成功）。
  // 此时**不生成二维码**：一张指向 `?k=…` 缺域名的图，扫出来是打不开的。
  const qrSvg = url ? await QRCode.toString(url, QR_OPTIONS) : '';
  return {
    code: store.code,
    name: store.name,
    active: store.active,
    /** 新入口：带 HMAC 签名，改写会被服务端拒绝 */
    entry: signed,
    url,
    /** 二维码图像（SVG 文本）。空串 = `base_url` 未配置，页面应提示运维而不是显示一张坏图 */
    qr_svg: qrSvg,
    /** 下载时的建议文件名（页面直接用，避免两边各拼一次命名规则） */
    qr_filename: `${store.code}-report-qr.svg`,
    /** 旧入口：裸门店编码（已印出的二维码走这条），**无防篡改保证** */
    legacy_url: base ? `${base}${H5_REPORT_PATH}?k=${encodeURIComponent(store.code)}` : '',
  };
}

export function createStoreEntryActionHandlers(deps: StoreEntryActionDeps): {
  [k: string]: ActionHandler;
} {
  const { services, logger } = deps;
  const { permissions } = services;

  /** 取链接（含二维码 SVG） */
  const storeEntryLinks = (async (ctx: any, next: any) => {
    const trace = traceId(ctx);
    try {
      const actor = await permissions.resolveActor(ctx);
      // fail-closed：没有密钥就**不能**产出"看起来像签名"的链接。
      // ⚠️ 不回退成"不带签名"的链接 —— 那看起来是成功，而印出去的码没有防篡改能力。
      const secret = signingSecretOf();
      if (!secret) {
        fail(ctx, 503, 'ENTRY_SECRET_MISSING', '服务端未配置 SIGN_SECRET，无法生成门店专属入口');
        return;
      }

      // 🔴 范围裁剪：`stores` 的主键是 `id`（不是 store_id）⇒ 这里显式指定 scopeField
      //
      // ⚠️ **必须用 `permissions.resolveActor(ctx)`，不能手工拼 `{userId, roles}`**
      //    （2026-10-10 实测踩到）：`scopeOf()` 会读 `actor.storeIds.length`，
      //    而手工拼出来的对象没有这个字段 ⇒ `Cannot read properties of undefined`
      //    ⇒ 接口 500。这个错误在**总部账号**下也照样发生（resolveActor 只是恰好
      //    还没被调用），所以它不挑身份、一上来就炸。
      //    `resolveActor` 同时还负责"未登录 ⇒ ForbiddenError ⇒ 401"，
      //    把手写的那段 401 判断也一并去掉 —— 鉴权口径只有一处。
      const filter = permissions.applyScope(actor, {}, 'id');
      const rows = await (ctx.app as any).db.getRepository('stores').find({
        filter,
        sort: ['code'],
        fields: ['code', 'name', 'active'],
      });

      const base = publicBaseUrlOf();
      if (!base) {
        logger.warn?.('[svc:storeEntryLinks] 对外站点基址为空（PUBLIC_H5_BASE_URL / PUBLIC_BASE_URL 均未配置）');
      }

      const items: Array<Record<string, unknown>> = [];
      for (const row of rows ?? []) {
        items.push(
          await entryOf(
            { code: String(row.code), name: String(row.name), active: row.active === true },
            base,
            secret,
          ),
        );
      }

      logger.debug?.(
        `[svc:storeEntryLinks] ${usernameOf(actor)} 取 ${items.length} 家门店入口（trace=${trace}）`,
      );
      ok(ctx, {
        /** 对外站点基址（明文回传，便于前台自证"链接是拼在这个域名上的"） */
        base_url: base,
        count: items.length,
        items,
        trace,
      });
    } catch (error) {
      fail(ctx, 500, 'INTERNAL_ERROR', String((error as Error)?.message ?? error).slice(0, 200));
    }
    await next();
  }) as unknown as ActionHandler;

  return { [SVC_ACTION.STORE_ENTRY_LINKS]: storeEntryLinks };
}
