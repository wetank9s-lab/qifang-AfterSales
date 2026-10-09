#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-config-falsegreen-reverse.mjs —— Phase 10 · #62 假绿清扫的**反向验证**
 * -----------------------------------------------------------------------------
 *  目的：证明新加/改写的三条判据**真的会变红**（铁律：断言不会变红 = 没有断言）。
 *
 *  与既有反向脚本（verify-technician-routing-reverse.mjs）不同的地方：
 *    本脚本有**两种极性** ——
 *      · kind:'red'   ：注入缺陷 ⇒ 必须变红，且红灯要命中**预期的那一条**断言；
 *      · kind:'green' ：注入"看起来很可疑但其实没问题"的形态 ⇒ 必须**仍然全绿**。
 *
 *    第二种极性是本次的重点。`#62-1` 修的是 mtime 判据，而旧判据的毛病是**假红**：
 *    `git checkout` / `cp` / 重新 clone 只刷 mtime、不动内容，它却要求"请重新 build"。
 *    只做 red 反例的话，"改完不再假红"这件事**根本没被证明** ——
 *    所以必须有一条"只改 mtime ⇒ 仍绿"的用例，并且要断言**指纹那条判据确实还在跑**
 *    （不能只看整体 exit 0：门禁整体没跑起来时也是 exit 0）。
 *
 *  用法：node scripts/verify-config-falsegreen-reverse.mjs
 *  退出码：0 = 全部反例成立且已干净还原；1 = 有反例不成立/还原失败；2 = 前置条件不成立
 * =============================================================================
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERIFY_CONFIG = path.join(ROOT, 'scripts', 'verify-config.mjs');

const NGINX_MAIN = path.join(ROOT, 'nginx', 'nginx.conf');
const SITE_CONF = path.join(ROOT, 'nginx', 'conf.d', 'service.conf');
const SRC_PROBE = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', 'collections', 'smsLogs.ts');
const MANIFEST = path.join(ROOT, 'storage', 'plugins', '@local', 'service-ticket', 'dist', 'build-fingerprint.json');
const H5_ASSETS = path.join(ROOT, 'h5', 'dist', 'assets');

const log = (s) => console.log(s);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const runVerifyConfig = () => {
  const r = spawnSync(process.execPath, [VERIFY_CONFIG], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ---------------------------------------------------------------------------
// 前置：起始状态必须是全绿的，否则"变红"没有意义
// ---------------------------------------------------------------------------
const baseline = runVerifyConfig();
if (baseline.code !== 0) {
  console.error('✗ 前置条件不成立：verify-config 当前不是全绿，先把它修好再来做反向验证。');
  for (const l of baseline.out.split('\n').slice(-14)) if (l.trim()) console.error('   ' + l);
  process.exit(2);
}
// ⚠️ 只匹配汇总行：输出正文里也到处出现"N 项"，抓第一个会把证据记错
//   （首跑真实踩到：这里显示成"11 项"，而实际是 59 项）。
log(`✓ 前置：verify-config 全绿（${/全部通过：(\d+) 项/.exec(baseline.out)?.[1] ?? '未知项数'} 项）`);

// ---------------------------------------------------------------------------
// 反例定义
// ---------------------------------------------------------------------------
/** 备份文本文件内容，供还原时逐字节比对 */
const textBackup = new Map();
const backupText = (p) => {
  if (!textBackup.has(p)) textBackup.set(p, fs.readFileSync(p, 'utf8'));
};
const restoreText = (p) => fs.writeFileSync(p, textBackup.get(p), 'utf8');

const CASES = [
  // ---- #62-1 源码指纹 -----------------------------------------------------
  {
    name: '源码内容改了一个字节、但没有重建产物（"产物落后于源码"的真实形态）',
    kind: 'red',
    expect: '源码已变、产物未重建',
    apply: () => {
      backupText(SRC_PROBE);
      fs.writeFileSync(SRC_PROBE, `${textBackup.get(SRC_PROBE)}\n// [reverse-probe] 反向验证临时写入，跑完必须还原\n`, 'utf8');
    },
    restore: () => restoreText(SRC_PROBE),
  },
  {
    name: '只改源码 mtime、内容一个字节没变（旧 mtime 判据在这里会**假红**；新判据必须仍绿）',
    kind: 'green',
    expect: '指纹一致',
    apply: () => {
      backupText(SRC_PROBE);
      // 关键：把源码 mtime 顶到"比产物还新" —— 这正是旧判据 `outM >= newest` 必然判红的形态。
      const future = new Date(Date.now() + 3600 * 1000);
      fs.utimesSync(SRC_PROBE, future, future);
      const artifact = path.join(ROOT, 'storage', 'plugins', '@local', 'service-ticket', 'dist', 'server', 'index.js');
      if (!(fs.statSync(SRC_PROBE).mtimeMs > fs.statSync(artifact).mtimeMs)) {
        throw new Error('前置形态没造出来：源码 mtime 未超过产物 mtime ⇒ 这条用例是空跑');
      }
    },
    restore: () => restoreText(SRC_PROBE), // 内容未变，写回只为把 mtime 也带回正常
  },
  {
    name: '产物缺少构建指纹清单（产物来源不明，不能当作"已同步"放行）',
    kind: 'red',
    expect: '产物缺少源码指纹清单',
    apply: () => {
      backupText(MANIFEST);
      fs.rmSync(MANIFEST);
    },
    restore: () => restoreText(MANIFEST),
  },

  // ---- #62-2 h5/dist 空目录 ----------------------------------------------
  {
    name: 'h5/dist 的产物被清空（目录还在 ⇒ 旧的存在性断言照样通过，而 /h5/ 全站 404）',
    kind: 'red',
    expect: 'index.html 引用的产物缺失或为空',
    apply: () => {
      // 移走（而不是删除）：还原时不重新生成产物，避免"还原"本身把真实产物换掉
      fs.mkdirSync(`${H5_ASSETS}.reverse-bak`, { recursive: true });
      for (const f of fs.readdirSync(H5_ASSETS)) {
        fs.renameSync(path.join(H5_ASSETS, f), path.join(`${H5_ASSETS}.reverse-bak`, f));
      }
      if (fs.readdirSync(H5_ASSETS).length !== 0) throw new Error('资产目录没被清空 —— 用例空跑');
    },
    restore: () => {
      for (const f of fs.readdirSync(`${H5_ASSETS}.reverse-bak`)) {
        fs.renameSync(path.join(`${H5_ASSETS}.reverse-bak`, f), path.join(H5_ASSETS, f));
      }
      fs.rmSync(`${H5_ASSETS}.reverse-bak`, { recursive: true, force: true });
    },
  },

  // ---- #62-3 限流值 -------------------------------------------------------
  {
    name: '对客承诺被顺手放宽：svc_public rate 30r/m → 300r/m',
    kind: 'red',
    expect: 'rate 是',
    apply: () => {
      backupText(NGINX_MAIN);
      fs.writeFileSync(
        NGINX_MAIN,
        textBackup.get(NGINX_MAIN).replace('zone=svc_public:10m   rate=30r/m', 'zone=svc_public:10m   rate=300r/m'),
        'utf8',
      );
    },
    restore: () => restoreText(NGINX_MAIN),
  },
  {
    name: '突发容量被顺手放宽：svc_public burst=10 → burst=1000（只钉 rate 的话这条拦不住）',
    kind: 'red',
    expect: 'burst=',
    apply: () => {
      backupText(SITE_CONF);
      fs.writeFileSync(
        SITE_CONF,
        textBackup.get(SITE_CONF).replace('zone=svc_public burst=10', 'zone=svc_public burst=1000'),
        'utf8',
      );
    },
    restore: () => restoreText(SITE_CONF),
  },
  {
    name: 'limit_req 漏写 burst（nginx 默认 burst=0，等于零突发）',
    kind: 'red',
    expect: '未显式写 burst',
    apply: () => {
      backupText(SITE_CONF);
      fs.writeFileSync(
        SITE_CONF,
        textBackup.get(SITE_CONF).replace('limit_req zone=svc_public burst=10 nodelay', 'limit_req zone=svc_public nodelay'),
        'utf8',
      );
    },
    restore: () => restoreText(SITE_CONF),
  },
  {
    name: 'nginx.conf 里指向单一事实来源的指针被删掉（改值的人将不再被引导去改 expected-rate-limits.mjs）',
    kind: 'red',
    expect: '未指向 scripts/expected-rate-limits.mjs',
    apply: () => {
      backupText(NGINX_MAIN);
      // 🔴 必须带 `g`（删**全部**出现处）。本 fixture 此前只有 `m` ⇒ 只替换第一处。
      //    2026-10-09（Phase 11 / P11-0）踩到：给 svc_general 加注释时**新写了一处**
      //    `expected-rate-limits.mjs` 引用，于是"删指针"只删掉旧的、新的还在
      //    ⇒ verify-config 仍绿 ⇒ 反向门如实报"这条断言是假闸门"。
      //    ⇒ 缺陷形态是"指针被删掉"，注入就必须覆盖它的**全部**形态；
      //      只删一处是**注入不完整**，而不是产品有假绿。
      fs.writeFileSync(
        NGINX_MAIN,
        textBackup.get(NGINX_MAIN).replace(/^.*scripts\/expected-rate-limits\.mjs.*$/gm, '    # （指针已被反向验证临时移除）'),
        'utf8',
      );
    },
    restore: () => restoreText(NGINX_MAIN),
  },
];

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
const problems = [];
let restoredCleanly = false;

try {
  for (const [i, c] of CASES.entries()) {
    log(`\n══ 反例 ${i + 1}/${CASES.length}［${c.kind === 'red' ? '必须变红' : '必须仍绿'}］：${c.name} ══`);
    try {
      c.apply();
    } catch (e) {
      problems.push(`反例「${c.name}」的缺陷形态没造出来：${e.message}`);
      log(`  🚨 ${e.message}`);
      continue;
    }

    const r = runVerifyConfig();
    c.restore();

    if (c.kind === 'red') {
      if (r.code === 0) {
        problems.push(`反例「${c.name}」下 verify-config 仍然全绿 —— 这条断言是**假闸门**`);
        log('  🚨 仍然全绿：这条断言拦不住该缺陷');
        continue;
      }
      if (!r.out.includes(c.expect)) {
        problems.push(`反例「${c.name}」确实变红了，但红灯里看不到「${c.expect}」—— 红的可能是别的断言`);
        log(`  🚨 变红了但不是预期的断言（找不到「${c.expect}」）`);
        continue;
      }
      log(`  ✅ 如实变红，且红灯命中预期断言：「${c.expect}」`);
    } else {
      // 极性为"必须仍绿"：只看 exit 0 不够 —— 门禁整体没跑起来时也是 exit 0。
      // 必须同时确认**那一条判据确实执行了且判绿**，否则就是"因为没检所以绿"。
      if (r.code !== 0) {
        const failed = [...r.out.matchAll(/•\s+(.+)/g)].map((m) => m[1].trim()).slice(0, 5);
        problems.push(`反例「${c.name}」下 verify-config 不该变红却红了 —— 假红又回来了：${failed.join(' / ')}`);
        log(`  🚨 不该变红却红了：${failed.join(' / ')}`);
        continue;
      }
      if (!r.out.includes(c.expect)) {
        problems.push(`反例「${c.name}」下整体全绿，但看不到「${c.expect}」—— 该判据可能根本没执行（空绿）`);
        log(`  🚨 看不到「${c.expect}」—— 判据可能没跑（空绿不等于真绿）`);
        continue;
      }
      log(`  ✅ 仍然全绿，且目标判据确实执行并判绿：「${c.expect}」`);
    }
  }
} finally {
  log('\n── 还原 ──');
  for (const [p, text] of textBackup) {
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) fs.writeFileSync(p, text, 'utf8');
  }
  // 资产目录兜底还原（apply 抛错时可能没走到 restore）
  if (fs.existsSync(`${H5_ASSETS}.reverse-bak`)) {
    for (const f of fs.readdirSync(`${H5_ASSETS}.reverse-bak`)) {
      const dst = path.join(H5_ASSETS, f);
      if (!fs.existsSync(dst)) fs.renameSync(path.join(`${H5_ASSETS}.reverse-bak`, f), dst);
    }
    fs.rmSync(`${H5_ASSETS}.reverse-bak`, { recursive: true, force: true });
  }

  const dirty = [...textBackup.keys()].filter(
    (p) => sha(p) !== crypto.createHash('sha256').update(textBackup.get(p)).digest('hex'),
  );
  if (dirty.length > 0) {
    console.error(`✗ 还原失败（内容与备份不一致）：${dirty.join(', ')}`);
  } else {
    log(`  ✅ ${textBackup.size} 个文件已按原始内容还原（sha256 逐字节比对一致）`);
    const after = runVerifyConfig();
    if (after.code === 0) {
      log('  ✅ 还原后 verify-config 回到全绿');
      restoredCleanly = true;
    } else {
      console.error('  ✗ 还原后 verify-config 仍不是全绿 —— **请手工检查 nginx 配置与插件产物**');
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

log(
  `\n✅ ${CASES.length} 个反例全部成立：` +
    `${CASES.filter((c) => c.kind === 'red').length} 条缺陷形态都能把对应断言打红，` +
    `${CASES.filter((c) => c.kind === 'green').length} 条"看起来可疑但其实没问题"的形态仍然判绿;` +
    `改动已干净还原。`,
);
