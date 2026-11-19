// 试验：把三个 group 的 schemaUid 置空，看「管理与设置」能否在混排布局里渲染成可折叠分组
import { execFileSync } from 'node:child_process';
const db = 'service_ticket';
const psql = (sql) => execFileSync('docker', ['exec','svc-postgres','psql','-U','svc_app','-d',db,'-At','-c',sql], {encoding:'utf8'});
console.log('before:', psql(`SELECT id,title,coalesce("schemaUid",'NULL') FROM "desktopRoutes" WHERE type='group' ORDER BY sort;`));
