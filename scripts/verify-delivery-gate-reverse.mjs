#!/usr/bin/env node
/**
 * verify-delivery-gate-reverse.mjs —— **产物交付链**断言的反向验证
 * =============================================================================
 *
 * 铁律 8：断言不会变红 = 没有断言。
 *
 * 做法：把 nginx 的 `/static/plugins/` 缓存策略临时改回历史缺陷形态
 * （`expires 7d;` + `Cache-Control: public, max-age=604800`），reload 后
 * 要求 `verify-bundle-delivery.mjs` **如实变红**；`finally` 还原配置并 reload，
 * 再要求它回到全绿。
 *
 * 为什么这条值得单独做：**它才是能提前抓住"详情 404 拖了一整轮"的那个断言。**
 * 当时所有断言都盯着"代码对不对"，没有一条盯着"浏览器拿不拿得到"。
 *
 * ⚠️⚠️ 两个必须处理的真实坑（第一版就是被它们骗了，"缺陷态居然全绿"）：
 *   ① **reload 不是同步生效的**：`nginx -s reload` 只是发信号就返回，
 *      新配置要等新 worker 起来（本项目配置在 Windows 绑定挂载上，
 *      经 9p/drvfs 透传，实测有数秒延迟）。
 *   ② **keep-alive 会把旧 worker 的连接留住**：用同一个进程内的 fetch（undici 连接池）
 *      复测，很可能还被旧 worker 服务 ⇒ 读到的是**上一版**配置。
 *   ⇒ 所以本脚本：改完配置先**轮询等到配置真的生效**再断言；
 *      探测用 `curl -H 'Connection: close'`（每次全新连接，绕开连接池）。
 *
 * 退出码：0 = 反向验证成立；1 = 断言不会红（假闸门）或未干净还原；2 = 环境未就绪
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONF = path.join(ROOT, 'nginx/conf.d/service.conf');
const DELIVERY = path.join(ROOT, 'scripts/verify-bundle-delivery.mjs');
const NGINX_CONTAINER = 'svc-nginx';
const PORT = Number(process.env.NGINX_HTTP_PORT ?? 8080);
const BUNDLE_URL = `http://127.0.0.1:${PORT}/static/plugins/@local/service-ticket/dist/client/index.js`;

const GOOD = '        add_header Cache-Control "no-cache" always;';
const BAD = '        expires 7d;\n        add_header Cache-Control "public, max-age=604800" always;';

const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reload = () => {
  execFileSync('docker', ['exec', NGINX_CONTAINER, 'nginx', '-s', 'reload'], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

/** 探测脚本：**必须每次新起进程**（新进程 = 新连接池 = 新连接，
 *  否则可能被 reload 前的旧 worker 服务，读到上一版配置） */
const PROBE_SRC = `
const u = process.argv[1];
fetch(u, { headers: { 'accept-encoding': 'identity' } })
  .then((r) => console.log(r.headers.get('cache-control') || '(无)'))
  .catch((e) => console.log('ERR ' + e.message));
`;

function curCacheControl() {
  try {
    const out = execFileSync(process.execPath, ['-e', PROBE_SRC, BUNDLE_URL], {
      encoding: 'utf8',
      timeout: 20000,
    });
    return String(out).trim();
  } catch (e) {
    const detail = String(e.stderr || e.message || '').split('\n').filter(Boolean)[0] || '未知';
    return `<探测失败：${detail}>`;
  }
}

/** 等到新配置真的生效（否则会读到上一版配置，制造"缺陷态全绿"的假象） */
async function waitForCache(re, label) {
  const deadline = Date.now() + 30000;
  let last = '';
  while (Date.now() < deadline) {
    last = curCacheControl();
    if (re.test(last)) {
      log(`  · 配置已生效（${label}）：Cache-Control: ${last}`);
      return true;
    }
    await sleep(700);
  }
  log(`  ⚠️  等了 30s，配置仍未变成「${label}」（当前：${last || '（读不到）'}）`);
  return false;
}

const runDelivery = () => {
  const r = spawnSync(process.execPath, [DELIVERY], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

if (!fs.existsSync(CONF)) {
  console.error(`✗ 找不到 nginx 配置：${CONF}`);
  process.exit(2);
}

const original = fs.readFileSync(CONF, 'utf8');
if (!original.includes(GOOD)) {
  console.error('✗ 配置里找不到预期的 no-cache 行 —— 前置条件不成立（先确认 DEV-74 的修复在位）');
  process.exit(2);
}

let failed = false;
let restored = false;
let abort = false;

try {
  log('══ 反向验证：把 /static/plugins/ 的缓存策略改回 7 天长缓存 ══');
  fs.writeFileSync(CONF, original.replace(GOOD, BAD), 'utf8');
  reload();
  log('  · 已改配置并 reload nginx');

  // 前置：必须确认"缺陷配置"真的生效了，否则后面读到的还是好配置
  const becameBad = await waitForCache(/max-age=604800/, '长缓存');
  if (!becameBad) {
    // ⚠️ 这里**不能** process.exit：它会跳过 finally，把缺陷配置留在 nginx 上。
    abort = true;
  }

  const bad = abort ? { code: null, out: '' } : runDelivery();
  if (abort) {
    log('\n（前置条件不成立，未执行断言）');
  } else {
  log('\n── 缺陷态下的交付链断言输出 ──');
  for (const l of bad.out.split('\n')) if (l.trim()) log('   ' + l);

  if (bad.code === 0) {
    failed = true;
    log('\n🚨 **交付链断言没有变红** —— 长缓存被放过了，这条断言是假的');
  } else if (!/长缓存|max-age/.test(bad.out)) {
    failed = true;
    log('\n🚨 断言红了，但红灯里看不到"长缓存"的证据 —— 判据不够精确');
  } else {
    log('\n✅ 交付链断言如实变红（正是 DEV-74 的缺陷态）');
  }
  }
} finally {
  if (fs.readFileSync(CONF, 'utf8') !== original) {
    fs.writeFileSync(CONF, original, 'utf8');
    log('\n── 已还原 nginx 配置 ──');
  }
  try {
    reload();
    const backToGood = await waitForCache(/no-cache/, 'no-cache');
    const good = runDelivery();
    log(`  · 还原后交付链断言退出码：${good.code}（应为 0）`);
    restored = backToGood && good.code === 0;
    if (!restored) {
      for (const l of good.out.split('\n')) if (l.trim()) log('      ' + l);
    }
  } catch (e) {
    console.error(`✗ 还原后 reload/断言失败：${e.message} —— **请手工确认 nginx 配置并 reload**`);
  }
}

if (!restored) {
  console.error('\n❌ 没有干净地还原到达标状态');
  process.exit(1);
}
if (abort) {
  console.error('\n❌ 反向验证未能执行：缺陷配置没生效（已还原，未做任何判定）');
  process.exit(2);
}
if (failed) {
  console.error('\n❌ 反向验证不成立：交付链断言在缺陷态下没变红');
  process.exit(1);
}
console.log('\n✅ 反向验证成立：缺陷态变红、还原后全绿');
process.exit(0);
