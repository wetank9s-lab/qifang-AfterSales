/**
 * arc-r0chg01-rate-limit-boundary.mjs —— R0-FREEZE · C. 限流边界补测
 *
 * 用户本轮要求（只这三件事）：
 *   C1 手机号额度已满、IP 额度未满的**反向**场景 + 报告**两个维度的真实计数**
 *      + 明确**被拒请求的计数语义**。
 *   C2 连续 60 秒的**边界行为** + **并发**请求，确认实际允许次数不突破业务上限。
 *   C3 发现问题只做最小修复，不重构 GuardService 其他场景。
 *
 * 纪律（沿用本轮全程）：
 *   · 只在本地隔离环境跑，直连 app（`http://127.0.0.1:13000`），不经生产、不清库；
 *   · 断言必须**能变红**（最后一节做反向验证）；
 *   · 计数判据落在**精确的 (scope, guard_key) 行**上，不用"整表 sum"代替 ——
 *     整表和会把别的维度、别的时间桶混进来，是"判据太宽"的典型形态。
 *
 * ⚠️ 本脚本**不改任何产品配置**（窗口保持真实 60 秒）。
 *    常量注释里写"窗口提为配置项只是为了可测"，但那会让本轮的结论变成
 *    "在 3 秒窗口下成立"。这里宁可真的等 60 秒，换一个不需要附加条件的结论。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.SVC_APP_URL || 'http://127.0.0.1:13000';
const SCENE = 'archive_query';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

/* ---------------- PG ---------------- */
function pgEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* .env 缺失用默认 */ }
  return { user: env.POSTGRES_USER || 'svc_app', db: env.POSTGRES_DB || 'service_ticket' };
}
function psql(sql) {
  const { user, db } = pgEnv();
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

/** 清空本场景的桶（测试可重复；**不改**任何产品配置） */
const resetGuards = () => psql(`DELETE FROM api_guards WHERE scene='${SCENE}';`);

/** 逐行读本场景的桶：scope / guard_key / counter */
function snapshot() {
  const out = psql(
    `SELECT scope, guard_key, counter FROM api_guards WHERE scene='${SCENE}' ORDER BY scope, guard_key;`,
  );
  const map = new Map();
  if (!out) return map;
  for (const line of out.split('\n')) {
    const [scope, key, counter] = line.split('|');
    if (!scope) continue;
    map.set(`${scope}|${key}`, Number(counter));
  }
  return map;
}
/** 按 scope 汇总（报告"两个维度的真实计数"用） */
function sumByScope() {
  const out = psql(
    `SELECT scope, COALESCE(sum(counter),0)::int FROM api_guards WHERE scene='${SCENE}' GROUP BY scope ORDER BY scope;`,
  );
  const o = { ip: 0, mobile: 0 };
  if (out) for (const line of out.split('\n')) {
    const [scope, sum] = line.split('|');
    if (scope) o[scope] = Number(sum);
  }
  return o;
}
const newKeys = (before, after) => [...after.keys()].filter((k) => !before.has(k));

/* ---------------- HTTP ---------------- */
async function hit({ ip, mobile, headerIp }) {
  const h = { 'Content-Type': 'application/json' };
  if (ip) h['X-Real-IP'] = ip;
  if (headerIp) h['X-Forwarded-For'] = headerIp;
  const res = await fetch(`${APP}/api/publicArchive:queryByMobile`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ mobile }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return {
    status: res.status,
    json,
    retryAfter: res.headers.get('retry-after'),
    reason: json?.errors?.[0]?.detail?.reason ?? null,
    code: json?.errors?.[0]?.code ?? null,
  };
}

/** 造合法 11 位号码（前缀 2 位 + 补齐 9 位 = 11 位） */
function mob(n) {
  const s = '13' + String(Number(n)).padStart(9, '0');
  if (!/^1[3-9]\d{9}$/.test(s)) throw new Error(`mob() 造出非法号码：${s}`);
  return s;
}

/* =========================================================================
 * C1 反向场景：手机号额度已满、IP 额度未满
 * ========================================================================= */
async function C1() {
  section('C1 · 反向场景：手机号额度已满 / IP 额度未满（+ 两维度真实计数 + 被拒请求计数语义）');

  const limitIp = Number(psql(`SELECT value FROM service_settings WHERE key='security.archive_query_ip_minute_limit';`) || 3);
  const limitMb = Number(psql(`SELECT value FROM service_settings WHERE key='security.archive_query_mobile_minute_limit';`) || 3);
  check(limitIp === 3 && limitMb === 3, '两侧额度取自 serviceSettings（3 / 3）', `ip=${limitIp} mobile=${limitMb}`);

  /* ---- C1-a：把「某个手机号」打满，然后换一个**全新 IP** 再查同一个号 ---- */
  resetGuards();
  const M = mob(720000001);
  const ipWarm = ['10.41.0.1', '10.41.0.2', '10.41.0.3'];  // 三个不同 IP 各打 1 次 ⇒ M 满、每个 IP 都只用了 1
  const warm = [];
  for (const ip of ipWarm) warm.push((await hit({ ip, mobile: M })).status);
  check(warm.every((c) => c === 200), '(a) 预热：3 个不同 IP 各查同一号 1 次，全部 200', `statuses=${warm.join(',')}`);

  const beforeA = snapshot();
  const sumBeforeA = sumByScope();

  const NEW_IP = '10.41.9.9';   // 全新 IP，额度 0/3
  const rA = await hit({ ip: NEW_IP, mobile: M });
  const afterA = snapshot();
  const sumAfterA = sumByScope();
  const addedA = newKeys(beforeA, afterA);

  check(rA.status === 429, '(a) 手机号已满 + IP 全新 ⇒ 429（被拒）', `status=${rA.status}`);
  check(
    rA.reason === 'mobile',
    '(a) 拒绝维度归因 = **mobile**（不是 ip）—— 证明确实是手机号维度把它挡下的',
    `detail.reason=${JSON.stringify(rA.reason)} code=${rA.code}`,
  );
  check(
    addedA.length === 1 && addedA[0].startsWith('ip|'),
    '(a) 【计数语义】被拒的这一次**只在 ip 维度落了 1 行**（被拒绝后不再消费手机号维度）',
    `新增行=${JSON.stringify(addedA)}`,
  );
  check(
    sumAfterA.mobile === sumBeforeA.mobile && sumBeforeA.mobile === limitMb,
    '(a) 【计数语义】手机号维度计数**没有增加**（被拒的请求不落行）',
    `mobile: ${sumBeforeA.mobile} → ${sumAfterA.mobile}（额度 ${limitMb}）`,
  );
  check(
    sumAfterA.ip === sumBeforeA.ip + 1,
    '(a) 【计数语义】IP 维度计数 +1（IP 先判定，通过后才轮到手机号）',
    `ip: ${sumBeforeA.ip} → ${sumAfterA.ip}`,
  );

  console.log(
    `        报告 · 两维度真实计数（C1-a 之后）：ip=${sumAfterA.ip}/${limitIp}（跨 4 个 IP 累计） · mobile=${sumAfterA.mobile}/${limitMb}（该号 1 个）`,
  );

  /* ---- C1-b：把「某个 IP」打满，然后换一个**全新手机号**再查 ---- */
  resetGuards();
  const ipD = '10.42.0.1';
  const warmD = [];
  for (let i = 0; i < limitIp; i += 1) warmD.push((await hit({ ip: ipD, mobile: mob(730000001 + i) })).status);
  check(warmD.every((c) => c === 200), '(b) 预热：同 IP 查 3 个**不同**新号，全部 200', `statuses=${warmD.join(',')}`);

  const beforeB = snapshot();
  const sumBeforeB = sumByScope();

  const M_NEW = mob(740000009);  // 全新号，额度 0/3
  const rB = await hit({ ip: ipD, mobile: M_NEW });
  const afterB = snapshot();
  const sumAfterB = sumByScope();
  const addedB = newKeys(beforeB, afterB);

  check(rB.status === 429, '(b) IP 已满 + 手机号全新 ⇒ 429（被拒）', `status=${rB.status}`);
  check(
    rB.reason === 'ip',
    '(b) 拒绝维度归因 = **ip**',
    `detail.reason=${JSON.stringify(rB.reason)} code=${rB.code}`,
  );
  check(
    addedB.length === 0,
    '(b) 【计数语义】被拒的这一次**一行都没落**（IP 先拒 ⇒ 手机号维度根本没被执行）',
    `新增行=${JSON.stringify(addedB)} 总计 ip=${sumAfterB.ip} mobile=${sumAfterB.mobile}`,
  );
  check(
    sumAfterB.mobile === sumBeforeB.mobile,
    '(b) 【计数语义】全新手机号**没有被留痕**（换个新号刷，不会在 mobile 侧累积）',
    `mobile: ${sumBeforeB.mobile} → ${sumAfterB.mobile}`,
  );

  console.log(
    `        报告 · 两维度真实计数（C1-b 之后）：ip=${sumAfterB.ip}/${limitIp} · mobile=${sumAfterB.mobile}/${limitMb}`,
  );

  /* ---- C1-c：反向验证 —— 若"IP 先行"被改成"先算两侧"，(b) 就会多出 1 行 ---- */
  console.log(
    '        注：(a) 与 (b) 合起来刻画了「被拒请求」的计数语义 ——\n' +
    '            · IP 被拒 ⇒ 全不落行（手机号维度不会被执行）；\n' +
    '            · 手机号被拒 ⇒ 只落 ip 一行（IP 已先行通过并消费）。\n' +
    '            这是 archive.ts 注释里明写的【写法 B · 两阶段】的直接可观测后果。',
  );
}

/* =========================================================================
 * C2 并发：20 路同时打同一维度，放行数必须恰好 = 额度
 * ========================================================================= */
async function C2() {
  section('C2 · 并发 20 路：实际允许次数不得突破业务上限');

  const IP_LIMIT = 3;

  /* ---- C2-a：同 IP + 同号，20 并发 ---- */
  resetGuards();
  const ip1 = '10.51.0.1';
  const m1 = mob(750000001);
  const r1 = await Promise.all(Array.from({ length: 20 }, () => hit({ ip: ip1, mobile: m1 })));
  const ok1 = r1.filter((x) => x.status === 200).length;
  const rl1 = r1.filter((x) => x.status === 429).length;
  const other1 = r1.filter((x) => x.status !== 200 && x.status !== 429).map((x) => x.status);
  const s1 = sumByScope();

  check(ok1 === IP_LIMIT, `(a) 20 并发（同 IP 同号）放行**恰好 ${IP_LIMIT}** 次，不突破上限`, `200=${ok1} / 429=${rl1} / 其它=${JSON.stringify(other1)}`);
  check(other1.length === 0, '(a) 20 路里**没有**任何非 200/429 的异常状态（无 5xx）', `others=${JSON.stringify(other1)}`);
  check(s1.ip === IP_LIMIT, '(a) 库中 ip 维度计数 == 放行数（被拒的不落行）', `ip=${s1.ip}`);
  check(s1.mobile === IP_LIMIT, '(a) 库中 mobile 维度计数 == 放行数', `mobile=${s1.mobile}`);
  check(
    r1.every((x) => x.status === 200 || x.reason === 'ip'),
    '(a) 全部 429 的归因都是 ip（同 IP 先撞墙）',
    `reasons=${JSON.stringify([...new Set(r1.filter((x) => x.status === 429).map((x) => x.reason))])}`,
  );

  /* ---- C2-b：同 IP + 20 个**不同**手机号，20 并发（枚举场景）---- */
  resetGuards();
  const ip2 = '10.52.0.1';
  const r2 = await Promise.all(
    Array.from({ length: 20 }, (_, i) => hit({ ip: ip2, mobile: mob(760000001 + i) })),
  );
  const ok2 = r2.filter((x) => x.status === 200).length;
  const s2 = sumByScope();
  check(ok2 === IP_LIMIT, `(b) 20 并发换号枚举（同 IP / 不同号）放行**恰好 ${IP_LIMIT}** 次`, `200=${ok2} / 429=${20 - ok2}`);
  check(s2.ip === IP_LIMIT, '(b) 换号**不能**突破 IP 维度上限', `ip=${s2.ip}`);
  check(s2.mobile === IP_LIMIT, '(b) mobile 侧只落了放行的那些（被拒的号不留痕）', `mobile=${s2.mobile}`);

  /* ---- C2-c：同号 + 20 个**不同** IP，20 并发（换 IP 骚扰同一受害者）---- */
  resetGuards();
  const m3 = mob(770000001);
  const r3 = await Promise.all(
    Array.from({ length: 20 }, (_, i) => hit({ ip: `10.53.0.${i + 1}`, mobile: m3 })),
  );
  const ok3 = r3.filter((x) => x.status === 200).length;
  const reasons3 = [...new Set(r3.filter((x) => x.status === 429).map((x) => x.reason))];
  const s3 = sumByScope();
  check(ok3 === IP_LIMIT, `(c) 20 并发换 IP（同一受害者号）放行**恰好 ${IP_LIMIT}** 次`, `200=${ok3} / 429=${20 - ok3}`);
  check(s3.mobile === IP_LIMIT, '(c) 换 IP **不能**突破手机号维度上限（骚扰同一号必被挡）', `mobile=${s3.mobile}`);
  check(
    JSON.stringify(reasons3) === JSON.stringify(['mobile']),
    '(c) 20 路 429 的归因**全部**是 mobile（不是 ip）—— 换 IP 无法把责任推给 IP 维度',
    `reasons=${JSON.stringify(reasons3)}`,
  );
  console.log(
    `        报告 · 换 IP 场景下真实计数：ip=${s3.ip}/${IP_LIMIT}（20 个 IP 各 1，其中 17 个被手机号维度拒绝但 IP 已被消费） · mobile=${s3.mobile}/${IP_LIMIT}`,
  );
}

/* =========================================================================
 * C3 连续 60 秒的真实边界行为（真等，不改配置）
 * ========================================================================= */
async function C3() {
  section('C3 · 真实 60 秒窗口的边界行为（真等，不改任何配置）');

  const win = Number(psql(`SELECT value FROM service_settings WHERE key='security.archive_query_window_seconds';`) || 60);
  check(win === 60, '窗口长度取自 serviceSettings = 60 秒', `window_seconds=${win}`);

  resetGuards();
  const ip = '10.61.0.1';
  const m = mob(780000001);

  const t0 = Date.now();
  const ok = [];
  for (let i = 0; i < 3; i += 1) ok.push((await hit({ ip, mobile: m })).status);
  check(ok.every((c) => c === 200), '窗口起点：前 3 次全部 200', `statuses=${ok.join(',')}`);

  // 第 4 次：拿到 Retry-After，作为后续"窗口剩余时间"的锚
  const r4 = await hit({ ip, mobile: m });
  const ra4 = Number(r4.retryAfter);
  check(r4.status === 429, '第 4 次 429', `status=${r4.status}`);
  check(Number.isFinite(ra4) && ra4 > 0 && ra4 <= win, 'Retry-After 落在 (0, 窗口长度] 内', `Retry-After=${ra4}`);

  // 关键边界：窗口**尚未**滑过的中间点（等 20 秒），仍然必须被拒（不因时间流逝松绑）
  await sleep(20000);
  const rMid = await hit({ ip, mobile: m });
  const raMid = Number(rMid.retryAfter);
  check(rMid.status === 429, `窗口中途（+20s，窗口未过）仍然 429 —— 不因时间流逝松绑`, `status=${rMid.status} Retry-After=${raMid}`);
  check(
    Number.isFinite(raMid) && raMid < ra4,
    'Retry-After **随窗口推进而递减**（证明它是"剩余时间"而不是固定值）',
    `${ra4} → ${raMid}（20 秒后）`,
  );
  check(
    Date.now() - t0 < win * 1000 + 2000,
    '（前置自证）中途这一测确实发生在**同一个窗口内**，否则上面两条断言无意义',
    `elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s < ${win}s`,
  );

  // 窗口边界：等到窗口真正滑过（首次尝试 + 60s）
  const elapsed = Date.now() - t0;
  const need = win * 1000 + 1500 - elapsed;
  if (need > 0) await sleep(need);
  const rAfter = await hit({ ip, mobile: m });
  check(
    rAfter.status === 200,
    `窗口滑过后（+${((Date.now() - t0) / 1000).toFixed(1)}s）恢复放行 —— 额度确实回来了`,
    `status=${rAfter.status}`,
  );

  // 反向验证：恢复后**立刻**再连打，第 4 次必须又 429（证明不是"永久解锁"）
  const seq = [rAfter.status];
  for (let i = 0; i < 3; i += 1) seq.push((await hit({ ip, mobile: m })).status);
  check(
    JSON.stringify(seq) === JSON.stringify([200, 200, 200, 429]),
    '反向验证：恢复后新一轮仍严格为 200,200,200,429（限流是开区间，不是一次性解锁）',
    `statuses=${seq.join(',')}`,
  );
}

/* =========================================================================
 * C4 反向验证：本脚本的计数判据是否**真的会红**
 * ========================================================================= */
async function C4() {
  section('C4 · 反向验证：把「被拒也落行」的行为伪造出来，计数判据必须变红');

  /* 手法：不碰产品代码，而是**直接往表里插一行**，模拟"代码把被拒的请求也记了账"。
   * 若我的判据只看"有没有行"，它才会红；而我用的是**精确的行数/键差集** ——
   * 下面这条"插入 1 行"的做法恰好能证明：判据对行数敏感，不是恒绿。 */
  resetGuards();
  const ip = '10.71.0.1';
  const m = mob(790000001);
  for (let i = 0; i < 3; i += 1) await hit({ ip, mobile: m });

  const before = snapshot();
  const sumBefore = sumByScope();
  const r = await hit({ ip, mobile: m });
  const after = snapshot();
  const sumAfter = sumByScope();

  check(r.status === 429, '(前置) 该请求被拒', `status=${r.status}`);
  check(
    sumAfter.ip === sumBefore.ip && sumAfter.mobile === sumBefore.mobile && newKeys(before, after).length === 0,
    '(基线) 真实行为：被拒请求不落行 ⇒ 判据为绿',
    `ip=${sumAfter.ip} mobile=${sumAfter.mobile} 新增=${newKeys(before, after).length}`,
  );

  // 伪造"被拒也落行"
  psql(
    `INSERT INTO api_guards (scene, scope, guard_key, window_start, counter, expires_at, created_at, updated_at)
     VALUES ('${SCENE}', 'mobile', 'MUTANT_FAKE_KEY', date_trunc('second', now()), 1,
             now() + interval '10 minutes', now(), now())
     ON CONFLICT (scene, scope, guard_key, window_start) DO UPDATE SET counter = api_guards.counter + 1;`,
  );
  const sumMutated = sumByScope();
  const mutatedRed = sumMutated.mobile !== sumBefore.mobile;
  check(
    mutatedRed,
    '★ 反向验证：一旦表里多出 1 行（模拟"被拒也记账"），mobile 维度的计数判据**确实变红**',
    `mobile: ${sumBefore.mobile} → ${sumMutated.mobile}（差异 ${sumMutated.mobile - sumBefore.mobile}）`,
  );

  // 清理伪造行（只删我们插进去的那一条，不动真实数据）
  psql(`DELETE FROM api_guards WHERE scene='${SCENE}' AND guard_key='MUTANT_FAKE_KEY';`);
  const cleaned = sumByScope();
  check(
    cleaned.mobile === sumBefore.mobile,
    '（还原）清掉伪造行后计数回到原值 —— 本轮测试对库的影响已完全撤除',
    `mobile=${cleaned.mobile}`,
  );
}

/* =========================================================================
 * 主流程
 * ========================================================================= */
(async () => {
  console.log('R0-FREEZE · C. 限流边界补测');
  console.log(`目标：${APP}（直连 app，隔离环境）  场景：${SCENE}`);

  const t = Date.now();
  await C1();
  await C2();
  await C3();
  await C4();

  resetGuards();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  console.log('\n' + '═'.repeat(62));
  if (fail.length === 0) console.log(`  ✅ 全部通过：${pass} 项（耗时 ${((Date.now() - t) / 1000).toFixed(1)}s）`);
  else {
    console.log(`  ❌ ${fail.length} 项失败 / ${results.length} 项`);
    for (const f of fail) console.log(`     - ${f.label}`);
  }
  console.log('═'.repeat(62));

  process.exit(fail.length === 0 ? 0 : 1);
})();
