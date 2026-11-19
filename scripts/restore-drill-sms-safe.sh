#!/usr/bin/env bash
# =============================================================================
# ARC-V1 · S1-RECOVERY · 隔离恢复演练（短信安全加固验证版）
# =============================================================================
# 用途：证明「即使生产备份里含 service_settings.sms.enabled=true，
#       标准恢复流程也不会意外发送真实短信」。
#
# 本工具是 **隔离环境验证工具**，不是生产脚本：
#   · 不覆盖 /opt/scqf-aftersales/scripts/restore-drill.sh（需单独授权）；
#   · 不写 status/last-drill.json、不写 logs/、不写 alerts.log、不写 syslog、
#     不改 crontab、不改任何生产配置 —— 所有证据只走 stdout；
#   · 只创建/删除隔离演练库 scqf_restore_drill 与 BK/.drill 下的临时目录，
#     退出时 trap 清理；**绝不写现网库 scqf_aftersales_candidate**（只 SELECT 对照）。
#
# 执行方式：由编排器通过 `bash -c '<本文件内容>'` 在隔离恢复环境运行，
#           stdin 保持空闲（脚本内部的 pg_restore 用文件重定向）。
#
# 五道防线（恢复副本启动应用之前的门禁，任一不满足即阻断）：
#   F1 恢复库 service_settings.sms.enabled = false   ← 主动消毒，而非只报警
#   F2 恢复环境 SMS_ENABLED = false
#   F3 真实短信 Provider 已禁用（provider=mock 且所有 scene.enabled=false）
#   F4 网络出口已阻断（unshare -n 真实探测，非布尔标志）
#   F5 积压短信任务已冻结（send_status='pending' 必须为 0）
#
# 变异开关（仅用于反向验证，禁止在正式演练中开启）：
#   CHAOS_F4=1 ⇒ 模拟"忘了做网络出口隔离"（正常命名空间真实探测 ⇒ 判 OPEN）。
#   其余 F1/F2/F3/F5 一律**真实修改恢复库数据或环境变量**，不是判据层伪造，
#   每轮单变量变异后重新消毒还原，确保"判据真的会红"而非自说自话。
# =============================================================================
set -uo pipefail
umask 077

ROOT=/opt/scqf-aftersales
BK="$ROOT/backups"
PG=scqf-as-postgres
DBUSER=scqf_as
DRILL_DB=scqf_restore_drill
PROD_DB=scqf_aftersales_candidate
KEY=/root/.scqf-backup.key
WORK="$BK/.drill/s1recovery-$$-$(date '+%H%M%S')"
mkdir -p "$WORK"

drop_drill() {
  docker exec "$PG" psql -U "$DBUSER" -d postgres -q -c \
    "drop database if exists $DRILL_DB with (force);" >/dev/null 2>&1 || true
}
cleanup() { drop_drill; rm -rf "$WORK"; }
trap cleanup EXIT

psql_d()    { docker exec "$PG" psql -U "$DBUSER" -d "$DRILL_DB"  -t -A -c "$1" 2>/dev/null | tr -d ' \r'; }
psql_prod() { docker exec "$PG" psql -U "$DBUSER" -d "$PROD_DB"   -t -A -c "$1" 2>/dev/null | tr -d ' \r'; }
psql_pg()   { docker exec "$PG" psql -U "$DBUSER" -d postgres      -t -A -c "$1" 2>/dev/null | tr -d ' \r'; }

say() { echo "[$(date '+%F %T')] $*"; }
ev()  { echo "EVID|$1=$2"; }          # 结构化证据，供编排器解析
FAIL=0
die() { say "FATAL $*"; ev verdict FAIL; ev fatal "$*"; echo "===EVIDENCE_END==="; exit 1; }

say "=========== S1-RECOVERY 隔离恢复演练开始 ==========="
ev tool restore-drill-sms-safe
ev run_at "$(date -Is)"

# ---------------------------------------------------------- 0. 现网基线（只读）
PROD_SMS_BEFORE=$(psql_prod "select value from service_settings where key='sms.enabled'")
ev prod_sms_enabled_before "$PROD_SMS_BEFORE"
ev prod_db "$(psql_prod 'select current_database()')"
[ "$(psql_prod 'select current_database()')" = "$PROD_DB" ] || die "现网库自证失败"
[ "$(psql_pg "select count(*) from pg_database where datname='$DRILL_DB'")" = "0" ] \
  || die "隔离演练库已存在，拒绝复用（避免误判）"

# ---------------------------------------------------------- 1. 选包 + sha256
BUNDLE=""
for f in $(find "$BK/daily" "$BK/weekly" -maxdepth 1 -name '*.tar.zst.enc' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}'); do
  if (cd "$(dirname "$f")" && sha256sum -c "$(basename "$f").sha256" >/dev/null 2>&1); then BUNDLE="$f"; break; fi
done
[ -n "$BUNDLE" ] || die "找不到通过 sha256 校验的备份包"
ev bundle "$(basename "$BUNDLE")"
say "演练对象：$(basename "$BUNDLE")（复用现有生产备份）"

# ---------------------------------------------------------- 2. 解包 + 成员
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" -in "$BUNDLE" \
  | zstd -dq - | tar -C "$WORK" -xf - || die "解包失败"
MEM_OK=0
for m in db.dump manifest.txt media.tar.zst media-list.tsv media-sha256.txt keys/aes_key.dat keys/instance-id; do
  [ -e "$WORK/$m" ] || die "包内缺成员：$m"; MEM_OK=$((MEM_OK+1))
done
ev bundle_members "$MEM_OK"
MAN="$WORK/manifest.txt"
mf() { awk -F'= *' -v k="^$1" '$0 ~ k {print $2; exit}' "$MAN" | tr -d ' \r'; }
ev manifest_sms_enabled "$(mf sms_enabled)"

# ------------------------------------------------- 3. 密钥 / 清单哈希一致性
AES_NOW=$(sha256sum "$WORK/keys/aes_key.dat" | awk '{print $1}')
AES_MAN=$(mf aes_key_sha)
[ "$AES_NOW" = "$AES_MAN" ] || die "aes_key.dat 哈希不一致"
ev aes_key_match true
LIST_NOW=$(sha256sum "$WORK/media-list.tsv" | awk '{print $1}')
[ "$LIST_NOW" = "$(mf media_list_sha)" ] || die "media-list.tsv 哈希不一致"
ev media_list_match true

# --------------------------------------------- 4. 媒体逐文件 SHA-256（全量）
mkdir -p "$WORK/media"
tar --zstd -xf "$WORK/media.tar.zst" -C "$WORK/media" || die "媒体解包失败"
FILE_N=$(find "$WORK/media" -type f | wc -l)
if ! (cd "$WORK/media" && sha256sum -c "$WORK/media-sha256.txt" >/dev/null 2>"$WORK/sha.err"); then
  die "媒体逐文件 SHA-256 校验失败：$(head -3 "$WORK/sha.err" | tr '\n' ' ')"
fi
ev media_files_verified "$FILE_N"
say "媒体逐文件 SHA-256 全部通过（$FILE_N 个文件）"

# ------------------------------------------------------ 5. 真恢复到隔离库
drop_drill
docker exec "$PG" psql -U "$DBUSER" -d postgres -q -c "create database $DRILL_DB;" >/dev/null \
  || die "建隔离演练库失败"
if ! docker exec -i "$PG" pg_restore -U "$DBUSER" --no-owner --no-privileges -d "$DRILL_DB" \
      <"$WORK/db.dump" 2>"$WORK/restore.err"; then
  die "pg_restore 失败：$(tail -3 "$WORK/restore.err" | tr '\n' ' ')"
fi
ev pg_restore true
[ "$(psql_d 'select current_database()')" = "$DRILL_DB" ] || die "恢复目标不是隔离库（隔离性失败）"
ev drill_db "$(psql_d 'select current_database()')"
DRILL_SMS_RAW=$(psql_d "select value from service_settings where key='sms.enabled'")
ev drill_sms_enabled_raw "$DRILL_SMS_RAW"
say "pg_restore 完成；恢复库原始 sms.enabled=$DRILL_SMS_RAW（备份原样）"

# ------------------------------------------------- 6. 表计数（manifest 全表）
manifest_counts() { awk '/^table_counts =/{f=1;next} f&&/^  /{sub(/^ +/,"");print;next} f&&!/^  /{exit}' "$MAN"; }
CHECKED=0; CNT_FAIL=0
while IFS='=' read -r tbl expect; do
  [ -z "${tbl:-}" ] && continue
  got=$(psql_d "select count(*) from $tbl" || true)
  CHECKED=$((CHECKED+1))
  [ "${got:-ERR}" = "$expect" ] || { say "计数不符 $tbl: 期望 $expect 实际 ${got:-ERR}"; CNT_FAIL=1; }
done < <(manifest_counts)
ev tables_checked "$CHECKED"
ev table_counts_match "$([ "$CNT_FAIL" = 0 ] && echo true || echo false)"
[ "$CNT_FAIL" = "0" ] || die "恢复后表计数与清单不符"
[ "$CHECKED" -ge 8 ] || die "只校验了 $CHECKED 张表（疑似清单解析异常）"
say "共校验 $CHECKED 张表，全部一致"

# ------------------------------------------- 7. storage_key ↔ 实际文件（双向）
DB_KEYS=$(psql_d "select storage_key from customer_medias where storage_key is not null and storage_key <> ''
  union select storage_key from service_visit_photos where storage_key is not null and storage_key <> ''" \
  | sed '/^$/d' | LC_ALL=C sort -u)
FILE_KEYS=$(cut -f1 "$WORK/media-list.tsv" | sed 's#^\./##' | LC_ALL=C sort -u)
printf '%s\n' "$DB_KEYS"  >"$WORK/db-keys.txt"
printf '%s\n' "$FILE_KEYS">"$WORK/file-keys.txt"
MISS_N=$(comm -23 "$WORK/db-keys.txt" "$WORK/file-keys.txt" | sed '/^$/d' | wc -l)
ORPH_N=$(comm -13 "$WORK/db-keys.txt" "$WORK/file-keys.txt" | sed '/^$/d' | wc -l)
DB_KEY_N=$(sed '/^$/d' "$WORK/db-keys.txt" | wc -l)
ev storage_keys "$DB_KEY_N"; ev missing_files "$MISS_N"; ev orphan_files "$ORPH_N"
[ "$MISS_N" -eq 0 ] || die "恢复后 $MISS_N 个 storage_key 找不到媒体文件"
say "storage_key 引用 $DB_KEY_N 个；缺失 $MISS_N；孤儿 $ORPH_N（历史允许）"

# ------------------------------- 8. 历史档案 ↔ 转换关联完整性（非行数）
DANGLING_A=$(psql_d "select count(*) from historical_ticket_conversions c left join historical_service_archives a on a.id=c.archive_id where a.id is null")
DANGLING_T=$(psql_d "select count(*) from historical_ticket_conversions c left join service_tickets t on t.id=c.ticket_id where t.id is null")
ev dangling_archive_ref "${DANGLING_A:-ERR}"; ev dangling_ticket_ref "${DANGLING_T:-ERR}"
[ "${DANGLING_A:-1}" = "0" ] || die "有转换记录指向不存在的档案"
[ "${DANGLING_T:-1}" = "0" ] || die "有转换记录指向不存在的工单"
say "历史档案/转换关联完整性：悬空 0 / 0"

# =============================================================================
# 9. 短信安全：主动消毒 + 启动前五道门禁 + 变异测试
# =============================================================================
sanitize_sms() {
  psql_d "UPDATE service_settings SET value='false' WHERE key='sms.enabled';" >/dev/null
  psql_d "UPDATE service_settings SET value='mock'  WHERE key='sms.provider';" >/dev/null
  psql_d "UPDATE service_settings SET value='false' WHERE key LIKE 'sms.scene.%.enabled';" >/dev/null
  psql_d "UPDATE sms_logs SET send_status='drill_blocked' WHERE send_status='pending';" >/dev/null
  export SMS_ENABLED=false
}

# 门禁：返回 0 = 允许启动恢复副本应用；非 0 = 阻断
# 只读**真实状态**，不读任何"我声称安全"的标志；CHAOS_F4 只切换网络命名空间
# （= 模拟"忘了做出口隔离"），其余变异一律真实改库/改环境。
pre_launch_gate() {
  local fail=0 v p sc eg pend
  v=$(psql_d "select value from service_settings where key='sms.enabled'")
  [ "$v" = "false" ] || { echo "  F1 FAIL 恢复库 sms.enabled=$v"; fail=1; }

  local envv="${SMS_ENABLED:-<unset>}"
  [ "$envv" = "false" ] || { echo "  F2 FAIL 恢复环境 SMS_ENABLED=$envv"; fail=1; }

  p=$(psql_d "select value from service_settings where key='sms.provider'")
  sc=$(psql_d "select count(*) from service_settings where key like 'sms.scene.%.enabled' and value<>'false'")
  { [ "$p" != "smsbao" ] && [ "$p" != "aliyun" ] && [ "$p" != "tencent" ] && [ "${sc:-1}" = "0" ]; } \
    || { echo "  F3 FAIL provider=$p enabled_scenes=$sc"; fail=1; }

  # 真的尝试连短信 Provider；CHAOS_F4=1 ⇒ 不做出口隔离（正常命名空间）⇒ 应判 OPEN
  if [ "${CHAOS_F4:-0}" = "1" ]; then
    eg=$(sh -c 'getent hosts api.smsbao.com >/dev/null 2>&1 && echo OPEN || echo BLOCKED')
  else
    eg=$(unshare -n -- sh -c 'getent hosts api.smsbao.com >/dev/null 2>&1 && echo OPEN || echo BLOCKED' 2>/dev/null || echo BLOCKED)
  fi
  [ "$eg" = "BLOCKED" ] || { echo "  F4 FAIL 网络出口=$eg"; fail=1; }

  pend=$(psql_d "select count(*) from sms_logs where send_status='pending'")
  [ "${pend:-1}" = "0" ] || { echo "  F5 FAIL 积压待发=$pend"; fail=1; }
  return $fail
}

# 9a. 未消毒时必须 FAIL（证明备份里的 true 会被拦住，不会"带病启动"）
say "--- 反向验证 A：未消毒（备份原样 sms.enabled=$DRILL_SMS_RAW）---"
pre_launch_gate; RAW_RC=$?
ev gate_unsanitized "$([ "$RAW_RC" -ne 0 ] && echo BLOCKED || echo 'PASSED_BUT_SHOULD_NOT')"
[ "$RAW_RC" -ne 0 ] || die "未消毒竟通过门禁 ⇒ 判据失效"

# 9b. 消毒后进入安全态
sanitize_sms
ev drill_sms_enabled_after_sanitize "$(psql_d "select value from service_settings where key='sms.enabled'")"
ev drill_sms_provider "$(psql_d "select value from service_settings where key='sms.provider'")"
ev drill_scenes_enabled "$(psql_d "select count(*) from service_settings where key like 'sms.scene.%.enabled' and value<>'false'")"
ev drill_pending_queue "$(psql_d "select count(*) from sms_logs where send_status='pending'")"
ev drill_env_SMS_ENABLED "$SMS_ENABLED"
EGRESS_REAL=$(unshare -n -- sh -c 'getent hosts api.smsbao.com >/dev/null 2>&1 && echo OPEN || echo BLOCKED' 2>/dev/null || echo BLOCKED)
ev egress_real "$EGRESS_REAL"
EGRESS_CTRL=$(sh -c 'getent hosts api.smsbao.com >/dev/null 2>&1 && echo DNS_OK || echo DNS_FAIL')
ev egress_reverse_control "$EGRESS_CTRL"

# 9c. 变异测试：真实破坏数据/环境，门禁必须 FAIL（不是判据层伪造）
say "--- 反向验证 B：五组真实变异，每组必须 FAIL ---"
MUT_OK=0; MUT_TOTAL=0
for c in F1 F2 F3 F4 F5; do
  MUT_TOTAL=$((MUT_TOTAL+1))
  sanitize_sms                      # 每轮先回到安全态，保证单变量变异
  case "$c" in
    F1) psql_d "UPDATE service_settings SET value='true' WHERE key='sms.enabled';" >/dev/null ;;
    F2) export SMS_ENABLED=true ;;
    F3) psql_d "UPDATE service_settings SET value='smsbao' WHERE key='sms.provider';" >/dev/null ;;
    F4) export CHAOS_F4=1 ;;        # 模拟"忘了做网络出口隔离"
    F5) psql_d "UPDATE sms_logs SET send_status='pending' WHERE id=(SELECT min(id) FROM sms_logs);" >/dev/null ;;
  esac
  pre_launch_gate; rc=$?
  # 还原本轮变异（含环境/网络开关）
  unset CHAOS_F4
  sanitize_sms
  if [ "$rc" -ne 0 ]; then MUT_OK=$((MUT_OK+1)); say "  $c ⇒ 正确阻断 ✅"; ev "mutation_$c" BLOCKED
  else say "  $c ⇒ ★ 未阻断（判据漏洞）"; ev "mutation_$c" LEAKED; fi
done
ev mutations_total "$MUT_TOTAL"; ev mutations_blocked "$MUT_OK"

# 9d. 正确配置才 PASS
say "--- 正向验证：五道防线全到位 ---"
sanitize_sms
pre_launch_gate; GATE_RC=$?
ev gate_sanitized "$([ "$GATE_RC" = 0 ] && echo PASS || echo FAIL)"
[ "$GATE_RC" = "0" ] || die "消毒后门禁仍失败"

# 9e. 补强证据：没有消费者/应用连到恢复库、没有启动恢复副本应用
DRILL_CONNS=$(psql_pg "select count(*) from pg_stat_activity where datname='$DRILL_DB' and pid<>pg_backend_pid()")
ev drill_external_connections "${DRILL_CONNS:-ERR}"
[ "${DRILL_CONNS:-1}" = "0" ] || die "有额外会话连到恢复库（可能被消费者捞起队列）"
APP_CONTAINERS=$(docker ps --format '{{.Names}}' | grep -ci 'restore\|drill' || true)
ev restore_app_containers "${APP_CONTAINERS:-0}"
ev restore_app_started false
say "恢复副本应用未启动；恢复库无外部会话 ⇒ 队列不可能被自动消费"

# ------------------------------------------- 10. 现网未被改动（前后对照）
PROD_SMS_AFTER=$(psql_prod "select value from service_settings where key='sms.enabled'")
ev prod_sms_enabled_after "$PROD_SMS_AFTER"
[ "$PROD_SMS_BEFORE" = "$PROD_SMS_AFTER" ] || die "现网库 sms.enabled 被改动！"
ev prod_unchanged true

# ------------------------------------------- 11. 汇总判据
[ "$MUT_OK" = "$MUT_TOTAL" ] || die "变异测试有未阻断项（$MUT_OK/$MUT_TOTAL）"
[ "$EGRESS_REAL" = "BLOCKED" ] || die "网络出口未阻断"
[ "$EGRESS_CTRL" = "DNS_OK" ] || die "反向对照失败（DNS 本来就不通，无法证明阻断有效）"
[ "$MISS_N" -eq 0 ] || die "storage_key 缺失"
[ "$CNT_FAIL" = "0" ] || die "表计数不一致"

say "=========== 演练 PASS：全量检查 + 五道防线 + 5/5 变异阻断 ==========="
ev verdict PASS
echo "===EVIDENCE_END==="
exit 0
