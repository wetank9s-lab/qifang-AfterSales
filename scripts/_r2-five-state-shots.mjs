#!/usr/bin/env node
/**
 * _r2-five-state-shots.mjs —— R2：**五种状态的工单详情**真实界面截图 + 内容取证
 *
 * ## 为什么必须"打开真实界面"而不是只跑接口
 *
 * 用户明确要求："只需要实际打开五种代表性状态的工单详情。确认每种状态：
 * 信息是否正确。重要内容是否在前面。按钮是否真实可执行。无权限操作是否不可用。"
 * ⇒ 接口 200 只证明"后端有数据"；**界面**才证明"人能看到什么、能点什么"。
 *    这与本项目铁律②"判闸门有效要看它真正观测到的东西"同源。
 *
 * ## 取什么证（每条都要能变红）
 *
 * 每个状态打开后，从**抽屉的 DOM** 取：
 *   · `data-testid="detail-issue"` 存在（重要内容在最前）
 *   · `data-testid="detail-next-step"` 的文案（下一步是否与状态自洽）
 *   · 「所属门店」行的文本（R2 服务端投影是否真的渲染出来）
 *   · 抽屉标题里的工单号**只出现一次**（不重复展示）
 *   · 可用按钮清单（<button> 的文本），用于人工核对"该有的有、不该有的没有"
 *   · 控制台/网络错误（证明没红）
 *
 * ## 截图怎么做才不是假证据
 *
 *   · 用**视口截图**（`Page.captureScreenshot` 不带 `captureBeyondViewport`）——
 *     超长截图会触发重排、把 NocoBase 打回 loading 态，截出空白转圈（项目已踩过）；
 *   · 每张图记录**字节数 + sha256**，用哈希区分"真的不同状态"而不是靠文件名；
 *   · 打开抽屉后先 `sleep` 等 `svc:timeline` 回来，再取 DOM、再截图。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchCdp } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
import { execFileSync } from 'node:child_process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp', 'r2-five-states');

const STORE_EMAIL = 'uat.store.a@svc.local';
const STORE_PW = envValue('UAT_STORE_A_PASSWORD');
if (!STORE_PW) {
  console.error('环境未就绪：.env 缺少 UAT_STORE_A_PASSWORD');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-A', '-t', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

/**
 * 五态 → 代表工单（门店 1 的，store.a 账号有权限）。
 *
 * ⚠️ 优先用**本次生命周期脚本刚造出来的**样本（`.tmp-r2-lifecycle.json`），
 *    因为列表页默认只显示最近 20 行 —— 库里既有的 CLOSED 都在 10 月，
 *    翻不到就会得到 `no-row`（第一版就撞上了）。
 *    只有最后一个（CLOSED）拿不到"刚造的"时才回退到库里既有的最新一条。
 */
function pickSamples() {
  const stateFile = path.join(process.cwd(), '.tmp-r2-lifecycle.json');
  const recent = new Map(); // status -> {id, ticketNo}
  if (fs.existsSync(stateFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (j?.ticketId && j?.finalStatus) {
        recent.set(j.finalStatus, { id: Number(j.ticketId), ticketNo: j.ticketNo });
      }
    } catch { /* 忽略 */ }
  }

  const out = [];
  for (const st of ['NEW', 'PROCESSING', 'WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CLOSED']) {
    // 优先：最近一次生命周期脚本产出的该态样本
    const hit = recent.get(st);
    if (hit) { out.push({ status: st, ...hit, from: 'fresh' }); continue; }
    const row = psqlScalar(
      `SELECT id || '|' || ticket_no FROM service_tickets WHERE status='${st}' AND store_id=1 ORDER BY id DESC LIMIT 1;`,
    );
    if (!row) continue;
    const [id, ticketNo] = row.split('|');
    out.push({ status: st, id: Number(id), ticketNo, from: 'db' });
  }
  return out;
}

const results = [];
const ck = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `  [${detail}]` : ''}`);
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const samples = pickSamples();
  console.log('\n五态样本：');
  for (const s of samples) console.log(`  ${s.status.padEnd(20)} #${s.id} ${s.ticketNo}`);

  const session = await launchCdp({ port: 9533, label: 'r2-five' });
  const { cdp } = session;

  try {
    // ---- 收集控制台错误（证明界面没红）----
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); return true; })()`,
    });

    // ---- 同源 fetch 登录（可靠做法：表单注入/native setter 在本项目都失败过）----
    // ⚠️ `cdp.evaluate(expr)` 内部已经 `awaitPromise:true`；**不要**再传第二个参数
    //    （那会被当成 timeout，写成 `{awaitPromise:true}` 会让它变成一个奇怪的对象）。
    await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
    await sleep(4000);
    const login = await cdp.evaluate(
      `(async () => {
        try {
          const r = await fetch('/api/auth:signIn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: ${JSON.stringify(STORE_EMAIL)}, password: ${JSON.stringify(STORE_PW)} }),
          });
          const j = await r.json();
          if (!j || !j.data || !j.data.token) return { ok: false, status: r.status, body: JSON.stringify(j).slice(0, 200) };
          localStorage.setItem('NOCOBASE_TOKEN', j.data.token);
          localStorage.setItem('NOCOBASE_ROLE', 'store_after_sales');
          return { ok: true };
        } catch (e) {
          return { ok: false, why: String(e && e.message || e) };
        }
      })()`,
    );
    ck(login?.ok === true, '同源登录成功并写入 localStorage', JSON.stringify(login).slice(0, 160));
    if (!login?.ok) { session.close(); process.exit(2); }

    const shots = [];
    for (const s of samples) {
      console.log(`\n--- ${s.status}（#${s.id} ${s.ticketNo}）---`);

      // 进入"我的门店工单"列表页（每次重新导航 = 抽屉强制关闭，避免上一态残留）
      await cdp.send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
      await sleep(3500);

      /*
       * ⚠️ 必须**先按工单号筛选**，不能指望目标行出现在首屏。
       *    实测：列表默认 20 行/页，CLOSED 的代表样本 #6668 是 10 月的单，
       *    翻不到 ⇒ `no-row`。用页面自带的「工单号」查询框筛出来最稳。
       */
      const filtered = await cdp.evaluate(
        `(async () => {
          const want = ${JSON.stringify(s.ticketNo)};
          const inputs = [...document.querySelectorAll('input')];
          // 「工单号」输入框：用 placeholder / 邻近 label 定位
          const box = inputs.find((i) => (i.placeholder || '').includes('工单号'))
            || inputs.find((i) => (i.getAttribute('aria-label') || '').includes('工单号'));
          if (!box) return { ok: false, why: 'no-filter-input', placeholders: inputs.map((i) => i.placeholder).filter(Boolean).slice(0, 12) };
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set;
          setter.call(box, want);
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
          // 点「筛选」
          const btn = [...document.querySelectorAll('button')].find((b) => /筛\s*选/.test(b.innerText || ''));
          if (btn) btn.click();
          return { ok: true };
        })()`,
      );
      if (!filtered?.ok) console.log(`  ⚠️ 筛选未生效：${JSON.stringify(filtered)}`);
      await sleep(2500);

      /*
       * ⚠️ 按钮文案是「**查看**」不是「详情」（2026-11-16 实测）。
       *    第一版按 `/详情/` 找按钮 ⇒ `no-detail-btn` ⇒ 抽屉从未打开，
       *    五张截图因此全是同一张列表页（**哈希去重把这件事抓了出来**，
       *    否则我会拿 5 张一样的图当"五态证据"）。
       *    列表行可点元素实测：`["查看", "审核结果"(仅待确认态), "FW2026…"(工单号)]`。
       */
      const openRes = await cdp.evaluate(
        `(async () => {
          const want = ${JSON.stringify(s.ticketNo)};
          const rows = [...document.querySelectorAll('.ant-table-row')];
          const row = rows.find((r) => (r.innerText || '').includes(want));
          if (!row) return { ok: false, why: 'no-row', rowCount: rows.length };
          const btns = [...row.querySelectorAll('button, a')];
          const pick = btns.find((b) => /查看/.test(b.innerText || ''))
            || btns.find((b) => (b.innerText || '').includes(want));
          if (!pick) return { ok: false, why: 'no-open-btn', btns: btns.map((b) => b.innerText).slice(0, 20) };
          pick.click();
          return { ok: true, clicked: (pick.innerText || '').trim() };
        })()`,
      );
      console.log(`  点击详情：${JSON.stringify(openRes)}`);
      await sleep(3000);

      // 取抽屉 DOM 证据
      const probe = await cdp.evaluate(
        `(() => {
          const d = [...document.querySelectorAll('.ant-drawer')].find((x) => {
            const r = x.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== 'hidden';
          });
          if (!d) return { drawer: false };
          const txt = d.innerText || '';
          const q = (sel) => d.querySelector(sel);
          const issue = q('[data-testid="detail-issue"]');
          const next = q('[data-testid="detail-next-step"]');
          const btns = [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean);
          const title = (d.querySelector('.ant-drawer-title') || {}).innerText || '';
          // 工单号在正文里出现几次（应为 0 —— 只在标题出现）
          const no = ${JSON.stringify(s.ticketNo)};
          const bodyText = (d.querySelector('.ant-drawer-body') || {}).innerText || '';
          const countInBody = bodyText.split(no).length - 1;
          const storeMatch = /所属门店\\s*\\n?\\s*([^\\n]+)/.exec(txt);
          return {
            drawer: true,
            title: title.slice(0, 80),
            hasIssue: !!issue,
            issueText: issue ? (issue.innerText || '').slice(0, 120) : null,
            hasNext: !!next,
            nextText: next ? (next.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : null,
            storeName: storeMatch ? storeMatch[1].trim() : null,
            countInBody,
            buttons: btns,
            errs: (window.__errs || []).slice(0, 5),
          };
        })()`,

      );

      console.log(`  抽屉标题：${probe?.title ?? '(无)'}`);
      console.log(`  客户问题卡片：${probe?.hasIssue ? '有' : '无'}`);
      console.log(`  下一步：${probe?.nextText ?? '(无)'}`);
      console.log(`  所属门店：${probe?.storeName ?? '(无)'}`);
      console.log(`  工单号在正文出现次数：${probe?.countInBody}`);
      console.log(`  按钮：${JSON.stringify(probe?.buttons)}`);

      ck(probe?.drawer === true, `${s.status}：抽屉真的打开了`);
      ck(probe?.hasIssue === true, `${s.status}：客户问题在最前（detail-issue 存在）`);
      ck(!!probe?.nextText, `${s.status}：有「下一步」提示`, String(probe?.nextText ?? ''));
      ck(probe?.storeName === '新都圣大家电', `${s.status}：所属门店渲染出真实门店名`, String(probe?.storeName ?? ''));
      ck(probe?.countInBody === 0, `${s.status}：工单号不重复（正文里 0 次）`, `count=${probe?.countInBody}`);

      // 截图（**视口截图**，不用 captureBeyondViewport）
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.data, 'base64');
      const file = path.join(OUT_DIR, `${s.status}_${s.id}.png`);
      fs.writeFileSync(file, buf);
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      console.log(`  截图：${path.basename(file)} (${buf.length} B, sha256:${hash})`);
      shots.push({ ...s, file, bytes: buf.length, hash, probe });

      // 关抽屉（点遮罩或关闭按钮），确保下一态不残留
      await cdp.evaluate(
        `(() => { const b = document.querySelector('.ant-drawer-close'); if (b) b.click(); return true; })()`,

      );
      await sleep(1000);
    }

    console.log('\n===== 截图汇总（用哈希区分，不靠文件名）=====');
    const uniq = new Set(shots.map((x) => x.hash));
    for (const x of shots) console.log(`  ${x.status.padEnd(20)} ${x.bytes} B  sha256:${x.hash}`);
    ck(uniq.size === shots.length, '五张截图互不相同（哈希去重）', `uniq=${uniq.size}/${shots.length}`);

    fs.writeFileSync(
      path.join(OUT_DIR, 'probe.json'),
      JSON.stringify({ samples: shots, generatedAt: new Date().toISOString() }, null, 2),
    );
    console.log(`\n证据目录：${OUT_DIR}`);
  } finally {
    session.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 汇总：${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`} =====`);
  for (const f of failed) console.log(`   FAIL ${f.label} ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e?.stack ?? e?.message ?? e); process.exit(2); });
