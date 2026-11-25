#!/bin/bash
# 在隔离容器 svc-page-rehear 里重建三表并按迁移的五段逻辑复刻，跑两遍验幂等。
# 用法：bash /tmp/rehear/reset-import.sh
set -euo pipefail

C=svc-page-rehear
DB=rehear
U=rehear
Q() { docker exec -i "$C" psql -U "$U" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "== step1: drop & create public schema =="
Q -q -c "DROP SCHEMA IF EXISTS public CASCADE" >/dev/null
Q -q -c "CREATE SCHEMA public" >/dev/null
echo "OK"

echo "== step2: import schema =="
docker exec -i "$C" psql -U "$U" -d "$DB" -v ON_ERROR_STOP=1 -q -f - < /tmp/rehear-schema.sql >/dev/null
echo "OK"

echo "== step3: import data =="
docker exec -i "$C" psql -U "$U" -d "$DB" -v ON_ERROR_STOP=1 -q -f - < /tmp/rehear-data.sql >/dev/null
echo "OK"

echo "== step4: counts =="
Q -At -c "SELECT count(*) FROM \"desktopRoutes\""
Q -At -c "SELECT count(*) FROM \"flowModels\""
Q -At -c "SELECT count(*) FROM \"rolesDesktopRoutes\""
