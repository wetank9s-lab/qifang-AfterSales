-- 隔离预演：复刻 202611251-archives-admin-page.ts 的 SQL 语义
-- 与迁移保持同口径：授权必须覆盖 **分组 + 页面 + Tab**（三者缺一，菜单不出现）
-- 用法：psql -v ON_ERROR_STOP=1 -f rehear-migrate.sql
BEGIN;

-- ① 父分组：查不到直接抛错（复刻 migration 的 throw）
DO $$
DECLARE gid bigint;
BEGIN
  SELECT id INTO gid FROM "desktopRoutes"
   WHERE type = 'group' AND title = '售后工单' LIMIT 1;
  IF gid IS NULL THEN
    RAISE EXCEPTION '[svc:archives-page] 找不到导航分组「售后工单」';
  END IF;
  RAISE NOTICE '① 分组 id=%', gid;
END $$;

-- ② 页面
WITH g AS (
  SELECT id FROM "desktopRoutes" WHERE type='group' AND title='售后工单' LIMIT 1
), ins AS (
  INSERT INTO "desktopRoutes"
    (id, "createdAt", "updatedAt", "parentId", title, type, "schemaUid", "menuSchemaUid",
     sort, "hideInMenu", "enableTabs", "enableHeader", "displayTitle")
  SELECT
    (SELECT COALESCE(max(id),0) + 1 FROM "desktopRoutes"),
    now(), now(), g.id, '上门服务档案', 'flowPage',
    substr(md5(random()::text), 1, 11), substr(md5(random()::text), 1, 11),
    (extract(epoch from now()) * 1000)::bigint * 1000,
    false, false, true, true
  FROM g
  WHERE NOT EXISTS (
    SELECT 1 FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案'
  )
  RETURNING id
)
SELECT '② 页面新增 ' || count(*) FROM ins;

-- ③ Tab
WITH p AS (
  SELECT id FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案' LIMIT 1
), ins AS (
  INSERT INTO "desktopRoutes"
    (id, "createdAt", "updatedAt", "parentId", title, type, "schemaUid",
     sort, "hideInMenu", "enableTabs", "enableHeader", "displayTitle")
  SELECT
    (SELECT COALESCE(max(id),0) + 1 FROM "desktopRoutes"),
    now(), now(), p.id, '上门服务档案', 'tabs',
    substr(md5(random()::text), 1, 11),
    (extract(epoch from now()) * 1000)::bigint * 1000,
    false, true, false, false
  FROM p
  WHERE NOT EXISTS (
    SELECT 1 FROM "desktopRoutes" WHERE type='tabs' AND "parentId"=p.id AND title='上门服务档案'
  )
  RETURNING id
)
SELECT '③ Tab 新增 ' || count(*) FROM ins;

-- ④ 区块（name = uid，类名在 options.use，parentId 指向 Tab 的 schemaUid）
INSERT INTO "flowModels" (uid, name, options)
SELECT buid, buid, json_build_object(
    'parentId', tabuid,
    'subKey', 'items',
    'subType', 'array',
    'use', 'ServiceArchivesAdminModel',
    'props', '{}'::json,
    'decoratorProps', '{}'::json,
    'stepParams', json_build_object('__flowSurfaceMeta', json_build_object(
        'declaredKey', 'svc-archives-block',
        'title', '上门服务档案'))
  )
FROM (
  SELECT r."schemaUid" AS tabuid, substr(md5(random()::text), 1, 11) AS buid
    FROM "desktopRoutes" r
    JOIN "desktopRoutes" p ON p.id = r."parentId"
   WHERE r.type='tabs' AND p.type='flowPage' AND p.title='上门服务档案'
   LIMIT 1
) s
WHERE NOT EXISTS (
  SELECT 1 FROM "flowModels" WHERE options->>'use' = 'ServiceArchivesAdminModel'
);

-- ⑤ 授权：**分组 + 页面 + Tab** × 4 角色 = 12 条，ON CONFLICT DO NOTHING
INSERT INTO "rolesDesktopRoutes" ("createdAt","updatedAt","desktopRouteId","roleName")
SELECT now(), now(), t.route_id, r.role
  FROM (
    -- 分组
    SELECT id AS route_id FROM "desktopRoutes" WHERE type='group' AND title='售后工单'
    UNION ALL
    -- 页面
    SELECT id FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案'
    UNION ALL
    -- Tab
    SELECT t.id FROM "desktopRoutes" t
      JOIN "desktopRoutes" p ON p.id = t."parentId"
     WHERE t.type='tabs' AND p.type='flowPage' AND p.title='上门服务档案'
  ) t
  CROSS JOIN (VALUES
    ('hq_after_sales'), ('hq_admin'), ('store_sales'), ('store_manager')
  ) AS r(role)
ON CONFLICT ("desktopRouteId","roleName") DO NOTHING;

-- ⑥ 回查断言：逐个目标 × 逐个角色
DO $$
DECLARE
  pid bigint; gid bigint; np int; nt int; nb int; ng int; ngroup int; expect int;
BEGIN
  SELECT count(*) INTO np FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案';
  IF np <> 1 THEN RAISE EXCEPTION '回查失败：页面应 1 条，实际 %', np; END IF;

  SELECT id INTO pid FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案';
  SELECT id INTO gid FROM "desktopRoutes" WHERE type='group' AND title='售后工单';

  SELECT count(*) INTO nt FROM "desktopRoutes" WHERE type='tabs' AND "parentId"=pid;
  IF nt < 1 THEN RAISE EXCEPTION '回查失败：无 Tab'; END IF;

  SELECT count(*) INTO nb FROM "flowModels" WHERE options->>'use'='ServiceArchivesAdminModel';
  IF nb < 1 THEN RAISE EXCEPTION '回查失败：区块不存在'; END IF;

  -- 期望 = 4 角色 × (分组 + 页面 + Tab数)
  expect := 4 * (2 + nt);
  SELECT count(*) INTO ng FROM "rolesDesktopRoutes"
   WHERE ("desktopRouteId" = gid OR "desktopRouteId" = pid
          OR "desktopRouteId" IN (SELECT id FROM "desktopRoutes" WHERE "parentId"=pid))
     AND "roleName" IN ('hq_after_sales','hq_admin','store_sales','store_manager');
  IF ng <> expect THEN
    RAISE EXCEPTION '回查失败：授权应 % 条（4 角色 × % 节点），实际 %', expect, 2+nt, ng;
  END IF;

  -- 额外断言：分组本身必须授权给这 4 个角色（这是"菜单出不来"的直接原因）
  SELECT count(*) INTO ngroup FROM "rolesDesktopRoutes"
   WHERE "desktopRouteId" = gid
     AND "roleName" IN ('hq_after_sales','hq_admin','store_sales','store_manager');
  IF ngroup <> 4 THEN RAISE EXCEPTION '回查失败：分组授权应 4 条，实际 %', ngroup; END IF;

  RAISE NOTICE '⑥ 回查通过：page=% tabs=% block=% 授权=%/%（分组授权 % 条）',
    pid, nt, nb, ng, expect, ngroup;
END $$;

COMMIT;
