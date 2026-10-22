/**
 * verify-be01-s1-resource-inventory.mjs —— viewer 可读资源清单的**自动护栏**
 *
 * 用户要求：对当前资源全集给出明确结论，并建立**新增资源的自动检查规则**。
 *
 * 做法：直接读 `dataSourcesRolesResources`（NocoBase 实际生效的 ACL 表，不是猜接口），
 * 断言 viewer 的 (资源, action) 集合**恰好等于**审计过的那一份。
 * 任何新增（换个人配权限、插件升级带出新集合）都会让本门禁变红，
 * 提醒必须先跑 `audit-be01-s1-read-paths.mjs` 再放行。
 *
 * 这就是"反向验证 B"的可持续形态：比一次性构造关联明文更难被绕过。
 */
import { execFileSync } from 'node:child_process';

const psql = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '|', '-c', sql], {
    encoding: 'utf8',
  }).trim();

/** 2026-10-20 审计过的完整集合（有序，便于 diff 输出） */
const EXPECTED = [
  'serviceTickets:get,list,view',
  'serviceVisits:get,list,view',
  'smsLogs:get,list,view',
  'stores:get,list,view',
  'ticketEvents:get,list,view',
].sort();

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  viewer 可读资源清单（ACL 实际值 vs 已审计清单）');
console.log('══════════════════════════════════════════════════════════════');

const rows = psql(
  `select r.name || ':' || coalesce(string_agg(distinct a.name, ',' order by a.name), '')
   from "dataSourcesRolesResources" r
   left join "dataSourcesRolesResourcesActions" a on a."rolesResourceId" = r.id
   where r."roleName" = 'viewer'
   group by r.name order by r.name`,
)
  .split('\n')
  .filter(Boolean)
  .sort();

console.log(`  实际 ${rows.length} 个资源：`);
for (const r of rows) console.log(`    · ${r}`);

const added = rows.filter((r) => !EXPECTED.includes(r));
const removed = EXPECTED.filter((r) => !rows.includes(r));

if (added.length || removed.length) {
  console.log('\n  ❌ 清单发生变化：');
  for (const a of added) console.log(`     + ${a}  （新增可读资源，必须先审计再放行）`);
  for (const r of removed) console.log(`     - ${r}  （被移除，确认是否有意）`);
  process.exit(1);
}
console.log('\n  ✅ 与已审计清单完全一致（新增资源会自动变红）');
console.log('');
