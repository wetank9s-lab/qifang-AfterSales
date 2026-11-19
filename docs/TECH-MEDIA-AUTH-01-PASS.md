# TECH-MEDIA-AUTH-01 / TECH-PHOTO-DELETE-01：隔离建场恢复与回归报告

> 时间：2026-10-23 11:11–11:35 CST
> 结论：**客户媒体跨工单授权回归 = PASS**（10 条用例，含深度重算 ref）；
> **照片删除 = TEST INVALID**（夹具类型错，未产生照片）。

---

## 1. psql 返回值解析的最小修复

原来的错：

```bash
psql -t -A -c "... returning id"   # 输出两行：先 id，再 "INSERT 0 1"
IDA=$(... | tail -1)               # ← 拿到 "INSERT 0 1"，后续 SQL 全废
```

改为：

```bash
Q(){ docker exec … psql -U … -q -t -A -c "$1"; }     # -q 关命令标签
ROW(){ local v; v=$(Q "$1" | tr -d '[:space:]');
       case "$v" in ''|*[!0-9]*) echo "PARSE_FAIL";; *) echo "$v";; esac; }
```

**严格性**：空输出 / 多行 / 含非数字 → `PARSE_FAIL` 并中止；`INSERT 0 1` 这类标签一律不接受。

---

## 2. 复用确认（未重建、未重传）

| ID | 类型 | 状态 |
|---|---|---|
| tickets **1**/**2** | `TEST-A-0001` / `TEST-B-0001` | 复用（首轮建的） |
| medias **3**/**4** | `video/mp4` 258,819 B / 4000ms | 复用（首轮上传的） |
| medias **1**/**2** | 50 MiB 边界测试媒体 | **未触碰**（复查仍 `ticket_id=null`）✅ |

**新增**：`service_visits` id=**1**（→ticket 1）、id=**2**（→ticket 2）。
**绑定**：`media 3 → ticket 1`、`media 4 → ticket 2`，均带 `ticket_id is null` 条件、各命中 1 行。

---

## 3. 一个关键发现：鉴权不止看 hash

第一版建完 Visit 仍报 `TOKEN_INVALID`。回源码（`services/token-service.ts:202-232`）才看到 `verify()` 的完整条件：

| 条件 | 要求 |
|---|---|
| `access_token_hash` | 匹配 sha256(明文) |
| **`token_expires_at`** | **必须存在且未过期** ← 我漏了这一个 |
| `token_used_at` | 必须为空 |
| `token_revoked_at` | 必须为空 |
| `visit_status` | `ASSIGNED` |
| 工单状态 | `NEW` 或 `PROCESSING` |

补 `token_expires_at = now() + 2 hours` 后，`:get` 立刻正常。
**这也是"手工建场必须按真实业务状态构造，不能只满足 NOT NULL"的活例子。**

---

## 4. 夹具有效性（真实 `:get`）

```
A: {"data":{"ticket_no":"TEST-A-0001","store_name":"新都圣大家电",…}}
B: {"data":{"ticket_no":"TEST-B-0001","store_name":"新都圣大家电",…}}
refA=Cexyu…  refB=yOkmg…   （均存在）
```

---

## 5. 媒体授权回归（10 条，全绿）

| # | 用例 | 状态码 | 返回字节 | 判定 |
|---|---|---|---|---|
| 1 | **A 读 A（正向）** | **200** | **258,819** | ✅ 真拿到媒体 |
| 2 | **B 读 B（正向）** | **200** | **258,819** | ✅ |
| 3 | **A 读 B（跨单）** | **404** | **79**（错误 JSON） | ✅ 无媒体字节 |
| 4 | **B 读 A（跨单）** | **404** | **79** | ✅ |
| 5 | 伪造 Token | **401** | 104 | ✅ |
| 6 | 不存在的 ref | **404** | 79 | ✅ |
| 7 | **深度：A 的 hash + mediaId=4 重算 ref** | **404** | **79** | ✅ **关键用例通过** |
| 8 | **深度对称：B 的 hash + mediaId=3** | **404** | **79** | ✅ |
| 9 | 撤销 Visit A 后读 A | **401** | 104 | ✅ |
| 10 | 替换 Token 后用旧 Token | **401** | 104 | ✅ |

**关于第 7/8 条（你特别要求的）**：按真实算法 `base64url(sha256(mediaId + ':' + tokenHash))[:22]`
用 **A 的 tokenHash 对 mediaId=4（B 的媒体）** 重算 ref，请求仍 **404** ——
说明拦截点是**候选集归属**（`listForTicket(ticket_id)`），不是"ref 猜不到"。
**这正是白盒越权测试要证明的东西。**

**每个拒绝用例都核了返回字节**：79/104 字节全是错误 JSON，**没有一例返回目标媒体字节**。

---

## 6. 照片删除：TEST INVALID（夹具类型错）

```
POST /api/technicianVisit:upload?token=A  -F file=@fx.mp4
→ {"code":"UNSUPPORTED_IMAGE","message":"只支持 JPEG / PNG / WEBP 格式的图片"}
```

师傅照片入口**只收图片**，我拿 MP4 去传 ⇒ 一张照片也没建出来 ⇒
`photoRef` 为空、`photos_in_db=0` ⇒ 后续删除用例全部落在 `PHOTO_NOT_FOUND`，**不能算证据**。

| 用例 | 结果 | 判定 |
|---|---|---|
| 合法删除成功 | 未发生（无照片） | ❌ 未取得 |
| 他单照片删除拒绝 | 404（因 ref 不存在，非归属拒绝） | ❌ 无效 |
| 客户媒体走删除接口 | 404 | ⚠️ 形式上通过，但**与合法删除同响应，不可作为证据** |
| 重复删除 | 404 | 同上 |
| DB 与存储一致 | `photos=0`，无从比较 | ❌ |

⇒ **TECH-PHOTO-DELETE-01：TEST INVALID**（需要一张真实 PNG/JPEG 重跑）。

---

## 7. H5 状态验证

隔离实例**不提供 H5 静态产物**（只跑 API）⇒ **UI 验证 PENDING**，未做任何模拟冒充。

---

## 8. 记录与清理

| 资源 | ID |
|---|---|
| 合成工单 | **1、2**（另有 2 条早前重复尝试留下的 3、4 号工单） |
| 合成 Visit | **1**（ticket 1）、**2**（ticket 2） |
| 合成媒体 | **3**（→ticket1）、**4**（→ticket2） |
| 保留媒体 | **1、2**（50 MiB 边界，`ticket_id` 仍为 null）✅ |
| 师傅照片 | 0（未创建成功） |

计数：`tickets=4 visits=2 medias=4 photos=0`

**清理方案**（未执行，等验收后按 ID 精确删）：
`service_visits` 1,2 → `customer_medias` 3,4（连同 `/opt/scqf-test-media` 下对应文件）→ `service_tickets` 1,2,3,4。
**不删 media 1,2**，不删任何生产资源。

---

## 9. 生产纪律

| 项 | 状态 |
|---|---|
| 生产工单 / 媒体 / 照片 / 提交 / 短信 / DB | **0 / 0 / 0 / 0 / 0 / 0** |
| 生产 Nginx / H5 / 插件 | 未动 |
| 测试库写入 | 仅 `scqf_media_test`（上表 ID） |
| `.tmp-verify/dplay` | 仍保留，未绕过 |
| Git | **未 commit / 未 push** |

---

## 10. 申请

| 项 | 状态 |
|---|---|
| **TECH-MEDIA-AUTH-01** | **PASS**（10 条用例含深度重算 ref，均核过返回字节） |
| TECH-PHOTO-DELETE-01 | **TEST INVALID**（需 PNG/JPEG 夹具重跑） |
| TECH-MEDIA-READ-ROUTE-01 | READ FUNCTIONAL PASS / AUTH **现可升为 PASS**（隔离侧已证） |
| TECH-MEDIA-RANGE-01 | OPEN |
| TECH-TOKEN-REFERRER-01 | OPEN |
| H5 删除后卡片更新 | PENDING（隔离实例无 H5） |

P6：LIVE / CONDITIONAL；Release：HOLD。
