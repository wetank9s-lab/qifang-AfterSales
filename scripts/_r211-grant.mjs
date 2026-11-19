// 给本地 hq_admin 补 flowModels / flowModelTreePath / uiSchemas 的 list/get/view 授权
// 仅本地开发实例；生产不动。
import { execFileSync } from 'node:child_process';
const sql = `
INSERT INTO "dataSourcesRolesResourcesActions" (id, "rolesResourceId", name)
SELECT to_number(to_char(clock_timestamp(),'YYMMDDHH24MISS'),'99999999999999')::bigint*10000 + row_number() OVER (), r.id, a.name
FROM "dataSourcesRolesResources" r
CROSS JOIN (VALUES ('list'),('get'),('view')) AS a(name)
WHERE r."roleName"='hq_admin' AND r.name IN ('flowModels','flowModelTreePath','uiSchemas')
  AND NOT EXISTS (SELECT 1 FROM "dataSourcesRolesResourcesActions" x WHERE x."rolesResourceId"=r.id AND x.name=a.name);
`;
