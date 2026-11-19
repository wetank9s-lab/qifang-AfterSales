# TECH-MEDIA-AUTH-01 / TECH-PHOTO-DELETE-01：建场结果（TEST INVALID）

> 时间：2026-10-23 11:07–11:30 CST
> 结论：**建场未完成 → TEST INVALID**。**没有得出任何授权结论**，也不申请 AUTH / DELETE PASS。
> 诚实说明：失败在我的脚本（psql 输出解析），**不是产品问题**。

---

## 1. 隔离前提（已确认）

| 项 | 实测 |
|---|---|
| 应用连接的库 | **scqf_media_test** ✅ |
| `SMS_ENABLED` | **false** ✅ |
| 媒体挂载 | **/opt/scqf-test-media** ✅ |
| 基线 | tickets=2、visits=0、medias=2、photos=0 |

---

## 2. 建场进度（实际发生的事）

| 步骤 | 结果 |
|---|---|
| 合成工单 A/B | **已建**（首轮 run 创建，id=**1**、**2**，`TEST-A-0001` / `TEST-B-0001`） |
| 合成 Visit A/B | ❌ **未建成** —— INSERT 因 ID 变量污染而语法错误 |
| 两枚 43 位 Token | 已生成（仅内存，Token 未落库 ⇒ 无效） |
| 合成媒体 A/B | **已上传**：id=**3**、**4**（`video/mp4`，258,819 B，`duration_ms=4000`）✅ |
| 媒体绑定工单 | ❌ **未绑定**（`ticket_id` 仍为 null） |
| 师傅照片 | ❌ 未上传（因 token 无效 → `TOKEN_INVALID`） |

**测试新增记录（供后续清理，均为 `scqf_media_test` 内）**：
`service_tickets` id=1,2；`customer_medias` id=3,4。**未触碰原 50 MiB 边界测试的 media id=1,2**。

---

## 3. 失败根因（我的脚本，不是产品）

`psql -t -A -F'|' -c "... returning id"` 会**先打印 id、再打印命令标签 `INSERT 0 1`**。
我最初用 `tail -1` 取最后一行，拿到的是 **`INSERT 0 1`** 而不是 id ⇒
后续 `values(INSERT 0 1, ...)` 语法错误 ⇒ Visit 建不出来 ⇒ Token 无载体 ⇒
`:get` 返回 0 条 ⇒ 所有跨单用例**无从执行**。

**正确做法**：用 `head -1`，或 `psql -q`，或 `-c "..." | grep -E '^[0-9]+$'`。

> 附带一条：我生成的 8 kHz WAV 被服务端判 `DURATION_UNREADABLE`
> （`wavDurationMs` 没能解析），改用已验证的 4 秒 MP4 夹具后上传正常。
> 这也再次印证「合法媒体要看服务端容器解析实现，不是文件后缀」。

---

## 4. 未取得的证据（全部 PENDING，一条都没跑）

| 用例 | 状态 |
|---|---|
| Token A 读媒体 A 成功 | **未执行** |
| Token A 读媒体 B 被拒 | **未执行** |
| Token B 读媒体 A 被拒 | **未执行** |
| 不存在 ref 被拒 | 仅生产侧间接证据（404） |
| 错误 Token 被拒 | 仅生产侧间接证据（401） |
| Visit 撤销后拒绝 | **未执行** |
| Visit 替换后旧 Token 拒绝 | **未执行** |
| 合法照片删除成功 | **未执行** |
| 他单/客户媒体/重复删除 | **未执行** |
| DB 与存储一致性 | **未执行** |
| H5 卡片更新 | **未执行** |

---

## 5. 下一步（重跑只差一个字符级修正）

1. 把 ID 捕获改成 `head -1`；
2. 用已建好的 tickets 1/2 + medias 3/4 直接补：`INSERT service_visits`（两次）+ `UPDATE customer_medias SET ticket_id`；
3. 再跑 8 条授权用例 + 照片删除用例。

预计一次脚本即可完成。

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产工单 / 媒体 / 照片 / 提交 / 短信 / DB | **0 / 0 / 0 / 0 / 0 / 0** |
| 生产 Nginx / H5 / 插件 | 未动 |
| 测试库写入 | 仅 `scqf_media_test` 的 tickets 1,2 + medias 3,4（已登记） |
| `.tmp-verify/dplay` | **仍保留**，未绕过 `SAFE_DELETE_FAIL_CLOSED` |
| Git | **未 commit / 未 push** |

---

## 7. 状态

**TECH-MEDIA-AUTH-01：TEST INVALID（建场未完成）**
**TECH-PHOTO-DELETE-01：TEST INVALID（同上）**
TECH-MEDIA-READ-ROUTE-01：READ FUNCTIONAL PASS / AUTH PENDING
TECH-MEDIA-RANGE-01：OPEN｜TECH-TOKEN-REFERRER-01：OPEN

P6：LIVE / CONDITIONAL；Release：HOLD。
