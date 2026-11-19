#!/usr/bin/env bash
# ARC-V1 · 生产数据库只读预检（S2 增量，补充 prod-db-precheck.sh 未覆盖的 ARC 项）
#
# 纪律：整段只有 SELECT / pg_catalog 查询，没有一条 DDL/DML/迁移/重启。
# 输出每段带 ### 标记 —— 缺哪段就是哪段没跑到。
#
# 定位：现有 `scripts/prod-db-precheck.sh` 覆盖"迁移/索引/触发器/ASSIGNED/库规模/短信基线"，
#       但**不含 R0 要求的 ARC 项**（六表存在性、路由 UID 冲突、member 授权范围、门店与账号绑定）。
#       本脚本只补 ARC 增量，不重复那份。
#
# 用法：
#   ssh root@162.14.121.180        （或腾讯云控制台「登录」）
#   docker ps | grep -i postgres   # 先确认容器名
#   PG=scqf-as-postgres DB=scqf_aftersales_candidate bash prod-db-precheck-arc.sh
#
# ⚠️ 生产库名是 scqf_aftersales_candidate / 用户 scqf_as（见 docs/PROD-DEPLOY-LOG.md）。
#    prod-db-precheck.sh 里的 DB=service_ticket 是**开发库默认值/模板占位**，不是生产值。
#    本脚本默认值即生产值，但**仍请先跑第 0 段确认库名与量级**（S0 判据）。

set -u
PG="${PG:-scqf-as-postgres}"
DB="${DB:-scqf_aftersales_candidate}"
DBUSER="${DBUSER:-scqf_as}"

run() { docker exec -i "$PG" psql -U "$DBUSER" -d "$DB" -P pager=off -c "$1"; }

echo "===== 0. 环境与目标库自证（S0 判据） ====="
docker ps --format '{{.Names}}  {{.Status}}' | head -20
run "SELECT '### 0a.当前库与规模' AS sec, current_database() AS db,
            pg_size_pretty(pg_database_size(current_database())) AS size,
            (SELECT count(*) FROM service_tickets) AS tickets,
            (SELECT count(*) FROM service_visits)  AS visits;"
# 判据：库名 = scqf_aftersales_candidate，且 tickets 是**生产量级**（数百以上）。
#       若 tickets/tickets 只有几十 ~ 几千且库名是 service_ticket ⇒ 你连的是开发库，停。

echo
echo "===== 1. ARC 六张业务表是否存在（由插件自动建，不靠迁移） ====="
run "SELECT '### 1a.ARC 六表存在性' AS sec, t.name AS table_name,
            (c.oid IS NOT NULL) AS exists
       FROM (VALUES ('service_archives'),
                    ('service_archive_stages'),
                    ('service_archive_events'),
                    ('service_archive_photos'),
                    ('service_archive_query_sessions'),
                    ('service_archive_verify_codes')) AS t(name)
       LEFT JOIN pg_class c ON c.relname = t.name AND c.relkind = 'r'
      ORDER BY t.name;"
# 期望：**上线前应为全 false**（六表尚未创建，部署后由 loadCollections 自动建）。
#       若已有 true，说明之前跑过 —— 需要先确认里面有没有真实档案数据，别盲目重放。

run "SELECT '### 1b.若已存在，行数（判断是否已有真实数据）' AS sec, t.name AS table_name,
            CASE WHEN c.oid IS NULL THEN NULL ELSE 0 END AS placeholder
       FROM (VALUES ('service_archives')) AS t(name)
       LEFT JOIN pg_class c ON c.relname = t.name AND c.relkind = 'r';"

echo
echo "===== 2. 路由 / 模型 UID 冲突预检（C3，最关键的一项） ====="
run "SELECT '### 2a.ARC 两条 schemaUid 是否已被 desktopRoutes 占用' AS sec,
            id, type, \"schemaUid\", title
       FROM \"desktopRoutes\"
      WHERE \"schemaUid\" IN ('n5c25yq5qlt','97x481j2bv1');"
# 期望：**0 行**。若有行 ⇒ 撞号，重放脚本会"按 schemaUid 回查复用"⇒ **静默串页**，必须停手改名重放。

run "SELECT '### 2b.ARC 页面模型 uid 是否已被 flowModels 占用' AS sec, count(*) AS hit
       FROM \"flowModels\"
      WHERE uid IN ('n5c25yq5qlt','97x481j2bv1',
                    'c2d0e320f4c','3b3ce952a41','3ebe3d19d1c','4a9895992a1',
                    '559eff98d00','5baefb48c9e','6314ed18eef','6a0e3309720',
                    '786debe3874','78d58467c4a','88bc036b9d8','9ca9bc1bbdb',
                    'b5350c06acc','c27422abfd2','c3c50ec1f43','c778e1f724e',
                    'd22055a2041','de399c62339','e3d1ed504e3','f5fbb7bb373',
                    'f96f3bd8cf2','fbbc7e231c3','fd211bce27b');"
# 期望：0。整套 uid 清单来自 scripts/arc/arc-v1-page-payload.json。

run "SELECT '### 2c.生产 desktopRoutes 现有规模（对照，非判据）' AS sec,
            type, count(*) AS n
       FROM \"desktopRoutes\" GROUP BY type ORDER BY n DESC;"
# 说明：生产已有历史后台页面（如 /admin/qke3hyq3v92）。**这不是冲突**，只是背景量级。

echo
echo "===== 3. member 的路由授权范围（C2，S6-B 的前置基线） ====="
run "SELECT '### 3a.member 授权的路由总数' AS sec, count(*) AS member_grants
       FROM \"rolesDesktopRoutes\" WHERE \"roleName\" = 'member';"

run "SELECT '### 3b.member 是否已授权 ARC 两条（若 2a 为 0 行，此项必为 0）' AS sec,
            count(*) AS member_arc_grants
       FROM \"rolesDesktopRoutes\" rdr
       JOIN \"desktopRoutes\" dr ON dr.id = rdr.\"desktopRouteId\"
      WHERE rdr.\"roleName\" = 'member'
        AND dr.\"schemaUid\" IN ('n5c25yq5qlt','97x481j2bv1');"

run "SELECT '### 3c.各角色的路由授权行数（看是否有意外角色全量可见）' AS sec,
            \"roleName\", count(*) AS n
       FROM \"rolesDesktopRoutes\" GROUP BY \"roleName\" ORDER BY n DESC;"

run "SELECT '### 3d.member 的 default / allowNewMenu 开关' AS sec, name, \"default\",
            \"allowNewMenu\", \"allowNewMobileMenu\"
       FROM roles WHERE name = 'member';"
# 列名取证：NocoBase 元数据下发（.tmp-verify/a6-admin-meta.json，collectionName=roles）。
# 说明：allowNewMobileMenu=t 意味着"以后每建一个移动页，member 自动拿到"⇒ 这是 A5 要收敛的根因。

echo
echo "===== 4. 门店与账号绑定（C1） ====="
run "SELECT '### 4a.十家门店（生产 ID 不连续，禁假设 1..10）' AS sec,
            id, code, name, active
       FROM stores ORDER BY id;"
# 期望：id ∈ {1,4,8,9,10,11,12,13,14,15}，全部 active=true。

run "SELECT '### 4b.账号 904 的角色（应只有 store_after_sales，不含 member）' AS sec,
            u.id, u.email, r.\"roleName\"
       FROM users u
       LEFT JOIN \"rolesUsers\" r ON r.\"userId\" = u.id
      WHERE u.id = 904;"

run "SELECT '### 4c.账号 904 的门店绑定（C1：报告记 [4]，A0 记 10 家，以现网为准）' AS sec,
            su.user_id, su.store_id, s.code AS store_code
       FROM store_users su
       LEFT JOIN stores s ON s.id = su.store_id
      WHERE su.user_id = 904 ORDER BY su.store_id;"
# ⚠️ 这里读到什么就是什么。**只读，不要改**（用户明确：不改 904 的绑定）。

run "SELECT '### 4d.悬空门店绑定（A0 记 user 194 → store 2）' AS sec,
            su.user_id, su.store_id
       FROM store_users su
       LEFT JOIN stores s ON s.id = su.store_id
      WHERE s.id IS NULL;"

echo
echo "===== 5. 角色与迁移基线 ====="
run "SELECT '### 5a.现有角色' AS sec, name, title FROM roles ORDER BY name;"
# 期望（上线前）：无 store_sales / store_manager（这两个由迁移 202611091 新建）。

run "SELECT '### 5b.迁移登记总数（上线前 41）' AS sec, count(*) AS migrations_total
       FROM migrations;"

run "SELECT '### 5c.本次增量迁移是否已登记（应 0 行）' AS sec, name
       FROM migrations WHERE name LIKE '%202611091%' OR name LIKE '%arc-v1%';"

echo
echo "===== 6. 短信基线（部署不得改动，作对照） ====="
run "SELECT '### 6a.短信日志分布' AS sec, send_status, delivery_status, provider, count(*) AS n
       FROM sms_logs GROUP BY send_status, delivery_status, provider ORDER BY n DESC LIMIT 20;"
# ⚠️ send_status 是队列、delivery_status 是送达 —— 两列不可混用（见 DEV-204）。

run "SELECT '### 6b.档案验证码场景是否已启用真实发送（应为 0）' AS sec, count(*) AS n
       FROM sms_logs WHERE scene = 'archive_verify';"

echo "===== 完成（以上全部为只读；未执行任何 DDL/DML/迁移/重启） ====="
