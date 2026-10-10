/**
 * 内部业务 action：**门店人工新建服务单**（Phase 11 / P11-2 · 用户 B 段）
 *
 *   POST /api/svc:createTicket
 *
 * ===========================================================================
 * 与匿名建单（`actions/public/ticket.ts`）的关系：**同一套服务层，两套边界**
 * ===========================================================================
 * | | 匿名客户 H5 | 门店人工新建（本文件） |
 * |---|---|---|
 * | 门店归属 | 由**签名入口**裁决（`?k=`） | 由**操作者的门店范围**裁决（`store_code` + `storeScope`） |
 * | 工单类型 | **只有两类** `repair` / `complaint` | **六类**（含安装 / 调试保养 / 移机拆机 / 其他） |
 * | `urgent` | 字段**不存在**（伪造也无效） | 由**授权员工**设置（必须是真布尔） |
 * | `source` | `qr` / `link` | **`staff`** |
 * | 操作人 | 无（客户匿名） | `operatorUserId` = 当前登录用户，事件 `operator_kind = staff` |
 *
 * 🔴 **两条边界必须继续隔离**（用户原话）：
 *    "人工新建六类，与匿名客户 H5 只能提交 repair/complaint 的两类白名单必须继续隔离；
 *     不能因为内部 API 支持六类，就允许匿名请求伪造安装、其他或紧急标记。"
 *    ⇒ 本文件的存在**不**放宽匿名面一个字：匿名面的 `TYPE_SET` 仍是
 *      `PUBLIC_TICKET_TYPE_VALUES`（两类），`urgent` 仍不在其白名单内。
 *      门禁 `verify-store-create.mjs` 有**双向**断言盯住这一点。
 *
 * ===========================================================================
 * handler 的四步（与 ticket.ts / dispatch.ts 完全一致，顺序即安全约定）
 * ===========================================================================
 *   1) 解析操作者（未登录 → 401）
 *   2) **能力校验** `create_ticket` —— ⚠️ 与 `write_ticket` **不是同一个能力**：
 *      总部角色有 `write_ticket`（能处理全量工单），但**没有** `create_ticket`。
 *      用户原话："总部汇总查看权限不自动等于跨店创建权限。"
 *   3) **门店范围校验**：`store_code` 解析出的门店必须在 `actor.storeIds` 里
 *      —— 与"能看哪家门店"用**同一份**范围数据，不做第二套判断。
 *   4) 调服务层建单（工单 + `created` 事件 + 幂等记录**同事务**）
 *
 * ⚠️ 越权一律以 **403 `STORE_OUT_OF_SCOPE`** 表达，而不是"门店不存在"：
 *    这里与"读"的口径**刻意不同**。读的越权要 404（不泄露对象存在性），
 *    但"新建到哪家门店"是**操作意图**，操作者已经明确说出了门店编码 ——
 *    告诉他"你没这个权限"不会泄露任何他不知道的信息，反而避免他以为编码写错了。
 *    两个口径都已写进 `docs/API.md`。
 */
import { SVC_ACTION, TICKET_SOURCE, OPERATOR_KIND } from '../../constants';
import { StateConflictError, ValidationError } from '../../services/ticket-service';
import { CUSTOMER_NAME_MAX, parseNewModelFields } from '../_new-ticket-fields';
import { ok } from './_http';
import {
  createWrapper,
  param,
  replay,
  requireRequestId,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/** 幂等场景名（与 `INTERNAL_WRITE_SCENE` 同族；新建类单独一个 scene） */
const CREATE_SCENE = 'svc_create_ticket';

/**
 * 入参读取：同时接受 snake_case 与 camelCase。
 *
 * 对外契约（docs/API.md）是 snake_case，而后台自定义动作表单习惯 camelCase。
 * 只认一种会得到"文档里写着的字段传了却没生效"这种最难查的问题
 * （与 `dispatch.ts` 的 `dispatchInputOf` 同源理由）。
 */
function readInput(ctx: any): Record<string, unknown> {
  const snake = (key: string, camel: string): unknown => {
    const a = param(ctx, key);
    if (a !== undefined && a !== null && String(a).trim() !== '') return a;
    return param(ctx, camel);
  };
  return {
    store_code: snake('store_code', 'storeCode'),
    ticket_type: snake('ticket_type', 'ticketType'),
    content: snake('content', 'content'),
    customer_name: snake('customer_name', 'customerName'),
    customer_mobile: snake('customer_mobile', 'customerMobile'),
    service_address: snake('service_address', 'serviceAddress'),
    appliance_category: snake('appliance_category', 'applianceCategory'),
    brand_model: snake('brand_model', 'brandModel'),
    urgent: param(ctx, 'urgent'),
  };
}

export function createTicketCreateHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services } = deps;
  const { permissions, tickets } = services;
  const wrap = createWrapper(deps);

  // -------------------------------------------------------------------------
  // I21 createTicket —— （新建）→ NEW
  // -------------------------------------------------------------------------
  const createTicket = wrap('createTicket', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'createTicket');
    if (!requestId) return;

    const raw = readInput(ctx);

    // ---- ⑤ 幂等**前置**：命中即回放（**先查再建**）----
    //
    // 🔴 2026-10-10 实录（本动作首轮）：
    //    漏了这一步 ⇒ 同一个 `X-Request-Id` 第二次请求时，服务层在事务里
    //    往 `idempotency_records` 插了第二行 ⇒ 撞唯一约束 ⇒
    //    整个请求变成 **HTTP 500 `Validation error`**（不是"回放"，也不是 409）。
    //    匿名建单没有这个问题，唯一原因是它在守卫链 ⑤ 步**先查了一次**
    //    （`guards.findIdempotency`）—— 也就是说这条纪律本来就存在，
    //    只是新建入口照抄时漏掉了。
    //    ⇒ 教训：**幂等的"先查"不在服务层，在入口层**；
    //      新增一个写入口，就要把这一步一起抄过来（不能只抄"调用服务层"那一句）。
    const replayed = await services.guards.findIdempotency(CREATE_SCENE, requestId);
    if (replayed) {
      if (replayed.response === null || replayed.response === undefined) {
        // 首次请求写了幂等占位但没来得及回写响应体（进程被杀）。
        // ⚠️ 刻意**不伪造成功**：告诉调用方"这一笔已经发生过，但我复现不出当时的返回值"，
        //    而不是回一个编造的单号（那会让前端显示错误的单号）。
        throw new StateConflictError(
          '这次提交已经处理过，但当时的响应没有保存下来。请刷新工单列表确认是否已创建。',
          'IDEMPOTENT_RESPONSE_MISSING',
        );
      }
      replay(ctx, replayed.response);
      return;
    }

    // ---- ② 能力：**新建**与**写入**是两个能力（总部能写但不能跨店新建）----
    permissions.assertCanCreateTicket(actor);

    // ---- ③ 门店范围：先解析门店（含"必须已启用"），再核它在不在操作者的范围内 ----
    //     ⚠️ 顺序不能反：先解析才有 store.id 可比；先比范围则无从比起。
    const store = await tickets.resolveActiveStore({ storeCode: raw.store_code });
    permissions.assertStoreInScope(actor, store.id, '新建服务单');

    // ---- ④ 字段校验：与匿名面**共用**同一份规则（见 _new-ticket-fields.ts）----
    const name = String(raw.customer_name ?? '').trim();
    if (!name) {
      throw new ValidationError('INVALID_CUSTOMER_NAME', '必须填写客户姓名', 422);
    }
    if (name.length > CUSTOMER_NAME_MAX) {
      throw new ValidationError(
        'INVALID_FIELD_LENGTH',
        `客户姓名最多 ${CUSTOMER_NAME_MAX} 字，当前 ${name.length} 字`,
        422,
      );
    }
    const mobile = String(raw.customer_mobile ?? '').trim();
    const content = String(raw.content ?? '').trim();
    const ticketType = String(raw.ticket_type ?? '').trim();
    if (!ticketType) {
      // 单独给一条说清"六类里选一个"的提示；枚举合法性交给服务层 assertEnum
      throw new ValidationError(
        'MISSING_TICKET_TYPE',
        '必须选择服务类型（维修 / 安装 / 调试保养 / 移机拆机 / 投诉 / 其他）',
        422,
      );
    }

    // ⚠️ 门店人工新建**允许** urgent（`allowUrgent: true`）；
    //    匿名面在同一个函数里传 false（那边"紧急"字段根本不存在）。
    const fields = parseNewModelFields(raw, { allowUrgent: true });

    /**
     * 响应体构造 —— **幂等记录与首次响应共用它**。
     *
     * ⚠️ 必须是**纯函数**：拿到的是 `{ ticket, store }`，只从入参派生。
     *    绝不能读"当前状态" —— 第一次用它写进 `response_json`，重放时原样取回，
     *    读当前状态会让两次结果不同（那就不叫幂等了）。
     * ⚠️ 字段刻意**只有 6 个**：内部动作的响应不该顺手把整行工单回给前端
     *    （整行里有手机号、Token 哈希等，脱敏与否都不该靠"记得脱敏"）。
     */
    const responseOf = (result: { ticket: any; store: any }) => ({
      ticket_no: String(result.ticket.ticket_no),
      store_name: String(result.store.name),
      store_code: String(result.store.code),
      ticket_id: Number(result.ticket.id),
      ticket_type: String(result.ticket.ticket_type ?? ''),
      status: String(result.ticket.status ?? 'NEW'),
      created_at: String(result.ticket.createdAt ?? result.ticket.created_at ?? ''),
    });

    const result = await tickets.create({
      storeId: store.id,
      ticketType,
      content,
      customerName: name,
      customerMobile: mobile,
      // 🔴 来源与操作人：门店人工新建固定 `staff`，并留下操作者 ——
      //    这两项是"这张单是谁建的"的唯一凭据，也是审计事件的输入。
      source: TICKET_SOURCE.STAFF,
      // ⚠️ 是 `STORE` 不是 `STAFF` —— `OPERATOR_KIND` 里没有 STAFF 这个键。
      //    首轮就是写成 STAFF：它是 `undefined`，而服务层写的是
      //    `input.operatorKind ?? OPERATOR_KIND.CUSTOMER` ⇒ **静默落回 customer**，
      //    事件变成「客户提交」，接口却一切正常（201 / 落库都对）。
      //    🔴 这类拼写错误在 `verify-types` 里是 **TS2339**，而 TS2339 目前
      //    被归入"已知积压不判红"（宿主包 stub 产生大量同码噪声）⇒
      //    它**不会**被静态检查拦住，只能靠端到端断言（本门禁 §1 就是那条断言）。
      operatorKind: OPERATOR_KIND.STORE,
      operatorUserId: actor.userId,
      serviceAddress: fields.serviceAddress,
      applianceCategory: fields.applianceCategory,
      brandModel: fields.brandModel,
      urgent: fields.urgent,
      // 幂等：同 request_id 重放返回**逐字相同**的首次响应（不新建第二张单）
      idempotency: { scene: CREATE_SCENE, key: requestId, responseOf },
      metadata: {
        created_via: 'store_manual',
        request_id: requestId,
        operator_username: actor.roles?.length ? undefined : undefined,
      },
    });

    // 🔴 首次响应 = `responseOf(result)`，**与幂等回放时返回的那份是同一个对象**。
    //
    //    2026-10-10 实录（本动作首轮）：首次回的是 `{ ticket, event, store }`（嵌套），
    //    而 `responseOf` 存进 `response_json` 的是扁平的一份 ⇒ 同一请求重放两次
    //    得到**两种形状**的响应。那不是"回放"，那叫"两次不同的响应" ——
    //    幂等的定义就是"两次逐字节一致"，形状不同等于幂等没做到。
    //    ⇒ 收敛成一处构造：**响应体与幂等记录用同一个函数**。
    //    （匿名建单的 `buildResponse` 也是这么做的，理由写在它上面。）
    ok(ctx, responseOf(result), 201);
  });

  return { [SVC_ACTION.CREATE_TICKET]: createTicket };
}
