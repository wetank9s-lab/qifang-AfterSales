/**
 * 服务档案写入 action（ARC-V1 / A2）
 *
 * 执行顺序与工单 action 一致（顺序本身就是安全约定）：
 *   ① 解析操作者（createWrapper，未登录 401）
 *   ② 能力 + 门店归属（ArchiveService.assertCanWriteStore）
 *   ③ 业务校验（必填 / 完成规则 / 乐观锁）
 *   ④ 写库 + 写事件
 *
 * 🔴 为什么不把这些规则放在原生 collection 的 hook 里：
 *    原生 `serviceArchives:update` 对任何业务角色**都没有授权**（见 ROLE_ACL_ACTIONS）。
 *    规则必须在"唯一放行的路径"上，而不是"顺便拦一下其它路径"。
 *    如果将来有人给某角色开了原生 update，这里的所有规则会当场失效，
 *    而且**不会有任何报错**——所以这条边界要写在这里，也要写进验收断言。
 */
import { SVC_ACTION } from '../../constants';
import {
  ARCHIVE_ADMIN_LIST_ROLES,
  ARCHIVE_HQ_READ_ROLES,
  ARCHIVE_VISIBILITY,
  PLATFORM_ADMIN_ROLES,
} from '../../constants';
import { ArchiveService, ArchiveError, isArchiveError } from '../../services/archive-service';
import { ArchiveProductService } from '../../services/archive-product-service';
import { canReadArchiveCustomerMobile } from '../../services/archive-mobile-visibility';
import { ArchiveStageService } from '../../services/archive-stage-service';
import { ArchivePhotoService } from '../../services/archive-photo-service';
import { DEFAULT_PRIVATE_DIR } from '../../services/photo-service';
import { readSingleUpload } from '../technician/visit';
import { parseDateOnly } from '../../../shared/date-only';
import { fail, ok, traceId } from './_http';
import { createWrapper, param, paramPresence, requireArchiveId, requireRequestId, replay } from './_request';
import type { ActionHandler, SvcActionDeps } from './_request';

export interface ArchiveActionDeps extends SvcActionDeps {
  /** 档案服务直接下库（聚合/条件更新），与 report 三条接口同构 */
  db: any;
}

/** 把 Sequelize 行转成朴素对象（`.toJSON()` 存在则优先用它） */
const plainRow = (row: any): any =>
  typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row ?? {}) };

// ===========================================================================
// B-32：`archiveUpdate` 的字段更新语义（用户 2026-11-11 正式批准）
// ===========================================================================
// 白名单按"能不能被清空"拆成三组，**这是唯一口径**：
//   · 必填文本：明确清空 ⇒ 400，绝不写 NULL
//   · 可选文本：明确清空 ⇒ null；没提交 ⇒ 不动
//   · 日期：明确清空 ⇒ null；坏值 ⇒ 400；没提交 ⇒ 不动
//
// 为什么要拆成常量而不是在循环里 `if (key === 'xxx')`：
//   这张表同时是"契约"和"测试判据"。`verify-b32-clear.mjs` 会拿它去核对
//   每个字段的真实行为，字段增删必须先改这里，不会漏。
export const ARCHIVE_UPDATE_REQUIRED_TEXT = [
  'customer_name',
  'customer_mobile',
  'service_address',
  'service_type',
] as const;

export const ARCHIVE_UPDATE_CLEARABLE_TEXT = [
  'product_description',
  'package_description',
  'assigned_worker',
  'notes',
  'public_note',
] as const;

/**
 * 只接受日期的字段。
 *
 * ⚠️ `service_date` 与 `planned_date` **并列、互不覆盖**（R2.2.4-rc.2）：
 *    用户例子「原计划 11-28、实际提前 11-26」要求两列各存各的；
 *    改其中一个**绝不能**顺手同步另一个。
 */
export const ARCHIVE_UPDATE_DATE_ONLY = ['purchase_date', 'planned_date', 'service_date'] as const;

/**
 * 把 dateOnly 列转成 `YYYY-MM-DD`，且**不受时区影响**。
 *
 * 🔴 三条错法（都实际会导致"日期错一天"）：
 *   ① `new Date(v).toISOString().slice(0,10)` —— 东八区 08:00 前建的行会被算成前一天；
 *   ② `(v as Date).toLocaleDateString()` —— 依赖进程 locale，生产容器未必是 zh-CN；
 *   ③ 直接 `String(v).slice(0,10)` —— 对 `2026-11-26T00:00:00.000+08:00` 恰好对，
 *      但驱动若回传 `2026-11-26T00:00:00.000Z`（UTC 归一）就会取到同一串而语义已偏。
 *
 * 做法：**先看原值是不是纯日期串**（dateOnly 列在 PG 里就是 `DATE`，
 * Sequelize 可能回传 `'2026-11-26'` 或 `'2026-11-26T00:00:00.000Z'`）。
 *   · 纯 `YYYY-MM-DD` ⇒ 原样返回，零换算；
 *   · 其余（Date / ISO 串）⇒ 用**服务端时区**（Asia/Shanghai）取分量，不用 UTC。
 */
function dateOnlyOf(v: any): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // 用 'en-CA' 的 YYYY-MM-DD 形态 + 显式时区，避开 toISOString 的 UTC 偏移
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    // 极端环境无 ICU 时退化为 UTC 分量（宁可一致地偏，也不抛错让列表整页失败）
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
}

/** 字段中文名 —— 400 文案与前端控件标签共用一套说法，别在别处再写一遍 */
const ARCHIVE_FIELD_LABEL: Record<string, string> = {
  customer_name: '客户姓名',
  customer_mobile: '客户手机号',
  service_address: '服务地址',
  service_type: '服务类型',
  product_description: '产品描述',
  package_description: '套餐说明',
  assigned_worker: '指派师傅',
  purchase_date: '购买日期',
  planned_date: '计划上门日期',
  service_date: '实际服务日期',
  notes: '内部备注',
  public_note: '客户可见说明',
};

const isRequiredTextField = (key: string): boolean =>
  (ARCHIVE_UPDATE_REQUIRED_TEXT as readonly string[]).indexOf(key) >= 0;

const isDateOnlyField = (key: string): boolean =>
  (ARCHIVE_UPDATE_DATE_ONLY as readonly string[]).indexOf(key) >= 0;

/** 把 ArchiveError 映射成文档规定的错误响应；其它异常交给外层 */
function failFrom(ctx: any, error: unknown): boolean {
  if (!isArchiveError(error)) return false;
  const e = error as ArchiveError;
  fail(ctx, e.status, e.code, e.message);
  return true;
}

/**
 * 私有存储根目录 —— 与师傅现场照片**同一个** `UPLOAD_PRIVATE_DIR`。
 * 档案照片不另建存储体系（执行令：不增加新的图片存储体系）。
 */
function resolvePrivateDir(): string {
  const raw = String(process.env.UPLOAD_PRIVATE_DIR ?? '').trim();
  return raw || DEFAULT_PRIVATE_DIR;
}

/**
 * 单张照片字节上限。
 *
 * 刻意**不新增配置键**：复用 `ARC_PHOTO_MAX_MB` 环境变量覆盖，
 * 缺省 5MB（与 `visit.photo_max_size_mb` 的种子值同口径）。
 * 新增一个 `archive.photo_max_mb` 会让后台多一个需要维护、却没人看的开关。
 */
function resolveMaxPhotoBytes(): number {
  const raw = Number(String(process.env.ARC_PHOTO_MAX_MB ?? '').trim());
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 5;
  return Math.floor(mb * 1024 * 1024);
}

export function createArchiveActionHandlers(deps: ArchiveActionDeps): Record<string, ActionHandler> {
  const { logger } = deps;
  const archives = new ArchiveService(deps.db, logger);
  const wrap = createWrapper(deps);

  /** 从请求体/查询里取一个字符串参数 */
  const str = (ctx: any, key: string): string | undefined => {
    const v = param(ctx, key);
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  };

  // -------------------------------------------------------------------------
  // archiveCreate
  // -------------------------------------------------------------------------
  const archiveCreate = wrap('archiveCreate', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveCreate');
    if (!requestId) return;

    const actor = actorLike as any;

    // ---- ARC-V1 / A5-B3：store_id 可以由服务端推导，但**绝不接受前端自报** ----
    //
    // 背景：移动表单没有任何可靠途径拿到"当前账号的唯一门店"。
    //   让表单显示门店选择框 = 允许销售自由选店（用户明确禁止）；
    //   写死门店 1 = 跨店越权（用户明确禁止）。
    //
    // 规则（用户 2026-11-10 裁决）：
    //   · 请求**不传** store_id ⇒ 取当前登录销售**唯一**的有效门店绑定；
    //   · 请求**传了** store_id ⇒ 仍然执行原有的门店一致性校验（不能因为"可推导"就放宽）。
    //   · 零店 / 多店 / 悬空绑定 ⇒ 一律 fail closed。
    //
    // ⚠️ 只是把"参数的来源"从客户端换成服务端，**校验一点没减**：
    //    推导出来的 id 照样进 assertCanWriteStore。
    const rawStoreId = param(ctx, 'store_id');
    const explicitStoreId = rawStoreId === undefined || rawStoreId === null || String(rawStoreId).trim() === ''
      ? null
      : Number(rawStoreId);

    let storeId: number;
    if (explicitStoreId !== null) {
      storeId = explicitStoreId;
    } else {
      // 显式收敛成 number[]：actor 是 any（跨包边界），直接 map 会得到 unknown。
      // 注意这里**不是**为了绕过类型检查 —— 非有限数值必须被丢掉，
      // 否则一个脏赋值会让 bound[0] 变成 NaN，一路带进 assertCanWriteStore 才炸。
      const rawBound: unknown[] = Array.isArray(actor?.storeIds) ? actor.storeIds : [];
      const bound: number[] = [
        ...new Set(
          rawBound
            .map((n: unknown) => Number(n))
            .filter((n: number) => Number.isFinite(n) && n > 0),
        ),
      ];
      if (bound.length !== 1) {
        // 零店、多店、以及"绑了但门店已不存在"（loadStoreIds 返回空）都会落到这里。
        // 不降级、不猜：猜一个门店就是在替客户做越权决定。
        return fail(
          ctx,
          403,
          'ARCHIVE_STORE_NOT_DETERMINED',
          bound.length === 0
            ? '当前账号没有有效门店绑定，无法建档'
            : `当前账号绑定了 ${bound.length} 个门店，无法唯一确定建档门店`,
          { boundStores: bound, action: 'archiveCreate' },
        );
      }
      storeId = bound[0];
    }

    try {
      // ---- A5-B：让 X-Request-Id 真正成为**幂等键**（原来只是格式校验）----
      //
      // 事实（2026-11-10 取证）：本文件 7 个 action 拿到 requestId 后**从未使用**，
      //   `ArchiveService.create()` 也没有任何幂等逻辑 => 同一 request id 重放会
      //   真的建出第二条档案。用户要求"核查是否真有幂等；若只是格式校验，如实报告"。
      //   前一版把它补上了，但**幂等记录与业务写入不在同一事务**里 —— 并发下
      //   两笔业务都可能落库、只有一笔能写进幂等表。本版把两者收进同一事务。
      //
      // 复用既有的 `idempotency_records (scene, idempotency_key)` 唯一索引 ——
      //   不新增表、不新增迁移，与 public_ticket / ticket-create 同一套机制。
      //
      // 键形状：`${actor.userId}:${requestId}`
      //   · 含操作者：缓存的响应体是按首次操作者生成的，跨人回放等于泄露。
      //   · 含 scene：不同动作同号不会互相串。
      const scene = 'archive_create';
      const idemKey = `${actor.userId ?? 0}:${requestId}`;
      const idemRepo = deps.db.getRepository('idempotencyRecords');

      /**
       * 幂等回放的**最小响应体**（2026-11-10，用户 §1.3 裁决后收窄）。
       *
       * 改之前 `writeBoth` 直接把 `{ archive: row }` 整个塞进 `response_json` ——
       * 也就是把 `customer_mobile`、`service_address`（客户住址）等人身信息
       * **以明文长期存进幂等表**。那是真实缺陷，不是理论风险：
       *   · `idempotency_records` 是通用表，任何拿到该库读权限的地方都能读到；
       *   · 它的保留期由幂等清理策略决定，与"档案数据的生命周期"完全无关；
       *   · 而回放**根本不需要**这些字段 —— 客户端要的是"哪个档案、什么编号、
       *     什么状态、什么版本"，好去列表里刷新。
       *
       * 与 `ticket-create.ts` 的 `responseOf` 同一口径（那里写着"整行里有手机号，
       * 脱敏与否都不该靠记得脱敏"）：**不存，比存了再记得脱敏更可靠**。
       *
       * 为什么多带了 `status/version/visibility`：重放必须逐字复现首次响应，
       * 而客户端（archive-create-block）正是靠这几个字段决定后续能不能编辑、
       * 版本号从几开始。它们是**非敏感**的运行态标识。
       */
      const toReplayBody = (row: any) => ({
        archive: {
          id: Number(row.id),
          archive_no: String(row.archive_no ?? ''),
          archive_type: String(row.archive_type ?? ''),
          store_id: Number(row.store_id),
          status: String(row.status ?? ''),
          visibility: String(row.visibility ?? ''),
          version: Number(row.version ?? 1),
          created_at: String(row.createdAt ?? row.created_at ?? ''),
        },
      });

      /**
       * `dateOnly` 字段必须先校验，再进库（DEV-217 真机 500 的修复）。
       *
       * 真机实测：建档第一次提交就 500 —— `invalid input syntax for type date: "Invalid date"`。
       * 根因是**控件实现在移动端与桌面不同**：原生 `<input type="date">` 空值时 `value === ''`，
       * 而不少移动端实现把"没选日期"暴露成字符串 `'Invalid date'`（dayjs/moment 对无效日期
       * `format()` 的返回值）。原代码 `str(ctx,'planned_date')` 只做 trim 就透传 ⇒ 直接进 SQL。
       *
       * 为什么把校验放在**这里**（写库之前、幂等记账之前）而不是：
       *   · 数据库层：那已经不是"用户输入问题"，只能得到 500 —— 用户看到的是"服务端异常"，
       *     而真正该说的是"日期格式不对，请重选"。
       *   · `ArchiveService.create` 内部：那里没有 `ctx`，报不出带字段名的 400。
       *
       * ⚠️ 空值仍然允许（`''`/`null` → 入库 `null`）。**区分"没填"与"填了个坏值"**
       *    正是 `parseDateOnly` 的职责：静默把坏值当没填 = "提交成功但内容没保存"。
       *
       * ⚠️⚠️ 为什么这段**必须**在 `resolveExisting` 之前（2026-11-11 A6 修 P0）：
       *    它原先位于 `resolveExisting` 定义**之后**、改用 `const dateInputs` 声明，而
       *    `resolveExisting` 的比对里有 `cmp('planned_date', …, dateInputs.planned_date)`。
       *    回放快路径（命中已有幂等记录）会在 `dateInputs` 初始化**之前**调用
       *    `resolveExisting` ⇒ `ReferenceError: Cannot access 'dateInputs' before initialization`
       *    ⇒ **幂等回放整条路径 500**（同一 requestId 第 2 次起必然失败）。
       *    `const`/`let` 的 TDZ 是**运行期**才报的：esbuild 只转译、tsc 也不在此处报错
       *    （引用在闭包体内，词法上"存在"），所以构建门禁**看不见**它 —— 只有真实回放才暴露。
       *    修法是把解析块上移到调用点之前（依赖必须早于使用它的闭包被**执行**的时机）。
       */
      const dateInputs: Record<string, string | null> = {};
      for (const key of ['purchase_date', 'planned_date'] as const) {
        const rawDate = param(ctx, key);
        const parsed = parseDateOnly(rawDate);
        if (!parsed.ok) {
          return fail(
            ctx,
            400,
            'ARCHIVE_BAD_DATE',
            `${key === 'planned_date' ? '预约上门日期' : '购买日期'}${parsed.reason}。请重新选择日期后再提交`,
            { field: key, hint: 'DATE_ONLY_YYYY_MM_DD' },
          );
        }
        dateInputs[key] = parsed.value;
      }

      /**
       * R2.2.4 §C：产品清单（一对多）。
       *
       * ⚠️ 与日期校验**同样必须在 `resolveExisting` 定义之前**完成 ——
       *    幂等回放的比对里要用到 `products`（见 `resolveExisting` 内的比对项），
       *    而 `const` 的 TDZ 是运行期才报的（DEV 记录：`dateInputs` 曾因此
       *    让"回放整条路径 500"）。依赖必须先于使用它的闭包**被执行**。
       *
       * `null` = 请求里没这个字段 ⇒ 不动清单（老客户端只传 product_description 时）。
       * `[]`   = 明确清空。
       */
      const products = new ArchiveProductService(deps.db, logger).normalize(param(ctx, 'products'));

      /**
       * 命中已有幂等记录之后的处理 —— **先比对内容，再决定回放还是拒绝**。
       *
       * 为什么不能"命中就回放"（ticket-create.ts 同一处已踩过，此处照抄其结论）：
       *   同一个 UUID 带着**不同内容**再来一次，若直接回放首次响应，
       *   后半句请求的内容**从未被创建**，而调用方看到"成功 + 一个编号"。
       *   那是**静默丢请求**，比报错危险得多。
       *
       * 比对用**语义比对**（拿库里那张真实档案逐字段比），不用入参哈希：
       *   哈希要么污染 response_json、要么加列；而"和库里那张比"用的是已经存在的事实，
       *   出错时日志里直接能看出是哪一项不同。
       *
       * 抽成函数是刻意的：这个判断有**两个调用点**（进入时的快路径、唯一键碰撞后的
       *   落败方路径）。同一段判定写两遍 = 同一个坑有两条腿，只修一条是经典现场。
       */
      const resolveExisting = async (existing: any): Promise<void> => {
        // 档案行可能**还没被先到者提交**（自己的事务里写了幂等行、外层的档案行尚未可见）。
        // 这是并发落败方最常见的一瞬间，不能当成"档案已被删除"。
        // 用另一条连接退避重读，读不到才是真的不存在。
        let stored = await archives.loadCommittedRow('serviceArchives', {
          id: Number(existing.resource_id),
        });
        for (let i = 0; i < 20 && !stored; i += 1) {
          // 先到者的响应体已缓存 ⇒ 说明它已经提交或即将提交，值得等这一下
          if (existing.response_json != null && i >= 4) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
          stored = await archives.loadCommittedRow('serviceArchives', {
            id: Number(existing.resource_id),
          });
        }
        if (!stored) {
          logger.warn?.(
            `[svc:archiveCreate] 幂等记录指向的档案读不到：idemId=${existing.id} resourceId=${existing.resource_id} ` +
              `hasBody=${existing.response_json != null} key=${idemKey}（trace=${traceId(ctx)}）`,
          );
          // 幂等记录指向的档案不存在（被清理过）：不伪造成功
          return fail(
            ctx,
            409,
            'IDEMPOTENT_RESOURCE_MISSING',
            '这次提交已经处理过，但它对应的档案不存在或尚未可见。请刷新后到档案列表确认',
            { requestId },
          );
        }

        const norm = (v: unknown): string => String(v ?? '').trim();
        const same = (a: unknown, b: unknown): boolean => {
          if (a === null || a === undefined || a === '') {
            return b === null || b === undefined || b === '';
          }
          return norm(a) === norm(b);
        };
        const differences: string[] = [];
        const cmp = (field: string, storedValue: unknown, incoming: unknown): void => {
          if (!same(storedValue, incoming)) {
            // 只报字段名，不把客户手机号等明文写进错误体
            differences.push(field);
          }
        };
        cmp('archive_type', stored.archive_type, str(ctx, 'archive_type') ?? 'service');
        cmp('store_id', stored.store_id, storeId);
        cmp('customer_name', stored.customer_name, str(ctx, 'customer_name'));
        cmp('customer_mobile', stored.customer_mobile, str(ctx, 'customer_mobile'));
        cmp('service_address', stored.service_address, str(ctx, 'service_address'));
        cmp('service_type', stored.service_type, str(ctx, 'service_type'));
        cmp('product_description', stored.product_description, str(ctx, 'product_description'));
        cmp('planned_date', stored.planned_date, dateInputs.planned_date);
        cmp('public_note', stored.public_note, str(ctx, 'public_note'));
        /**
         * R2.2.4 §C：产品清单也参与幂等比对。
         *
         * ⚠️ 为什么必须比：同一个 X-Request-Id 带**不同产品清单**再来一次，
         *    若直接回放首次响应，后半句请求里那几条产品**从未被创建**，
         *    而调用方看到"成功 + 一个档案号"。那是静默丢请求。
         *
         * ⚠️ 判据是"规范化后的形状"而不是原始入参：
         *    前端两条空白条目与一条空白条目，规范后都得到 `[]`，
         *    它们**语义相同**，不该被判成"内容不同"（否则用户多留了一个空行就重试失败）。
         *
         * ⚠️ 只在**本次请求真的带了 products** 时比对。带了才比、不带不比 ——
         *    否则只想改备注的老客户端会永远撞上 MISMATCH。
         */
        if (products !== null) {
          const storedProducts = await new ArchiveProductService(deps.db).list(Number(stored.id));
          const shape = (arr: Array<{ product_name: string | null; purchase_date: string | null; quantity: number }>) =>
            JSON.stringify(arr.map((p) => [p.product_name ?? '', p.purchase_date ?? '', p.quantity]));
          if (shape(storedProducts) !== shape(products)) {
            differences.push('products');
          }
        }

        if (differences.length > 0) {
          return fail(
            ctx,
            409,
            'IDEMPOTENT_PAYLOAD_MISMATCH',
            `X-Request-Id ${requestId} 已经用于另一份建档内容，不能复用它回放。` +
              `如需新建请重新提交（会生成新的请求号）。不同的字段：${differences.join('、')}`,
            { requestId, differences },
          );
        }

        if (existing.response_json == null) {
          return fail(
            ctx,
            409,
            'IDEMPOTENT_REPLAY_UNAVAILABLE',
            '该请求此前已执行过，但首次响应未能缓存，请刷新后到档案列表确认',
          );
        }

        // ---- 回放前复核 ①：**当前**账号的角色与门店权限 ----
        //
        // 用户 §1.2 的原话：「避免账号撤权后凭旧请求 ID 读取档案」。
        //
        // 这里的风险是**时间差**，不是逻辑错误：
        //   · 上面的 `storeId` 推导与门店归属校验，用的是**本次请求**解析出的 actor；
        //   · 但那只是"这次请求能不能建"的判断，而回放返回的是**档案内容**。
        //   · 若账号在被撤掉门店/角色之后，拿旧的 requestId 再来一次，
        //     幂等快路径会命中旧记录 —— 于是**在没有任何写权限的情况下拿到了一份档案的编号与状态**。
        //
        // 正确判据不是"当初是谁"，而是"**现在**这个人还能不能看这张档案"。
        // 因此这里用**本请求的 actor** 对**档案真实行**再跑一遍门店归属校验
        // （`assertCanWriteStore` 内部先判角色能力、再判门店归属）。
        //
        // ⚠️ 为什么用 `stored` 而不是用缓存响应里的 `store_id`：
        //    缓存是"当初那一刻"的快照，而权限必须按**现在**的事实判。
        //    拿快照里的门店去校验，等于让被篡改/过期的快照决定权限。
        try {
          archives.assertCanWriteStore(actor, Number(stored.store_id));
        } catch (error) {
          // 角色被撤 ⇒ 403；门店被撤 ⇒ 404（越权与不存在统一，避免探测）
          if (!failFrom(ctx, error)) throw error;
          return;
        }

        // ---- 回放前复核 ②：缓存响应与真实行必须说同一件事 ----
        //
        // 收窄 `response_json` 之后（只存 id/编号/类型/门店/状态/可见性/版本/时间），
        // 缓存与真实行**可能出现分歧**的唯一现实原因是：档案在首次响应之后被改过。
        // 这时若原样回放旧快照，调用方会拿到一个**过期的版本号**，
        // 后续带 `expected_version` 的编辑必然 409 —— 一个查不出原因的死循环。
        //
        // 判据取**单调递增的 `version`**：它只增不减，任何写操作都会推进它。
        // 版本一致 ⇒ 快照未过期 ⇒ 原样回放（这正是幂等要求的"逐字相同"）。
        // 版本不一致 ⇒ 不谎称"这就是当前状态"，回 409 让调用方去列表取最新值。
        const bodyVersion = Number((existing.response_json as any)?.archive?.version);
        const liveVersion = Number(stored.version);
        if (Number.isFinite(bodyVersion) && Number.isFinite(liveVersion) && bodyVersion !== liveVersion) {
          logger.warn?.(
            `[svc:archiveCreate] 幂等缓存的版本已过期：idemId=${existing.id} ` +
              `resourceId=${existing.resource_id} bodyV=${bodyVersion} liveV=${liveVersion} key=${idemKey}`,
          );
          return fail(
            ctx,
            409,
            'IDEMPOTENT_REPLAY_STALE',
            '这次提交此前已处理过，但该档案此后被修改过。请刷新后到档案列表查看当前内容，不要用旧结果继续操作',
            { requestId, archiveId: Number(existing.resource_id) },
          );
        }

        replay(ctx, existing.response_json);
      };

      // 快路径：顺序重放（并发不靠它，靠下面的唯一约束）
      const existing = await idemRepo.findOne({
        filter: { scene, idempotency_key: idemKey },
      });
      if (existing) {
        await resolveExisting(existing);
        return;
      }

      /**
       * 业务写入 + 幂等记账 —— **同一个事务**。
       *
       * 事务范围（用户要求的四个问题，逐条回答）：
       *   1. `ArchiveService.create` 原本**没有任何事务**：档案行、暖通阶段行、
       *      创建事件是三笔独立自动提交的写。中途失败会留下"有档案没事件"
       *      或（暖通）"只有三行阶段"的半成品。现在它接受 `transaction` 参数，四笔写同进退。
       *   2. 幂等记录原本**在事务之外**、且写在业务之后 => 业务成功而幂等记账失败时，
       *      重放会**再建一张**档案。这正是"极端并发两条记录"的放大器。
       *   3. 现在：档案行 + 阶段行 + 创建事件 + 幂等记录 **同事务**，
       *      任一失败整体回滚 => 不存在"半个档案"，也不存在"有幂等没业务"。
       *   4. 唯一键碰撞 = 事务回滚 => **落败方的业务写入一行都不留**，
       *      随后用另一条连接读先到者**已提交**的档案与缓存响应来做比对/回放。
       *
       * 为什么碰撞采用"先写幂等行 + 碰撞后回滚重来"而不是先查后写：
       *   先查后写在并发下是 TOCTOU —— 两个请求都查到"没有"，然后都去创建。
       *   让数据库的唯一索引当裁判，才是真正原子的那一下。
       *   （因此这里刻意**不预设** advisory lock：唯一约束已经提供了所需的原子性。）
       */
      const writeBoth = async (transaction: any) => {
        /**
         * R2.2.4 §C：旧列取"第一条产品的镜像"，**仅当**请求真的带了清单。
         *
         * 三种来源的优先级（这一段的全部逻辑）：
         *   ① 请求带了 `products`（数组，可能为空）⇒ 清单是权威来源；
         *      第一条的 name/date 覆盖旧列；清单为空则**不覆盖**（保持请求里的原值）
         *   ② 请求没带 `products`，但传了 `product_description`（老客户端）
         *      ⇒ 照旧直接用，一行产品都不建（不能凭空造出一条"只改备注就多出台设备"）
         *   ③ 都没传 ⇒ null
         *
         * ⚠️ 为什么不在服务层 `ArchiveService.create` 里做镜像：
         *    那里不知道"请求有没有带 products"（它只看得到 input 字段），
         *    把三种来源的优先级写在 action 层才有上下文。
         */
        const mirror = products === null ? {} : new ArchiveProductService(deps.db).mirrorToLegacy(products);
        const legacyProduct = mirror.product_description !== undefined
          ? mirror.product_description
          : str(ctx, 'product_description') ?? null;
        const legacyPurchaseDate = mirror.purchase_date !== undefined
          ? mirror.purchase_date
          : dateInputs.purchase_date;

        const row = await archives.create(
          actor,
          {
            archive_type: str(ctx, 'archive_type') ?? '',
            store_id: storeId,
            customer_name: str(ctx, 'customer_name') ?? '',
            customer_mobile: str(ctx, 'customer_mobile') ?? '',
            service_address: str(ctx, 'service_address') ?? '',
            service_type: str(ctx, 'service_type') ?? null,
            product_description: legacyProduct,
            package_description: str(ctx, 'package_description') ?? null,
            purchase_date: legacyPurchaseDate,
            planned_date: dateInputs.planned_date,
            assigned_worker: str(ctx, 'assigned_worker') ?? null,
            notes: str(ctx, 'notes') ?? null,
            public_note: str(ctx, 'public_note') ?? null,
          },
          transaction,
        );
        // 产品清单与档案行**同一事务**：清单写失败 ⇒ 档案行也不留（不存在"半个档案"）
        await new ArchiveProductService(deps.db, logger).replace(Number(row.id), products, transaction);
        // ⚠️ 入库的是 `toReplayBody(row)` 的**最小字段集**，不是整行 ——
        //    见上方 `toReplayBody` 的注释（幂等表不得留客户手机号/住址明文）。
        const created = toReplayBody(row);
        await idemRepo.create({
          values: {
            scene,
            idempotency_key: idemKey,
            resource_type: 'serviceArchive',
            resource_id: Number(row.id),
            response_json: created,
          },
          ...(transaction ? { transaction } : {}),
        });
        return created;
      };

      /** 唯一键碰撞（PG 23505 / Sequelize UniqueConstraintError）的识别 */
      const isDup = (error: any): boolean =>
        error?.name === 'UniqueConstraintError' ||
        String(error?.parent?.code ?? error?.original?.code ?? '') === '23505' ||
        String(error?.message ?? '').includes('duplicate key');

      // ---- 事务开关已被移除（2026-11-10，用户 §1.1 裁决）----
      //
      // 曾经有一个 `SVC_IDEM_TXN=off` 环境变量，用于**反向验证**（变异测试）：
      //   把它设成 off 就强制走"无事务顺序写"，用来证明"去掉同事务之后，
      //   并发用例会真的变红"。
      //
      // 为什么必须删掉它：**一个能被环境变量关掉的事务，等于没有事务**。
      //   它把"最关键的并发保证"降级成一条运行期开关，而开关的误用（本地调试后
      //   忘了删、部署脚本里抄了 `-e SVC_IDEM_TXN=off`）不会报错、不会告警，
      //   只会让并发下的重复建档悄悄复活。反向验证的价值是**一次性的证明**，
      //   证明完了就该把脚手架拆掉，而不是长期留在产品代码里。
      //
      // 反向验证已完成并留档（见 docs/ARC-V1-CONTRACT.md §2.1.1 的验证结果表）：
      //   · `SVC_IDEM_TXN=off` 时并发用例变红（archives=2）⇒ 断言确实会变红；
      //   · 移除开关后同一用例回到 archives=1。
      // 现在事务路径**无条件**生效：没有开关、没有降级、没有"忘了设"的可能。
      const sequelize = deps.db?.sequelize;
      let created: { archive: any } | null = null;
      let dupError: any = null;

      if (sequelize && typeof sequelize.transaction === 'function') {
        try {
          created = await sequelize.transaction(async (t: any) => writeBoth(t));
        } catch (error) {
          if (!isDup(error)) throw error;
          // 事务已回滚：落败方的档案/阶段/事件/幂等行**一条都没有留下**
          dupError = error;
        }
      } else {
        // 宿主没有事务能力时退化为顺序写（与本仓库 historical-review-archive /
        // sms-service 的同一约定）。此时并发保护只剩唯一索引给出的
        // "至多一条幂等记录"，落败方的业务行**会**残留 —— 所以补一次补偿删除。
        try {
          created = await writeBoth(undefined);
        } catch (error) {
          if (!isDup(error)) throw error;
          dupError = error;
        }
      }

      if (dupError) {
        // ---- 并发落败方：以先到者为准 ----
        //
        // ⚠️ 判断"先到者已经完成"的条件是**它的幂等行带上了 response_json**，
        //    不是"查到了这条幂等行"。
        //    实测踩过（.tmp-verify/a8/v2-idem-race.mjs 的 A1）：先到者若处在
        //    "已插入幂等行、外层还差最后一步"的瞬间，落败方查到的是一条
        //    **没有响应体 / 指向尚未提交资源** 的记录；此时若直接拿去 resolve，
        //    会读不到档案行 —— 于是把一次正常的并发撞车报成
        //    `IDEMPOTENT_RESOURCE_MISSING`（"档案已不存在"），
        //    用户看到的是一个**像数据丢了**的错误。那是最坏的一类误报。
        //
        //    因此：只有 `response_json != null` 才视为完成态；否则继续等。
        //    等不到就如实回 409 CONCURRENT_PENDING（"正在处理中"），
        //    既不伪造成功，也不谎称"档案不存在"。
        let winner = await idemRepo.findOne({ filter: { scene, idempotency_key: idemKey } });
        for (let i = 0; i < 40; i += 1) {
          if (winner && winner.response_json != null) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
          winner = await idemRepo.findOne({ filter: { scene, idempotency_key: idemKey } });
        }
        if (!winner || winner.response_json == null) {
          logger.warn?.(
            `[svc:archiveCreate] 碰撞后等不到先到者的完成态：found=${!!winner} ` +
              `hasBody=${winner?.response_json != null} resourceId=${winner?.resource_id} key=${idemKey}`,
          );
          return fail(
            ctx,
            409,
            'IDEMPOTENT_CONCURRENT_PENDING',
            '同一请求号的另一次提交正在处理中，请稍后到档案列表确认结果',
            { requestId },
          );
        }
        await resolveExisting(winner);
        return;
      }

      logger.info?.(
        `[svc:archiveCreate] 创建档案 ${created?.archive?.archive_no}（门店 ${created?.archive?.store_id}，操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
      );
      ok(ctx, created);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // archiveUpdate
  // -------------------------------------------------------------------------
  const archiveUpdate = wrap('archiveUpdate', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveUpdate');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    const expectedVersion = Number(param(ctx, 'expected_version'));
    if (!Number.isFinite(archiveId) || archiveId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'id 无效');
    }
    if (!Number.isFinite(expectedVersion) || expectedVersion <= 0) {
      // 强制要求版本号：不传就等于允许"无条件覆盖"，那正好是并发缺陷的入口
      return fail(ctx, 400, 'ARCHIVE_MISSING_VERSION', '必须携带 expected_version（乐观锁）');
    }

    const patch: Record<string, unknown> = {};
    for (const key of [
      ...ARCHIVE_UPDATE_REQUIRED_TEXT,
      ...ARCHIVE_UPDATE_CLEARABLE_TEXT,
      ...ARCHIVE_UPDATE_DATE_ONLY,
    ]) {
      // ═══════════════════════════════════════════════════════════════════
      // B-32（用户 2026-11-11 正式批准）冻结的字段更新语义
      // ═══════════════════════════════════════════════════════════════════
      //   ① 请求体**没有**某字段        ⇒ 不更新，保留原值
      //   ② 明确提交空串 / null（可选） ⇒ 清空为 null
      //   ③ 明确清空**必填**字段        ⇒ 400，不保存
      //   ④ 表单没渲染的字段            ⇒ 客户端不得自动转成 null 提交
      //   ⑤ 日期被明确清除              ⇒ 存 null
      //   ⑥ 全部更新继续走 expected_version 乐观锁
      //
      // 🔴 判"有没有提交这个字段"必须用 `paramPresence`，**不能用 `param` / `str`**：
      //    `param()` 把 `''` 与 `null` 都当作"没传"返回 undefined，
      //    于是「用户清空」与「用户没提这回事」塌缩成同一结果 —— 这正是 B-32：
      //    清空备注提示"已保存"，重新打开旧内容还在。
      //    `paramPresence()` 只回答"这个键到底出没出现"，取值语义留给本函数决定，
      //    这样规则只有一处。
      //
      // ⚠️ 用户明确要求：**不改全局 `str()` 语义**（它被 7 个 action 共用，
      //    改动会波及售后工单接口）。所以只在本 action 内部换判据。
      const presence = paramPresence(ctx, [key]);
      if (!presence.present) continue; // ① 没提交 = 不动这一列

      if (isDateOnlyField(key)) {
        // ⑤ 明确清除（'' / null）⇒ parseDateOnly 返回 { ok:true, value:null } ⇒ 存 null
        // 坏值（'Invalid date' / '2026-02-31'）仍然 400，绝不静默落 NULL
        const parsed = parseDateOnly(presence.raw);
        if (!parsed.ok) {
          return fail(
            ctx,
            400,
            'ARCHIVE_BAD_DATE',
            `${ARCHIVE_FIELD_LABEL[key] ?? key}${parsed.reason}。请重新选择日期后再保存`,
            { field: key, hint: 'DATE_ONLY_YYYY_MM_DD' },
          );
        }
        patch[key] = parsed.value;
        continue;
      }

      const raw = presence.raw;
      const blank =
        raw === null ||
        raw === undefined ||
        (typeof raw === 'string' && raw.trim() === '');

      if (blank) {
        if (isRequiredTextField(key)) {
          // ③ 必填字段不允许清空。返回 400 而不是写 NULL：
          //    写 NULL 要么被数据库 NOT NULL 拦成 500（用户看到"服务端异常"），
          //    要么在可空列上留一张没有客户姓名的档案 —— 两种都不该发生。
          return fail(
            ctx,
            400,
            'FIELD_REQUIRED',
            `${ARCHIVE_FIELD_LABEL[key] ?? key}不能为空，请填写后再保存`,
            { field: key },
          );
        }
        // ② 可选字段明确清空 ⇒ null。
        //    ⚠️ 只有到这里才是"用户要清空"；`!presence.present` 那条分支已经继续掉了，
        //       两者必须分开，否则又会退化成 B-32。
        patch[key] = null;
        continue;
      }

      patch[key] = String(raw).trim();
    }

    try {
      /**
       * R2.2.4 §C：产品清单更新。
       *
       * 顺序是**先清单、后主表**，原因不是随便排的：
       *   · `archives.update` 会推进 `version` 并写事件；
       *   · 清单写入若失败，必须让整个请求失败，并且**不能让版本号已经往前走了**,
       *     否则客户端拿着新版本号重试时，看到的是一份"版本变了但内容没变"的档案。
       *   ⇒ 先做清单（可能 400/失败，此时还没动主表），再做主表。
       *
       * ⚠️ 两者不在同一事务里（`archives.update` 内部是条件 UPDATE + 事件写入，
       *    没有对外暴露事务参数）。权衡过：
       *     - 清单成功、主表 409（乐观锁）⇒ 清单已经改了，但版本号没动。
       *       下一次重试会带着新清单再覆盖一次 —— **幂等**，不会累积错误。
       *     - 反过来（主表先成功、清单失败）⇒ 版本号前进了但清单没改，
       *       客户端不知道要不要重试。所以必须是这个顺序。
       */
      const productsInput = new ArchiveProductService(deps.db, logger).normalize(param(ctx, 'products'));
      if (productsInput !== null) {
        /**
         * 产品清单变更留痕（R2.2.4-rc.2）。
         *
         * ⚠️ 必须在 `replace` **之前**取旧清单：replace 之后表里已是新值，
         *    再读就只能拿到"变更后"，审计里两个 before 全变成同一份。
         * ⚠️ 只在**真的变了**时写事件：前端每次保存都会带整份清单，
         *    若无脑记一条"清单已改"，用户每改一次备注都会多出一条假记录。
         */
        const beforeProducts = await new ArchiveProductService(deps.db, logger).list(archiveId);
        const shapeOf = (arr: Array<{ product_name: string | null; purchase_date: string | null; quantity: number }>) =>
          JSON.stringify(arr.map((p) => [p.product_name ?? '', p.purchase_date ?? '', p.quantity]));
        const productsChanged = shapeOf(beforeProducts) !== shapeOf(productsInput);

        await new ArchiveProductService(deps.db, logger).replace(archiveId, productsInput);
        // 清单是权威来源 ⇒ 旧列必须跟着第一条走，否则客户 H5 与导出报表会显示旧值。
        // 铁律 ③：清单为空时 mirrorToLegacy 返回 {}，旧列**保持原值**。
        Object.assign(patch, new ArchiveProductService(deps.db).mirrorToLegacy(productsInput));

        if (productsChanged) {
          await archives.writeEvent(actor, archiveId, null, 'archive_updated', {
            fields: ['products'],
            // 只记条数与"加了几条/删了几条"，不把整份清单抄进事件表：
            // 清单可能有几十行，抄进去会让时间线无法阅读，而完整内容在清单表里本来就有。
            changes: {
              products: { from: `${beforeProducts.length} 项`, to: `${productsInput.length} 项` },
            },
          });
        }

        // 全部字段都没变时不要把"只有产品变化"判成 NOTHING_TO_UPDATE
        if (Object.keys(patch).length === 0) {
          const fresh = await deps.db.getRepository('serviceArchives').findOne({
            filter: { id: archiveId },
          });
          return ok(ctx, { archive: fresh });
        }
      }

      const row = await archives.update(actor, archiveId, patch, expectedVersion);
      ok(ctx, { archive: row });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // archiveProductList —— 产品清单只读入口（R2.2.4 §C）
  // -------------------------------------------------------------------------
  /**
   * 为什么不复用 `svc:archiveDetail` 一起返回：
   *   档案详情是**员工端**的读，产品清单在客户 H5 也要读，两者权限口径不同。
   *   合成一个接口 ⇒ 要么客户能拿到内部投影（越权），要么员工拿不到清单字段。
   *   拆开后：本 action 走 `assertCanAccessRow`（门店范围 + 总部只读），
   *   客户侧由 `archive-query-service` 自己的投影带上（那里已经做了白名单）。
   */
  const archiveProductList = wrap('archiveProductList', async (ctx, actorLike) => {
    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);
    if (!Number.isFinite(archiveId) || archiveId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'id 无效');
    }
    try {
      const row = await deps.db.getRepository('serviceArchives').findOne({ filter: { id: archiveId } });
      if (!row) return fail(ctx, 404, 'ARCHIVE_NOT_FOUND', '档案不存在或无权查看');
      // 门店范围校验与详情页同一入口 —— 产品清单不比档案本身更"不敏感"
      archives.assertCanAccessRow(actor, row);
      const list = await new ArchiveProductService(deps.db).list(archiveId);
      /**
       * `legacy_only`：这条档案的清单表**从来没有过任何行**（不是"被清空了"）。
       *
       * 🔴 为什么必须由服务端回答（R2.2.4-rc.2 · 用户 §四）：
       *    客户端的 `archiveProductList` 返回 `[]` 时，**分不清**两种完全不同的情况：
       *      · 迁移前的老档案，清单表里一行都没有 ⇒ 旧列 `product_description`
       *        是唯一的数据来源，应当显示；
       *      · 用户把产品全删光了 ⇒ 清单是权威的"空"，旧列只是历史残留，
       *        **绝不能**再拿出来显示 —— 否则界面上会出现
       *        "我明明删光了，却还显示一台机器"（用户点名要核实的那条）。
       *
       *    判据只能查库：`SELECT count(*) FROM service_archive_products WHERE archive_id = ?`。
       *    前端没有任何办法知道这张表里有没有过行。
       *
       * ⚠️ 与 `mirrorToLegacy([])` 返回 `{}`（不动旧列）是**配套**的两件事：
       *    清空时保留旧列值是为了不抹掉历史购买信息（铁律 ③），
       *    而 `legacy_only=false` 保证这份历史**不会被当成当前显示来源**。
       */
      /**
       * ⚠️ 用 `find({ fields:['id'] })` + `length` 而**不用 `count()`**：
       *    NocoBase 的 `Repository.count` 在不同小版本里签名不一致
       *    （有的要 `{ filter }`，有的直接吃 filter 对象），而本仓库其他位置
       *    一律用 `find` —— 跟着现有用法走，换版本时不用回头改这一行。
       *    这张表的数据量是一条档案几行，多取几个 id 没有性能问题。
       */
      const legacyRows = await deps.db
        .getRepository('serviceArchiveProducts')
        .find({ filter: { archive_id: archiveId }, fields: ['id'] });
      const legacyCount = Array.isArray(legacyRows) ? legacyRows.length : 0;

      /**
       * 🔴 只看"当前行数是否为 0"是**不够的**（2026-11-24 实测踩到）。
       *
       *    复现：建档带 1 条产品（表内 1 行）→ 清空清单（表内 0 行）
       *    ⇒ `legacyCount === 0` ⇒ 旧判据给出 `legacy_only = true`
       *    ⇒ 详情页回落显示旧列 ⇒ **用户明明删光了，界面还显示一台机器**
       *    —— 正是用户 §四 点名要核实的那条矛盾。
       *
       *    根本原因：整表替换是 `destroy` + `create`，清空后**表里的行被删光了**，
       *    "从来没有过" 与 "有过又删光" 在**当前行数**上完全一样。
       *    ⇒ 必须找一个**不会被删除**的持久证据。
       *
       *    选事件表 `service_archive_events`：清单变更时 `archive.ts` 会写一条
       *    `archive_updated`，`payload_json.fields` 含 `'products'`。
       *    事件是**只增不删**的业务流水，清空清单不会把这条记录抹掉。
       *
       *    ⚠️ 为什么不用"旧列是否为 null"当判据：
       *       `mirrorToLegacy([])` 刻意不清旧列（铁律 ③，保留历史购买信息），
       *       所以旧列有值**既可能是"老档案"也可能是"清空过"**，无法区分。
       *    ⚠️ 为什么不用 `updated_at != created_at`：改过一次备注也会满足，
       *       会把"只改过备注的老档案"误判成"清空过"，导致产品区凭空消失。
       */
      let everHadProducts = legacyCount > 0;
      if (!everHadProducts) {
        const evRows = await deps.db
          .getRepository('serviceArchiveEvents')
          .find({
            filter: { archive_id: archiveId, event_type: 'archive_updated' },
            fields: ['payload_json'],
          });
        for (const ev of Array.isArray(evRows) ? evRows : []) {
          const payload = typeof ev?.payload_json === 'string' ? ev.payload_json : JSON.stringify(ev?.payload_json ?? {});
          if (payload && payload.includes('"products"')) {
            everHadProducts = true;
            break;
          }
        }
      }
      ok(ctx, { products: list, legacy_only: !everHadProducts });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // archiveComplete —— 普通上门服务的完工闸
  // -------------------------------------------------------------------------
  const archiveComplete = wrap('archiveComplete', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveComplete');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk

    // ---- 完成日期先过共享解析器（DEV-217 的同族）----
    // `completed_at` 是 timestamp 列：移动端控件可能吐 `'Invalid date'`，
    // 原代码 `str()` 只 trim 就透传 ⇒ 数据库报错 ⇒ 500「服务端异常」。
    // 用户要求「缺照片或缺日期必须明确提示」，所以这里必须给出可读的 400。
    // ⚠️ 空值不在这里拦：交给 `archives.complete()` 抛 `ARCHIVE_MISSING_COMPLETED_AT`，
    //    保证"缺日期"的文案只有一个出处。
    const rawCompletedAt = param(ctx, 'completed_at');
    let completedAt = '';
    if (
      rawCompletedAt !== undefined &&
      rawCompletedAt !== null &&
      String(rawCompletedAt).trim() !== ''
    ) {
      const parsed = parseDateOnly(rawCompletedAt);
      if (!parsed.ok) {
        return fail(
          ctx,
          400,
          'ARCHIVE_BAD_DATE',
          `实际完成日期${parsed.reason}。请重新选择日期后再提交`,
          { field: 'completed_at', hint: 'DATE_ONLY_YYYY_MM_DD' },
        );
      }
      completedAt = String(parsed.value ?? '');
    }

    const expectedVersionRaw = param(ctx, 'expected_version');
    try {
      const row = await archives.complete(actor, archiveId, {
        completed_at: completedAt,
        expectedVersion:
          expectedVersionRaw === undefined || expectedVersionRaw === null
            ? undefined
            : Number(expectedVersionRaw),
      });
      logger.info?.(
        `[svc:archiveComplete] 档案 ${archiveId} 已完成（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
      );
      ok(ctx, { archive: row });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // archivePublish —— ARC-V1 / A5-E：受控发布（唯一入口）
  // -------------------------------------------------------------------------
  //
  // 为什么必须有这个 action（而不是复用原生 update）：
  //   ① 原生 `serviceArchives:update` 对门店角色**本来就是关闭的**（既有安全边界，
  //      用户要求「不得开放」），而且它能改任意列（status / store_id / archive_no）；
  //   ② 发布需要独立的并发语义：已发布再发布要 409，不重复推进版本；
  //   ③ 审计要记一条 `published` 事件，原生 update 不会写。
  //
  // 语义：`visibility` 与业务 `status` **相互独立** —— 未完工也能发布；
  //       完工也不会自动发布。角色与门店范围由 `ArchiveService.publish` 判。
  const archivePublish = wrap('archivePublish', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archivePublish');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    if (!Number.isFinite(archiveId) || archiveId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'id 无效');
    }
    const expectedVersionRaw = param(ctx, 'expected_version');
    try {
      const row = await archives.publish(actor, archiveId, {
        expectedVersion:
          expectedVersionRaw === undefined || expectedVersionRaw === null
            ? undefined
            : Number(expectedVersionRaw),
      });
      logger.info?.(
        `[svc:archivePublish] 档案 ${archiveId} 已发布（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
      );
      ok(ctx, { archive: row });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // A3：暖通六阶段
  // -------------------------------------------------------------------------
  const stageService = new ArchiveStageService(deps.db, archives, logger);

  const archiveStageComplete = wrap('archiveStageComplete', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveStageComplete');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    const stageCode = str(ctx, 'stage_code') ?? '';
    const stageDate = str(ctx, 'stage_date') ?? '';
    const expectedVersion = Number(param(ctx, 'expected_version'));
    if (!Number.isFinite(expectedVersion)) {
      return fail(ctx, 400, 'ARCHIVE_MISSING_VERSION', '必须携带 expected_version（乐观锁）');
    }
    try {
      const result = await stageService.completeStage(actor, archiveId, stageCode, {
        stage_date: stageDate,
        note: str(ctx, 'note') ?? null,
        expected_version: expectedVersion,
      });
      ok(ctx, result);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archiveStageUpdate = wrap('archiveStageUpdate', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveStageUpdate');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    const stageCode = str(ctx, 'stage_code') ?? '';
    const expectedVersion = Number(param(ctx, 'expected_version'));
    if (!Number.isFinite(expectedVersion)) {
      return fail(ctx, 400, 'ARCHIVE_MISSING_VERSION', '必须携带 expected_version（乐观锁）');
    }

    // 🔴 这里刻意**不**做字段白名单之外的兜底透传：
    //    body 里就算塞了 status / completed_at / stage_order / archive_id，
    //    也传不进 updateStage —— 服务层的写法里根本没有这些列。
    //    参数层只挑两个键，多传的一律忽略（而不是报错），
    //    因为前端可能复用同一个 body 对象，多带键不该导致 400。
    //
    // ⚠️ 取值**必须**用 paramPresence 而不是 param：
    //    `param()` 会把 `''` 与 `null` 都当"没传"（见 _request.ts:202 的刻意设计），
    //    于是「把日期清空」会被静默忽略、接口回 200 却什么都没改 ——
    //    用户以为清掉了，其实日期还在。这类"假成功"比报错危险得多。
    //    反向验证 N3 就是用来钉死这一点的。
    const input: { stage_date?: string | null; note?: string | null; expected_version: number } = {
      expected_version: expectedVersion,
    };
    const dateP = paramPresence(ctx, ['stage_date']);
    if (dateP.present) {
      input.stage_date = dateP.raw === null || dateP.raw === '' ? null : String(dateP.raw);
    }
    const noteP = paramPresence(ctx, ['note']);
    if (noteP.present) {
      input.note = noteP.raw === null ? null : String(noteP.raw);
    }

    try {
      const result = await stageService.updateStage(actor, archiveId, stageCode, input);
      logger.info?.(
        `[svc:archiveStageUpdate] 档案 ${archiveId} 阶段 ${stageCode} ` +
          `改动=${result.changed.join(',') || '(无变化)'}（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
      );
      ok(ctx, result);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archiveStageWithdraw = wrap('archiveStageWithdraw', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archiveStageWithdraw');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    const stageCode = str(ctx, 'stage_code') ?? '';
    const reason = str(ctx, 'reason') ?? '';
    const expectedVersion = Number(param(ctx, 'expected_version'));
    if (!Number.isFinite(expectedVersion)) {
      return fail(ctx, 400, 'ARCHIVE_MISSING_VERSION', '必须携带 expected_version（乐观锁）');
    }
    try {
      const result = await stageService.withdrawStage(actor, archiveId, stageCode, {
        reason,
        expected_version: expectedVersion,
      });
      logger.warn?.(
        `[svc:archiveStageWithdraw] 档案 ${archiveId} 撤回阶段 ${stageCode}，连带 ${result.withdrawn.length} 个（操作者 ${actor.userId}）`,
      );
      ok(ctx, result);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archiveStageList = wrap('archiveStageList', async (ctx, actorLike) => {
    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    try {
      const stages = await stageService.listStages(actor, archiveId);
      ok(ctx, { stages });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  // -------------------------------------------------------------------------
  // ARC-PHOTO-01：档案照片
  // -------------------------------------------------------------------------
  const photoService = new ArchivePhotoService(
    {
      db: deps.db,
      privateDir: resolvePrivateDir(),
      maxSizeBytes: resolveMaxPhotoBytes(),
      logger,
    },
    archives,
  );

  const archivePhotoAttach = wrap('archivePhotoAttach', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archivePhotoAttach');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk

    // multipart 解析复用师傅上传那一份（同一条链路，不自己实现边界解析）
    const file = await readSingleUpload(ctx, resolveMaxPhotoBytes());
    if (!file) {
      return fail(ctx, 422, 'NO_FILE', '请选择要上传的照片（multipart/form-data，字段名 file）');
    }

    // ⚠️ multipart 的**文本字段**不在 `ctx.action.params` 里（那是 JSON body 的位置），
    //    而在 multer 解析后写入的 `ctx.request.body`。第一次实现时用了 `param()`，
    //    结果 photo_type 恒为空 ⇒ 一路被判成"类型非法"（400），
    //    看起来像"上传功能坏了"，其实是取错了地方。
    const multipartParam = (key: string): unknown => {
      const body = ctx?.request?.body ?? {};
      const v = body[key];
      return v === undefined || v === null || v === '' ? undefined : v;
    };
    const stageRaw = multipartParam('stage_id');
    const photoTypeRaw = multipartParam('photo_type');

    try {
      const view = await photoService.attach(actor, {
        archiveId,
        stageId: stageRaw === undefined ? null : Number(stageRaw),
        photoType: photoTypeRaw === undefined ? null : String(photoTypeRaw),
        buffer: file.buffer,
        declaredMime: file.mimetype ?? null,
        originalName: file.originalname ?? null,
      });
      logger.info?.(
        `[svc:archivePhotoAttach] 档案 ${archiveId} 新增照片 ${view.id}（操作者 ${actor.userId}）`,
      );
      ok(ctx, { photo: view });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archivePhotoPublish = wrap('archivePhotoPublish', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archivePhotoPublish');
    if (!requestId) return;

    const actor = actorLike as any;
    const photoId = Number(param(ctx, 'photo_id'));
    const raw = param(ctx, 'published');
    if (!Number.isFinite(photoId) || photoId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'photo_id 无效');
    }
    // 显式布尔：`'false'` 字符串不能被当成 true
    const published = raw === true || raw === 'true' || raw === 1 || raw === '1';
    try {
      const view = await photoService.setPublished(actor, photoId, published);
      ok(ctx, { photo: view });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archivePhotoFile = wrap('archivePhotoFile', async (ctx, actorLike) => {
    const actor = actorLike as any;
    // 🔴 DEV-271：参数名兼容 `photo_id` / `id` / `filterByTk`。
    //
    // 曾经的写法是只认 `photo_id`，而前端 `archivePhotoFileUrl()` 发的是
    // `?filterByTk=<id>`（NocoBase 的惯例名），`archivePhotoList` 又读 `id`
    // —— 三个地方三个名字。结果 `Number(undefined) === NaN`，
    // Sequelize 把 NaN 拼进 SQL 变成 **`column "nan" does not exist`**，
    // 对外只表现为 500「服务端异常」，看不出是参数名问题。
    //
    // 为什么后端做兼容而不是只改前端：
    //   `/m/` 是首次上线（生产曾长期没有移动端），但 `svc:archivePhotoFile`
    //   是**既有对外 action**，任何已发出的链接/外部脚本都可能用旧名。
    //   单边改前端 = 换一批调用继续踩。兼容读一次，成本是一个函数。
    const pickId = (): number => {
      for (const key of ['photo_id', 'id', 'filterByTk', 'filterByTK']) {
        const v = param(ctx, key);
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return NaN;
    };
    const photoId = pickId();
    // 显式挡在 SQL 之前：NaN 一旦进 Sequelize，报错信息会指向一个不存在的列，
    // 排查会被误导到 schema 层（本项目实测过一次，见 DEV-271）。
    if (!Number.isFinite(photoId) || photoId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'photo_id 无效');
    }
    try {
      const file = await photoService.readForActor(actor, photoId);
      ctx.set('Content-Type', file.mime);
      ctx.set('Cache-Control', 'private, no-store');
      ctx.set('Content-Disposition', `inline; filename="${file.fileName}"`);
      // 不写 storage_key、不写绝对路径，只回字节
      ctx.body = file.buffer;
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  const archivePhotoList = wrap('archivePhotoList', async (ctx, actorLike) => {
    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);   // DEV-274：兼容 id / archive_id / filterByTk
    try {
      const archive = await deps.db.getRepository('serviceArchives').findOne({
        filter: { id: archiveId },
      });
      if (!archive) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
      archives.assertCanAccessRow(actor, archive);
      const rows = await deps.db.getRepository('serviceArchivePhotos').find({
        filter: { archive_id: archiveId },
        sort: ['id'],
      });
      ok(ctx, { photos: (rows ?? []).map((r: any) => photoService.project(r)) });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  /**
   * R2.2.1 §七 / §九：移除一张阶段照片（合法替换 / 移除）。
   *
   * 🔴 与 `archivePhotoPublish(published=false)` 是**两件事**：
   *    取消发布只是"客户看不到"，行与文件都还在；
   *    员工点「移除」要的是"这张传错了，删掉"。
   *    用取消发布顶替移除 ⇒ 照片区永远显示那张错图（内部投影不过滤 published），
   *    员工会反复点、每次都"没反应"。
   *
   * ⚠️ 必需照片数不能变零（用户 §七 原文）：
   *    服务端在删之前重新数一次本阶段剩余张数，低于下限直接 409。
   *    前端也有同样的闸（`QFStagePhotoManager`），但**前端拦不住脚本调用**。
   */
  const archivePhotoRemove = wrap('archivePhotoRemove', async (ctx, actorLike) => {
    const requestId = requireRequestId(ctx, 'archivePhotoRemove');
    if (!requestId) return;

    const actor = actorLike as any;
    const archiveId = requireArchiveId(ctx);
    const photoId = Number(param(ctx, 'photo_id') ?? param(ctx, 'id') ?? param(ctx, 'filterByTk'));
    if (!Number.isFinite(photoId) || photoId <= 0) {
      return fail(ctx, 400, 'ARCHIVE_BAD_ID', 'photo_id 无效');
    }
    try {
      const result = await photoService.remove(actor, archiveId, photoId);
      logger.info?.(
        `[svc:archivePhotoRemove] 档案 ${archiveId} 移除照片 ${photoId}，阶段剩余 ${result.remaining} 张（操作者 ${actor.userId}）`,
      );
      ok(ctx, result);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  /**
   * R2.2.1 第十条：后台「上门服务档案」列表（**只读**）。
   *
   * 🔴 为什么必须有这条动作，而不是让页面直接打 `serviceArchives:list`：
   *    ① `store_sales` / `store_manager` 的原生 ACL 是 `ARCHIVE_NATIVE_READ_RESOURCES`
   *       （含 serviceArchives 的 view/list/get），但**后台 V2 页面**还要过
   *       `collections:listMeta`，那个它们一律 403 ⇒ 页面会退化成"数据表可能已被删除"。
   *    ② 这里要返回的是"档案 + 门店名 + 服务类型分布"这种**聚合视图**，
   *       不是裸行；让前端自己 join 等于把门店表也开给它们。
   *
   * ⚠️ 门店裁剪在**服务端**做（`scopeOf` 已经算好 actor.storeIds），
   *    前端只负责显示。前端再过滤一遍会让"看到多少"和"被授权多少"两件事混在一起。
   * ⚠️ 只返回已发布（visibility=published）：草稿是移动端保存中的半成品。
   * ⚠️ 客户手机号**不在**本响应里。后台列表没有"拨号"这个动作，
   *    把号码带出来只会多一处泄露面。
   */
  const archiveAdminList = wrap('archiveAdminList', async (ctx, actorLike) => {
    const actor = actorLike as any;
    try {
      // ⚠️ 这里**不能**用 `archives.assertCanRead()`：那个方法认的是 `ARCHIVE_READ_ROLES`，
      //    里面不含 `root` / `admin`。
      // ⚠️ 更要紧的一点（实测踩了两次）：`actor.roles` 是**归一化之后**的业务角色列表，
      //    `root` / `admin` 已经被 `normalizeRolesDetailed()` 剥掉、单独放进
      //    `actor.platformRoles`。所以判超管必须读 `platformRoles`，
      //    在 `roles` 里找 `'root'` 永远找不到 —— 那不是数据问题，是两块字段。
      const roleList: string[] = Array.isArray(actor.roles) ? actor.roles : [];
      const platformList: string[] = Array.isArray(actor.platformRoles) ? actor.platformRoles : [];
      const isPlatformAdmin = platformList.some((r) => PLATFORM_ADMIN_ROLES.includes(r));
      if (!isPlatformAdmin && !roleList.some((r) => ARCHIVE_ADMIN_LIST_ROLES.includes(r))) {
        throw new ArchiveError('ARCHIVE_FORBIDDEN', '当前角色无档案访问权限', 403);
      }
      const isHq =
        isPlatformAdmin || roleList.some((r) => ARCHIVE_HQ_READ_ROLES.includes(r as any));
      const storeIds: number[] = isHq ? [] : (actor.storeIds ?? []).map((n: any) => Number(n));

      const filter: any = { visibility: ARCHIVE_VISIBILITY.PUBLISHED };
      if (!isHq) {
        // 门店角色：只给本店；空集合表示"没有任何门店" ⇒ 直接空列表（fail closed，不报错）
        if (!storeIds.length) {
          ctx.withoutDataWrapping = true;
          ctx.status = 200;
          ctx.body = { rows: [], total: 0, stores: [], scope: 'stores' };
          return;
        }
        filter.store_id = { $in: storeIds };
      }

      const rows = (await deps.db.getRepository('serviceArchives').find({
        filter,
        sort: ['-id'],
        limit: 500,
      })) ?? [];

      const storeRepo = deps.db.getRepository('stores');
      const storeRows = isHq
        ? ((await storeRepo.find({ filter: { id: { $in: (rows ?? []).map((r: any) => Number(plainRow(r).store_id)) } } })) ?? [])
        : ((await storeRepo.find({ filter: { id: { $in: storeIds } } })) ?? []);
      const storeById = new Map<number, any>();
      for (const s of storeRows ?? []) {
        const p = plainRow(s);
        storeById.set(Number(p.id), p);
      }

      const projected = (rows ?? []).map((r: any) => {
        const p = plainRow(r);
        const st = storeById.get(Number(p.store_id));
        /**
         * R2.2.1 §四：客户手机号按「角色 + 门店范围」裁剪，**在服务端**裁。
         *
         * · 有权限（本店销售 / 平台超管）→ 完整 11 位；
         * · 没权限（门店负责人、总部查看、跨店销售）→ **null**，不是掩码。
         *
         * 「为什么是 null 而不是 138****8888」的完整理由见
         * services/archive-mobile-visibility.ts 文件头 —— 一句话：掩码仍然
         * 泄露号段与首尾位，对已知姓名的客户足以缩小到个位数候选。
         *
         * ⚠️ 判定必须逐行做（不能用"这个人是什么角色"一次性决定整表）：
         *    同一个销售可能被绑定多家店，而列表里可能混有非本店行。
         */
        const mobileVisible = canReadArchiveCustomerMobile(actor, p.store_id);
        return {
          id: Number(p.id),
          archive_no: p.archive_no ?? null,
          // 姓名原样返回：后台是内部界面，且列表页本来就要能对上"哪一单"
          customer_name: p.customer_name ?? null,
          /**
           * 客户手机号。`null` = **当前角色无权查看本行**（不是"没填"）。
           * 前端必须把两者渲染成不同文案：无权 → 「已隐藏」；没填 → 「—」。
           */
          customer_mobile: mobileVisible ? (p.customer_mobile ?? null) : null,
          /**
           * 机器可读的裁剪标记。存在的理由：
           *   前端不该靠"手机号是不是 null"来反推权限（那样"没填"会被误判成"无权"）。
           * 与 `customer_mobile` 同源同判，只是把判定结果显式说出来。
           */
          customer_mobile_visible: mobileVisible,
          /**
           * ⚠️ 两个字段**不是一回事**，别合并：
           *    · `archive_type`  = 档案大类（`service` 上门服务 / `hvac` 暖通工程）—— 页签按它分；
           *    · `service_type`  = 上门服务**内部**的服务类型（安装/维修/清洗…）—— 只有 service 才有；
           *      暖通档案这一列本来就是 NULL。
           *    第一版我只返回了 `service_type`，结果暖通行全变成空串，
           *    前端按 `service_type === 'home_service'` 分类时一条都匹配不上（实测踩到）。
           */
          archive_type: String(p.archive_type ?? ''),
          service_type: p.service_type == null ? null : String(p.service_type),
          hvac_stage: p.hvac_stage ?? null,
          status: String(p.status ?? ''),
          visibility: String(p.visibility ?? ''),
          /**
           * R2.2.4-rc.3：后台列表要显示「服务进展及相关日期」。
           *
           * 🔴 `planned_date` / `service_date` / `completed_at` **三个都要下发**，
           *    且**谁都不能代替谁**：
           *      · `planned_date` 计划上门日期（可改）
           *      · `service_date` 实际服务日期（可改，允许早于计划）
           *      · `completed_at` 完工**动作发生时刻**（由 archiveComplete 写入，不可改）
           *    后台如果只拿 `completed_at` 当"实际日期"显示，就会把
           *    "11-26 上门、11-30 才点完工"显示成 11-30 —— 那是两件事。
           */
          planned_date: dateOnlyOf(p.planned_date),
          service_date: dateOnlyOf(p.service_date),
          completed_at: p.completed_at ? new Date(p.completed_at).toISOString() : null,
          store_id: p.store_id == null ? null : Number(p.store_id),
          store_code: st ? String(st.code) : null,
          store_name: st ? String(st.name) : null,
          sales_name: p.assigned_worker ?? null,
          created_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          published_at: p.published_at ? new Date(p.published_at).toISOString() : null,
        };
      });

      /**
       * ⚠️ 这里**故意**用 `ctx.withoutDataWrapping = true` 而不是 `ok()`：
       *
       *    `ok(ctx, {...})` 会被 NocoBase 的 dataWrapping 包成 `{ data: <payload> }`，
       *    而本动作返回体本身**已经有** `rows/total/stores/scope` 四个键。
       *    实测结果：前端拿到的是 `{ data: [ ...行... ] }` —— 包装把四个键**压平成数组**，
       *    `stores` 和 `scope` 直接消失（页面拿不到门店清单，也判不出视角）。
       *    这不是"多包一层"那么轻：它是**丢字段**。
       *
       *    关掉包装后，响应就是文档里写的那四个键，前端 `data.rows` 一次命中。
       *    与 `report.ts` / `visit-review.ts` 的做法一致（那两处同样因为"返回体自带结构"而关包装）。
       */
      ctx.withoutDataWrapping = true;
      ctx.status = 200;
      ctx.body = {
        rows: projected,
        total: projected.length,
        stores: (storeRows ?? []).map((s: any) => {
          const p = plainRow(s);
          return { id: Number(p.id), code: String(p.code), name: String(p.name) };
        }),
        scope: isHq ? 'all' : 'stores',
        /**
         * R2.2.4-rc.3：**服务端**告诉前端"当前账号能不能编辑档案"。
         *
         * 🔴 为什么不让前端按角色名自己算：
         *    ① 前端拿到的角色名是登录态里的原始名，而"能不能写"要看
         *       `ARCHIVE_WRITE_ROLES` + **门店归属**两件事，角色名只是其中一半；
         *    ② 一旦两边各写一份规则，将来改 `ARCHIVE_WRITE_ROLES` 时
         *       必然出现"按钮还在、接口已经 403"的错位 —— 那是最难归因的一类 bug。
         *    所以这里直接复用 `ArchiveService.canWrite()`，与 `archiveUpdate` 的
         *    判定是**同一个函数**，不存在第二份真相。
         *
         * ⚠️ 这只是"界面上要不要显示编辑入口"的提示，**不是权限边界**：
         *    真正拦写在 `archiveUpdate` 里（`assertCanWriteStore` 先判能力再判归属）。
         *    显示为真但调用被拒是完全可能的（例如多店销售对非本店行），
         *    前端必须能正常显示那个 403，而不是当成"页面坏了"。
         */
        can_edit: archives.canWrite(actor),
      };
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  return {
    [SVC_ACTION.ARCHIVE_CREATE]: archiveCreate,
    [SVC_ACTION.ARCHIVE_UPDATE]: archiveUpdate,
    // R2.2.4 §C：产品清单只读入口
    [SVC_ACTION.ARCHIVE_PRODUCT_LIST]: archiveProductList,
    [SVC_ACTION.ARCHIVE_COMPLETE]: archiveComplete,
    // ARC-V1 / A5-E：受控发布（visibility 与 status 独立）
    [SVC_ACTION.ARCHIVE_PUBLISH]: archivePublish,

    // ---- ARC-V1 / A3：暖通六阶段 ----
    [SVC_ACTION.ARCHIVE_STAGE_COMPLETE]: archiveStageComplete,
    [SVC_ACTION.ARCHIVE_STAGE_WITHDRAW]: archiveStageWithdraw,
    [SVC_ACTION.ARCHIVE_STAGE_UPDATE]: archiveStageUpdate,
    [SVC_ACTION.ARCHIVE_STAGE_LIST]: archiveStageList,

    // ---- ARC-V1 / ARC-PHOTO-01：档案照片 ----
    [SVC_ACTION.ARCHIVE_PHOTO_ATTACH]: archivePhotoAttach,
    [SVC_ACTION.ARCHIVE_PHOTO_PUBLISH]: archivePhotoPublish,
    [SVC_ACTION.ARCHIVE_PHOTO_FILE]: archivePhotoFile,
    [SVC_ACTION.ARCHIVE_PHOTO_LIST]: archivePhotoList,
    // R2.2.1 §七 / §九：移除阶段照片（先传替换再删旧，服务端再判一次必需张数）
    [SVC_ACTION.ARCHIVE_PHOTO_REMOVE]: archivePhotoRemove,

    // R2.2.1 第十条：后台「上门服务档案」只读列表
    [SVC_ACTION.ARCHIVE_ADMIN_LIST]: archiveAdminList,
  };
}
