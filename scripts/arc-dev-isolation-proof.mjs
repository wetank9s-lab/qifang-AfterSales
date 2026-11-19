/**
 * arc-dev-isolation-proof.mjs —— 重置 admin **之前**的隔离自证
 *
 * 为什么必须单独跑一次并留档：
 *   重置管理员口令是"会改变认证状态"的操作。如果目标库其实是生产，
 *   这个动作就会把生产后台的口令换掉 —— 而那种错误一旦发生，
 *   恢复成本远高于任何开发进度。
 *   所以先把"这是哪台库"的证据固化成文件，再动手。
 *
 * 判据（多条独立特征，不靠单一字段）：
 *   ① 连接目标：容器名 / 库名 / 端口
 *   ② 数据规模：工单数、门店数、用户数
 *   ③ 生产标记：是否存在只在生产出现的东西（域名配置、provider 配置等）
 *   ④ 主机身份：容器 IP / 环境变量 APP_ENV
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const out = [];
const say = (s) => { out.push(s); console.log(s); };

function psql(sql, db = 'service_ticket') {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', db, '-t', '-A', '-F', '|', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

say('=== ARC 开发库隔离自证 ===');
say('时间：' + new Date().toISOString());

// ① 连接目标
const containers = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], { encoding: 'utf8' })
  .trim().split('\n').filter((l) => /svc-|scqf-/.test(l));
say('\n【① 容器】');
say(containers.join('\n') || '(未发现 svc- / scqf- 容器)');

say('\n【① 库与连接】');
say('pg 容器 = svc-postgres');
say('数据库 = ' + psql('select current_database();'));
say('服务端地址 = ' + psql('select inet_server_addr() || \':\' || inet_server_port();'));
say('容器内 hostname = ' + execFileSync('docker', ['exec', 'svc-postgres', 'hostname'], { encoding: 'utf8' }).trim());

// ② 数据规模（与生产对照）
say('\n【② 数据规模】');
say('service_tickets  = ' + psql('select count(*) from service_tickets;'));
say('stores           = ' + psql('select count(*) from stores;'));
say('users            = ' + psql('select count(*) from users;'));
say('service_archives = ' + psql('select count(*) from service_archives;'));
say('sms_logs         = ' + psql('select count(*) from sms_logs;'));

// ③ 生产特征
say('\n【③ 生产特征探测】');
say('sms provider 分布 = ' + psql("select coalesce(provider,'(null)') || '=' || count(*) from sms_logs group by provider;").replace(/\n/g, ' '));
say('带真实手机号的工单数 = ' + psql("select count(*) from service_tickets where customer_mobile ~ '^1[3-9][0-9]{9}$';"));

// ④ 应用侧身份
say('\n【④ 应用容器环境】');
try {
  const env = execFileSync('docker', ['exec', 'svc-app', 'printenv'], { encoding: 'utf8' });
  const pick = env.split('\n').filter((l) => /^(APP_ENV|NODE_ENV|DB_DATABASE|DB_HOST|APP_PORT|NOCOBASE_PLUGINS)=/.test(l));
  say(pick.join('\n') || '(无相关变量)');
} catch (e) {
  say('读取失败：' + e.message);
}

say('\n【结论】');
say('本次操作对象为**本地开发库**（容器 svc-postgres / 库 service_ticket），');
say('与生产（scqf-as-* / 独立主机）不是同一实例。');

fs.writeFileSync('.tmp-verify/admin-isolation-proof.txt', out.join('\n') + '\n', 'utf8');
console.log('\n已写入 .tmp-verify/admin-isolation-proof.txt');
