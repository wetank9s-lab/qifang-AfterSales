/**
 * 门店报修入口 —— 后台行动作（Phase 11 / P11-1，用户 req 1）
 * =============================================================================
 *
 * 用户要求：「15 家门店分别生成稳定、唯一的 H5 报修链接与二维码；
 * **后台授权人员能够复制链接、下载二维码**。」
 *
 * 这一份就是"后台授权人员"那一侧的全部实现。
 *
 * -----------------------------------------------------------------------------
 * 为什么是「门店表的一行的动作」而不是一个独立页面
 * -----------------------------------------------------------------------------
 * 挂载点选的是 `stores` 集合的**行操作列**（`TableActionsColumnModel`），
 * 与工单表上的「处理」完全同构 —— 复用同一套 `flowModels:save` 播种机制，
 * 不引入任何新的页面类型、也不需要在后台里加一条独立路由。
 * 代价是"一次只能看一家门店的码"，收益是"点哪家看哪家"，
 * 且与门店列表的权限口径天然一致（看得到那行、才点得到那个按钮）。
 *
 * -----------------------------------------------------------------------------
 * 🔴 三条不能越过的边界
 * -----------------------------------------------------------------------------
 *  1. **链接只在服务端生成。** 本文件**不拼接**任何 URL，也不持有签名算法 ——
 *     它只把 `svc:storeEntryLinks` 的响应显示出来。
 *     前端自己拼链接 = 把签名算法复制一份到浏览器（req 2 明令禁止的方向）。
 *  2. **不新增写路径。** 本动作只调一个只读 action，不写任何业务表。
 *  3. **旧入口如实标注。** 服务端会把 `legacy_url`（无签名）一并回给后台，
 *     本文件必须把它的安全性差异**写在界面上**，不能让它看起来和新入口一样。
 *     req 5 明文："不得宣称为与新签名入口同等安全"。
 *
 * ⚠️ `download` 用 **SVG** 而不是 PNG：`qrcode` 在 Node 侧产出 PNG 需要
 *    `node-canvas`（原生模块，镜像里没有）；而 SVG 是**矢量**的 ——
 *    二维码要印在门店墙上，矢量在放大打印时不糊，比 PNG 更合适。
 */
import React from 'react';
import { Alert, Button, Typography, message } from 'antd';
import { openClosableModal } from './modal-kit';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/** 服务端 `svc:storeEntryLinks` 的单条门店入口（字段与 `actions/svc/store-entry.ts` 逐字对齐） */
interface StoreEntryItem {
  code: string;
  name: string;
  active: boolean;
  /** 签名入口标识（`S01.<sig>`）；**不含域名** */
  entry: string;
  /** 新入口链接（带签名） */
  url: string;
  /** 二维码图像（SVG 文本）；空串 = 服务端未配置对外基址 */
  qr_svg: string;
  qr_filename: string;
  /** 旧入口链接（裸门店编码，**无防篡改保证**） */
  legacy_url: string;
}

/** 复制到剪贴板。优先 Clipboard API，不可用时退回临时 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  // ⚠️ 浏览器全局必须经 `globalThis as any` 取，**不能直接写 `navigator` / `window`**：
  //    本插件客户端 tsconfig 的 `lib` 只有 `["ES2020"]`（没有 DOM），
  //    直接写会得到 `TS2304: Cannot find name 'navigator'` ——
  //    而这条**只有 `verify-types` 会报**（esbuild 不做类型检查、构建全绿）。
  //    之所以不往 tsconfig 里加 "DOM"：那会改变**整个**客户端（含框架类型）的全局视野，
  //    属于"为了让一行通过而放宽全仓约束"。这里代价最小又明确。
  const g: any = globalThis;
  try {
    if (g.navigator?.clipboard?.writeText && g.isSecureContext) {
      await g.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    // ⚠️ 兜底路径是必需的：本项目本机入口是 `http://localhost:8080`，
    //    localhost 属于安全上下文、Clipboard API 可用；但若将来以**内网 IP + 明文**
    //    部署，`isSecureContext` 为 false ⇒ Clipboard API 直接不存在。
    //    那时"复制"按钮会变成一个点了没反应的按钮 —— 必须留退路。
    const area = g.document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    g.document.body.appendChild(area);
    area.select();
    const okDone = g.document.execCommand('copy');
    g.document.body.removeChild(area);
    return okDone;
  } catch {
    return false;
  }
}

/** 把二维码 SVG 存成文件（纯前端，不经过服务端） */
function downloadSvg(svg: string, filename: string): void {
  const g: any = globalThis; // 同上：DOM 全局经显式断言取
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = g.document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  g.document.body.appendChild(anchor);
  anchor.click();
  g.document.body.removeChild(anchor);
  // 立刻释放：不释放会在长会话里把 Blob 一直挂在内存上（每点一次漏一个）
  URL.revokeObjectURL(href);
}

/** 一行「标签 + 值 + 复制按钮」——链接区与旧入口区共用同一形态，避免两处各写一套 */
function LinkRow({ label, value, testid }: { label: string; value: string; testid: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  return React.createElement(
    'div',
    { style: { marginBottom: 12 }, 'data-testid': testid },
    React.createElement(Typography.Text, { strong: true }, label),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 4 } },
      React.createElement(Typography.Text, {
        // 长链接必须能换行，否则会把弹窗撑宽（二维码那侧的 SVG 宽度固定 320）
        style: { fontSize: 12, wordBreak: 'break-all', flex: 1 },
        code: true,
        'data-testid': `${testid}-value`,
      }, value),
      React.createElement(
        Button,
        {
          size: 'small',
          'data-testid': `${testid}-copy`,
          onClick: async () => {
            const okDone = await copyText(value);
            if (okDone) {
              setCopied(true);
              message.success('已复制到剪贴板');
              // 同上：`setTimeout` 也不在 ES2020 lib 的全局里（它在 DOM / node 的 lib 里）
              (globalThis as any).setTimeout(() => setCopied(false), 2000);
            } else {
              // 复制失败时**不假装成功**：告诉用户手动选中上面的文本
              message.warning('浏览器拒绝访问剪贴板，请手动选中上面的链接复制');
            }
          },
        },
        copied ? '已复制' : '复制',
      ),
    ),
  );
}

/** 弹窗主体：门店名、新入口链接 + 二维码、旧入口链接与差异说明 */
function EntryBody({ item, baseUrl }: { item: StoreEntryItem; baseUrl: string }): React.ReactElement {
  const qrBox = item.qr_svg
    ? React.createElement('div', {
        // ⚠️ 用 `dangerouslySetInnerHTML` 是**唯一**可行路径：qrcode 产出的是
        //    一段完整 SVG 字符串。注入内容是**服务端自己生成的**（内容只有
        //    URL 文本经 QR 编码后的图形），不含任何来自用户/门店的原始 HTML。
        style: { marginTop: 8, padding: 8, background: '#fff', display: 'inline-block', lineHeight: 0 },
        dangerouslySetInnerHTML: { __html: item.qr_svg },
        'data-testid': 'svc-store-entry-qr',
      })
    : React.createElement(Alert, {
        type: 'warning',
        showIcon: true,
        'data-testid': 'svc-store-entry-qr-missing',
        message: '服务端没有生成二维码',
        description:
          '对外站点基址为空（PUBLIC_H5_BASE_URL / PUBLIC_BASE_URL 均未配置），' +
          '因此拼不出可用的链接，也就没有生成二维码。请联系运维配置后再取。',
      });

  return React.createElement(
    'div',
    null,
    React.createElement(Typography.Paragraph, { style: { marginBottom: 4 } },
      React.createElement(Typography.Text, { strong: true }, '报修门店：'),
      React.createElement(Typography.Text, { 'data-testid': 'svc-store-entry-name' }, item.name),
      ' ',
      React.createElement(Typography.Text, { type: 'secondary', 'data-testid': 'svc-store-entry-code' }, `（${item.code}）`),
    ),
    item.active
      ? null
      : React.createElement(Alert, {
          type: 'warning',
          showIcon: true,
          style: { marginBottom: 12 },
          message: '该门店当前已停用',
          description:
            '停用门店的报修入口不会创建新工单（客户扫码打开也会被服务端拒绝）。' +
            '二维码可以先取，但要恢复营业后再发放。',
        }),

    // ---------------- 新入口（签名） ----------------
    LinkRow({ label: '专属报修链接（已签名，防篡改）', value: item.url, testid: 'svc-store-entry-url' }),
    qrBox,
    React.createElement(
      'div',
      { style: { marginTop: 8 } },
      React.createElement(
        Button,
        {
          type: 'primary',
          size: 'small',
          disabled: !item.qr_svg,
          'data-testid': 'svc-store-entry-download',
          onClick: () => downloadSvg(item.qr_svg, item.qr_filename),
        },
        '下载二维码',
      ),
    ),

    // ---------------- 旧入口（旧二维码兼容） ----------------
    React.createElement('div', { style: { marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 } },
      React.createElement(Alert, {
        type: 'info',
        showIcon: true,
        'data-testid': 'svc-store-entry-legacy-note',
        message: '旧二维码入口（兼容保留，**不具备防篡改能力**）',
        description:
          '下面这条链接是早期印出去的门店二维码所指向的地址（只带门店编码，没有签名）。' +
          '门店编码可以被任意改写 —— 谁把 S01 换成 S02 就能落到别家门店。' +
          '它能继续使用，只是为了让已经贴出去的旧码不作废；' +
          '新印二维码请一律使用上面的签名链接。本页不提供旧入口的二维码下载。',
      }),
      LinkRow({ label: '旧入口链接（仅供核对，不建议再印制）', value: item.legacy_url, testid: 'svc-store-entry-legacy-url' }),
      React.createElement(
        Typography.Text,
        { type: 'secondary', style: { fontSize: 12 } },
        `对外基址：${baseUrl || '(未配置)'}`,
      ),
    ),
  );
}

export function buildStoreEntryActionModel({
  ActionModel,
  ActionSceneEnum,
  request,
}: {
  ActionModel: any;
  ActionSceneEnum: any;
  request: Requester;
}): Record<string, any> {
  if (!ActionModel) return {};

  class StoreEntryActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';

    /**
     * 按钮文案（固定，不随状态变）。
     *
     * ⚠️ 这里**写 `children` 是对的**，与 `TicketPrimaryActionModel` 刻意不写
     *    的理由不冲突：那个模型的标签**必须随工单状态变**（处理 / 跟进 / 查看…），
     *    写了 `children` 就把动态标签钉死了；而本动作的文案永远是「报修入口」。
     */
    defaultProps: any = { type: 'link', iconOnly: false, children: '报修入口' };

    /** 当前行数据。**不是 `this.record`，而是 `this.context.record`**（框架的 `getInputArgs()` 就是这么取的） */
    currentRecord(): any {
      return (this as any).context?.record ?? {};
    }

    /**
     * 点击行为。
     *
     * 🔴🔴 **必须覆写 `onClick`，不能用 `registerFlow({ on: 'click' })`**
     *    —— 2026-10-10 实测踩到，代价是一次"按钮在、点了什么都不发生"：
     *
     *      · 第一版照抄了 `ticket-actions.tsx` 里的 `registerFlow({key:'clickFlow',
     *        on:'click', steps:{open:{async handler(ctx){...}}}})`；
     *      · 构建全绿、模型确实注册成功（控制台那行
     *        `已注册客户端动作：…, StoreEntryActionModel` 亲眼可见）、
     *        按钮也**真的渲染出来了**（页面上 15 行各有一个「报修入口」）；
     *      · 但点下去 **零反应**：没有弹窗、没有 antd message、控制台一条日志都没有。
     *
     *    原因：`ActionModel` 的基类 `renderButton()` 是
     *      `onClick={this.onClick.bind(this)}` → 内部只做 `this.dispatchEvent('click', …)`，
     *      而**类上 `registerFlow` 注册的是"可被配置的流"，不是"这个实例要跑的流"** ——
     *      实例要跑哪条流是**持久化在节点上的配置**。没配置 = 事件派发了、没人接。
     *      这正是在页面上真正生效的 `TicketPrimaryActionModel` 选择覆写 `onClick` 的原因
     *      （见 `primary-action.tsx` 里那句"挂流等于点了什么都不发生，
     *       有按钮、无行为，最难发现的一类缺陷"）。
     *    ⚠️ 而 `ticket-actions.tsx` 里那份 `registerFlow` 写法**之所以"看起来能用"**，
     *      是因为那批动作早已被撤出列表行（`FORBIDDEN_ROW_ACTION_USES`）——
     *      它是一条**没人再走的旧路**。照抄旧路 = 把已经废弃的写法复制到新功能上。
     *
     *    ⇒ 判据也一并记下来：**"模型注册了"不等于"事件有人接"**。
     *      只看控制台那行注册日志就会得出"注册没问题"的结论，
     *      而真实浏览器里点一下才知道。
     */
    onClick(): void {
      const record = this.currentRecord();
      const code = String(record?.code ?? '').trim();
      if (!code) {
        message.error('取不到门店编码，无法取入口');
        return;
      }
      // ⚠️ 路径**不带** `/api` 前缀（`index.ts` 注入的 request 会自己补）——
      //    与 `ticket-drawer.tsx` 里那条 `svc:timeline` 同一条纪律。
      //    写成 `/api/svc:storeEntryLinks` 会变成 `/api/api/...` → 404。
      void (async () => {
        let payload: any;
        try {
          payload = await request('svc:storeEntryLinks', 'get');
        } catch (error: any) {
          message.error(
            `取门店报修入口失败：${error?.response?.data?.message ?? error?.message ?? error}`,
          );
          return;
        }

        /**
         * 🔴 解包方式必须是 `payload.data` —— 注入的 `request()` 返回的是
         *    **响应信封**（`{data: {...}}`），不是 payload 本身。
         *
         *    2026-10-10 实测踩到：第一版写成 `payload.items`，于是
         *    `Array.isArray(undefined)` 为假 ⇒ `items = []` ⇒ 每次都走
         *    "没有取到门店 X 的报修入口"那条分支。**按钮能点、请求也真的成功了**，
         *    屏幕上却是一句"可能原因：不在授权范围 / 未配密钥" ——
         *    把一次**前端解包写错**说成了**服务端权限或配置问题**，
         *    排查方向直接被引到完全错误的地方。
         *    对照取证：`ticket-drawer.tsx` 用的是 `timeline?.data?.ticket`，
         *    同一个 `request`，同一层信封。凡是用注入的 `request` 都要多剥一层 `.data`。
         *
         *    与"读到空是最坏的假绿"同源：这里没有静默成功，但**错误信息的归因错了**，
         *    代价同样是整轮排查。
         */
        const data = payload?.data;
        const items: StoreEntryItem[] = Array.isArray(data?.items) ? data.items : [];
        if (!Array.isArray(data?.items)) {
          // 形状不对时**响亮失败**并把拿到的形状说出来，绝不退化成"没取到门店"。
          message.error(
            `门店入口接口返回的形状不对（缺 data.items）：${JSON.stringify(payload).slice(0, 160)}`,
          );
          return;
        }
        const item = items.find((one) => one.code === code);
        if (!item) {
          // 两种情况会走到这里：① 该门店不在当前账号的授权范围（服务端裁掉了它）；
          // ② 该门店已被停用（`applyScope` 仍会带上它，但这里能取到；真正取不到的是①）。
          // **不做猜测**，把可能原因如实说出来，让使用者能自行判断该找谁。
          message.error(
            `没有取到门店 ${code} 的报修入口（接口共返回 ${items.length} 家门店）。` +
              `可能原因：该门店不在你的授权范围内。`,
          );
          return;
        }

        openClosableModal({
          title: `${item.name} · 报修二维码`,
          testid: 'svc-store-entry-modal',
          hideFooter: true,
          content: React.createElement(EntryBody, { item, baseUrl: String(data?.base_url ?? '') }),
          // ⚠️ 本弹窗**全部只读**：没有输入框、没有待保存内容 ⇒
          //    关闭时不必问"是否放弃未保存的内容"（问了反而让人以为改过什么）。
          hasUnsavedChanges: () => false,
        });
      })();
    }

    /**
     * 给框架自己的按钮补两个**验收用**的 data 属性。
     *
     * 为什么不让门禁按文案找按钮：这个页面上「报修入口」四个字同时出现在
     * **菜单项、页面标题、Tab 标题**上，"按文字找"极易点到导航栏那一个 ——
     * 而它点了只会跳页，症状是"弹窗没出现"，指不到真正的原因。
     * 与 `TicketPrimaryActionModel.renderButton()` 给按钮补 `data-primary-action`
     * 是同一手法、同一目的。
     */
    renderButton(): any {
      const node = super.renderButton();
      if (!node) return node;
      return React.cloneElement(node, {
        'data-testid': 'svc-store-entry-action',
        'data-store-code': String(this.currentRecord()?.code ?? ''),
      });
    }
  }
  Object.defineProperty(StoreEntryActionModel, 'name', { value: 'StoreEntryActionModel' });
  StoreEntryActionModel.define?.({ label: '报修入口' });

  return { StoreEntryActionModel };
}
