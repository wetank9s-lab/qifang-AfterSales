-- 回滚 202611251-archives-admin-page（只删本迁移自己创建的行）
-- 判据：按 title + 本迁移写入的形态定位，不按 id、不按 uid 猜。
-- 用法：psql -v ON_ERROR_STOP=1 -f rehear-rollback.sql
BEGIN;

-- 先拿到要删的 page / tabs 的 id 与 schemaUid（用于精准删区块）
CREATE TEMP TABLE _del AS
SELECT p.id AS page_id, t.id AS tab_id, t."schemaUid" AS tab_uid
  FROM "desktopRoutes" p
  LEFT JOIN "desktopRoutes" t ON t."parentId" = p.id AND t.type = 'tabs'
 WHERE p.type = 'flowPage' AND p.title = '上门服务档案';

-- 授权先删（外键顺序：子先于父）
DELETE FROM "rolesDesktopRoutes"
 WHERE "desktopRouteId" IN (SELECT page_id FROM _del);

-- 区块按 parentId=tab_uid 精确删（不用 use 全库扫，避免误删别处同名区块）
DELETE FROM "flowModels"
 WHERE options->>'parentId' IN (SELECT tab_uid FROM _del)
   AND options->>'use' = 'ServiceArchivesAdminModel';

-- Tab 再删
DELETE FROM "desktopRoutes" WHERE id IN (SELECT tab_id FROM _del);

-- 页面最后删
DELETE FROM "desktopRoutes" WHERE id IN (SELECT page_id FROM _del);

DROP TABLE _del;
COMMIT;

-- 回滚后断言：三处都应回到 0
--
-- ⚠️ 断言里的「孤儿授权 N 条」**不是本迁移留下的**，是生产本来就有的历史残留：
--    实测生产 `rolesDesktopRoutes` 里就有 **8 条**指向已不存在的 desktopRouteId，
--    隔离库（导入同一份 dump）基线也是 8 条，迁移前后不变 ⇒ 与本迁移无关。
--    回滚脚本按 desktopRouteId 精确删除，不会碰这 8 条 —— 这是**有意**的：
--    清历史残留在用户 §五「不删已有菜单节点」的边界之外，应由运维单独决策。
DO $$
DECLARE np int; nt int; nb int; ng int;
BEGIN
  SELECT count(*) INTO np FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案';
  SELECT count(*) INTO nb FROM "flowModels" WHERE options->>'use'='ServiceArchivesAdminModel';
  SELECT count(*) INTO ng FROM "rolesDesktopRoutes" r
   WHERE NOT EXISTS (SELECT 1 FROM "desktopRoutes" p WHERE p.id = r."desktopRouteId");
  IF np <> 0 THEN RAISE EXCEPTION '回滚失败：页面仍 % 条', np; END IF;
  IF nb <> 0 THEN RAISE EXCEPTION '回滚失败：区块仍 % 条', nb; END IF;
  RAISE NOTICE '回滚通过：页面 0 / 区块 0（孤儿授权 % 条）', ng;
END $$;
