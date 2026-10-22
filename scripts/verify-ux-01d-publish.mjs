/**
 * verify-ux-01d-publish.mjs —— UX-01D M1 **发布 / 并发 / 幂等 / 原子性 / 回滚**门禁。
 *
 * 判什么（用户 §五）：
 *   ① 第一份草稿的安全创建；② 两管理员同时保存 → 200 + 409；
 *   ③ 两管理员同时发布 → 200 + 409；④ 同请求号同内容 ⇒ 回放（不新增版本）；
 *   ⑤ 同请求号不同内容 ⇒ 409 IDEMPOTENT_PAYLOAD_MISMATCH；
 *   ⑥ **发布事务中途失败 ⇒ 线上版本不变**（用真实 DB 触发器注入失败）；
 *   ⑦ 回滚 = 新版本 + 旧版快照，历史不被改写；
 *   ⑧ 公开面只看到"完整且已提交"的最新快照，草稿内容不泄漏。
 *
 * ⚠️ 本门禁**会改动 UAT 环境的已发布配置**（这是它的职责）。收尾会把线上恢复成
 *    运行前的快照（**再发一版**，不改写历史），并在报告里如实说明版本号会增加。
 *
 * 用法：node scripts/verify-ux-01d-publish.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return process.env[key] ?? fallback;
}

const pg = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql], {
    encoding: 'utf8',
  }).trim();

async function api(pathname, { method = 'GET', token, body, requestId, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(email, password) {
  const r = await api('/api/auth:signIn', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`登录失败 ${email}: HTTP ${r.status}`);
  return r.json.data.token;
}

const uuid = () => crypto.randomUUID();
const unwrap = (r) => r.json?.data?.data ?? r.json?.data ?? r.json;

const DEFAULT_DOC = {
  schema_version: 1,
  brand: { name: '四川七方连锁售后服务平台', subtitle: '' },
  theme: { preset: 'classic-blue' },
  copy: { media_help: '也可直接填写文字，任选一种即可说明问题。' },
  modules: { media_help: true },
};

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01D M1：发布 / 并发 / 幂等 / 原子失败 / 回滚');
console.log('══════════════════════════════════════════════════════════════');

let admin;
let admin2;
try {
  admin = await login(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
  // 第二个"管理员会话"：同一个账号再登一次（并发语义与两个不同管理员等价，都是两条独立会话）
  admin2 = await login(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
} catch (error) {
  console.log(`  ⛔ 环境未就绪：${error.message}`);
  process.exit(2);
}

const getDraft = async () => unwrap(await api('/api/svc:uiThemeDraft', { token: admin }));
const getPublic = async () => {
  const r = await api('/api/publicUiTheme:get');
  return { body: r.json?.data ?? r.json, etag: r.headers.get('etag'), status: r.status };
};
const releaseCount = () => Number(pg(`select count(*) from page_theme_releases where scope='hq'`) || 0);
const latestVersion = () => Number(pg(`select coalesce(max(version),0) from page_theme_releases where scope='hq'`) || 0);

const save = (doc, expectedRevision, token = admin, requestId = uuid()) =>
  api('/api/svc:uiThemeSave', { method: 'POST', token, requestId, body: { doc, expected_revision: expectedRevision } });
const publish = (expectedRevision, token = admin, requestId = uuid()) =>
  api('/api/svc:uiThemePublish', { method: 'POST', token, requestId, body: { expected_revision: expectedRevision } });

const initial = await getDraft();
const initialPublic = await getPublic();
const originalPublishedDoc = initialPublic.body.version > 0 ? initialPublic.body : null;
note('运行前线上版本', `v${initialPublic.body.version}`);
note('运行前草稿修订号', String(initial.draft?.revision ?? 0));

try {
  // -------------------------------------------------------------------------
  // ① 第一份草稿的安全创建（已存在则按当前 revision 保存一份已知内容）
  // -------------------------------------------------------------------------
  console.log('\n① 草稿保存（乐观锁）');
  const docA = {
    ...DEFAULT_DOC,
    brand: { name: 'M1发布门禁', subtitle: '并发与回滚验证' },
    theme: { preset: 'brand-red' },
  };
  const firstSave = await save(docA, Number(initial.draft?.revision ?? 0));
  check(firstSave.status === 200, '保存成功（首次 expected_revision=0 或按现有修订号）', `HTTP ${firstSave.status}`);
  const revA = Number(unwrap(firstSave)?.revision ?? 0);
  check(revA > 0, '返回新的修订号', String(revA));

  // -------------------------------------------------------------------------
  // ② 两管理员同时保存
  // -------------------------------------------------------------------------
  console.log('\n② 并发保存（同一 expected_revision）');
  const [s1, s2] = await Promise.all([
    save({ ...docA, brand: { ...docA.brand, subtitle: '并发-A' } }, revA, admin),
    save({ ...docA, brand: { ...docA.brand, subtitle: '并发-B' } }, revA, admin2),
  ]);
  const statuses = [s1.status, s2.status].sort();
  check(statuses[0] === 200 && statuses[1] === 409, '一个 200 + 一个 409', statuses.join(' / '));

  // -------------------------------------------------------------------------
  // ③ 幂等：同请求号 + 同内容 ⇒ 回放；不同内容 ⇒ 409
  // -------------------------------------------------------------------------
  console.log('\n③ 幂等（request_id）');
  const cur = await getDraft();
  const revNow = Number(cur.draft?.revision ?? 0);
  const docIdem = { ...cur.draft.doc, brand: { ...cur.draft.doc.brand, subtitle: '幂等验证' } };
  const rid = uuid();
  const a1 = await save(docIdem, revNow, admin, rid);
  const revAfter = Number(unwrap(a1)?.revision ?? 0);
  const a2 = await save(docIdem, revAfter, admin, rid);
  check(a1.status === 200 && a2.status === 200, '同号同内容两次都 200', `${a1.status} / ${a2.status}`);
  check(Boolean(unwrap(a2)?.replayed), '第二次标记 replayed=true', JSON.stringify(unwrap(a2)));
  check(
    Number(unwrap(a2)?.revision) === revAfter,
    '回放不推进修订号',
    `${unwrap(a2)?.revision} vs ${revAfter}`,
  );

  const mismatch = await save({ ...docIdem, brand: { ...docIdem.brand, subtitle: '另一份内容' } }, revAfter, admin, rid);
  check(mismatch.status === 409, '同号不同内容 ⇒ 409', `HTTP ${mismatch.status}`);
  check(
    String(unwrap(mismatch)?.code ?? '') === 'IDEMPOTENT_PAYLOAD_MISMATCH' ||
      /IDEMPOTENT_PAYLOAD_MISMATCH/.test(mismatch.text),
    '错误码为 IDEMPOTENT_PAYLOAD_MISMATCH',
    mismatch.text.slice(0, 120),
  );

  // -------------------------------------------------------------------------
  // ④ 两管理员同时发布
  // -------------------------------------------------------------------------
  console.log('\n④ 并发发布（同一 expected_revision）');
  const beforePub = await getDraft();
  const revToPublish = Number(beforePub.draft?.revision ?? 0);
  const [p1, p2] = await Promise.all([publish(revToPublish, admin), publish(revToPublish, admin2)]);
  const pStatuses = [p1.status, p2.status].sort();
  check(pStatuses[0] === 200 && pStatuses[1] === 409, '一个 200 + 一个 409', pStatuses.join(' / '));
  const pubWinner = p1.status === 200 ? p1 : p2;
  const vAfterConcurrent = Number(unwrap(pubWinner)?.version ?? 0);
  check(vAfterConcurrent === latestVersion(), '线上版本 = 库里最大版本', `v${vAfterConcurrent}`);

  const afterPubPublic = await getPublic();
  check(
    afterPubPublic.body.version === vAfterConcurrent,
    '公开接口读到新版本',
    `public v${afterPubPublic.body.version}`,
  );
  check(
    afterPubPublic.body.brand.name === beforePub.draft.doc.brand.name &&
      afterPubPublic.body.theme.preset === beforePub.draft.doc.theme.preset,
    '公开内容 = 已发布快照（逐字段来自草稿的整份快照）',
    JSON.stringify(afterPubPublic.body.brand),
  );

  // -------------------------------------------------------------------------
  // ⑤ 发布幂等（同号同内容 ⇒ 不新增版本；同号不同内容 ⇒ 409）
  // -------------------------------------------------------------------------
  console.log('\n⑤ 发布幂等');
  const pubRid = uuid();
  const cur2 = await getDraft();
  const rev2 = Number(cur2.draft?.revision ?? 0);
  const doc2 = { ...cur2.draft.doc, brand: { ...cur2.draft.doc.brand, name: '幂等发布验证' } };
  const s3 = await save(doc2, rev2);
  const rev3 = Number(unwrap(s3)?.revision ?? 0);
  const countBefore = releaseCount();
  const pub1 = await publish(rev3, admin, pubRid);
  const countMid = releaseCount();
  const pub2 = await publish(rev3, admin, pubRid);
  const countAfter = releaseCount();
  check(pub1.status === 200 && pub2.status === 200, '同号同内容两次都 200', `${pub1.status} / ${pub2.status}`);
  check(Boolean(unwrap(pub2)?.replayed), '第二次标记 replayed=true');
  check(countMid === countBefore + 1 && countAfter === countMid, '版本行只增 1 行（回放不再插）', `${countBefore}→${countMid}→${countAfter}`);

  const cur3 = await getDraft();
  const rev4 = Number(cur3.draft?.revision ?? 0);
  const s4 = await save({ ...cur3.draft.doc, brand: { ...cur3.draft.doc.brand, name: '改成别的内容' } }, rev4);
  const rev5 = Number(unwrap(s4)?.revision ?? 0);
  const pubMismatch = await publish(rev5, admin, pubRid);
  check(pubMismatch.status === 409, '同号不同内容发布 ⇒ 409', `HTTP ${pubMismatch.status} ${pubMismatch.text.slice(0, 100)}`);

  // -------------------------------------------------------------------------
  // ⑥ 原子性：发布事务中途失败 ⇒ 线上不变
  // -------------------------------------------------------------------------
  console.log('\n⑥ 原子性（DB 触发器注入"发布中途失败"）');
  const cur4 = await getDraft();
  const rev6 = Number(cur4.draft?.revision ?? 0);
  const s5 = await save(
    { ...cur4.draft.doc, brand: { ...cur4.draft.doc.brand, name: '本该失败的发布' } },
    rev6,
  );
  const revBeforeFail = Number(unwrap(s5)?.revision ?? 0);
  const versionBeforeFail = latestVersion();
  const publicBeforeFail = await getPublic();
  const draftBeforeFail = await getDraft();

  pg(
    `CREATE OR REPLACE FUNCTION ux01d_fail_publish() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ux01d injected failure'; END; $$ LANGUAGE plpgsql;`,
  );
  pg(`DROP TRIGGER IF EXISTS ux01d_fail_publish ON page_theme_releases;`);
  pg(`CREATE TRIGGER ux01d_fail_publish BEFORE INSERT ON page_theme_releases FOR EACH ROW EXECUTE FUNCTION ux01d_fail_publish();`);
  let failStatus = 0;
  let failText = '';
  try {
    const failed = await publish(revBeforeFail);
    failStatus = failed.status;
    failText = failed.text;
  } finally {
    pg(`DROP TRIGGER IF EXISTS ux01d_fail_publish ON page_theme_releases;`);
    pg(`DROP FUNCTION IF EXISTS ux01d_fail_publish();`);
  }
  check(failStatus >= 500, '发布在事务中途失败（5xx）', `${failStatus} ${failText.slice(0, 100)}`);
  check(latestVersion() === versionBeforeFail, '线上版本不变', `${latestVersion()} vs ${versionBeforeFail}`);
  const publicAfterFail = await getPublic();
  check(
    publicAfterFail.body.version === publicBeforeFail.body.version &&
      JSON.stringify(publicAfterFail.body.brand) === JSON.stringify(publicBeforeFail.body.brand),
    '公开内容不变（没有半成品）',
    `v${publicAfterFail.body.version}`,
  );
  const draftAfterFail = await getDraft();
  check(
    Number(draftAfterFail.draft?.revision) === Number(draftBeforeFail.draft?.revision),
    '草稿未被改动（失败不吞数据）',
    `${draftAfterFail.draft?.revision} vs ${draftBeforeFail.draft?.revision}`,
  );

  // -------------------------------------------------------------------------
  // ⑦ 回滚：新版本 + 旧快照，历史不改写
  // -------------------------------------------------------------------------
  console.log('\n⑦ 回滚（新版本 + 旧快照）');
  const versions = pg(`select version from page_theme_releases where scope='hq' order by version`)
    .split('\n')
    .filter(Boolean)
    .map(Number);
  check(versions.length >= 2, '至少有两个历史版本可供回滚', versions.join(','));
  const target = versions[0];
  const targetDocBefore = pg(
    `select doc::text from page_theme_releases where scope='hq' and version=${target}`,
  );
  const countBeforeRollback = releaseCount();
  const versionMaxBefore = latestVersion();

  const rb = await api('/api/svc:uiThemeRollback', {
    method: 'POST',
    token: admin,
    requestId: uuid(),
    body: { to_version: target, note: `门禁回滚到 v${target}` },
  });
  check(rb.status === 200, '回滚成功', `HTTP ${rb.status} ${rb.text.slice(0, 120)}`);
  const rbOut = unwrap(rb);
  check(Number(rbOut?.version) === versionMaxBefore + 1, '回滚产生**新版本号**', `v${rbOut?.version}`);
  check(Number(rbOut?.rolled_back_from) === target, 'rolled_back_from 指向来源版本', String(rbOut?.rolled_back_from));
  check(releaseCount() === countBeforeRollback + 1, '只新增 1 行（历史不删）', `${countBeforeRollback}→${releaseCount()}`);

  const targetDocAfter = pg(
    `select doc::text from page_theme_releases where scope='hq' and version=${target}`,
  );
  check(targetDocAfter === targetDocBefore, `旧版本 v${target} 的快照未被改写`, 'jsonb 文本逐字相等');

  const newDoc = pg(`select doc::text from page_theme_releases where scope='hq' and version=${rbOut?.version}`);
  check(newDoc === targetDocBefore, '新版本的 doc 逐字等于目标快照', 'jsonb 文本逐字相等');

  const publicAfterRollback = await getPublic();
  check(
    JSON.stringify(publicAfterRollback.body.brand) ===
      JSON.stringify((JSON.parse(targetDocBefore).brand ?? {})),
    '公开接口回到目标版本的品牌',
    JSON.stringify(publicAfterRollback.body.brand),
  );
  check(
    !/本该失败的发布/.test(JSON.stringify(publicAfterRollback.body)),
    '失败发布的草稿内容没有泄漏到公开面',
  );
} finally {
  // -------------------------------------------------------------------------
  // 收尾：把线上恢复成运行前快照（**再发一版**，不删历史、不改旧行）
  // -------------------------------------------------------------------------
  console.log('\n收尾：恢复线上为运行前内容');
  try {
    const restoreDoc = originalPublishedDoc ?? DEFAULT_DOC;
    const cur = await getDraft();
    const rev = Number(cur.draft?.revision ?? 0);
    const s = await save(
      {
        schema_version: 1,
        brand: restoreDoc.brand,
        theme: restoreDoc.theme,
        copy: restoreDoc.copy,
        modules: restoreDoc.modules,
      },
      rev,
    );
    if (s.status === 200) {
      const r = await publish(Number(unwrap(s)?.revision ?? 0));
      note('恢复发布', `HTTP ${r.status} · v${unwrap(r)?.version ?? '?'}`);
    } else {
      note('恢复失败（草稿保存）', `HTTP ${s.status} ${s.text.slice(0, 120)}`);
    }
  } catch (error) {
    note('恢复异常', String(error?.message ?? error));
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  发布契约：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过');
  console.log('');
}
