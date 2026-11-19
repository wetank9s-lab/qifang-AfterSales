/**
 * 查「所有工单」页面为什么没有 TicketPrimaryActionModel。
 *
 * 判据（按记忆里的教训）：
 *   · 模型类名在 COALESCE(options->>'use', options->'schema'->>'use')
 *   · 页面标题在 desktopRoutes.title（不是 flowModels）
 *   · flowModels.name 存的是**节点 uid**
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SQL = `
\\pset pager off
\\x off

-- 1) 「所有工单」这个路由的 schemaUid
SELECT id, title, type, schema_uid AS "schemaUid", parent_id AS "parentId"
FROM "desktopRoutes"
WHERE title IN ('所有工单','我的门店工单')
ORDER BY title;

-- 2) 这两个 RouteModel uid 下到底挂了哪些模型
WITH roots AS (
  SELECT schema_uid AS uid, title FROM "desktopRoutes" WHERE title IN ('所有工单','我的门店工单')
)
SELECT r.title AS "route",
       fm.name AS "modelNodeUid",
       COALESCE(fm.options->>'use', fm.options->'schema'->>'use') AS "use",
       t.depth
FROM roots r
JOIN "flowModelTreePath" t ON t.ancestor = r.uid
JOIN "flowModels" fm ON fm.name = t.descendant
WHERE t.depth <= 4
  AND COALESCE(fm.options->>'use', fm.options->'schema'->>'use') IS NOT NULL
ORDER BY r.title, t.depth, "use";
`;

fs.writeFileSync('storage/tmp/r212/_q1.sql', SQL);

const out = execFileSync('docker', [
  'exec', '-i', 'svc-postgres',
  'psql', '-U', 'nocobase', '-d', 'nocobase', '-v', 'ON_ERROR_STOP=1', '-f', '-',
], { input: SQL, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });

console.log(out);
