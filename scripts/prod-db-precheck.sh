#!/usr/bin/env bash
# 生产数据库只读检查（粘贴到云服务器控制台 / SSH 会话里执行）
#
# 纪律：整段只有 SELECT 与系统目录查询，没有一条 DDL/DML/迁移/重启。
# 输出会被逐段贴回，所以每段都带 ### 标记 —— 缺哪段就是哪段没跑到。
#
# 用法：
#   ssh root@162.14.121.180     （或腾讯云控制台「登录」）
#   docker ps | grep -i postgres          # 先确认容器名
#   把下面 PG= 改成实际容器名，然后整段粘贴

set -u
PG="${PG:-scqf-as-postgres}"
DB="${DB:-service_ticket}"

run() { docker exec -i "$PG" psql -U svc_app -d "$DB" -P pager=off -c "$1"; }

echo "===== 0. 环境 ====="
docker ps --format '{{.Names}}  {{.Status}}' | head -20
echo

run "SELECT '### 1.迁移总数' AS sec, count(*) AS migrations_total FROM migrations;"

run "SELECT '### 1b.本次涉及的迁移是否已登记' AS sec, name
       FROM migrations
      WHERE name LIKE '%20261106%'
         OR name LIKE '%20261023%'
         OR name LIKE '%20261025%'
      ORDER BY name;"

run "SELECT '### 2a.service_visits 索引' AS sec, indexname
       FROM pg_indexes WHERE tablename='service_visits' ORDER BY indexname;"

run "SELECT '### 2b.service_tickets 索引' AS sec, indexname
       FROM pg_indexes WHERE tablename='service_tickets' ORDER BY indexname;"

run "SELECT '### 2c.service_visits 待新增列是否已存在' AS sec,
            column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name='service_visits'
        AND column_name IN ('short_code_hash','short_code_expires_at',
                            'manual_code_salt','manual_code_hash',
                            'manual_code_expires_at','manual_code_epoch')
      ORDER BY column_name;"

run "SELECT '### 3a.trg_service_visits_one_assigned' AS sec,
            t.tgname, c.relname, t.tgenabled, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
      WHERE t.tgname='trg_service_visits_one_assigned';"

run "SELECT '### 3b.service_visits 全部非内部触发器' AS sec, t.tgname, t.tgenabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname='service_visits' AND NOT t.tgisinternal
      ORDER BY t.tgname;"

# ↓↓↓ 用户指定的重复派工查询，原样执行（只读）
run "SELECT '### 4.同一工单多个 ASSIGNED' AS sec, ticket_id, COUNT(*) AS assigned_count
       FROM service_visits
      WHERE visit_status = 'ASSIGNED'
      GROUP BY ticket_id
     HAVING COUNT(*) > 1
      ORDER BY ticket_id;"

run "SELECT '### 4b.重复汇总' AS sec,
            count(*) AS dup_ticket_count,
            COALESCE(sum(assigned_count),0) AS involved_rows
       FROM (SELECT ticket_id, COUNT(*) AS assigned_count
               FROM service_visits
              WHERE visit_status='ASSIGNED'
              GROUP BY ticket_id
             HAVING COUNT(*)>1) x;"

run "SELECT '### 4c.visit_status 分布' AS sec, visit_status, count(*) AS n
       FROM service_visits GROUP BY visit_status ORDER BY n DESC;"

run "SELECT '### 5a.库规模与关键表行数' AS sec,
            pg_size_pretty(pg_database_size(current_database())) AS db_size,
            (SELECT count(*) FROM service_tickets) AS tickets,
            (SELECT count(*) FROM service_visits)  AS visits;"

run "SELECT '### 5b.短信日志分布（部署不该动它，作基线）' AS sec,
            send_status, provider, count(*) AS n
       FROM sms_logs GROUP BY send_status, provider ORDER BY n DESC;"

echo "===== 完成（以上全部为只读；未执行任何 DDL/DML/迁移/重启） ====="
