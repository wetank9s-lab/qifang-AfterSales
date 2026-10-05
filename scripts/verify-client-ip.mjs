#!/usr/bin/env node
/**
 * verify-client-ip.mjs —— 公网限流「按客户端 IP 分桶」是否真实成立（Phase 10 / P10-C）
 *
 * ===========================================================================
 * 为什么需要这支门禁（它检查的是一件**静态配置看不出来**的事）
 * ===========================================================================
 * nginx 的三个限流区都按 `$binary_remote_addr` 分桶：
 *   limit_req_zone $binary_remote_addr zone=svc_public:10m rate=30r/m;   （对客承诺）
 *   … svc_upload / svc_general 同理
 *
 * 静态看配置永远"是对的"。但**部署形态**会让它悄悄退化：
 *   容器 + 端口发布这一跳会 **SNAT 改写源地址** ⇒ nginx 看到的是网桥网关
 *   ⇒ 所有外部流量落进**同一个桶** ⇒
 *     · 匿名接口的"按 IP 限流"变成"全局总量限流"（一个正常用户就能把别人挤掉）；
 *     · 失去了"按客户端 IP 防滥用"这个原语。
 *
 * ⚠️ 这不是"读配置能发现"的：配置里每个字段都对。
 *   只能**真的打一次请求，然后读 nginx 记下的 $remote_addr**。
 *
 * ===========================================================================
 * 判据（自包含，不依赖本机其它项目）
 * ===========================================================================
 * ① 临时起一个**同网络**的容器（`docker run --rm --network <svc 网络>`），
 *    它的 IP 已知且**不是**网桥网关；
 * ② 让它请求宿主机的已发布端口；
 * ③ 读 svc-nginx 的 access log，取最后一条的 `$remote_addr`；
 * ④ 它**必须等于**那个临时容器的 IP。若等于网桥网关（或任何不等于它的值）⇒ **红**。
 *
 * 退出码：0 绿 / 1 红 / 2 环境未就绪（容器没起、没有 docker 网络）
 */
import { execFileSync } from 'node:child_process';

const NGINX_CONTAINER = 'svc-nginx';
const PROBE_IMAGE = 'alpine:3.20';
/**
 * 请求一个**会被记 access log** 的路径。
 *
 * ⚠️ 刻意**不用** /healthz：那个 location 写着 access_log off（nginx 自身存活探针
 *   本来就不需要记），打了它 access log 一行都不会有 ⇒ 判据空转。
 *   也不用 /api/svc:health（同样 access_log off）。
 * 这里打一个必然 404 的 API 路径：它会落到 location /（有 access_log），
 * 我们要的只是 nginx 记下的源地址，不是业务响应。
 */
const PROBE_PATH = '/api/__ip-probe__';

function run(cmd, args, timeout = 60000) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
}

function fail(msg) {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ❌ ' + msg);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}

function notReady(msg) {
  console.log('');
  console.log('  ⛔ ' + msg);
  console.log('     （环境未就绪，不是产品红灯）');
  console.log('');
  process.exit(2);
}

function ok(msg) {
  console.log('  ✅ ' + msg);
}

// ---------------------------------------------------------------------------
// 0. 环境
// ---------------------------------------------------------------------------
let running;
try {
  running = run('docker', ['inspect', '-f', '{{.State.Running}}', NGINX_CONTAINER], 20000).trim();
} catch {
  notReady(`容器 ${NGINX_CONTAINER} 不存在`);
}
if (running !== 'true') notReady(`${NGINX_CONTAINER} 未运行`);

const network = (() => {
  try {
    return run('docker', ['inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}', NGINX_CONTAINER], 20000).trim().split('\n')[0];
  } catch {
    return '';
  }
})();
if (!network) notReady(`取不到 ${NGINX_CONTAINER} 所在 docker 网络`);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  公网限流「按客户端 IP 分桶」实测（Phase 10 / P10-C）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · nginx 容器：${NGINX_CONTAINER}`);
console.log(`  · docker 网络：${network}`);

// 记录当前日志行数，便于只比对"这次请求新增的行"
const logMark = run('docker', ['logs', NGINX_CONTAINER], 30000).split('\n').length;

// ---------------------------------------------------------------------------
// 1. 起临时容器（它的 IP 已知且不是网关）
// ---------------------------------------------------------------------------
let probeIp;
try {
  run('docker', ['pull', PROBE_IMAGE], 180000);
} catch {
  /* 拉不到就当作本地已有，run 时再报错 */
}

// 容器名只允许 [a-zA-Z0-9_.-]：用随机后缀，不能带 $
let probeName = 'svc-ipprobe-' + Math.random().toString(36).slice(2, 8);
try {
  probeIp = run('docker', ['run', '-d', '--rm', '--name', probeName, '--network', network, PROBE_IMAGE, 'sleep', '30'], 60000).trim();
  probeIp = run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', probeName], 20000).trim();
} catch (err) {
  try {
    run('docker', ['rm', '-f', probeName], 20000);
  } catch {
    /* ignore */
  }
  notReady(`无法启动探针容器（${err.message.split('\n')[0]}）`);
}
if (!probeIp || !/^\d+\.\d+\.\d+\.\d+$/.test(probeIp)) {
  notReady(`探针容器 IP 不可用：${probeIp}`);
}
console.log(`  · 探针容器 IP：${probeIp}（与 nginx 同网络，必然不是网桥网关）`);

// ---------------------------------------------------------------------------
// 2. 找宿主网关并从探针容器打一次请求
// ---------------------------------------------------------------------------
let gateway;
try {
  gateway = run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', probeName], 20000).trim();
} catch {
  gateway = '';
}
if (!gateway) notReady('取不到该网络的网关地址');

let hostPort = '8080';
try {
  const binds = run('docker', ['inspect', '-f', '{{json .HostConfig.PortBindings}}', NGINX_CONTAINER], 20000);
  const m = /"80\/tcp":\[\{"HostIp":"[^"]*","HostPort":"(\d+)"\}\]/.exec(binds);
  if (m) hostPort = m[1];
} catch {
  /* 用默认 80 */
}
console.log(`  · 宿主发布端口：${hostPort}（网关 ${gateway}）`);

try {
  run('docker', ['exec', probeName, 'wget', '-q', '-O', '/dev/null', `http://${gateway}:${hostPort}${PROBE_PATH}`], 40000);
} catch (err) {
  console.log(`  ⚠️ 探针请求失败：${err.message.split('\n')[0]}`);
}
try {
  run('docker', ['rm', '-f', probeName], 20000);
} catch {
  /* --rm 已回收 */
}

// ---------------------------------------------------------------------------
// 3. 读 nginx 实际记下的 $remote_addr
// ---------------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 1500));
const all = run('docker', ['logs', NGINX_CONTAINER], 30000).split('\n');
// ⚠️ 不用"行数增量"切片：docker logs 里 access log 行与 [error] 行是混在一起的，
//   而一次 docker pull / 容器事件都可能改变总行数 ⇒ 切片会切错位置（第一版就切错过）。
//   取**最后一条符合 access log 形态**的行即可 —— 探针请求是最近发起的那个。
const ACCESS_LINE = /^(\d{1,3}(?:\.\d{1,3}){3})\s+-\s+-\s+\[/;
const matched = all.filter((l) => ACCESS_LINE.test(l.trim()));
const lastLine = matched.length ? matched[matched.length - 1].trim() : '';
const remoteAddrs = lastLine ? [ACCESS_LINE.exec(lastLine)[1]] : [];
if (lastLine) console.log(`  · 最后一条 access log：${lastLine.slice(0, 120)}`);

const observed = [...new Set(remoteAddrs)];
console.log(`  · nginx 记下的 $remote_addr：${observed.join(', ')}`);
console.log(`  · 探针容器真实 IP：        ${probeIp}`);
console.log('');

const preserved = observed.includes(probeIp);
const collapsedToGateway = observed.includes(gateway);

if (preserved) {
  ok(`源地址被如实保留：nginx 看到 ${probeIp} ⇒ 限流按真实客户端 IP 分桶成立`);
  console.log('');
  console.log('  结论：当前部署形态下 $binary_remote_addr 就是真实客户端 IP。');
  console.log('');
  process.exit(0);
}

if (collapsedToGateway) {
  fail(
    '源地址被改写成网桥网关 —— 限流退化成「全局总量限流」。\n' +
      `\n     实测：探针容器真实 IP = ${probeIp}，nginx 记的却是 ${gateway}。\n` +
      '     后果：\n' +
      '       · 匿名接口的「按 IP 限流」变成「全局总量限流」——一个正常用户就能把\n' +
      '         其他人挤掉（误伤），同时失去「按客户端 IP 防滥用」这个原语；\n' +
      '       · 触发限流时无法定位来源 IP，排障与运营都失去依据。\n' +
      '\n     两条可选修法（**都属于部署形态决策，不在本仓库内**，需你裁决）：\n' +
      '  A) Docker daemon 设 "userland-proxy": false —— 端口发布改走纯 iptables DNAT，\n' +
      '     不再 SNAT。改动最小、拓扑不变；代价：要重启 Docker daemon（本机其它项目\n' +
      '     如 crmeb 会一起中断），且 Docker Desktop 上是否生效需实测。\n' +
      '  B) nginx 改 network_mode: host —— 直接绑宿主机端口，绕开端口发布。\n' +
      '     代价：upstream 必须从 app:13000 改成 127.0.0.1:13000（host 网络没有 compose DNS），\n' +
      '     且 host 网络在 Docker Desktop(Windows) 上行为与 Linux 不同。\n' +
      '\n     ⚠️ 不要用 set_real_ip_from 0.0.0.0/0 + X-Forwarded-For 绕过：\n' +
      '        那等于让**任何客户端自己声明 IP**，限流当场失效，比现在更糟。',
  );
}

fail(
  '源地址既不是探针真实 IP、也不是网关 —— 属于第三种形态，需人工取证。\n' +
    `  实测：探针=${probeIp}，网关=${gateway}，nginx 记的=${observed.join(',')}\n` +
    '  这通常意味着中间还有一层代理/网关改写了来源，需要先定位那一层再谈修法。',
);
