/**
 * _r2-real-op-internal-note.mjs —— R2「完成一项真实业务操作」端到端验证
 *
 * 这是用户点名的例子：**添加内部跟进/备注**。
 *
 * 判据（对照用户原话"操作可提交；后台实际保存；详情正确更新；办理记录可查看"）：
 *   ① 提交成功（200）—— 操作可提交
 *   ② 库里真出现该事件行（ticketEvents，event_type='internal_note'）—— 后台实际保存
 *      · 且**只**新增这一条，工单本身的 status / closed_at / is_charged 一个都没变
 *   ③ `svc:timeline` 再取一次，新事件在返回里 —— 详情正确更新
 *   ④ 事件带操作者与正文（metadata.note）—— 办理记录可查看
 *   ⑤ **幂等**：同一个 X-Request-Id 重发 ⇒ 不产生第二条（回放）
 *   ⑥ **反向**：只读角色（viewer）提交 ⇒ 403（证明可提交不是因为"谁都能写"）
 *
 * ⚠️ 这会**真的写一条业务数据**（用户明确要求"完成一项真实业务操作"）。
 *    写入内容带 [R2-VERIFY] 前缀便于识别；不删（append-only 的语义就是留痕）。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** ⚠️ 必须 https://127.0.0.1；:8080 会 301 丢 body（见 _r2-store-name-probe.mjs 注释） */
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
  if (m) env[m[1]] = m[2];
}

const results = [];
const ck = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
};

/**
 * 🔴 **psql 出错必须抛错，绝不返回空串**（2026-11-16 假绿事故的直接修法）。
 *
 *    第一版直接 `execFileSync(...).trim()`：SQL 里写了一个**不存在的列**
 *    （`is_charged`），psql 把错误打到 stderr、退出码非 0，但 `execFileSync`
 *    默认不因 stderr 失败 ⇒ 两次快照都得到 `''` ⇒ `'' === ''` ⇒ 断言**假绿**。
 *    这正是本项目铁律"断言不会变红 = 没有断言"的教科书案例。
 *    ⇒ 现在把 exit code 与 stderr 都纳入判据，SQL 错就当场炸掉。
 */
function psql(sql) {
  let out = '';
  try {
    out = execFileSync(
      'docker',
      ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const stderr = String(e?.stderr ?? '');
    if (stderr) throw new Error(`psql 执行失败（SQL 或列名有误）：\n${stderr.trim()}`);
    throw e;
  }
  return out.trim();
}

async function signIn(account, password) {
  const res = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await res.json().catch(() => null);
  if (!j?.data?.token) throw new Error(`登录失败 ${account}: HTTP ${res.status}`);
  return j.data.token;
}

async function api(token, p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

async function main() {
  // ---- 选一张**门店 1** 的活跃工单，且当前无内部备注，便于"新增前后"对比 ----
  const picked = psql(`
    select t.id, t.ticket_no, t.status
    from service_tickets t
    where t.store_id = 1
      and t.status in ('NEW','PROCESSING')
    order by t.id desc limit 1;
  `);
  const [ticketId, ticketNo, statusBefore] = picked.split('|');
  console.log(`\n样本：工单 #${ticketId} ${ticketNo}（状态 ${statusBefore}）`);

  // 工单主体字段快照（用来证明"内部备注不改工单"）
  // ⚠️ 列名以库为准：本表**没有** `is_charged`；收费在 service_visits 上。
  const SNAPSHOT_SQL = `select status, coalesce(close_reason,'-'), coalesce(closed_at::text,'-'), coalesce(completed_at::text,'-') from service_tickets where id=${ticketId};`;
  const snapBefore = psql(SNAPSHOT_SQL);
  // 再证一次"真的读到了行"——否则上面那条"未改动"又会是 '' === ''
  ck(snapBefore.length > 0, '工单快照非空（SQL 真的读到了行，排除假绿）', `snapshot=[${snapBefore}]`);
  const noteCountBefore = Number(psql(`select count(*) from ticket_events where ticket_id=${ticketId} and event_type='internal_note';`));
  console.log(`写入前：工单快照=[${snapBefore}] / 已有内部备注 ${noteCountBefore} 条`);

  const token = await signIn('uat.store.a@svc.local', env.UAT_STORE_A_PASSWORD);

  // ---- ① 提交 ----
  const marker = `[R2-VERIFY] 已完成电话回访，客户确认机器运转正常（${new Date().toISOString()}）`;
  const requestId = crypto.randomUUID();
  console.log('\n--- ① 提交内部备注 ---');
  const post = await api(token, `/api/svc:internalNote?filterByTk=${ticketId}`, {
    method: 'POST',
    headers: { 'X-Request-Id': requestId },
    body: { note: marker },
  });
  ck(post.status === 200, '提交返回 200（操作可提交）', `status=${post.status} body=${post.text.slice(0, 160)}`);
  const eventId = post.json?.data?.event?.id;
  ck(!!eventId, '响应带新事件 id', `event.id=${eventId}`);

  // ---- ② 库里真保存 ----
  console.log('\n--- ② 后台实际保存 ---');
  const noteCountAfter = Number(psql(`select count(*) from ticket_events where ticket_id=${ticketId} and event_type='internal_note';`));
  ck(noteCountAfter === noteCountBefore + 1,
    ' ticket_events 新增恰好 1 条 internal_note',
    `${noteCountBefore} → ${noteCountAfter}`);

  const snapAfter = psql(SNAPSHOT_SQL);
  ck(snapAfter.length > 0 && snapAfter === snapBefore,
    ' 工单主体字段未被改动（状态/关闭原因/关闭时间/完工时间全等）',
    `before=[${snapBefore}] after=[${snapAfter}]`);

  // ---- ③ timeline 再取，新事件出现 ----
  console.log('\n--- ③ 详情正确更新 ---');
  const tl = await api(token, `/api/svc:timeline?filterByTk=${ticketId}&pageSize=50`);
  const events = tl.json?.data?.events ?? [];
  const mine = events.find((e) => Number(e.id) === Number(eventId));
  ck(!!mine, ' svc:timeline 返回里包含新事件', `events=${events.length}`);
  ck(String(mine?.summary ?? '').includes('[R2-VERIFY]') || String(mine?.metadata?.note ?? '').includes('[R2-VERIFY]'),
    ' 新事件正文可读（summary / metadata.note 命中标记）',
    `summary="${String(mine?.summary ?? '').slice(0, 60)}"`);

  // ---- ④ 操作者留痕 ----
  console.log('\n--- ④ 办理记录可查看 ---');
  const opUser = mine?.operator_user_id ?? mine?.operatorUserId;
  ck(opUser != null && Number(opUser) > 0, ' 事件记录了操作者', `operator_user_id=${opUser}`);

  // ---- ⑤ 幂等：同 requestId 重发不新增 ----
  console.log('\n--- ⑤ 幂等（同 X-Request-Id 重发）---');
  const dup = await api(token, `/api/svc:internalNote?filterByTk=${ticketId}`, {
    method: 'POST',
    headers: { 'X-Request-Id': requestId },
    body: { note: marker },
  });
  const noteCountDup = Number(psql(`select count(*) from ticket_events where ticket_id=${ticketId} and event_type='internal_note';`));
  ck(dup.status === 200, '重发仍 200（回放）', `status=${dup.status}`);
  ck(noteCountDup === noteCountAfter,
    '重发**没有**新增第二条（幂等生效）',
    `${noteCountAfter} → ${noteCountDup}`);

  // ---- ⑥ 反向：viewer 必须被拒 ----
  console.log('\n--- ⑥ 反向：只读角色提交应被拒 ---');
  const vToken = await signIn('uat.viewer@svc.local', env.UAT_VIEWER_PASSWORD);
  const vPost = await api(vToken, `/api/svc:internalNote?filterByTk=${ticketId}`, {
    method: 'POST',
    headers: { 'X-Request-Id': crypto.randomUUID() },
    body: { note: 'viewer 不该写进来' },
  });
  ck(vPost.status === 403 || vPost.status === 404,
    ' viewer 提交被拒（可写 ≠ 谁都能写）',
    `status=${vPost.status} code=${vPost.json?.errors?.[0]?.code ?? vPost.json?.code ?? '-'}`);
  const noteCountV = Number(psql(`select count(*) from ticket_events where ticket_id=${ticketId} and event_type='internal_note';`));
  ck(noteCountV === noteCountAfter, 'viewer 被拒后库里也没多出数据', `${noteCountAfter} → ${noteCountV}`);

  console.log('\n===== 汇总 =====');
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`);
  for (const f of failed) console.log(`   FAIL ${f.label} ${f.detail}`);
  console.log(`\n（写入的备注：工单 #${ticketId}，event.id=${eventId}）`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常：', e?.message ?? e); process.exit(2); });
