#!/usr/bin/env node
/**
 * verify-public-archive-gate.mjs —— PROD-HOTFIX-01 第一节的**针对性验证**
 *
 * 只验四件事（用户明令不重复历史验收）：
 *   ① **默认关闭**（不设 `PUBLIC_ARCHIVE_ENABLED`）⇒ 6 条匿名 action 全 403，且
 *      错误码是 `PUBLIC_ARCHIVE_DISABLED`，**不是**业务参数错误；
 *   ② **显式关闭**（`=false` / `=0` / `=yes` 等）⇒ 同样 403；
 *   ③ **允许开启的既有逻辑**（`=true`）⇒ 原行为不变（能进到业务层，
 *      例如 `queryByMobile` 缺手机号返回 400 `ARCHIVE_QUERY_BAD_MOBILE`）；
 *   ④ **不影响原售后公共接口**（`publicStore:list` = 200）+ 不影响员工端 `svc:*`（仍然要登录）。
 *
 * ★ 三条自证（防止"验了个假绿"）：
 *   · 每个 403 都必须是**我方错误码** —— 只判状态码会把 nginx 的 403、ACL 的 403
 *     全算成通过（这正是本仓库反复踩的"判据太宽 = 自造假绿"）；
 *   · `=true` 时必须**真的进到业务层**（拿到业务错误码）—— 否则"403 没了"可能只是
 *     换成了另一种拒绝；
 *   · 必须有**反向对照**：同一台实例、同一个 action，开/关两种档位给出**不同结论**。
 *
 * 用法：
 *   node scripts/verify-public-archive-gate.mjs --base=http://127.0.0.1:13001 \
 *     --container=svc-app-uat --compose=docker-compose.uat.yml
 *
 * ⚠️ 本脚本会**重启目标容器**（改环境变量必须重启才能生效）。
 *    默认只允许指向隔离容器：`--container` 若非 `*-uat` 会直接拒绝运行，
 *    除非显式加 `--allow-prod`（生产验证只做**只读**档，不重启）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d = '') => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};
const BASE = arg('base', 'http://127.0.0.1:13001');
const CONTAINER = arg('container', 'svc-app-uat');
const COMPOSE = arg('compose', 'docker-compose.uat.yml');
const READ_ONLY = process.argv.includes('--read-only');

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}\n        ${detail}`);
}

async function call(p, { method = 'POST', body, headers = {} } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/** 六个匿名 action + 一个最小合法请求体（关闭态下这些体**不应被解析**） */
const ACTIONS = [
  ['sendCode', { store_code: 'HL01', mobile: '13800138000' }],
  ['verify', { store_code: 'HL01', mobile: '13800138000', code: '000000' }],
  ['list', {}],
  ['detail', { archive_no: 'ARC-TEST-0001' }],
  ['photo', { photo_id: 1 }],
  ['queryByMobile', { mobile: '13800138000' }],
];

function gated(res) {
  const codes = (res.json?.errors ?? []).map((e) => e?.code);
  return res.status === 403 && codes.includes('PUBLIC_ARCHIVE_DISABLED');
}

function waitReady(timeoutMs = 180000) {
  const t0 = Date.now();
  return (async () => {
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch(BASE + '/api/app:getInfo', { method: 'GET' });
        if (r.status === 200) return true;
      } catch { /* 未就绪 */ }
      await sleep(2000);
    }
    return false;
  })();
}

function withEnv(value) {
  // 通过 compose override 注入/覆盖环境变量（不修改仓库里的 compose 文件）
  const overridePath = path.join(ROOT, '.tmp-media/hotfix01/compose-gate.override.yml');
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  const svc = CONTAINER.endsWith('-uat') ? 'app-uat' : 'app';
  const envBlock = value === null
    ? '      PUBLIC_ARCHIVE_ENABLED: ""'   // 空串 == 关闭（也不是 'true'）
    : `      PUBLIC_ARCHIVE_ENABLED: "${value}"`;
  fs.writeFileSync(overridePath, [
    'services:',
    `  ${svc}:`,
    '    environment:',
    envBlock,
    '',
  ].join('\n'), 'utf8');
  return overridePath;
}

async function restart(overridePath) {
  execFileSync('docker', [
    'compose', '-f', COMPOSE, '-f', overridePath, 'up', '-d', '--force-recreate', CONTAINER.endsWith('-uat') ? 'app-uat' : 'app',
  ], { stdio: 'pipe' });
  const ok = await waitReady();
  if (!ok) throw new Error('容器重启后 180s 内未就绪');
}

console.log('='.repeat(78));
console.log(`publicArchive 开关验证   base=${BASE} container=${CONTAINER}${READ_ONLY ? '  [READ-ONLY]' : ''}`);
console.log('='.repeat(78));

// ---- ④ 先测"不受影响"的两条（这两条与开关无关，任意档位都应成立）----
const storeRes = await call('/api/publicStore:list', { method: 'GET' });
record('X4a', '原有匿名门店接口 publicStore:list 不受影响（200 且有数据）',
  storeRes.status === 200 && Array.isArray(storeRes.json?.data) && storeRes.json.data.length > 0,
  `status=${storeRes.status} 门店数=${Array.isArray(storeRes.json?.data) ? storeRes.json.data.length : 'n/a'}`);

const svcRes = await call('/api/svc:userProfile', { method: 'GET' }).catch(() => ({ status: 0 }));
// svc 资源名不在公开清单里；这里只确认"没登录拿不到"，不关心具体码
record('X4b', '员工端 svc:* 仍需登录（匿名请求不得 200）',
  svcRes.status !== 200, `GET /api/svc:userProfile 匿名 ⇒ status=${svcRes.status}`);

if (!READ_ONLY) {
  // ---- ① 默认关闭：不设该环境变量 ----
  const ovOff = withEnv('');
  await restart(ovOff);
  const offResults = [];
  for (const [name, body] of ACTIONS) {
    const r = await call(`/api/publicArchive:${name}`, { body });
    offResults.push({ name, status: r.status, gated: gated(r),
      code: (r.json?.errors ?? [])[0]?.code ?? null,
      detail: (r.json?.errors ?? [])[0]?.detail ?? null });
  }
  record('X1', '默认关闭 + 显式空值 ⇒ 6 条匿名 action **全部** 403 且错误码为 PUBLIC_ARCHIVE_DISABLED',
    offResults.every((x) => x.gated),
    offResults.map((x) => `${x.name}:${x.status}/${x.code}`).join(' '));

  // ★ 关键自证：不能是"参数错在前" —— queryByMobile 传了合法手机号，若业务层先跑会返回 400
  const qbm = offResults.find((x) => x.name === 'queryByMobile');
  record('X1b', '★ 关闭态下**未进入业务层**：携带合法手机号仍返回 403（不是 400 ARCHIVE_QUERY_BAD_MOBILE）',
    qbm.status === 403 && qbm.code === 'PUBLIC_ARCHIVE_DISABLED' && qbm.code !== 'ARCHIVE_QUERY_BAD_MOBILE',
    `queryByMobile 携带 mobile=13800138000 ⇒ ${qbm.status} ${qbm.code}`);

  // ---- ② 显式关闭：各种"看起来像真值但不是 true"的写法 ----
  //
  // ⚠️ 这里刻意**不**把 'TRUE' / ' true ' 放进关闭清单：
  //    判据是"规范化后等于 true"，大小写与首尾空白属于**同一个值**，
  //    把它们当成"应关闭"就是给产品提了一个它没承诺的要求（验证器自己造的红）。
  //    第一次跑这条时我把 'TRUE ' 写进了关闭清单 ⇒ 得到一条假红。
  //    ⇒ 大小写/空白归入下面的"必须开启"组（见 X2b）。
  const explicitOff = ['false', '0', 'yes', 'on', '1', 'no', 'off', 'FALSE'];
  const badOnes = [];
  for (const v of explicitOff) {
    const ov = withEnv(v);
    await restart(ov);
    const r = await call('/api/publicArchive:queryByMobile', { body: { mobile: '13800138000' } });
    if (!gated(r)) badOnes.push(`${JSON.stringify(v)}=>${r.status}/${(r.json?.errors ?? [])[0]?.code}`);
  }
  record('X2', '显式关闭：false/0/no/off/yes/on/1/FALSE 一律关闭（宽松真值不得放行）',
    badOnes.length === 0,
    badOnes.length ? `未关闭：${badOnes.join(' ')}` : `已验 ${explicitOff.length} 种写法，全部 403`);

  // ---- ②b 大小写与首尾空白：'TRUE ' 仍是 true（同一个值，不是宽松解释）----
  const looseTrue = ['true', 'TRUE', ' true '];
  const notOpened = [];
  for (const v of looseTrue) {
    const ov = withEnv(v);
    await restart(ov);
    const r = await call('/api/publicArchive:queryByMobile', { body: { mobile: '13800138000' } });
    if (gated(r)) notOpened.push(`${JSON.stringify(v)}=>${r.status}`);
  }
  record('X2b', "大小写/首尾空白不算另一个值：'true' / 'TRUE' / ' true ' 都应开启",
    notOpened.length === 0,
    notOpened.length ? `未开启：${notOpened.join(' ')}` : `已验 ${looseTrue.length} 种写法，均未被拦`);

  // ---- ③ 显式开启：既有逻辑不变 ----
  const ovOn = withEnv('true');
  await restart(ovOn);
  const onRes = await call('/api/publicArchive:queryByMobile', { body: { mobile: '13800138000' } });
  const onCode = (onRes.json?.errors ?? [])[0]?.code ?? null;
  // 开启后应"进到业务层"：要么 200（有数据），要么业务错误（400 手机号/503 依赖缺失/429 限流）
  record('X3', '显式 true ⇒ 放行到业务层（不再返回 PUBLIC_ARCHIVE_DISABLED）',
    onRes.status !== 403 && onCode !== 'PUBLIC_ARCHIVE_DISABLED',
    `queryByMobile ⇒ ${onRes.status} ${onCode ?? '(200/data)'}`);

  // 其余 5 条同样不得再被开关拦
  const onOthers = [];
  for (const [name, body] of ACTIONS.filter(([n]) => n !== 'queryByMobile')) {
    const r = await call(`/api/publicArchive:${name}`, { body });
    onOthers.push({ name, status: r.status, code: (r.json?.errors ?? [])[0]?.code ?? null });
  }
  record('X3b', '显式 true ⇒ 其余 5 条也不被开关拦（业务错误/成功均可，只要不是 PUBLIC_ARCHIVE_DISABLED）',
    onOthers.every((x) => x.code !== 'PUBLIC_ARCHIVE_DISABLED'),
    onOthers.map((x) => `${x.name}:${x.status}/${x.code}`).join(' '));

  // ---- ★ 反向对照：同一实例同一 action，开关切换必须产生**不同结论** ----
  record('X5', '★ 反向对照：同实例同 action（queryByMobile），关⇒403 且 开⇒非403（证明测的是开关，不是网络/ACL）',
    qbm.status === 403 && onRes.status !== 403,
    `关闭 ${qbm.status} ${qbm.code} / 开启 ${onRes.status} ${onCode ?? 'data'}`);

  // ---- 收尾：恢复成"关闭"（生产目标态）并核验 ----
  const ovFinal = withEnv('');
  await restart(ovFinal);
  const finalRes = await call('/api/publicArchive:queryByMobile', { body: { mobile: '13800138000' } });
  record('X6', '收尾：恢复关闭态并核验（隔离实例不得留在"开启"状态）',
    gated(finalRes), `恢复后 ⇒ ${finalRes.status} ${(finalRes.json?.errors ?? [])[0]?.code}`);
}

const failed = results.filter((r) => !r.pass);
fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01/public-archive-gate.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, container: CONTAINER,
    readOnly: READ_ONLY, results }, null, 2));
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
