# 门店查看/复制师傅链接 · 接口设计（待一个产品决策后即可实现）

> 2026-10-29　状态：**设计完成，未实现**（缺一个必须先定的语义，见 §2）
> 触发：门店问「FW20261029-0002 的师傅链接给我」，而系统当前**没有**任何读回明文的出口。

---

## 1. 为什么"查看"不能是只读的（硬约束）

| 事实 | 位置 |
|---|---|
| 库里只存 `access_token_hash = sha256(明文)` | `TokenService.mint()` / `collections/serviceVisits.ts` |
| 明文链接只进 `PendingSms.request.params.link`，**内存态** | `ticket-service.ts:2707`（注释：不落 SmsLog、不进事件） |
| 全仓只有 `mint()` 会拼链接（`linkOf` 仅在其内部被调用） | `token-service.ts:121/153` |
| 没有任何 action 返回过 `link` | 全量 grep `linkOf(` 仅 1 处调用 |

⇒ 对**已签发**的 Visit，明文在生成那一刻之后就消失了。**读不回来，不是没写接口。**

## 2. 必须先定的一个决策

| 方案 | 语义 | 代价 | 需要 migration |
|---|---|---|---|
| **A. 查看即重签**（推荐） | 点「获取师傅链接」→ **换发**新 Token，返回新链接，**旧链接立即失效** | 客服一点，师傅手里的旧链接就打不开了；必须二次确认 + 明确文案 | 否 |
| B. 保存可读链接 | 新增一列存明文/密文，随时读 | 违背"只存哈希"的安全设计；等于把长期凭证放进 DB | **是**（你已明令本轮不授权 migration） |
| C. 只在派工那一刻可复制 | 派工/改派/改约的响应里带 `technician_link`（一次性，不落库） | 历史单仍看不到；对 FW20261029-0002 无效 | 否 |

> A 与 C 不冲突，可以都做：C 解决"新单顺手复制"，A 解决"历史单补救"。

## 3. 方案 A 的接口契约（已设计好，可直接实现）

```
POST /api/svc:technicianLink?filterByTk=<ticketId>
Headers: X-Request-Id: <uuid>   Authorization: Bearer <store|hq_admin 令牌>
```

**权限**：复用 `permissions.assertCanWriteTicket(actor, ticketId)`（门店只能操作本店；只读角色 403；匿名 401）。
**前置**：工单存在；存在 `visit_status=ASSIGNED` 且 `token_used_at IS NULL` 的当前 Visit；否则 409 + 业务码。

**响应（成功 200）**
```json
{
  "ticket": { "id": 6941, "ticket_no": "FW20261029-0002", "status": "PROCESSING" },
  "visit":  { "id": 2652, "visit_no": 1, "technician_name": "黄师傅" },
  "link": "https://sh.scqfls.cn/t/<43 位 base64url>",
  "expires_at": "2026-11-01T16:38:00.000Z",
  "replaced": true,
  "event": { "id": ..., "event_type": "internal_note" }
}
```
- `link` **只在本响应出现一次**，不落库、不进事件、不进日志。
- 事件用既有 `EVENT_TYPE.INTERNAL_NOTE`（`event_type` 是枚举列，**新增值需要 DB 变更**，本轮不做），
  摘要写「系统：重新签发师傅作业链接（旧链接已失效）」。

**幂等**：这里有个坑，必须显式处理——
- 不能把 `link` 放进幂等记录（那等于把明文写进 `idempotencyRecords.response`）；
- 但若重放时静默"不返回链接"，用户会以为失败，而服务端其实已经换发了一枚可用 Token（旧链接已死），
  这是**最难查的状态**。
- ⇒ 采用：同 `X-Request-Id` 重放返回 **409 `LINK_REISSUE_REPLAYED`**，
  文案「该请求已签发过链接（明文不保存），请再次点击获取新链接」。
  即：**重试不会静默换发，也不会静默丢链接。**

## 4. 实现清单（约 4 个文件，无 migration）

| 文件 | 改动 |
|---|---|
| `server/constants.ts` | `SVC_ACTION.REISSUE_LINK = 'technicianLink'`；`INTERNAL_WRITE_SCENE.REISSUE_LINK = 'svc_reissue_link'` |
| `server/services/ticket-service.ts` | 新增 `reissueTechnicianLink(ticketId, actor, idempotency)`：事务内 `findActiveByTicket` → `tokens.reissue` → `events.write(INTERNAL_NOTE)`；**返回 link 但不进幂等快照** |
| `server/actions/svc/dispatch.ts` | 新增 action `technicianLink`：`requireRequestId` → `requireTicketId` → `assertCanWriteTicket` → 调服务 |
| `client/ticket-store-review.tsx` 或 `primary-action.tsx` | 按钮「获取师傅链接」+ 二次确认（文案必须写明"旧链接立即失效"）+ 成功后显示可复制输入框 |

**验证**（p6-uat 真接口，不碰生产）：
1. 拿新链接 → `GET /api/technicianVisit:get?token=<新>` = 200；
2. 同 Visit 的旧 Token（上一枚） → 401；
3. 只读角色调用 → 403；匿名 → 401；
4. 同 `X-Request-Id` 重放 → 409 且 `token_reissued` 未再发生（`access_token_hash` 不变）。

## 5. 对当前那张单（FW20261029-0002）

- 现在：Visit 2652 / 黄师傅 / `ASSIGNED` / 链接有效期到 11-01 16:38 / **未使用未吊销**，但明文已不可取回。
- 走方案 A 后：点一次即得新链接，**旧链接（若已发给黄师傅）立即失效**。
- 若你只想让黄师傅打开页面、且不介意旧链接作废：现在就可以用 A 的临时脚本版先给你一条；
  但那属于"在生产换发 Token"，需要你一句明确批准。

## 6. 需要你回一句话

> **A（查看即重签，二次确认旧链接失效）** ／ **B（存明文，接受 migration 与安全评审）** ／ **A+C（推荐：新单可复制 + 历史单可重签）**

定了我就按 §3/§4 直接实现并跑 §3 的四条真接口验证；不涉及生产部署。
