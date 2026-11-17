/**
 * `ArchiveEditBlockModel` —— ARC-V1 / A5-C：「档案移动测试」页的**编辑 + 拍照**区块。
 *
 * ===========================================================================
 * 本区块只做一件事（用户 §二 裁决）
 * ===========================================================================
 *   普通上门服务档案的六步：
 *     列表 → 打开（显示真实已保存字段）→ 编辑 → 保存 → 拍照上传 → 预览 → 再次打开
 *
 *   **不做**：员工 H5、通用表单框架、批量页面生成。
 *   所以这里没有"字段元数据驱动的渲染"——字段写死在 `EDIT_FIELDS` 里。
 *   那不是偷懒：通用表单框架正是用户明确排除的范围，写死才能让这六步真的走通。
 *
 * ===========================================================================
 * 七条编辑硬要求 → 本文件里的落点
 * ===========================================================================
 *   ① 从**受权限控制**的接口取本人门店档案 →
 *      `serviceArchives:list/get`（原生读，ACL 已按 storeScope 裁到本店；实测 A 店销售
 *      只看到 store_id=1 的 31 条、B 店销售只看到 store_id=4 的 11 条）。
 *      ⚠️ 这里**必须**走原生读，不能自建 `svc:archiveList` —— 读范围复用已审计过的
 *      storeScope，比再写一份范围过滤更不容易漏。
 *   ② 打开显示真实已保存字段 → `archiveGet` 拉到行后 `form.setFieldsValue(row)`。
 *      不拿列表里的缓存行顶替：列表可能只带部分字段，且可能是旧的。
 *   ③ 调用 `svc:archiveUpdate` → `onSave`。
 *   ④ **必须带 `expected_version`** → `versionRef.current`，初始值来自服务端行。
 *   ⑤ 成功后更新本地版本号 → `versionRef.current = res.archive.version`。
 *      必须用**服务端返回的**版本，不能用 `version+1` 猜 —— 服务端可能在别处又推进了。
 *   ⑥ 409 冲突**保留用户修改内容** + 提示"已被其他操作更新" + **不静默覆盖**：
 *      · 不调 `form.resetFields()`、不调 `setFieldsValue(row)`（那会抹掉用户正在改的字）；
 *      · 明确给出「重新载入最新内容」按钮，由**人**决定是否放弃自己的修改。
 *   ⑦ 已作废档案禁止修改 → `visibility==='voided'` 时表单 `disabled`，保存按钮不渲染。
 *   另：**严禁开放原生 update** —— 本区块只调 `svc:archiveUpdate`，不碰 `serviceArchives:update`。
 *
 * ===========================================================================
 * 八条照片硬要求 → 本文件里的落点
 * ===========================================================================
 *   1 手机拍照或选相册 → `<input type="file" accept="image/*" capture="environment">`
 *     （`capture` 让手机直接开相机；桌面端退化成文件选择，同一控件两种行为）
 *   2 上传后**立即**显示受控预览 → 先 `URL.createObjectURL(file)` 本地预览，
 *     上传成功后换成服务端字节流（`archivePhotoFile`）。**不用原图的 blob 冒充服务端结果**，
 *     否则"预览能看"不代表"服务端真的存下来了"。
 *   3 失败**只提示当前照片失败**，不清空档案字段/其他照片 → 错误放在该照片自己的
 *     状态里（`photoErrors[idx]`），表单值与已上传列表一行不动。
 *   4 默认 `published=false` → 上传体里**不传 published**，由服务端取默认（false），
 *     客户端不"顺手帮忙发布"。
 *   5 不自动发布档案或照片 → 本区块**没有任何** publish 调用。
 *   6 不返回 `storage_key` → 服务端 `project()` 本来就不含它（本区块也不读它）。
 *   7 正确释放预览 Blob URL → 每个 objectURL 都记在 `objectUrlsRef`，
 *     在 换图 / 卸载 / 重新载入 时 `revokeObjectURL`。
 *     用一个 ref 数组而不是"就地 revoke"：组件卸载时也要能清，否则长会话会漏。
 *   8 严禁跨店照片 → 服务端 `archivePhotoFile` / `archivePhotoList` 都过
 *     `assertCanAccessRow`；本区块只对自己刚打开的那张档案操作，不拼 photo_id 猜别家。
 *
 * ===========================================================================
 * 为什么这里用原生 `request` 而不是 `sendSvcRequest`
 * ===========================================================================
 *   `sendSvcRequest` 是为**JSON 写**设计的（`data: object` + 固定 headers）。
 *   照片是 `multipart/form-data`，必须让浏览器自己生成 boundary
 *   （手动设 `Content-Type: multipart/form-data` 会**丢掉 boundary**，服务端解析失败）。
 *   所以照片走一条独立的 `uploadPhoto()`，其余写请求仍走 `sendSvcRequest`。
 *   两条通道各自正确，比硬把它们合成一个函数更安全。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Tag,
} from 'antd';
import {
  IDEMPOTENCY_REPLAY_HEADER,
  newRequestId,
  REQUEST_ID_HEADER,
  sendSvcRequest,
} from '../shared/svc-request';
import { parseDateOnly } from '../shared/date-only';
import { ARCHIVE_EDIT_FIELDS as EDIT_FIELDS, buildUpdateBody } from '../shared/archive-edit-body';
import { DateOnlyInput } from './date-only-input';
import {
  ARCHIVE_SERVICE_TYPE,
  ARCHIVE_SERVICE_TYPE_LABEL,
  ARCHIVE_STAGE_LABEL,
  ARCHIVE_STAGE_STATUS_LABEL,
} from '../server/constants';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: {
    headers?: Record<string, string>;
    responseType?: string;
    /** 查询串参数。列表接口的 pageSize / page / sort / filter 全靠它 */
    params?: Record<string, unknown>;
  },
) => Promise<any>;

/** 上传通道：与 `Requester` 分开，因为要传 FormData 且由浏览器定 Content-Type */
// ⚠️ 宿主包把 `FormData` / `File` 声明成**值**（`declare var`），不是类型 ⇒
//    写 `formData: FormData` 会报 TS2749。用 `any` 承接，运行期仍是真实的 FormData。
type Uploader = (url: string, formData: any, requestId: string) => Promise<any>;

/**
 * 编辑字段白名单 —— 与服务端 `archiveUpdate` 的白名单**逐字对应**。
 *
 * ⚠️ 已搬到 `src/shared/archive-edit-body.ts`（文件顶部 import）：
 *    那里同时承载**提交体的构造规则**（未注册字段不提交 / 日期必须过 `parseDateOnly` /
 *    `''` 才是清空）。搬家的直接原因：这条规则原来只活在组件里的一个循环中，没法单测，
 *    于是"没渲染的三个字段被当成用户清空"这个缺陷一直没人发现（DEV-218）。
 */

type EditValues = Record<string, string | undefined>;

/** 列表行（只声明本区块真正读的字段） */
interface ArchiveRow {
  id: number;
  archive_no: string;
  store_id: number;
  status: string;
  visibility: string;
  version: number;
  customer_name: string;
  customer_mobile: string;
  service_address: string;
  archive_type: string;
}

interface PhotoRow {
  id: number;
  archive_id: number;
  /** 暖通阶段照片才有值；普通服务为 null（A5-F） */
  stage_id?: number | null;
  photo_type: string;
  mime: string;
  byte_size: number;
  published: boolean;
  uploaded_at: string;
}

/** 一张照片在界面上的完整状态 */
interface PhotoSlot {
  /** 本地生成的临时键（列表 key，避免上传前后 key 变化导致重挂） */
  key: string;
  photoType: 'before' | 'after';
  /** 上传中 */
  uploading: boolean;
  /** 上传成功后的服务端照片（null = 还没成功） */
  photo: PhotoRow | null;
  /** 预览图 URL（可能是 blob:，也可能是 objectURL(服务端字节)） */
  previewUrl: string | null;
  /** 该照片自己的错误（**不影响**其他照片与表单） */
  error: string | null;
  /** 是否仍有可用预览 */
  previewLoading: boolean;
}

const useTypedForm = (): any => (Form as any).useForm();

/** 取服务端返回体的数据段（`ok()` 包了一层 `{ data }`） */
function payloadOf(r: any): any {
  if (r && typeof r === 'object' && 'data' in r) return r.data;
  return r;
}

/**
 * 档案可见性的中文说法（A5-E）。
 *
 * ⚠️ `visibility` 与业务 `status` 是**两套**语义，别混：
 *    · draft     —— 客户查不到（但业务上可能已经完工）
 *    · published —— 客户能查到（但业务上可能还没完工）
 *    · voided    —— 作废，停止对客查询，内部历史保留
 */
function visibilityLabel(v: unknown): string {
  const s = String(v ?? '');
  if (s === 'draft') return '草稿（客户查不到）';
  if (s === 'published') return '已发布（客户可查）';
  if (s === 'voided') return '已作废';
  return s || '未知';
}

/** 错误摘要：优先业务错误码 + 消息，其次 HTTP 状态 */
function errorInfoOf(e: any): { status: number | null; code: string | null; message: string } {
  const res = e?.response;
  const body = res?.data;
  const first = body?.errors?.[0];
  return {
    status: typeof res?.status === 'number' ? res.status : null,
    code: first?.code ? String(first.code) : null,
    message: String(
      first?.message ?? body?.message ?? (res?.status ? `请求失败（HTTP ${res.status}）` : e?.message ?? '未知错误'),
    ),
  };
}

const ERR_TOAST = {
  /**
   * 乐观锁冲突：**必须**保留用户已改内容。
   *
   * 文案口径（2026-11-10 A5-D 明确，用户要求）：
   *   · 说清**这次保存没成功**（"本次修改未保存"）—— 不说这句，用户会以为存上了；
   *   · 说清**当前输入还在**（"已为你保留"）—— 否则用户第一反应是赶紧刷新看看，
   *     一刷新就真丢了；
   *   · **绝不**提示"请刷新" —— 刷新是最容易丢掉未保存内容的操作，
   *     这里必须由人点「重新载入最新内容」按钮显式确认后才覆盖。
   */
  conflict: '保存未成功：数据已更新，本次修改未保存。你当前填写的内容已为你保留，请核对后确认是否重新加载',
  voided: '档案已作废，不能修改',
  forbidden: '当前账号无权操作这张档案',
};

export function buildArchiveEditBlockModel(deps: {
  FlowModelBase: any;
  request: Requester;
  uploader: Uploader;
}): Record<string, any> {
  const { FlowModelBase, request, uploader } = deps;
  if (!FlowModelBase) return {};

  function ArchiveEditPanel() {
    const [form] = useTypedForm();

    // ---- 列表 ----
    const [rows, setRows] = useState([] as ArchiveRow[]);
    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState(null as string | null);

    // ---- 当前打开的档案 ----
    const [current, setCurrent] = useState(null as ArchiveRow | null);
    /** ⚠️ 版本号放 ref：它是请求参数，不是渲染输入；放 state 会让 setState 异步性影响提交 */
    const versionRef = useRef(1);
    const [versionText, setVersionText] = useState(1);
    const [openLoading, setOpenLoading] = useState(false);
    const [openError, setOpenError] = useState(null as string | null);
    /**
     * 从服务端读到的字段值。
     *
     * 为什么要过一层 state 而不是直接 `form.setFieldsValue()`：
     *   `Form` 只在 `current` 有值时才渲染。`openArchive` 里 `setCurrent(row)` 之后
     *   同一 tick 内 Form **还没挂载**，此时 setFieldsValue 会被 antd 静默丢弃，
     *   表现是"版本号显示 v1、输入框却全是空的"。
     *   所以：打开时只写 `loadedValues`，由下方 useEffect 在 Form 挂载后同步一次。
     */
    const [loadedValues, setLoadedValues] = useState(null as EditValues | null);

    // ---- 保存 ----
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null as string | null);
    const [saveOk, setSaveOk] = useState(null as string | null);
    const [conflict, setConflict] = useState(false);

    /**
     * 冲突提示必须让用户**真的看见**。
     *
     * 2026-11-10 A5-D 实测（不是推测）：
     *   点下保存 → 409 → Alert 渲染出来了，但它的 `getBoundingClientRect().top = **-130**`
     *   —— 整个提示框落在视口**上方**。用户眼前只有一条右侧一闪而过的 toast，
     *   正文「数据已更新，本次修改未保存…」根本没进视野。
     *   此时如果 toast 也自动消失了，用户会以为"保存成功了"，
     *   然后带着没存上的内容离开页面 —— 恰好是这条提示要防的事。
     *
     * 为什么不用 `el.scrollIntoView()`：
     *   本页的滚动发生在 `nb-ui-layout-mobile-body` 这个内部容器上，
     *   `scrollIntoView` 在实测中没有改变任何可见位置（截图字节数完全不变）。
     *   所以这里显式找到**真正可滚动的祖先**，直接改它的 `scrollTop`。
     *
     * ⚠️ 第一版用「滚动容器顶部」当基准（`delta = el.top - 容器.top`），
     *    实测在同一份代码上出现两种结果：一次 alertTop=60，另一次 alertTop=-130。
     *    根因是那个容器的 `clientHeight = 0`（滚动由内部合成层承担），
     *    `getBoundingClientRect().top` **不代表内容原点**，拿它做加法的基准不可靠。
     *    改成**双锚点 + 事后校正**，全程只用「元素在视口里的位置」这一个量：
     *      · 目标位置 = min(提示框顶部, 表单顶部) - 12 —— 先保证提示，再尽量露出表单；
     *      · 设完 `scrollTop` 后立刻用同一把尺子复测，没到位就按新差量补一次；
     *      · 首帧没渲染出提示框就多试两帧（40/120/240ms），不押单次 setTimeout 的时机。
     *    这样与「容器顶部是否等于内容原点」无关，也与初始滚动位置无关。
     *
     * 幂等性：已经在视野内时两次比对的差量都接近 0，不会把用户乱甩。
     */
    useEffect(() => {
      if (!saveError) return;
      // 注：本项目 tsconfig 不带 DOM lib（类型环境里没有 HTMLElement / window），
      // 所以这里一律用 any —— 运行环境是浏览器，这些对象本来就存在。
      const doc: any = (globalThis as any).document;
      const win: any = (globalThis as any).window;
      if (!doc || !win) return;

      const timers: any[] = [];
      let done = false;

      /** 找到真正承载滚动的祖先（NocoBase 移动页是内部容器，不是 document） */
      const findScroller = (from: any): any => {
        let node: any = from;
        while (node && node !== doc.body) {
          const st = win.getComputedStyle(node);
          if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
            return node;
          }
          node = node.parentElement;
        }
        return doc.scrollingElement ?? doc.documentElement;
      };

      /** 只按**元素在视口里的位置**算差量，不假设容器顶部是内容原点 */
      const alignOnce = (): boolean => {
        const el: any = doc.querySelector('[data-testid="arc-edit-error"]');
        if (!el) return false; // 还没渲染出来，交给下一帧
        const form: any = doc.querySelector('[data-testid="arc-edit-form"]');
        const er = el.getBoundingClientRect();
        const fr = form ? form.getBoundingClientRect() : null;

        // 锚点：提示框顶部与表单顶部取更靠上者
        const currentTop = Math.min(er.top, fr ? fr.top : er.top);
        const MARGIN = 12;
        if (currentTop < MARGIN || currentTop > win.innerHeight * 0.5) {
          const target: any = findScroller(el.parentElement);
          if (!target) return true;
          // 差量为正 ⇒ 内容整体需要下移 ⇒ scrollTop 减小
          const next = target.scrollTop + (currentTop - MARGIN);
          target.scrollTop = Math.max(0, next);
          // 立刻复测：若容器没接受（或被别的逻辑抵消），再按新差量补一次
          const er2 = el.getBoundingClientRect();
          const fr2 = form ? form.getBoundingClientRect() : null;
          const top2 = Math.min(er2.top, fr2 ? fr2.top : er2.top);
          if (Math.abs(top2 - MARGIN) > 4) {
            const t2: any = findScroller(el.parentElement);
            if (t2) t2.scrollTop = Math.max(0, t2.scrollTop + (top2 - MARGIN));
          }
        }
        return true;
      };

      for (const delay of [40, 120, 240]) {
        timers.push(
          setTimeout(() => {
            if (done) return;
            if (alignOnce()) done = true;
          }, delay),
        );
      }

      return () => {
        done = true;
        for (const t of timers) clearTimeout(t);
      };
    }, [saveError]);

    // ---- 照片 ----
    const [photos, setPhotos] = useState([] as PhotoSlot[]);
    const [photosLoading, setPhotosLoading] = useState(false);
    const [photosError, setPhotosError] = useState(null as string | null);

    /**
     * 所有由本组件创建的 objectURL。
     *
     * ⚠️ 必须自己管：`URL.createObjectURL` 出来的 blob URL 会**一直持有**那块内存，
     *    浏览器只在页面卸载时统一回收。一个长会话里连拍十几张不 revoke，
     *    手机端内存会明显上涨（用户要求 §四.7）。
     */
    const objectUrlsRef = useRef([] as string[]);

    const trackObjectUrl = useCallback((url: string) => {
      objectUrlsRef.current.push(url);
      return url;
    }, []);

    const revokeAll = useCallback(() => {
      for (const url of objectUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* 已被回收过：忽略 */
        }
      }
      objectUrlsRef.current = [];
    }, []);

    const revokeOne = useCallback((url: string) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      objectUrlsRef.current = objectUrlsRef.current.filter((u) => u !== url);
    }, []);

    // 卸载时清掉所有预览 URL
    useEffect(() => revokeAll, [revokeAll]);


    // ---- A5-G：角色感知 + 只读模式 ----
    //
    // 为什么读 auth:check 而不是加一个"我是谁"的业务接口：
    //   角色是 NocoBase **已有的会话事实**；客户端只需要据此决定**渲染哪些控件**。
    //   真正的权限判定仍在服务端（写接口一律会拒），这里绝不复制权限规则 ——
    //   复制规则的结果一定是两边漂移，而漂移的方向通常是"界面允许、服务端拒绝"，
    //   或者更糟：界面显示只读、服务端却允许写。
    const [myRoles, setMyRoles] = useState([] as string[]);
    /** 总部：门店筛选（空串 = 全部）；门店角色不渲染筛选器 */
    const [storeFilter, setStoreFilter] = useState('');
    const [storeChoices, setStoreChoices] = useState([] as Array<{ id: number; name: string }>);

    // ---- A6：列表分页 ----
    // 原来写死 `page: 1, pageSize: 50` ⇒ 第 51 条起**永远看不到**（实测本店 129 条）。
    // 服务端本身支持分页并回 `meta.count / meta.totalPage`，只是界面没接。
    const [listPage, setListPage] = useState(1);
    const [listTotal, setListTotal] = useState(0);
    const [listTotalPage, setListTotalPage] = useState(1);

    const isVoided = current?.visibility === 'voided';
    const isCompleted = current?.status === 'completed';
    /** 暖通工程：照片挂在六个阶段里，没有 before/after 之分（A5-F） */
    const isHvac = current?.archive_type === 'hvac';
    // A5-G：写能力只看"是不是门店销售"——与 ARCHIVE_WRITE_ROLES 一致；
    // 但**不在客户端复刻权限规则**：这里只决定渲染，服务端仍逐条判定。
    const canWrite = myRoles.indexOf('store_sales') >= 0;
    const isHqViewer = myRoles.indexOf('hq_admin') >= 0 || myRoles.indexOf('hq_after_sales') >= 0;

    /**
     * 总部：门店下拉（用于筛选）。
     *
     * 为什么用原生 `stores:list` 而不是 `svc:storeOptions`：
     *   `storeOptions` 刻意**不回内部 id**（它服务于"选择门店编码"的场景），
     *   而档案筛选要按 `store_id` 过滤 ⇒ 需要 id。
     *   而 HQ 两个角色**本来就有** `stores:list` 的读权限（实测 200 / 10 行），
     *   负责人没有（403）⇒ 这里只是复用既有读能力，**没有新开任何授权**。
     */
    useEffect(() => {
      if (!isHqViewer) { setStoreChoices([]); return; }
      let alive = true;
      void (async () => {
        try {
          const res = await request('stores:list', 'get', undefined, {
            headers: { 'X-Data-Source': 'main' },
            params: { pageSize: 100, sort: ['sort'], fields: ['id', 'name'] },
          });
          const list = payloadOf(res);
          const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
          if (alive) {
            setStoreChoices(
              arr.map((r: any) => ({ id: Number(r.id), name: String(r.name ?? "#" + r.id) })),
            );
          }
        } catch {
          if (alive) setStoreChoices([]);
        }
      })();
      return () => { alive = false; };
    }, [request, isHqViewer]);

    // ---- A5-E：完工登记 / 发布管理的本地状态 ----
    // 命名刻意分开：完工的 `completing` 与发布的 `publishingArchive` 互不复用，
    // 否则"完工请求在飞"会误禁发布按钮（两件事，两个 loading）。
    const [completeDate, setCompleteDate] = useState('');
    const [completing, setCompleting] = useState(false);
    const [completeError, setCompleteError] = useState(null as string | null);
    const [completeOk, setCompleteOk] = useState(null as string | null);

    const [publishingArchive, setPublishingArchive] = useState(false);
    const [publishError, setPublishError] = useState(null as string | null);
    const [publishOk, setPublishOk] = useState(null as string | null);
    /** 正在切换发布状态的照片 id（0 = 没有在途请求）。逐张互斥，避免连点 */
    const [photoBusy, setPhotoBusy] = useState(0);

    // ---------------------------------------------------------------- 列表
    const loadList = useCallback(async () => {
      setListLoading(true);
      setListError(null);
      try {
        // 原生读：ACL + storeScope 已裁到本店（这是"从受权限控制的接口取"的落点）
        //
        // ⚠️ 必须显式给 pageSize + sort。不给参数时服务端默认第一页 20 条、
        // 且**没有排序**（返回顺序不保证是插入顺序）—— 实测后果：刚建好的档案
        // 根本不在首屏，用户以为"建失败了"。按 createdAt DESC 取最近 50 条，
        // 新建的档案必然在第 1 行。
        const res = await request('serviceArchives:list', 'get', undefined, {
          headers: { 'X-Data-Source': 'main' },
          params: {
            pageSize: 50,
            page: listPage,
            sort: ['-createdAt'],
            // A5-G：总部门店筛选。没选门店时**不传 filter** ——
            // 传空 filter 与不传在 NocoBase 里语义不同，容易变成"看起来筛了其实没筛"。
            ...(storeFilter ? { filter: { store_id: Number(storeFilter) } } : {}),
          },
        });
        const list = payloadOf(res);
        setRows(Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : []);
        // 总数只在 meta 里（实测：meta = {count, page, pageSize, totalPage}）
        const meta = (res as any)?.meta ?? (res as any)?.data?.meta ?? null;
        if (meta && Number.isFinite(Number(meta.count))) {
          setListTotal(Number(meta.count));
          setListTotalPage(Math.max(1, Number(meta.totalPage ?? 1)));
        }
      } catch (e: any) {
        const info = errorInfoOf(e);
        setListError(info.message);
      } finally {
        setListLoading(false);
      }
    }, [request, storeFilter, listPage]);

    // 首次挂载即拉列表
    useEffect(() => {
      void loadList();
    }, [loadList]);

    /**
     * 建档成功后自动刷新列表（2026-11-11 A5-G）。
     *
     * 建档区块与列表区块是两个独立 FlowModel，互不感知。没有这一下，
     * 用户建完档案返回列表**看不到刚建的那条**（列表只在挂载时拉过一次），
     * 只能手动刷新整页。事件名与派发方见 `archive-create-block.tsx`。
     *
     * ⚠️ 只重拉列表，**不自动打开**那条新档案：建完可能还要接着建第二条，
     *    把用户突然推进详情页是另一个体验问题。
     */
    useEffect(() => {
      const onCreated = () => {
        void loadList();
      };
      window.addEventListener('svc:archive-created', onCreated as EventListener);
      return () => window.removeEventListener('svc:archive-created', onCreated as EventListener);
    }, [loadList]);
    /**
     * 读当前登录角色 —— **只用于决定渲染哪些控件**。
     *
     * 读不到就按"没有任何写权限"处理（fail closed）：
     * 宁可少给一个按钮，也不给一个本不该有的写入口。
     * 权限本身仍由服务端逐条判定，这里不是安全边界。
     */
    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const res = await request('auth:check', 'get');
          const me = payloadOf(res) ?? {};
          const roles = Array.isArray(me.roles)
            ? me.roles.map((r: any) => String(r?.name ?? "")).filter(Boolean)
            : [];
          if (alive) setMyRoles(roles);
        } catch {
          if (alive) setMyRoles([]);
        }
      })();
      return () => { alive = false; };
    }, [request]);

    /**
     * Form 挂载后把服务端字段灌进去。
     *
     * 触发时机：`openArchive` 先 `setCurrent(row)`（Form 此时才渲染）再 `setLoadedValues(values)`，
     * 两个 setState 在同一批里提交 ⇒ 本 effect 在 **Form 已挂载**之后才跑，值不会丢。
     * 依赖里带 `current?.id`：切到另一条档案时重新灌一次。
     */
    useEffect(() => {
      if (!current || !loadedValues) return;
      form.setFieldsValue(loadedValues);
      // 只依赖"换了哪条档案"，不要依赖 loadedValues 对象本身（每次 set 都是新引用会死循环）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form, current?.id, loadedValues]);

    // ---------------------------------------------------------------- 打开
    // ------------------------------------------------- A5-F：暖通六阶段状态
    const [stages, setStages] = useState([] as any[]);
    const [stagesLoading, setStagesLoading] = useState(false);
    const [stagesError, setStagesError] = useState(null as string | null);
    /** 正在提交的动作：`complete:survey` / `withdraw:pipe` / `photo:device` */
    const [stageBusy, setStageBusy] = useState('');
    const [stageMsg, setStageMsg] = useState(null as { ok: boolean; text: string } | null);
    // 每个阶段各自的输入（不要合成一个大对象：撤回原因与完成备注是两件事）
    const [stageDates, setStageDates] = useState({} as Record<string, string>);
    const [stageNotes, setStageNotes] = useState({} as Record<string, string>);
    const [stageReasons, setStageReasons] = useState({} as Record<string, string>);

    /**
     * ⚠️ `reloadPhotos` 定义在本文件**更下方**（openArchive 之后），而下面三个阶段处理函数
     *    需要它。直接写标识符会触发 TS2448（块级变量先用后声明），并被 BUILD-TS-GATE-01
     *    拦下（esbuild 只转译、照样能构建成功，所以那条门禁是唯一防线）。
     *    用 ref 间接持有：赋值发生在 reloadPhotos 定义之后，调用发生在用户交互时，不会为空。
     */
    const reloadPhotosRef = useRef(null as null | ((archiveId: number) => Promise<void>));

    const fetchStages = useCallback(
      async (archiveId: number) => {
        setStagesLoading(true);
        setStagesError(null);
        try {
          const res = await request(`svc:archiveStageList?id=${archiveId}`, 'post');
          const list = (payloadOf(res) ?? {}).stages;
          setStages(Array.isArray(list) ? list : []);
        } catch (e: any) {
          setStagesError(errorInfoOf(e).message);
          setStages([]);
        } finally {
          setStagesLoading(false);
        }
      },
      [request],
    );

    /**
     * 暖通阶段照片上传。
     *
     * 与 `before/after` 走**同一个** `svc:archivePhotoAttach`，只是多带 `stage_id`
     * （服务端据此把 `photo_type` 强制成 `stage`）。**不传 published** ——
     * 由服务端取默认 false，"上传即发布"是绝对不允许的。
     */
    const onPickStagePhoto = useCallback(
      async (stageId: number, file: any) => {
        if (!current || !file || isVoided) return;
        setStageBusy(`photo:${stageId}`);
        setStageMsg(null);
        try {
          const fd = new FormData();
          fd.append('file', file, file.name || `stage-${Date.now()}.jpg`);
          fd.append('id', String(current.id));
          fd.append('stage_id', String(stageId));
          fd.append('photo_type', 'stage');
          await uploader(
            `svc:archivePhotoAttach?id=${current.id}`,
            fd,
            newRequestId(),
          );
          // 上传后要同时刷新照片（预览）与阶段（photo_count / photo_required）
          await reloadPhotosRef.current?.(current.id);
          await fetchStages(current.id);
          setStageMsg({ ok: true, text: '照片已上传（默认未发布，客户看不到）' });
        } catch (e: any) {
          setStageMsg({ ok: false, text: errorInfoOf(e).message });
        } finally {
          setStageBusy('');
        }
      },
      [current, isVoided, uploader, fetchStages],
    );

    /** 完成某阶段：日期必填，其余交给服务端判（顺序 / 照片 / 张数） */
    const onCompleteStage = useCallback(
      async (stage: any) => {
        if (!current || isVoided || stageBusy) return;
        const code = String(stage.stage_code);
        const dateRaw = stageDates[code] ?? '';
        const parsed = parseDateOnly(dateRaw);
        if (!parsed.ok || !parsed.value) {
          setStageMsg({ ok: false, text: '请先选择该阶段的完成日期' });
          return;
        }
        setStageBusy(`complete:${code}`);
        setStageMsg(null);
        try {
          const res = await sendSvcRequest(request, {
            action: 'archiveStageComplete',
            body: {
              id: current.id,
              stage_code: code,
              stage_date: parsed.value,
              note: stageNotes[code] || null,
              // ⚠️ 这里是**阶段**的版本号，不是档案版本号
              expected_version: Number(stage.version),
            },
            requestId: newRequestId(),
          });
          const data = payloadOf(res) ?? {};
          if (data.archive?.version !== undefined) {
            versionRef.current = Number(data.archive.version);
            setVersionText(Number(data.archive.version));
          }
          if (data.archive?.status) {
            setCurrent((prev) => (prev ? ({ ...prev, status: String(data.archive.status) } as ArchiveRow) : prev));
          }
          setStageDates((prev) => ({ ...prev, [code]: '' }));
          await fetchStages(current.id);
          await reloadPhotosRef.current?.(current.id);
          setStageMsg({
            ok: true,
            text: `「${ARCHIVE_STAGE_LABEL[code] ?? code}」已完成`,
          });
        } catch (e: any) {
          setStageMsg({ ok: false, text: errorInfoOf(e).message });
        } finally {
          setStageBusy('');
        }
      },
      [current, isVoided, stageBusy, stageDates, stageNotes, request, fetchStages],
    );

    /** 撤回某阶段：必须写原因；服务端会连锁撤回后续已完成阶段并取消照片发布 */
    const onWithdrawStage = useCallback(
      async (stage: any) => {
        if (!current || isVoided || stageBusy) return;
        const code = String(stage.stage_code);
        const reason = String(stageReasons[code] ?? '').trim();
        if (!reason) {
          setStageMsg({ ok: false, text: '撤回必须填写原因' });
          return;
        }
        setStageBusy(`withdraw:${code}`);
        setStageMsg(null);
        try {
          const res = await sendSvcRequest(request, {
            action: 'archiveStageWithdraw',
            body: {
              id: current.id,
              stage_code: code,
              reason,
              expected_version: Number(stage.version),
            },
            requestId: newRequestId(),
          });
          const data = payloadOf(res) ?? {};
          if (data.archive?.version !== undefined) {
            versionRef.current = Number(data.archive.version);
            setVersionText(Number(data.archive.version));
          }
          if (data.archive?.status) {
            setCurrent((prev) => (prev ? ({ ...prev, status: String(data.archive.status) } as ArchiveRow) : prev));
          }
          setStageReasons((prev) => ({ ...prev, [code]: '' }));
          await fetchStages(current.id);
          // 撤回会把相关照片置为未发布，必须重新拉一次才能看到真实状态
          await reloadPhotosRef.current?.(current.id);
          const list = Array.isArray(data.withdrawn) ? data.withdrawn.join('、') : '';
          setStageMsg({
            ok: true,
            text: `已撤回：${list || ARCHIVE_STAGE_LABEL[code] || code}（相关照片已取消发布，内部历史保留）`,
          });
        } catch (e: any) {
          setStageMsg({ ok: false, text: errorInfoOf(e).message });
        } finally {
          setStageBusy('');
        }
      },
      [current, isVoided, stageBusy, stageReasons, request, fetchStages],
    );

    const openArchive = useCallback(
      async (id: number) => {
        setOpenLoading(true);
        setOpenError(null);
        setSaveError(null);
        setSaveOk(null);
        setConflict(false);
        setPhotosError(null);
        try {
          // ⚠️ 单值读取的**唯一正确写法**是 `filter[id]=<id>`（2026-11-10 实测）：
          //    · `serviceArchives:get?filterByTk=146` → 404「工单 146 不存在」
          //      （filterByTk 在这个资源上被当成查询条件，不是主键定位）
          //    · `serviceArchives:get:146`            → **静默返回 id=1**！
          //      最后一个路径段被当成**页码**，于是拿到第 1 页的第 1 条 —— 越权风险最高的一种错：
          //      页面看起来"打开成功了"，但展示的是**另一条档案**。
          //    · `serviceArchives:get?filter[id]=146` → 正确返回 id=146
          // 这三条都在本机实测过，别凭 NocoBase 直觉改回 `filterByTk` / `:id`。
          const res = await request('serviceArchives:get', 'get', undefined, {
            headers: { 'X-Data-Source': 'main' },
            params: { filter: { id } },
          });
          const row = payloadOf(res) as ArchiveRow & Record<string, unknown>;
          if (!row || !row.id) throw new Error('没取到档案内容');
          // 双保险：服务端若因路由/ACL 问题返回了别的行，这里必须炸而不是"静默展示错档"
          if (Number(row.id) !== Number(id)) {
            throw new Error(`取回的档案 id=${row.id} 与请求 id=${id} 不一致`);
          }

          setCurrent(row);
          versionRef.current = Number(row.version ?? 1);
          setVersionText(Number(row.version ?? 1));

          // 逐字段回填（表单里没有 archive_no / store_id，靠上方展示）
          const values: EditValues = {};
          for (const key of EDIT_FIELDS) {
            const v = (row as any)[key];
            // 🔴 `dateOnly` 两列要**归一**，不能直接 `String(v)`（DEV-217）。
            //    `String(new Date(...))` 得到的是 `'Sun Nov 15 2026 …'`，
            //    而 dateOnly 提交要求 `YYYY-MM-DD`。更要紧的是：服务端若因任何原因
            //    给出无效日期，`String(Invalid Date)` = `'Invalid date'` —— 那正是
            //    真机 500 的原字符串。解析不出就回填空，让用户重选，而不是把脏值再带回去。
            if (key === 'purchase_date' || key === 'planned_date') {
              const parsed = parseDateOnly(v);
              values[key] = parsed.ok ? (parsed.value ?? undefined) : undefined;
              continue;
            }
            values[key] = v === null || v === undefined ? undefined : String(v);
          }
          // ⚠️ 这里**只**写 state，不直接 `form.setFieldsValue()`。
          // 原因（实测踩到的）：`Form` 组件是 `current ? 渲染 : 不渲染`，
          // 上面刚 `setCurrent(row)` 时 Form **还没挂载**，此时 setFieldsValue 的值
          // 会被 antd 丢弃 —— 表现正是"打开后版本号有了、输入框全空"。
          // 正确做法：把值交给 `loadedValues`，由下面那个 useEffect 在 **Form 已挂载后**同步。
          setLoadedValues(values);

          // 已上传照片
          await reloadPhotos(id);

          // 暖通：同时拉六阶段（普通服务没有阶段，跳过）
          if (String((row as any).archive_type) === 'hvac') {
            await fetchStages(id);
          } else {
            setStages([]);
          }
        } catch (e: any) {
          setOpenError(errorInfoOf(e).message);
        } finally {
          setOpenLoading(false);
        }
      },
      // reloadPhotos 在下面定义，这里用 eslint 注释避免误报循环依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [form, request],
    );

    /**
     * 拉已上传照片，并为每张换取**受控预览**。
     *
     * 为什么不用 `/api/serviceArchivePhotos` 的某个 URL 直接当 `src`：
     *   · 服务端没有对外的静态 URL（私有目录，不进 public）；
     *   · 图片要带 token 才能取 ⇒ `<img src>` 发不了 Authorization 头。
     *   所以必须用 `archivePhotoFile` 拉字节，再转成 objectURL。
     *   这条路径本身也过了 `assertCanAccessRow`，跨店在这里被拒（要求 §四.8）。
     */
    const reloadPhotos = useCallback(
      async (archiveId: number) => {
        setPhotosLoading(true);
        setPhotosError(null);
        try {
          const res = await request(`svc:archivePhotoList?id=${archiveId}`, 'post');
          const data = payloadOf(res) ?? {};
          const list: PhotoRow[] = Array.isArray(data.photos) ? data.photos : [];

          const slots: PhotoSlot[] = [];
          for (const p of list) {
            const slot: PhotoSlot = {
              key: `srv-${p.id}`,
              photoType: (p.photo_type === 'after' ? 'after' : 'before') as 'before' | 'after',
              uploading: false,
              photo: p,
              previewUrl: null,
              error: null,
              previewLoading: true,
            };
            slots.push(slot);
          }
          setPhotos(slots);

          // 逐张换预览（失败的只标记这一张，不影响其他）
          for (const slot of slots) {
            const pid = slot.photo?.id;
            if (!pid) continue;
            try {
              const blobRes: any = await request(
                `svc:archivePhotoFile?photo_id=${pid}`,
                'post',
                undefined,
                { responseType: 'blob' },
              );
              const blob = blobRes instanceof Blob ? blobRes : blobRes?.data;
              const url = trackObjectUrl(URL.createObjectURL(blob));
              setPhotos((prev) =>
                prev.map((s) =>
                  s.key === slot.key ? { ...s, previewUrl: url, previewLoading: false } : s,
                ),
              );
            } catch (e: any) {
              setPhotos((prev) =>
                prev.map((s) =>
                  s.key === slot.key
                    ? { ...s, previewLoading: false, error: errorInfoOf(e).message }
                    : s,
                ),
              );
            }
          }
        } catch (e: any) {
          setPhotosError(errorInfoOf(e).message);
        } finally {
          setPhotosLoading(false);
        }
      },
      [request, trackObjectUrl],
    );

    // 把 reloadPhotos 交给上面那几个"先声明、后使用"的阶段处理函数（见 reloadPhotosRef 注释）
    useEffect(() => {
      reloadPhotosRef.current = reloadPhotos;
    }, [reloadPhotos]);

    // ---------------------------------------------------------------- 保存
    const onSave = useCallback(async () => {
      if (!current || saving || isVoided) return;

      let values: EditValues;
      try {
        values = await form.validateFields();
      } catch {
        // 前端校验失败：AntD 已在字段下标红，**不动**用户内容
        return;
      }

      setSaving(true);
      setSaveError(null);
      setSaveOk(null);
      setConflict(false);

      // 只提交白名单字段。**构造规则集中在 `buildUpdateBody`**（纯函数，可单测）：
      //   · 未注册进表单的字段（`undefined`）⇒ 不提交，服务端保持原值；
      //   · `dateOnly` 两列 ⇒ 过 `parseDateOnly`，坏值当场拦下（不把 500 留给用户）；
      //   · 文本 `''` ⇒ null（用户主动清空）。
      // ⚠️ 千万别再退回"`v === undefined || v === '' ? null : v`"那种写法：
      //    `EDIT_FIELDS` 里 `purchase_date` / `package_description` / `assigned_worker`
      //    这三列**没有渲染**，`validateFields()` 返回 undefined，写成 null 就等于
      //    把 `purchase_date` **每保存一次清空一次**（DEV-218，E2E 变异已证明）。
      //    另两列是服务端 `str()` 把 null 当"没传"才侥幸没丢 —— 不该依赖这种宽容。
      const built = buildUpdateBody(values as unknown as Record<string, unknown>);
      if (!built.ok) {
        setSaveError(String(built.message ?? '日期格式不正确，请重新选择后再保存'));
        setSaving(false);
        return;
      }
      const body: Record<string, unknown> = { id: current.id, ...(built.body ?? {}) };
      // 🔴 乐观锁：必须带，且是**服务端给的**版本号
      body.expected_version = versionRef.current;

      try {
        const res = await sendSvcRequest(request, {
          action: 'archiveUpdate',
          body,
          requestId: newRequestId(),
        });
        const data = payloadOf(res) ?? {};
        const row = data.archive ?? {};

        // ⑤ 用**服务端返回的**新版本更新本地版本号
        if (row.version !== undefined && row.version !== null) {
          versionRef.current = Number(row.version);
          setVersionText(Number(row.version));
        }
        // 同步本地视图（只同步版本与状态，不回填表单 —— 那会打断用户后续输入）
        setCurrent((prev) =>
          prev
            ? {
                ...prev,
                version: Number(row.version ?? prev.version),
                status: String(row.status ?? prev.status),
                visibility: String(row.visibility ?? prev.visibility),
              }
            : prev,
        );
        setSaveOk(`已保存（版本 ${row.version ?? '?'}）`);
      } catch (e: any) {
        const info = errorInfoOf(e);
        if (info.status === 409) {
          // ⑥ 冲突：**保留用户修改内容**，只报告，不覆盖
          setConflict(true);
          setSaveError(
            `${ERR_TOAST.conflict}${info.code ? `（${info.code}）` : ''}`,
          );
        } else if (info.status === 403) {
          setSaveError(`${ERR_TOAST.forbidden}（${info.message}）`);
        } else {
          setSaveError(info.message);
        }
        // ⚠️ 注意这里**没有任何** form.resetFields()/setFieldsValue()
        //    —— 那是"静默覆盖用户输入"，被用户 §三.6 明确禁止。
      } finally {
        setSaving(false);
      }
    }, [current, form, isVoided, request, saving]);

    /** 冲突后的显式动作：由**人**按下去才重新载入（放弃自己的修改要人决定） */
    const reloadLatest = useCallback(async () => {
      if (!current) return;
      await openArchive(current.id);
    }, [current, openArchive]);

    // ---------------------------------------------------------------- 拍照
    const onPickPhoto = useCallback(
      async (photoType: 'before' | 'after', file: any) => {
        if (!current || !file || isVoided) return;

        // 本地立刻预览（要求 §四.2）：此时还没有服务端 id
        const localUrl = trackObjectUrl(URL.createObjectURL(file));
        const key = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setPhotos((prev) => [
          ...prev,
          {
            key,
            photoType,
            uploading: true,
            photo: null,
            previewUrl: localUrl,
            error: null,
            previewLoading: false,
          },
        ]);

        try {
          const fd = new FormData();
          // 字段名必须是 file（服务端 readSingleUpload 的口径）
          fd.append('file', file, file.name || `photo-${Date.now()}.jpg`);
          fd.append('id', String(current.id));
          fd.append('photo_type', photoType);
          // ④ 刻意**不传 published**：由服务端取默认 false，客户端不帮忙发布

          const requestId = newRequestId();
          const res = await uploader(`svc:archivePhotoAttach?id=${current.id}`, fd, requestId);
          const data = payloadOf(res) ?? {};
          const photo = data.photo as PhotoRow | undefined;
          if (!photo?.id) throw new Error('服务端未返回照片编号');

          // 成功后：用**服务端字节**替换本地 blob 预览，确保"看到的"就是"存下来的"
          let serverUrl: string | null = null;
          try {
            const blobRes: any = await request(
              `svc:archivePhotoFile?photo_id=${photo.id}`,
              'post',
              undefined,
              { responseType: 'blob' },
            );
            const blob = blobRes instanceof Blob ? blobRes : blobRes?.data;
            serverUrl = trackObjectUrl(URL.createObjectURL(blob));
          } catch {
            // 回读失败不算上传失败：照片已经存下来了，预览先留本地图
            serverUrl = localUrl;
          }

          if (serverUrl && serverUrl !== localUrl) revokeOne(localUrl);

          setPhotos((prev) =>
            prev.map((s) =>
              s.key === key
                ? {
                    ...s,
                    uploading: false,
                    photo,
                    previewUrl: serverUrl,
                    previewLoading: false,
                    error: null,
                  }
                : s,
            ),
          );
        } catch (e: any) {
          // ③ 失败只标记**这一张**：不动表单、不动其他已上传照片
          const info = errorInfoOf(e);
          setPhotos((prev) =>
            prev.map((s) =>
              s.key === key
                ? { ...s, uploading: false, error: info.message || '上传失败' }
                : s,
            ),
          );
        }
      },
      [current, isVoided, request, revokeOne, trackObjectUrl, uploader],
    );

    const removeLocal = useCallback(
      (slot: PhotoSlot) => {
        if (slot.previewUrl) revokeOne(slot.previewUrl);
        setPhotos((prev) => prev.filter((s) => s.key !== slot.key));
      },
      [revokeOne],
    );

    // ------------------------------------------------- A5-E：完工 / 发布
    /**
     * 标记完成。
     *
     * ⚠️ 前端**不判断**"照片齐了没有"：`completing` 只负责防连点，
     *    真正的闸门在 `archives.complete()`（查 photo 表）。这里如果自己判一遍，
     *    就会出现"前端认为不能提交 / 后端认为能"的两套口径。
     *    唯一在这儿拦的是"日期没选"——那是输入问题，服务端也会拒（MISSING_COMPLETED_AT）。
     */
    const onComplete = useCallback(async () => {
      if (!current || completing || isVoided || isCompleted) return;
      const parsed = parseDateOnly(completeDate);
      if (!parsed.ok || !parsed.value) {
        setCompleteError('请先选择实际完成日期');
        setCompleteOk(null);
        return;
      }
      setCompleting(true);
      setCompleteError(null);
      setCompleteOk(null);
      try {
        const res = await sendSvcRequest(request, {
          action: 'archiveComplete',
          body: {
            id: current.id,
            completed_at: parsed.value,
            expected_version: versionRef.current,
          },
          requestId: newRequestId(),
        });
        const row = (payloadOf(res) ?? {}).archive ?? {};
        if (row.version !== undefined && row.version !== null) {
          versionRef.current = Number(row.version);
          setVersionText(Number(row.version));
        }
        setCurrent((prev) =>
          prev ? ({ ...prev, status: String(row.status ?? 'completed') } as ArchiveRow) : prev,
        );
        setCompleteDate('');
        setCompleteOk('已标记完成。完工不会自动发布档案或照片 —— 需要发布请在下方单独操作。');
      } catch (e: any) {
        setCompleteError(errorInfoOf(e).message);
      } finally {
        setCompleting(false);
      }
    }, [current, completing, isVoided, isCompleted, completeDate, request]);

    /** 发布档案（只改 visibility，不动 status；未完工也能发布） */
    const onPublishArchive = useCallback(async () => {
      if (!current || publishingArchive || isVoided) return;
      setPublishingArchive(true);
      setPublishError(null);
      setPublishOk(null);
      try {
        const res = await sendSvcRequest(request, {
          action: 'archivePublish',
          body: { id: current.id, expected_version: versionRef.current },
          requestId: newRequestId(),
        });
        const row = (payloadOf(res) ?? {}).archive ?? {};
        if (row.version !== undefined && row.version !== null) {
          versionRef.current = Number(row.version);
          setVersionText(Number(row.version));
        }
        setCurrent((prev) =>
          prev ? ({ ...prev, visibility: String(row.visibility ?? 'published') } as ArchiveRow) : prev,
        );
        setPublishOk('档案已发布。照片仍需逐张发布，客户才能看到。');
      } catch (e: any) {
        setPublishError(errorInfoOf(e).message);
      } finally {
        setPublishingArchive(false);
      }
    }, [current, publishingArchive, isVoided, request]);

    /** 单张照片发布 / 取消发布 */
    const onTogglePhotoPublish = useCallback(
      async (photoId: number, next: boolean) => {
        if (!photoId || photoBusy !== 0) return;
        setPhotoBusy(photoId);
        setPublishError(null);
        setPublishOk(null);
        try {
          await sendSvcRequest(request, {
            action: 'archivePhotoPublish',
            body: { photo_id: photoId, published: next },
            requestId: newRequestId(),
          });
          // 只改这一张的本地状态；照片发布不推进档案 version，所以不动 versionRef
          setPhotos((prev) =>
            prev.map((s) =>
              s.photo && s.photo.id === photoId
                ? { ...s, photo: { ...s.photo, published: next } }
                : s,
            ),
          );
          setPublishOk(next ? '照片已发布，客户现在可以看到这张。' : '照片已取消发布。');
        } catch (e: any) {
          setPublishError(errorInfoOf(e).message);
        } finally {
          setPhotoBusy(0);
        }
      },
      [photoBusy, request],
    );

    /** 已上传到服务端的照片（发布管理只认这些；本地还在传的不算） */
    const publishedPhotos = photos
      .map((s) => s.photo)
      // 暖通阶段照片（stage_id 有值）在**阶段卡片里**发布，这里只列 before/after，
      // 避免同一条照片出现两个发布入口（两处状态还可能不同步）
      .filter((p): p is PhotoRow => !!p && (p.stage_id === null || p.stage_id === undefined));

    // 换门店筛选要回到第 1 页：否则第 3 页 + 新门店（只有 1 页）会显示空列表
    useEffect(() => {
      setListPage(1);
    }, [storeFilter]);

    // ---------------------------------------------------------------- 渲染
    /**
     * 暖通六阶段列表（A5-F）。
     *
     * 三条纪律，全部落到"不做客户端业务判断"：
     *   ① **顺序 / 照片 / 张数**都由 `archives.completeStage()` 判。
     *      这里只在"前一阶段没完成"时把按钮置灰（体验），即便绕过也拦得住。
     *   ② 撤回原因必填，但"必填"只是少了这句就没法提交；连锁撤回哪些阶段、
     *      照片怎么取消发布，**完全以服务端返回的 `withdrawn` 为准**。
     *   ③ 重新完成后**不自动重新发布**旧照片：照片的 published 只有用户显式点
     *      「发布」才会变（`archivePhotoPublish`），阶段完成接口不碰它。
     */
    const renderStages = () => {
      if (stagesLoading && stages.length === 0) {
        return [React.createElement(Spin, { key: 'stage-loading', size: 'small' })];
      }
      if (stagesError) {
        return [
          React.createElement(Alert, {
            key: 'stage-error',
            type: 'error',
            showIcon: true,
            message: '阶段加载失败',
            description: stagesError,
            'data-testid': 'arc-stages-error',
          }),
        ];
      }
      if (stages.length === 0) {
        return [
          React.createElement(
            'div',
            { key: 'stage-empty', style: { fontSize: 12, color: '#8c8c8c' } },
            '该档案还没有阶段记录。',
          ),
        ];
      }

      // 「当前阶段」= 第一个还没完成的阶段（已撤回的也算未完成，允许重做）
      const currentCode = (() => {
        for (const st of stages) if (String(st.status) !== 'done') return String(st.stage_code);
        return null;
      })();

      return stages.map((st: any, i: number) => {
        const code = String(st.stage_code);
        const status = String(st.status);
        const isDone = status === 'done';
        const isWithdrawn = status === 'withdrawn';
        const isCurrent = code === currentCode;
        const mine = photos
          .map((s) => s.photo)
          .filter((p): p is PhotoRow => !!p && Number(p.stage_id) === Number(st.id));
        const count = mine.length;
        const max = Number(st.photo_max ?? 6);
        const atLimit = count >= max;
        const busy = stageBusy !== '' && stageBusy.endsWith(code);
        const previewOf = (pid: number) => {
          const slot = photos.find((s) => s.photo && s.photo.id === pid);
          return slot?.previewUrl ?? null;
        };

        return React.createElement(
          'div',
          {
            key: `stage-${code}`,
            'data-testid': `arc-stage-${code}`,
            style: {
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              padding: 10,
              marginTop: 10,
              background: isCurrent ? '#fafcff' : '#fff',
            },
          },
          // ---- 标题行 ----
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement(
              'span',
              { style: { fontSize: 14, fontWeight: 600 } },
              `${i + 1}. ${ARCHIVE_STAGE_LABEL[code] ?? code}`,
            ),
            React.createElement(
              Tag,
              {
                color: isDone ? 'green' : isWithdrawn ? 'orange' : 'default',
                'data-testid': `arc-stage-status-${code}`,
              },
              (ARCHIVE_STAGE_STATUS_LABEL as any)[status] ?? status,
            ),
            st.photo_required
              ? React.createElement(Tag, { color: 'blue' }, '必拍')
              : React.createElement(Tag, null, '照片可选'),
            React.createElement('span', { style: { fontSize: 12, color: '#8c8c8c' } }, `照片 ${count}/${max}`),
          ),

          // ---- 已保存的日期 / 备注 / 撤回原因 ----
          isDone
            ? React.createElement(
                'div',
                {
                  'data-testid': `arc-stage-date-view-${code}`,
                  style: { fontSize: 12, color: '#595959', marginTop: 6, lineHeight: 1.8 },
                },
                `完成日期：${String(st.stage_date ?? '—')}`,
                st.note ? `　备注：${String(st.note)}` : '',
              )
            : null,
          isWithdrawn && st.withdraw_reason
            ? React.createElement(
                'div',
                {
                  'data-testid': `arc-stage-reason-${code}`,
                  style: { fontSize: 12, color: '#d46b08', marginTop: 6 },
                },
                `撤回原因：${String(st.withdraw_reason)}`,
              )
            : null,

          // ---- 阶段照片（撤回后仍在，标签显示未发布；内部历史）----
          mine.length > 0
            ? React.createElement(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
                mine.map((p) =>
                  React.createElement(
                    'div',
                    {
                      key: `sp-${p.id}`,
                      'data-testid': `arc-stage-photo-${p.id}`,
                      style: { width: 78, textAlign: 'center' },
                    },
                    previewOf(p.id)
                      ? React.createElement('img', {
                          src: previewOf(p.id),
                          alt: '阶段照片',
                          style: {
                            width: 78,
                            height: 78,
                            objectFit: 'cover',
                            borderRadius: 6,
                            border: '1px solid #f0f0f0',
                          },
                        })
                      : React.createElement('div', {
                          style: {
                            width: 78,
                            height: 78,
                            borderRadius: 6,
                            background: '#fafafa',
                            border: '1px dashed #e8e8e8',
                          },
                        }),
                    React.createElement(
                      Tag,
                      {
                        color: p.published ? 'green' : 'default',
                        style: { marginTop: 4, marginRight: 0, fontSize: 11 },
                        'data-testid': `arc-stage-photo-state-${p.id}`,
                      },
                      p.published ? '已发布' : '未发布',
                    ),
                    // 只读角色（负责人 / 总部）能**看到**发布状态，但没有发布入口
                    canWrite
                      ? React.createElement(
                          Button,
                          {
                            size: 'small',
                            type: 'link',
                            style: { padding: 0, height: 20, fontSize: 12 },
                            loading: photoBusy === p.id,
                            disabled: isVoided || (photoBusy !== 0 && photoBusy !== p.id),
                            onClick: () => void onTogglePhotoPublish(p.id, !p.published),
                            'data-testid': `arc-stage-photo-publish-${p.id}`,
                          },
                          p.published ? '取消发布' : '发布',
                        )
                      : null,
                  ),
                ),
              )
            : null,

          // ---- 当前阶段：上传 + 完成 ----
          isCurrent && !isVoided && canWrite
            ? React.createElement(
                'div',
                { style: { marginTop: 10, borderTop: '1px dashed #f0f0f0', paddingTop: 10 } },
                React.createElement(
                  'label',
                  {
                    'data-testid': `arc-stage-pick-${code}`,
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      border: atLimit ? '1px dashed #d9d9d9' : '1px dashed #91caff',
                      borderRadius: 6,
                      fontSize: 13,
                      color: atLimit ? '#bfbfbf' : '#1677ff',
                      cursor: atLimit ? 'not-allowed' : 'pointer',
                      background: '#fafafa',
                    },
                  },
                  React.createElement('span', null, atLimit ? `已达上限 ${max} 张` : '＋ 上传阶段照片'),
                  React.createElement('input', {
                    type: 'file',
                    accept: 'image/*',
                    capture: 'environment',
                    disabled: atLimit || stageBusy !== '',
                    style: { display: 'none' },
                    onChange: (ev: any) => {
                      const f = ev?.target?.files?.[0];
                      void onPickStagePhoto(Number(st.id), f);
                      if (ev?.target) ev.target.value = '';
                    },
                  }),
                ),
                React.createElement(DateOnlyInput, {
                  testId: `arc-stage-date-${code}`,
                  value: stageDates[code] ?? '',
                  onChange: (v: string) => setStageDates((prev) => ({ ...prev, [code]: v })),
                  disabled: stageBusy !== '',
                }),
                React.createElement(Input.TextArea, {
                  placeholder: '阶段备注（选填）',
                  autoSize: { minRows: 2, maxRows: 3 },
                  maxLength: 300,
                  value: stageNotes[code] ?? '',
                  disabled: stageBusy !== '',
                  onChange: (e: any) => setStageNotes((prev) => ({ ...prev, [code]: e.target.value })),
                  style: { marginTop: 8 },
                  'data-testid': `arc-stage-note-${code}`,
                }),
                React.createElement(
                  Button,
                  {
                    type: 'primary',
                    style: { marginTop: 8 },
                    loading: busy && stageBusy.startsWith('complete'),
                    disabled: stageBusy !== '' && !(busy && stageBusy.startsWith('complete')),
                    onClick: () => void onCompleteStage(st),
                    'data-testid': `arc-stage-complete-${code}`,
                  },
                  '完成本阶段',
                ),
                st.photo_required && count === 0
                  ? React.createElement(
                      'span',
                      { style: { marginLeft: 10, fontSize: 12, color: '#d46b08' } },
                      '该阶段必须先上传至少 1 张照片',
                    )
                  : null,
              )
            : null,

          // ---- 已完成阶段：撤回（原因必填）----
          isDone && !isVoided && canWrite
            ? React.createElement(
                'div',
                { style: { marginTop: 10, borderTop: '1px dashed #f0f0f0', paddingTop: 10 } },
                React.createElement(Input.TextArea, {
                  placeholder: '撤回原因（必填，会写进审计）',
                  autoSize: { minRows: 2, maxRows: 3 },
                  maxLength: 300,
                  value: stageReasons[code] ?? '',
                  disabled: stageBusy !== '',
                  onChange: (e: any) => setStageReasons((prev) => ({ ...prev, [code]: e.target.value })),
                  'data-testid': `arc-stage-reason-input-${code}`,
                }),
                React.createElement(
                  Button,
                  {
                    danger: true,
                    style: { marginTop: 8 },
                    loading: busy && stageBusy.startsWith('withdraw'),
                    disabled: stageBusy !== '' && !(busy && stageBusy.startsWith('withdraw')),
                    onClick: () => void onWithdrawStage(st),
                    'data-testid': `arc-stage-withdraw-${code}`,
                  },
                  '撤回本阶段',
                ),
                React.createElement(
                  'div',
                  { style: { marginTop: 6, fontSize: 12, color: '#8c8c8c' } },
                  '撤回会连带撤回其后的已完成阶段，并把这些阶段的照片取消发布（内部历史保留）。',
                ),
              )
            : null,
        );
      });
    };

    const renderPicker = (photoType: 'before' | 'after', label: string) =>
      React.createElement(
        'label',
        {
          'data-testid': `arc-photo-pick-${photoType}`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            marginRight: 10,
            marginBottom: 8,
            border: '1px dashed #d9d9d9',
            borderRadius: 6,
            fontSize: 13,
            color: isVoided ? '#bfbfbf' : '#1677ff',
            cursor: isVoided ? 'not-allowed' : 'pointer',
            background: '#fafafa',
          },
        },
        React.createElement('span', null, `＋ ${label}`),
        React.createElement('input', {
          type: 'file',
          // accept + capture：手机上直接调用摄像头；桌面端退化为选文件
          accept: 'image/*',
          capture: 'environment',
          disabled: isVoided,
          style: { display: 'none' },
          onChange: (ev: any) => {
            const f = ev?.target?.files?.[0];
            void onPickPhoto(photoType, f);
            // 清空 value，否则同一张图连选两次不触发 change
            if (ev?.target) ev.target.value = '';
          },
        }),
      );

    const renderPhotoList = () => {
      if (photosLoading) {
        return React.createElement(
          'div',
          { style: { padding: '12px 0' } },
          React.createElement(Spin, { size: 'small' }),
          React.createElement('span', { style: { marginLeft: 8, fontSize: 13, color: '#8c8c8c' } }, '正在载入照片…'),
        );
      }
      if (photos.length === 0) {
        return React.createElement('div', {
          style: { padding: '10px 0', fontSize: 13, color: '#8c8c8c' },
          'data-testid': 'arc-photo-empty',
        }, '还没有照片。服务前、服务后各拍一张。');
      }
      return React.createElement(
        'div',
        {
          'data-testid': 'arc-photo-list',
          style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 },
        },
        ...photos.map((slot) =>
          React.createElement(
            'div',
            {
              key: slot.key,
              'data-testid': `arc-photo-card-${slot.photoType}`,
              'data-photo-id': slot.photo?.id ?? '',
              style: {
                width: 118,
                border: '1px solid #eee',
                borderRadius: 8,
                padding: 6,
                background: '#fff',
                boxSizing: 'border-box',
              },
            },
            React.createElement(
              'div',
              {
                style: {
                  width: '100%',
                  height: 86,
                  background: '#f5f5f5',
                  borderRadius: 6,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              },
              slot.previewLoading
                ? React.createElement(Spin, { size: 'small' })
                : slot.previewUrl
                  ? React.createElement('img', {
                      src: slot.previewUrl,
                      alt: `${slot.photoType} 照片`,
                      'data-testid': `arc-photo-img-${slot.photoType}`,
                      style: { width: '100%', height: '100%', objectFit: 'cover' },
                    })
                  : React.createElement('span', { style: { fontSize: 12, color: '#bfbfbf' } }, '无预览'),
            ),
            React.createElement(
              'div',
              { style: { marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' } },
              React.createElement(
                Tag,
                { color: slot.photoType === 'before' ? 'blue' : 'green', style: { marginInlineEnd: 0 } },
                slot.photoType === 'before' ? '服务前' : '服务后',
              ),
              slot.uploading
                ? React.createElement(Tag, { color: 'processing', style: { marginInlineEnd: 0 } }, '上传中')
                : null,
              slot.photo
                ? React.createElement(
                    Tag,
                    { color: slot.photo.published ? 'green' : 'default', style: { marginInlineEnd: 0 } },
                    slot.photo.published ? '已发布' : '未发布',
                  )
                : null,
            ),
            // ③ 单张失败只在这一张上报告
            slot.error
              ? React.createElement(
                  'div',
                  {
                    'data-testid': `arc-photo-err-${slot.photoType}`,
                    style: { marginTop: 4, fontSize: 11, color: '#cf1322', lineHeight: 1.5 },
                  },
                  slot.error,
                )
              : null,
            !slot.photo && !slot.uploading
              ? React.createElement(
                  Button,
                  {
                    size: 'small',
                    type: 'link',
                    danger: true,
                    style: { padding: 0, fontSize: 11 },
                    onClick: () => removeLocal(slot),
                  },
                  '移除',
                )
              : null,
          ),
        ),
      );
    };

    // ---- 列表态 ----
    if (!current) {
      return React.createElement(
        'div',
        { 'data-testid': 'arc-edit-list', style: { maxWidth: 560 } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          React.createElement(
            'div',
            { style: { fontSize: 15, fontWeight: 600 }, 'data-testid': 'arc-list-title' },
            // 只读角色的标题要写明范围：负责人是"本店"，总部是"全部门店"
            isHqViewer ? '服务档案（全部门店）' : canWrite ? '本店服务档案' : '本店服务档案（只读）',
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            // A5-G：总部门店筛选。门店角色不渲染 —— 他只有一个门店，给了也没意义。
            isHqViewer
              ? React.createElement(Select, {
                  'data-testid': 'arc-store-filter',
                  size: 'small',
                  style: { minWidth: 150 },
                  value: storeFilter || '',
                  onChange: (v: string) => setStoreFilter(String(v ?? "")),
                  options: [
                    { value: '', label: '全部门店' },
                    ...storeChoices.map((sc) => ({ value: String(sc.id), label: sc.name })),
                  ],
                })
              : null,
            React.createElement(Button, { size: 'small', onClick: () => void loadList(), loading: listLoading }, '刷新'),
          ),
        ),

        // ---- A6：分页条 ----
        // 只在多页时显示；单页还挂一排按钮会让人以为有更多数据。
        React.createElement(
          'div',
          {
            'data-testid': 'arc-list-pager',
            style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: 12, color: '#8c8c8c' },
          },
          React.createElement(
            'span',
            { 'data-testid': 'arc-list-pageinfo' },
            `共 ${listTotal} 条 · 第 ${listPage} / ${listTotalPage} 页`,
          ),
          React.createElement(
            Button,
            {
              size: 'small',
              disabled: listPage <= 1 || listLoading,
              onClick: () => setListPage((v) => Math.max(1, v - 1)),
              'data-testid': 'arc-list-prev',
            },
            '上一页',
          ),
          React.createElement(
            Button,
            {
              size: 'small',
              disabled: listPage >= listTotalPage || listLoading,
              onClick: () => setListPage((v) => Math.min(listTotalPage, v + 1)),
              'data-testid': 'arc-list-next',
            },
            '下一页',
          ),
        ),
        listError
          ? React.createElement(Alert, {
              type: 'error',
              showIcon: true,
              message: '列表加载失败',
              description: listError,
              style: { marginBottom: 10 },
            })
          : null,
        rows.length === 0 && !listLoading
          ? React.createElement(Empty, {
              // 总部筛选的是"某一家门店"，写"本店"会让人以为是总部自己的店
              description: isHqViewer ? '该门店还没有档案' : '本店还没有档案',
              image: Empty.PRESENTED_IMAGE_SIMPLE,
            })
          : React.createElement(
              // ⚠️ 这里刻意用普通 div 而不是 antd 的 `List`。
              //    本仓库有一条"宿主包具名导入白名单"门禁（DEV-147 的产物）：
              //    只有**核实过确实存在**的 antd 成员才能导入。`List` 没登记过，
              //    门禁会红。可以塞进白名单让它变绿，但那是把"已核实"改成谎话 ——
              //    真正诚实的做法是**根本不依赖那个成员**：列表只是几行文本 +
              //    一个按钮，原生元素完全够用，还少一层不需要的组件开销。
              'div',
              { 'data-testid': 'arc-edit-rows' },
              listLoading
                ? React.createElement(
                    'div',
                    { style: { padding: '16px 0', textAlign: 'center' } },
                    React.createElement(Spin, { size: 'small' }),
                  )
                : null,
              ...rows.map((item) =>
                React.createElement(
                  'div',
                  {
                    key: item.id,
                    'data-testid': `arc-edit-row-${item.id}`,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 12px',
                      border: '1px solid #f0f0f0',
                      borderRadius: 8,
                      marginBottom: 8,
                      background: '#fff',
                    },
                  },
                  React.createElement(
                    'div',
                    { style: { flex: 1, minWidth: 0, lineHeight: 1.7 } },
                    React.createElement(
                      'div',
                      { style: { fontSize: 14, fontWeight: 500 } },
                      `${item.archive_no} · ${item.customer_name}`,
                    ),
                    React.createElement(
                      'div',
                      { style: { fontSize: 12, color: '#8c8c8c' } },
                      `门店 ${item.store_id} · v${item.version} · ${item.status}`,
                      item.visibility === 'voided'
                        ? React.createElement(Tag, { color: 'red', style: { marginLeft: 6 } }, '已作废')
                        : item.visibility === 'draft'
                          ? React.createElement(Tag, { color: 'orange', style: { marginLeft: 6 } }, '草稿')
                          : null,
                    ),
                  ),
                  React.createElement(
                    Button,
                    {
                      size: 'small',
                      type: 'link',
                      'data-testid': `arc-edit-open-${item.id}`,
                      onClick: () => void openArchive(item.id),
                    },
                    '打开',
                  ),
                ),
              ),
            ),
      );
    }

    // ---- 详情/编辑态 ----
    return React.createElement(
      'div',
      { 'data-testid': 'arc-edit-detail', style: { maxWidth: 560 } },
      // 顶部：编号 + 版本 + 状态 + 返回
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
        React.createElement(
          'div',
          { 'data-testid': 'arc-edit-no', style: { fontSize: 17, fontWeight: 600 } },
          current.archive_no,
        ),
        React.createElement(
          Tag,
          { 'data-testid': 'arc-edit-version', color: 'blue' },
          `版本 v${versionText}`,
        ),
        React.createElement(Tag, null, `门店 ${current.store_id}`),
        isVoided ? React.createElement(Tag, { color: 'red' }, '已作废') : null,
        React.createElement(
          Button,
          {
            size: 'small',
            type: 'link',
            style: { marginLeft: 'auto' },
            onClick: () => {
              // 返回列表：清掉详情态与预览 URL（避免长会话累积）
              revokeAll();
              setCurrent(null);
              setLoadedValues(null);
              setPhotos([]);
              setSaveError(null);
              setSaveOk(null);
              setConflict(false);
              void loadList();
            },
          },
          '← 返回列表',
        ),
      ),

      openLoading ? React.createElement(Spin, null) : null,
      openError
        ? React.createElement(Alert, {
            type: 'error',
            showIcon: true,
            message: '打开失败',
            description: openError,
            style: { marginBottom: 10 },
          })
        : null,

      saveError
        ? React.createElement(Alert, {
            'data-testid': 'arc-edit-error',
            type: 'error',
            showIcon: true,
            // 标题要让人**立刻知道这次没存上**；"数据已被其他操作更新"只说清原因，
            // 没说结果，用户会以为已经保存、只是有提示。
            message: conflict ? '本次修改未保存（数据已更新）' : '保存失败',
            description: saveError,
            style: { marginBottom: 10 },
            action: conflict
              ? React.createElement(
                  Button,
                  { size: 'small', onClick: () => void reloadLatest() },
                  '重新载入最新内容',
                )
              : undefined,
          })
        : null,
      saveOk
        ? React.createElement(Alert, {
            'data-testid': 'arc-edit-ok',
            type: 'success',
            showIcon: true,
            message: saveOk,
            style: { marginBottom: 10 },
          })
        : null,
      isVoided
        ? React.createElement(Alert, {
            'data-testid': 'arc-edit-voided',
            type: 'warning',
            showIcon: true,
            message: '档案已作废，不能修改',
            style: { marginBottom: 10 },
          })
        : null,

      // 表单：显示的是**服务端已保存的真实字段**
      //
      // ⚠️ 「打开后输入框全空」这个缺陷的最终修法，核心是**不要过早渲染 Form**。
      //    antd 的 `initialValues` **只在 Form 首次 mount 时读一次**。此前的问题是：
      //    `setCurrent(row)` 一到就渲染 Form，那一刻 `loadedValues` 还是 null ⇒
      //    initialValues={} 被吃掉；后面 `setFieldsValue` 又赶上 Form 刚 mount 的
      //    空窗期，实测要等十几秒才偶尔成功（表现成"有时有值有时没有"）。
      //    现在：**没有 loadedValues 就只渲染一个 Spin，Form 压根不 mount**。
      //    这样 Form 首次挂载时 initialValues 必然就位，一次成型。
      loadedValues
        ? React.createElement(
            Form,
            {
              form,
              layout: 'vertical',
              // 只读角色（负责人 / 总部 / viewer）整表禁用：本来就没有保存入口，
              // 但"看起来能编辑"会让人以为改了会生效（A5-G）
              disabled: isVoided || saving || !canWrite,
              key: `arc-edit-form-${current.id}`,
              initialValues: loadedValues,
              'data-testid': 'arc-edit-form',
            },
            React.createElement(
          Form.Item,
          {
            name: 'customer_name',
            label: '客户姓名',
            rules: [{ required: true, whitespace: true, message: '请填写客户姓名' }],
          },
          React.createElement(Input, { maxLength: 40 }),
        ),
        React.createElement(
          Form.Item,
          {
            name: 'customer_mobile',
            label: '客户手机号',
            rules: [
              { required: true, message: '请填写客户手机号' },
              { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确（11 位）' },
            ],
          },
          React.createElement(Input, { maxLength: 11, inputMode: 'numeric' }),
        ),
        React.createElement(
          Form.Item,
          {
            name: 'service_address',
            label: '服务地址',
            rules: [{ required: true, whitespace: true, message: '请填写服务地址' }],
          },
          React.createElement(Input.TextArea, { autoSize: { minRows: 2, maxRows: 4 }, maxLength: 200 }),
        ),
        React.createElement(
          Form.Item,
          { name: 'service_type', label: '服务类型' },
          React.createElement(
            Select,
            {
              // 🔴 必填字段**不给清除入口**（B-32 规则③）。
              //    原来这里 `allowClear: true`，而 antd Select 被清空时给的是 `undefined`
              //    而不是 `''` —— 提交体构造把 `undefined` 当"没提交"跳过，
              //    于是一次"清空服务类型"保存会**静默无事发生**，用户以为存上了。
              //    干脆不提供这个入口：要么是某个服务类型，要么保持原值。
              //    ⚠️ 没加前端 required 规则：库里有 8 条历史档案 `service_type` 为空
              //    （2026-11-11 核对），加规则会让这 8 条连"改备注"都存不了。
              //    必填由服务端 400 `FIELD_REQUIRED` 兜底（API 直连也拦得住）。
              placeholder: '请选择',
              options: Object.values(ARCHIVE_SERVICE_TYPE).map((v) => ({
                value: v,
                label: (ARCHIVE_SERVICE_TYPE_LABEL as any)[v] ?? v,
              })),
            },
          ),
        ),
        React.createElement(
          Form.Item,
          { name: 'product_description', label: '产品描述' },
          React.createElement(Input.TextArea, { autoSize: { minRows: 2, maxRows: 4 }, maxLength: 300 }),
        ),
        React.createElement(
          Form.Item,
          { name: 'planned_date', label: '计划上门日期（选填）' },
          // 与提交页**同一个**日期选择器（DEV-218）。不要退回文本框：
          // 编辑页是"同一个坑的第二条腿"，文本框在这里同样要求用户记格式。
          React.createElement(DateOnlyInput, { testId: 'arc-edit-planned-date' }),
        ),
        React.createElement(
          Form.Item,
          { name: 'notes', label: '内部备注' },
          React.createElement(Input.TextArea, { autoSize: { minRows: 2, maxRows: 4 }, maxLength: 300 }),
        ),
        React.createElement(
          Form.Item,
          { name: 'public_note', label: '客户可见说明' },
          React.createElement(Input.TextArea, { autoSize: { minRows: 2, maxRows: 4 }, maxLength: 300 }),
        ),
        isVoided || !canWrite
          ? null
          : React.createElement(
              Space,
              { style: { marginTop: 4 } },
              React.createElement(
                Button,
                {
                  type: 'primary',
                  loading: saving,
                  onClick: () => void onSave(),
                  'data-testid': 'arc-edit-save',
                },
                saving ? '保存中…' : '保存',
              ),
            ),
          )
        : React.createElement(
            // 字段还没到：只给一个中性 loading，**不要**渲染空表单
            // （空表单一旦 mount，antd 就锁定了 initialValues={}，后面再补值很难生效）
            'div',
            { 'data-testid': 'arc-edit-form-loading', style: { padding: '16px 0' } },
            React.createElement(Spin, { size: 'small' }),
            React.createElement(
              'span',
              { style: { marginLeft: 8, color: '#8c8c8c', fontSize: 13 } },
              '正在载入已保存内容…',
            ),
          ),

      // ---- 照片区（仅普通上门服务；暖通照片挂在各自的阶段里）----
      isHvac ? null : React.createElement(
        'div',
        { style: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '现场照片'),
        React.createElement(
          'div',
          { style: { fontSize: 12, color: '#8c8c8c', marginBottom: 10, lineHeight: 1.7 } },
          '服务前、服务后各拍一张。上传后默认**不发布**，客户看不到；发布由后台流程决定。',
        ),
        isVoided || !canWrite
          ? null
          : React.createElement(
              'div',
              null,
              renderPicker('before', '拍服务前'),
              renderPicker('after', '拍服务后'),
            ),
        photosError
          ? React.createElement(Alert, {
              type: 'error',
              showIcon: true,
              message: '照片列表加载失败',
              description: photosError,
              style: { marginBottom: 8 },
            })
          : null,
        renderPhotoList(),
      ),

      // ══════════════════════════════════════════════════════════════════
      // 暖通工程 · 六阶段（ARC-V1 / A5-F）
      // ══════════════════════════════════════════════════════════════════
      //
      // ⚠️ 这里**不做**任何业务判定：顺序、必拍阶段、每阶段 ≤6 张、
      //    第六阶段完成 → accepted、撤回连锁与照片下架，全部由
      //    `ArchiveStageService` 判。页面只是把服务端的结论呈现出来。
      isHvac
        ? React.createElement(
            'div',
            { style: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 } },
            React.createElement(
              'div',
              { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } },
              '暖通工程 · 六阶段',
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: '#8c8c8c', marginBottom: 6, lineHeight: 1.7 } },
              '必须按顺序完成。勘察 / 管路施工 / 设备安装 / 客户验收四个阶段必须先传照片；每阶段最多 6 张。第六阶段完成后档案自动变为「已验收」。',
            ),
            stagesError
              ? null
              : React.createElement(
                  'div',
                  { style: { fontSize: 12, color: '#8c8c8c' } },
                  stagesLoading ? '正在读取阶段…' : '',
                ),
            stageMsg
              ? React.createElement(Alert, {
                  type: stageMsg.ok ? 'success' : 'error',
                  showIcon: true,
                  message: stageMsg.text,
                  style: { marginTop: 8 },
                  'data-testid': stageMsg.ok ? 'arc-stage-ok' : 'arc-stage-error',
                })
              : null,
            React.createElement('div', null, ...renderStages()),
          )
        : null,

      // ══════════════════════════════════════════════════════════════════
      // 服务完工登记（ARC-V1 / A5-E）
      // ══════════════════════════════════════════════════════════════════
      //
      // 三条纪律：
      //   ① **判据在服务端**：前后照片、日期是否齐全由 `archives.complete()` 查库判，
      //      这里只是把那句话提前显示出来，不做"前端认为齐了就算完成"。
      //   ② **完工不发布**：complete() 不碰 visibility，本区块也不调 publish。
      //   ③ 防重复点击：按钮用 `completing` 禁用；即便网络慢到点了两次，
      //      服务端也会以 `ARCHIVE_ALREADY_COMPLETED` / 版本号不匹配拒绝第二次。
      current?.archive_type === 'service'
        ? React.createElement(
            'div',
            { style: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 } },
            React.createElement(
              'div',
              { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } },
              '服务完工登记',
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: '#8c8c8c', marginBottom: 10, lineHeight: 1.7 } },
              '填写实际完成日期后标记完成。服务前、服务后照片各需至少一张，缺哪张服务端会明确指出。完工**不会**自动发布档案或照片。',
            ),
            // 作废态**不渲染**控件，而不是"渲染了但 disabled"：
            //   禁用态仍然是一个可被点到的入口，且自动化/人眼都容易把它当成"能改"。
            //   与发布区同口径（voided 时那里本来就没有按钮）。
            !canWrite
              ? React.createElement(
                  'div',
                  { style: { fontSize: 13, color: '#8c8c8c' }, 'data-testid': 'arc-complete-readonly' },
                  isCompleted ? '已完成' : '尚未标记完成（只读）',
                )
              : isVoided
              ? React.createElement(
                  'div',
                  { style: { fontSize: 13, color: '#8c8c8c' } },
                  '档案已作废，不能标记完成。',
                )
              : isCompleted
              ? React.createElement(
                  'div',
                  { 'data-testid': 'arc-complete-done', style: { fontSize: 13, color: '#389e0d' } },
                  `已完成（${String(current?.status ?? '')}）`,
                )
              : React.createElement(
                  'div',
                  null,
                  React.createElement(DateOnlyInput, {
                    testId: 'arc-complete-date',
                    value: completeDate,
                    onChange: setCompleteDate,
                    disabled: completing,
                  }),
                  React.createElement(
                    Button,
                    {
                      type: 'primary',
                      loading: completing,
                      disabled: completing,
                      onClick: () => void onComplete(),
                      style: { marginTop: 8 },
                      'data-testid': 'arc-complete-btn',
                    },
                    completing ? '提交中…' : '标记完成',
                  ),
                ),
            completeError
              ? React.createElement(Alert, {
                  type: 'error',
                  showIcon: true,
                  message: '完工未成功',
                  description: completeError,
                  style: { marginTop: 10 },
                  'data-testid': 'arc-complete-error',
                })
              : null,
            completeOk
              ? React.createElement(Alert, {
                  type: 'success',
                  showIcon: true,
                  message: completeOk,
                  style: { marginTop: 10 },
                  'data-testid': 'arc-complete-ok',
                })
              : null,
          )
        : null,

      // ══════════════════════════════════════════════════════════════════
      // 档案及照片发布管理（ARC-V1 / A5-E）
      // ══════════════════════════════════════════════════════════════════
      //
      // 🔴 「档案已发布」与「照片已发布」是**两件事**，刻意分成两块显示：
      //    · 档案发布：把 visibility 置 published，客户**才能查到这条档案**；
      //    · 照片发布：单张 published=true，客户才能看到**那张照片**。
      //    只发布档案 ⇒ 客户能看到档案信息但一张照片都看不到（这是预期，不是 bug）。
      React.createElement(
        'div',
        { style: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 } },
        React.createElement(
          'div',
          { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } },
          '档案及照片发布',
        ),
        React.createElement(
          'div',
          { style: { fontSize: 12, color: '#8c8c8c', marginBottom: 10, lineHeight: 1.7 } },
          '「档案已发布」只代表客户能查到这条档案；照片要**逐张**发布，客户才看得到。两者互不代替。',
        ),

        // ---- 档案发布 ----
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(
            'span',
            { 'data-testid': 'arc-publish-state', style: { fontSize: 13 } },
            `档案：${visibilityLabel(current?.visibility)}`,
          ),
          canWrite && current?.visibility === 'draft'
            ? React.createElement(
                Button,
                {
                  size: 'small',
                  type: 'primary',
                  loading: publishingArchive,
                  disabled: isVoided || publishingArchive,
                  onClick: () => void onPublishArchive(),
                  'data-testid': 'arc-publish-archive-btn',
                },
                publishingArchive ? '发布中…' : '发布档案',
              )
            : null,
        ),
        publishError
          ? React.createElement(Alert, {
              type: 'error',
              showIcon: true,
              message: '发布未成功',
              description: publishError,
              style: { marginTop: 10 },
              'data-testid': 'arc-publish-error',
            })
          : null,
        publishOk
          ? React.createElement(Alert, {
              type: 'success',
              showIcon: true,
              message: publishOk,
              style: { marginTop: 10 },
              'data-testid': 'arc-publish-ok',
            })
          : null,

        // ---- 照片发布（逐张）----
        React.createElement(
          'div',
          { style: { marginTop: 12, fontSize: 13, fontWeight: 600 } },
          '照片发布',
        ),
        publishedPhotos.length === 0
          ? React.createElement(
              'div',
              { style: { fontSize: 12, color: '#8c8c8c', marginTop: 4 } },
              isHvac ? '暖通照片请在各个阶段卡片里发布。' : '还没有照片。上传后在这里逐张发布。',
            )
          : React.createElement(
              'div',
              { style: { marginTop: 6 } },
              publishedPhotos.map((p) =>
                React.createElement(
                  'div',
                  {
                    key: `pub-${p.id}`,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: '1px solid #fafafa',
                    },
                  },
                  React.createElement(
                    'span',
                    { style: { fontSize: 13, minWidth: 64 } },
                    p.photo_type === 'after' ? '服务后' : '服务前',
                  ),
                  React.createElement(
                    Tag,
                    { color: p.published ? 'green' : 'default', style: { marginRight: 0 } },
                    p.published ? '已发布' : '未发布',
                  ),
                  canWrite
                    ? React.createElement(
                        Button,
                        {
                          size: 'small',
                          type: 'link',
                          loading: photoBusy === p.id,
                          disabled: isVoided || (photoBusy !== 0 && photoBusy !== p.id),
                          onClick: () => void onTogglePhotoPublish(p.id, !p.published),
                          'data-testid': `arc-photo-publish-${p.id}`,
                        },
                        p.published ? '取消发布' : '发布',
                      )
                    : null,
                ),
              ),
            ),
      ),
    );
  }

  class ArchiveEditBlockModel extends FlowModelBase {
    render(): any {
      return React.createElement(ArchiveEditPanel, null);
    }
  }
  Object.defineProperty(ArchiveEditBlockModel, 'name', {
    value: 'ArchiveEditBlockModel',
  });
  return { ArchiveEditBlockModel };
}
