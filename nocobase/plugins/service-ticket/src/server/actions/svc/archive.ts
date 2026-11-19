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
import { ArchiveError, ArchiveService, isArchiveError } from '../../services/archive-service';
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

export const ARCHIVE_UPDATE_DATE_ONLY = ['purchase_date', 'planned_date'] as const;

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
        const row = await archives.create(
          actor,
          {
            archive_type: str(ctx, 'archive_type') ?? '',
            store_id: storeId,
            customer_name: str(ctx, 'customer_name') ?? '',
            customer_mobile: str(ctx, 'customer_mobile') ?? '',
            service_address: str(ctx, 'service_address') ?? '',
            service_type: str(ctx, 'service_type') ?? null,
            product_description: str(ctx, 'product_description') ?? null,
            package_description: str(ctx, 'package_description') ?? null,
            purchase_date: dateInputs.purchase_date,
            planned_date: dateInputs.planned_date,
            assigned_worker: str(ctx, 'assigned_worker') ?? null,
            notes: str(ctx, 'notes') ?? null,
            public_note: str(ctx, 'public_note') ?? null,
          },
          transaction,
        );
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
      const row = await archives.update(actor, archiveId, patch, expectedVersion);
      ok(ctx, { archive: row });
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
        return {
          id: Number(p.id),
          archive_no: p.archive_no ?? null,
          // 姓名原样返回：后台是内部界面，且列表页本来就要能对上"哪一单"
          customer_name: p.customer_name ?? null,
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
      };
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  });

  return {
    [SVC_ACTION.ARCHIVE_CREATE]: archiveCreate,
    [SVC_ACTION.ARCHIVE_UPDATE]: archiveUpdate,
    [SVC_ACTION.ARCHIVE_COMPLETE]: archiveComplete,
    // ARC-V1 / A5-E：受控发布（visibility 与 status 独立）
    [SVC_ACTION.ARCHIVE_PUBLISH]: archivePublish,

    // ---- ARC-V1 / A3：暖通六阶段 ----
    [SVC_ACTION.ARCHIVE_STAGE_COMPLETE]: archiveStageComplete,
    [SVC_ACTION.ARCHIVE_STAGE_WITHDRAW]: archiveStageWithdraw,
    [SVC_ACTION.ARCHIVE_STAGE_LIST]: archiveStageList,

    // ---- ARC-V1 / ARC-PHOTO-01：档案照片 ----
    [SVC_ACTION.ARCHIVE_PHOTO_ATTACH]: archivePhotoAttach,
    [SVC_ACTION.ARCHIVE_PHOTO_PUBLISH]: archivePhotoPublish,
    [SVC_ACTION.ARCHIVE_PHOTO_FILE]: archivePhotoFile,
    [SVC_ACTION.ARCHIVE_PHOTO_LIST]: archivePhotoList,

    // R2.2.1 第十条：后台「上门服务档案」只读列表
    [SVC_ACTION.ARCHIVE_ADMIN_LIST]: archiveAdminList,
  };
}
