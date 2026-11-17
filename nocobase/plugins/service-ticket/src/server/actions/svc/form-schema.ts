/**
 * `svc:formSchema` —— ARC-V1 / A5-B1 的最小元数据通道（**插件内**，非全局授权）
 *
 * 要解决的问题：
 *   V2 表单区块渲染前会调 `GET /api/collections:listMeta`。该 action 的实现是
 *   `db.collections.forEach(...)` —— **完全不看 ACL、也不按角色过滤**，
 *   它只是被 `acl.allow('collections','listMeta','loggedIn')` 放行。
 *   但同一份 `allow` 在 `collections:list` / `fields:list` 上**没有**注册
 *   （那两个是面板配置用，靠角色 resources 授权），于是出现了一个自相矛盾的状态：
 *     · `listMeta` 对已登录放行 ⇒ 任何角色都能拿到**全量 33 个集合**的元数据（信息面过大）
 *     · `collections:list` / `fields:list` 对业务角色 403 ⇒ 前端另一条路径拿不到
 *   两条路径给的答案还不一样，前端最终按"拿不到字段"降级成
 *   「数据表 "主数据源 > serviceArchives" 可能已被删除」。
 *
 * 🔴 为什么不用"给角色授 collections:list / fields:list"来修（用户 2026-11-10 裁决：不批准）：
 *   那两个资源是整个数据源的**全量**元数据入口，授权面远大于本需求，
 *   而且会把 users / roles / smsLogs 等无关集合的 schema 一起暴露。
 *
 * ✅ 本实现的边界（三条都是硬边界）：
 *   ① **只回一个集合**：`serviceArchives`。集合名是常量，不接受参数 ——
 *      一旦参数化，它就变成了第二个"全量元数据接口"。
 *   ② **动作由插件自己判**：调用者必须对该集合至少有一个已授权动作
 *      （view / list / get 任一），否则 403。不依赖外层 ACL 兜底。
 *   ③ **字段只回 `interface` 已定义的**：不给前端塞内部列/关系细节；
 *      且**不含任何数据行**（纯 schema）。
 *
 * 它**不**创建数据库表、**不**改 `collections` / `fields` 表、**不**写任何东西。
 */
import { fail, ok } from './_http';
import { createWrapper } from './_request';
import type { ActionHandler, SvcActionDeps } from './_request';
import { collectRoleNames } from '../../services/permission-service';

/** 唯一允许下发的集合名。写死是**特性**，不是偷懒。 */
export const FORM_SCHEMA_COLLECTION = 'serviceArchives';

/** 允许调用此接口的最小动作集（有任一即可） */
const ACCESS_ACTIONS = ['view', 'list', 'get'];

/**
 * 有权读取档案字段定义的角色集。
 *
 * 依据不是"我们希望谁能看"，而是**库里真实的授予记录**：
 * `dataSourcesRolesResources` 上 `serviceArchives` 只有这四个角色有 `get/list/view`
 * （2026-11-10 查库核对）。新角色要开这个表单，必须先在后台把档案资源授给它
 * —— 那时这份集合也要同步加人，否则会出现"后台能读数据、表单却渲染不出来"。
 */
const ARCHIVE_READ_ROLES = new Set([
  'hq_admin',
  'hq_after_sales',
  'store_manager',
  'store_sales',
]);

export function createFormSchemaHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const wrap = createWrapper(deps);

  const formSchema = wrap('formSchema', async (ctx: any, actor) => {
    const acl = (ctx.app as any)?.acl;

    // ---- ② 访问判定 ——
    //
    // 🔴 **不能用 `acl.can()`，这是本文件最重要的一条结论**（2026-11-10 两次实测推翻）：
    //    `acl.can()` 在**没有 `setStrategyResources()`** 的实例上会走策略层回退
    //    （`acl.js:241`：`strategyResources === null ⇒ 对任何资源都成立`），
    //    再叠加角色 `strategy.actions`（viewer / store_after_sales / store_sales 全是
    //    `["view","list","get"]`）⇒ **对 serviceArchives 一律返回 true**。
    //    而同一个 viewer 直连原生 `serviceArchives:list` 却是 **403**
    //    —— 因为那条路径被两层中间件拦：`native-metadata-guard`（能力白名单）+
    //    `store-scope`。所以"ACL 说能读"和"真的能读"根本不是同一件事。
    //    ⇒ 用本系统**真实的那道闸**：`NATIVE_READ_ALLOWLIST`（`native-metadata-guard`
    //      就按它判 403）。一个接口的鉴权与它要开放的资源，必须走同一份判据。
    //
    //    ⚠️ 注意 `serviceArchives` **本来就不在** NATIVE_READ_ALLOWLIST 里
    //      （那张表只列 serviceTickets / serviceVisits / ticketEvents / smsLogs）。
    //      所以这里的可用性判据是**档案角色集**（ARC-V1 的四个角色）：
    //      `hq_admin / hq_after_sales / store_manager / store_sales`
    //      —— 与 `dataSourcesRolesResources` 上 serviceArchives 的授予对象完全一致
    //      （2026-11-10 查库核对：只有这四个角色有 get/list/view）。
    //      viewer / store_after_sales **没有**档案授权 ⇒ 必须 403。
    const roles: string[] = collectRoleNames(
      ctx?.state?.currentUser ?? ctx?.auth?.user ?? ctx?.currentUser ?? ctx?.state?.auth?.user,
      ctx,
    );
    const platform = new Set(actor?.platformRoles ?? []);

    let allowed = platform.size > 0;
    if (!allowed) {
      for (const role of roles) {
        if (ARCHIVE_READ_ROLES.has(String(role).trim().toLowerCase())) {
          allowed = true;
          break;
        }
      }
    }

    if (!allowed) {
      return fail(ctx, 403, 'FORM_SCHEMA_FORBIDDEN', '当前角色无权读取该表单的字段定义', {
        collection: FORM_SCHEMA_COLLECTION,
        roles,
      });
    }

    // ---- 集合与字段元数据（纯 schema，零数据行）----
    const db = (ctx.app as any).db;
    const collection = db?.getCollection?.(FORM_SCHEMA_COLLECTION);
    if (!collection) {
      // 集合不存在是**部署缺陷**，不是权限问题 —— 用 404 区分开，
      // 免得运维照着 403 去查权限，查一整天。
      return fail(ctx, 404, 'FORM_SCHEMA_COLLECTION_MISSING', '该集合未在本数据源加载', {
        collection: FORM_SCHEMA_COLLECTION,
      });
    }

    const fields = [...collection.fields.values()]
      // ③ 只下发有 interface 的字段：没有 interface 的字段前端也渲染不出来，
      //    下发只会让前端多做一次"支持不支持"的猜测。
      .filter((f: any) => f?.options?.interface)
      .map((f: any) => ({
        name: f.name,
        type: f.type,
        interface: f.options?.interface,
        title: f.options?.uiSchema?.title ?? f.options?.title ?? f.name,
        ...(f.options?.target ? { target: f.options.target } : {}),
        ...(f.options?.targetKey ? { targetKey: f.options.targetKey } : {}),
        ...(f.options?.dataType ? { dataType: f.options.dataType } : {}),
        ...(f.options?.enum ? { enum: f.options.enum } : {}),
      }));

    ok(ctx, {
      name: collection.name,
      title: collection.options?.title ?? collection.name,
      filterTargetKey: collection.filterTargetKey,
      fields,
    });
  });

  return { formSchema };
}
