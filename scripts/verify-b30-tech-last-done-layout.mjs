/**
 * verify-b30-tech-last-done-layout.mjs —— B-30 师傅「上一单作业记录」卡片布局门禁
 *
 * 背景（真机缺陷）：卡片文案曾整段放在 `.svc-hint` 里，而 `.svc-hint` 是
 * `display:flex; justify-content:space-between`（给"左文案 + 右按钮"用的）。
 * 长文本被拆成多个 flex item ⇒ 「不提供详情」竖排 4 列单字，整段裂成三列。
 *
 * 本门禁直接量**真实浏览器的行盒**，不看截图、不看字数：
 *   ① 卡片内每个文本块：行数不超过 8、非末行宽度 ≥ 26px（两个汉字）、无水平溢出；
 *   ② 卡片内各段落左边界一致（差 < 2px）—— 防止"裂成多列"；
 *   ③ 卡片整体高度 ≤ 280px（375 下正常约 180px，裂列时会飙到 400+）；
 *   ④ 文档无横向滚动；
 *   ⑤ 关键文案存在（标题 / 时间 / 工单号 / 不提供工单详情 / 清除按钮）；
 *   ⑥ 三视口 375 / 390 / 420。
 *
 * 反向验证（必须能变红）：把 `.svc-tech-done-note` 的样式改回 `display:flex`
 * （或把模板换回 `.svc-hint`）⇒ ① ② ③ 必红。
 *
 * 无副作用：不建工单、不写库；只在本浏览器 localStorage 注入一条摘要，跑完清掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(process.cwd(), '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  B-30：师傅「上一单作业记录」卡片布局（真实浏览器行盒）');
console.log('══════════════════════════════════════════════════════════════');

const TOKEN = 'Z'.repeat(43);
const session = await launchCdp({ port: 9494, label: 'b30-layout' });
const { cdp } = session;

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE}/h5/technician/visit/${TOKEN}` });
  await cdp.waitFor(`!!document.querySelector('.svc-alert') || !!document.querySelector('[data-testid="tech-last-done"]')`, {
    what: '失效页',
    timeout: 40_000,
  });
  // 注入"本机有上一单"（只写批准的两个字段）
  await cdp.evaluate(
    `(() => { localStorage.setItem('svc.tech.lastDone.v1', JSON.stringify({ ticketNo: 'FW20261019-0001', completedAt: Date.now() - 3600_000 })); return true; })()`,
  );

  for (const w of [375, 390, 420]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: `${BASE}/h5/technician/visit/${TOKEN}` });
    await cdp.waitFor(`!!document.querySelector('[data-testid="tech-last-done"]')`, {
      what: '上一单卡片',
      timeout: 30_000,
    });
    await sleep(400);

    const m = await cdp.evaluate(`(() => {
      const card = document.querySelector('[data-testid="tech-last-done"]');
      const blocks = [...card.querySelectorAll('h2, p')];
      const measured = blocks.map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()].filter((r) => r.width > 1);
        const box = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          lines: rects.length,
          widths: rects.map((r) => Math.round(r.width)),
          left: Math.round(box.left),
          overflows: el.scrollWidth > el.clientWidth + 1,
        };
      });
      const btn = card.querySelector('[data-testid="tech-clear-done"]');
      const bb = btn ? btn.getBoundingClientRect() : null;
      return {
        blocks: measured,
        cardHeight: Math.round(card.getBoundingClientRect().height),
        lefts: [...new Set(measured.map((x) => x.left))],
        btnVisible: !!bb && bb.width > 0 && bb.height >= 24,
        docScroll: document.documentElement.scrollWidth,
        win: window.innerWidth,
        text: card.innerText.replace(/\\s+/g, ' ').trim(),
      };
    })()`);

    note(
      `${w}px`,
      `高度=${m.cardHeight} · 左边界=${JSON.stringify(m.lefts)} · ` +
        m.blocks.map((b) => `${b.tag}:${b.lines}行`).join(' '),
    );

    // ① 每个文本块：行数合理、非末行不是单字、无溢出
    const badLines = m.blocks.filter((b) => b.lines > 8);
    check(badLines.length === 0, `${w}px ① 每个文本块行数 ≤ 8（未逐字换行）`, JSON.stringify(badLines));
    const narrow = m.blocks.filter((b) => b.widths.slice(0, -1).some((x) => x < 26));
    check(narrow.length === 0, `${w}px ② 非末行宽度 ≥ 26px（无单字成行）`, JSON.stringify(narrow));
    const overflow = m.blocks.filter((b) => b.overflows);
    check(overflow.length === 0, `${w}px ③ 文本块无水平溢出`, JSON.stringify(overflow));

    // ④ 各段左边界一致（裂成多列时 left 会分成好几组）
    check(m.lefts.length === 1, `${w}px ④ 所有段落左边界一致（未裂成多列）`, JSON.stringify(m.lefts));

    // ⑤ 卡片高度（裂列时会飙到 400+）
    check(m.cardHeight <= 280, `${w}px ⑤ 卡片高度 ≤ 280px`, `${m.cardHeight}px`);

    // ⑥ 无横向滚动
    check(m.docScroll <= m.win, `${w}px ⑥ 文档无横向滚动`, `scrollWidth=${m.docScroll} innerWidth=${m.win}`);

    // ⑦ 关键文案与操作
    check(/上一单作业记录/.test(m.text), `${w}px ⑦ 有标题「上一单作业记录」`, m.text.slice(0, 40));
    check(/工单号：FW20261019-0001/.test(m.text), `${w}px ⑦ 显示工单号`, '');
    check(/不提供工单详情/.test(m.text), `${w}px ⑦ 明确"不提供工单详情"`, '');
    check(
      !/本次售后服务(已经)?全部完成|工单已完成/.test(m.text),
      `${w}px ⑦ 不误写成"服务已全部完成"`,
      '',
    );
    check(m.btnVisible, `${w}px ⑦ 清除按钮可见且触控高度 ≥ 24px`, String(m.btnVisible));

    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `b30-tech-last-done-${w}.png`), Buffer.from(r.data, 'base64'));
  }

  // ---- 无本机记录时整卡不出现 ----
  await cdp.evaluate(`(() => { localStorage.removeItem('svc.tech.lastDone.v1'); return true; })()`);
  await cdp.send('Page.navigate', { url: `${BASE}/h5/technician/visit/${TOKEN}` });
  await cdp.waitFor(`!!document.querySelector('.svc-alert')`, { what: '失效页', timeout: 30_000 });
  await sleep(300);
  const noCard = await cdp.evaluate(`!document.querySelector('[data-testid="tech-last-done"]')`);
  check(noCard === true, '⑧ 本机无记录时整卡不出现（不显示空壳）', String(noCard));

  // ---- 清除后立即消失 ----
  await cdp.evaluate(
    `(() => { localStorage.setItem('svc.tech.lastDone.v1', JSON.stringify({ ticketNo: 'FW20261019-0002', completedAt: Date.now() })); return true; })()`,
  );
  await cdp.send('Page.navigate', { url: `${BASE}/h5/technician/visit/${TOKEN}` });
  await cdp.waitFor(`!!document.querySelector('[data-testid="tech-clear-done"]')`, { what: '清除按钮', timeout: 30_000 });
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="tech-clear-done"]').click(); return true; })()`);
  await sleep(300);
  const cleared = await cdp.evaluate(
    `(() => ({ card: !!document.querySelector('[data-testid="tech-last-done"]'), rec: localStorage.getItem('svc.tech.lastDone.v1') }))()`,
  );
  check(cleared.card === false && cleared.rec === null, '⑨ 点「清除本机记录」后卡片与存储同时消失', JSON.stringify(cleared));

  // ---- 存储只允许 {ticketNo, completedAt} ----
  const shape = await cdp.evaluate(`(() => {
    localStorage.setItem('svc.tech.lastDone.v1', JSON.stringify({ ticketNo: 'X', completedAt: 1, extra: 'y' }));
    const raw = localStorage.getItem('svc.tech.lastDone.v1');
    localStorage.removeItem('svc.tech.lastDone.v1');
    return raw;
  })()`);
  note('存储形状抽检', shape);
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  B-30 布局门禁：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
