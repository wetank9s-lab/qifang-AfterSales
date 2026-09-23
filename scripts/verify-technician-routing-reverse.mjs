#!/usr/bin/env node
/**
 * verify-technician-routing-reverse.mjs —— **P5-0 离线配置闸门**的反向验证
 * =============================================================================
 *
 * 铁律 8：**断言不会变红 = 没有断言**。
 * 本轮 `scripts/verify-config.mjs` 新增了 5 条与"师傅短链 / 师傅接口路由 /
 * 对外基址"有关的断言。它们守的都是**静态配置**，所以反向验证不需要 nginx ——
 * 直接改文件、跑断言、要求它**如实变红**、再还原。
 *
 * 为什么这 5 条必须逐条造反例（而不是只看它们现在是绿的）：
 *   它们要挡的缺陷有一个共同特征 —— **每一环都"成功"，只是送到错的系统**：
 *     · PUBLIC_BASE_URL 端口写错 → Token 对、短信发出去了，师傅点进去是**别的服务**；
 *     · nginx 的 `{43}` 与 Token 长度漂移 → 链接点不开（404），而两边代码都"看起来对"；
 *     · 短链跳转写成 301 → 当场看不出问题，**半年后想改 H5 路径时才发现改不动**（缓存钉死）；
 *     · 兜底 location 带 `^~` → **合法短链也 404**，日志干净、无任何报错；
 *     · `/api/technician/` 少了 rewrite → 404 + 日志里一条看起来毫不相干的
 *       "resource does not exist"（DEV-18 同型，"配了"与"没配"在响应上完全一样）。
 *   这类"静默且看起来正常"的缺陷，只有**反例**能证明闸门真的拦得住。
 *
 * 用法：node scripts/verify-technician-routing-reverse.mjs
 * 退出码：0 = 全部反例成立且已干净还原；1 = 有闸门不会变红（假闸门）或未还原；2 = 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERIFY_CONFIG = path.join(ROOT, 'scripts/verify-config.mjs');
const ENV_FILE = path.join(ROOT, '.env');
const SITE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');

const log = (s) => console.log(s);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * 每个反例：把 `from` 换成 `to`，然后要求 verify-config
 * ① 退出码非 0，且 ② 失败清单里出现 `expect`（判据精确到那条断言）。
 *
 * ⚠️ 只要求"变红"是不够的：**别的**断言也可能碰巧红。
 *    必须确认红的是**这一条**，否则我们只是证明了"改文件会让某个检查失败"。
 */
const CASES = [
  {
    name: 'PUBLIC_BASE_URL 末尾加了斜杠（会拼出 //t/<token>）',
    file: ENV_FILE,
    from: /^PUBLIC_BASE_URL=(.+)$/m,
    to: (m) => `PUBLIC_BASE_URL=${m[1]}/`,
    expect: '只含 origin',
  },
  {
    name: 'PUBLIC_BASE_URL 端口与 NGINX_HTTP_PORT 不一致（短信指向别的系统）',
    file: ENV_FILE,
    from: /^NGINX_HTTP_PORT=(\d+)$/m,
    to: (m) => `NGINX_HTTP_PORT=${Number(m[1]) + 1}`,
    expect: '与 NGINX_HTTP_PORT 一致',
  },
  {
    name: 'nginx 短链正则的 token 长度与 TECHNICIAN_TOKEN.LENGTH 漂移',
    file: SITE_CONF,
    // 实际形态：`location ~ "^/t/(?<svc_technician_token>[A-Za-z0-9_-]{43})$" {`
    // 顺序是 `{43})$`（先闭花括号、再闭捕获组、再 $），别写成 `{43}$)`。
    from: /\{43\}\)\$/,
    to: () => '{44})$',
    expect: '短链前缀与 Token 长度',
  },
  {
    name: '含 {n} 量词的正则漏了引号（nginx 把 { 当块定界符 → nginx -t 直接失败）',
    file: SITE_CONF,
    from: /location ~ "\^\/t\//,
    to: () => 'location ~ ^/t/',
    expect: '必须加引号',
  },
  {
    name: '短链跳转写成 301（会被客户端长期缓存，H5 路径将来改不动）',
    file: SITE_CONF,
    from: /return 302 \/h5\/technician\/visit\//,
    to: () => 'return 301 /h5/technician/visit/',
    expect: '短链前缀与 Token 长度',
  },
  {
    name: '兜底 location 写成 `^~ /t/`（会让合法短链也 404，且不报错）',
    file: SITE_CONF,
    from: /\n    location \/t\/ \{/,
    to: () => '\n    location ^~ /t/ {',
    expect: '短链前缀与 Token 长度',
  },
  {
    name: '删掉一条 /api/technician/ 的 rewrite（接口会 404 + 误导性日志）',
    file: SITE_CONF,
    // 注意：rewrite 的 pattern 现在是**带引号**的形态（`rewrite "^/api/...`），
    // 引号是 nginx 解析 `{43}` 所必需的，所以匹配必须容忍那个 `"?`。
    from: /^.*rewrite "?\^\/api\/technician\/visits\/\(\[A-Za-z0-9_-\]\{43\}\)\/files\$.*\n/m,
    to: () => '',
    expect: '必须显式 rewrite',
  },
  {
    // P5-0 联调时实测：nginx 默认 absolute_redirect on 会把相对 Location 改写成
    // `http://<Host>/h5/...`（容器内 Host=127.0.0.1 → http://127.0.0.1/h5/...）。
    name: '短链段漏了 absolute_redirect off（Location 被改写成绝对地址，外部契约跟着 Host 漂）',
    file: SITE_CONF,
    from: /^\s*absolute_redirect off;\n/m,
    to: () => '',
    expect: 'absolute_redirect off',
  },
];

const runVerifyConfig = () => {
  const r = spawnSync(process.execPath, [VERIFY_CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

/** 前置：任务开始时必须是**全绿**的（否则反例的"红"没有意义） */
const baseline = runVerifyConfig();
if (baseline.code !== 0) {
  console.error('✗ 前置条件不成立：verify-config 当前不是全绿，先把它修好再来做反向验证。');
  for (const l of baseline.out.split('\n').slice(-14)) if (l.trim()) console.error('   ' + l);
  process.exit(2);
}
log(`✓ 前置：verify-config 全绿（${/\d+ 项/.exec(baseline.out)?.[0] ?? '未知项数'}）`);

const originals = new Map(
  [...new Set(CASES.map((c) => c.file))].map((f) => [f, fs.readFileSync(f, 'utf8')]),
);

const problems = [];
let restoredCleanly = false;

try {
  for (const [i, c] of CASES.entries()) {
    log(`\n══ 反例 ${i + 1}/${CASES.length}：${c.name} ══`);

    const original = originals.get(c.file);
    if (!c.from.test(original)) {
      problems.push(`反例「${c.name}」的替换目标在当前文件里找不到 —— 前置形态变了，请更新本脚本`);
      log('  ⚠️  找不到替换目标（跳过）');
      continue;
    }

    fs.writeFileSync(c.file, original.replace(c.from, c.to), 'utf8');
    const r = runVerifyConfig();
    fs.writeFileSync(c.file, original, 'utf8');

    if (r.code === 0) {
      problems.push(`反例「${c.name}」下 verify-config 仍然全绿 —— 这条断言是**假闸门**`);
      log('  🚨 仍然全绿：这条断言拦不住该缺陷');
      continue;
    }
    if (!r.out.includes(c.expect)) {
      problems.push(
        `反例「${c.name}」确实变红了，但红灯里看不到「${c.expect}」—— 判据不精确，红的可能是别的断言`,
      );
      log(`  🚨 变红了但不是预期的断言（找不到「${c.expect}」）`);
      continue;
    }
    log(`  ✅ 如实变红，且红灯命中预期断言：「${c.expect}」`);
  }
} finally {
  // 还原 + 校验（用哈希确认真的写回去了，不靠"我写了"这个感觉）
  log('\n── 还原文件 ──');
  for (const [file, text] of originals) {
    if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, 'utf8');
  }
  const dirty = [...originals.keys()].filter((f) => {
    const expected = crypto.createHash('sha256').update(originals.get(f)).digest('hex');
    return sha(f) !== expected;
  });
  if (dirty.length > 0) {
    console.error(`✗ 还原失败（内容与备份不一致）：${dirty.join(', ')}`);
  } else {
    log(`  ✅ ${originals.size} 个文件已按原始内容还原（sha256 逐字节比对一致）`);
    const after = runVerifyConfig();
    if (after.code === 0) {
      log('  ✅ 还原后 verify-config 回到全绿');
      restoredCleanly = true;
    } else {
      console.error('  ✗ 还原后 verify-config 仍不是全绿 —— **请手工检查 .env 与 nginx 配置**');
      for (const l of after.out.split('\n').slice(-14)) if (l.trim()) console.error('     ' + l);
    }
  }
}

if (!restoredCleanly) process.exit(1);
if (problems.length > 0) {
  console.error(`\n❌ 反向验证不成立（${problems.length} 项）：`);
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}

log(`\n✅ ${CASES.length} 个反例全部成立：这 5 条闸门都能被对应的缺陷形态触发变红，且改动已干净还原。`);
process.exit(0);
