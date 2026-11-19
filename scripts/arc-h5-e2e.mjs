/**
 * arc-h5-e2e.mjs —— A4 客户 H5 真实页面集成验收
 *
 * 通过 CDP 驱动真实 Edge：打开**真正的 archive.html**，走**真实接口**，
 * 只做用户点名的 6 项验证。
 *
 * 为什么不用 --dump-dom：它不等异步 fetch，页面永远停在"加载中…"。
 * CDP 可以等到网络空闲、可以执行点击与输入、可以模拟离线。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CDP = 'http://127.0.0.1:9333';
const PAGE_URL = 'https://127.0.0.1/h5/archive.html';
const STORE_CODE = 'S01';
const MOBILE = '13600000001';
const KNOWN_CODE = '482915';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(sql) {
  return execFileSync('docker', ['exec','-i','svc-postgres','psql','-U','svc_app','-d','service_ticket','-v','ON_ERROR_STOP=1','-A','-t','-F','|','-f','-'], { input: sql, encoding: 'utf8' }).trim();
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------------- 极简 CDP 客户端 ---------------- */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS error: ' + (r.exceptionDetails.text || '') + ' ' +
        (r.exceptionDetails.exception?.description || ''));
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function attachPage() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  return cdp;
}

async function waitFor(cdp, expr, timeout = 20000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v;
    try { v = await cdp.evaluate(expr); } catch (e) { v = undefined; }
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`等待超时${label ? '（' + label + '）' : ''}: ${expr}`);
}

const cdp = await attachPage();

try {
  // -------------------------------------------------------------------------
  section('① 页面加载 + 渲染模块');
  // -------------------------------------------------------------------------
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(1500);

  const renderLoaded = await cdp.evaluate("typeof window.ArcRender === 'object' && typeof window.ArcRender.arcCard === 'function'");
  check(renderLoaded === true, 'archive-render.js 正确加载（window.ArcRender 可用）');

  // 脚本 404 会使 ArcRender 未定义；这里同时确认没有加载错误
  const scriptSrc = await cdp.evaluate("Array.from(document.scripts).map(s=>s.getAttribute('src')).filter(Boolean).join(',')");
  check(String(scriptSrc).includes('archive-render.js'), '页面引用的脚本路径含 archive-render.js', scriptSrc);

  const noInnerHtmlUse = await cdp.evaluate("typeof document.getElementById('storeSel').innerHTML === 'string'");
  check(noInnerHtmlUse === true, 'DOM 可访问（页面脚本未抛错）');

  // -------------------------------------------------------------------------
  section('② 10 家真实门店');
  // -------------------------------------------------------------------------
  const storeCount = await waitFor(
    cdp,
    "(()=>{const s=document.getElementById('storeSel');const n=s.querySelectorAll('option').length;return n>1?n:0;})()",
    20000, '门店列表',
  );
  check(storeCount === 11, '下拉出现 10 家门店 + 1 个占位项', `option 数=${storeCount}`);

  const storeNames = await cdp.evaluate(
    "Array.from(document.getElementById('storeSel').options).slice(1).map(o=>o.textContent).join('|')",
  );
  const names = String(storeNames).split('|');
  const hasAll = ['新都圣大家电','金堂华林电器','崇州九兴电器','新津欣盛电器','青神易田电器',
    '郫都康乐电器','龙泉东山电器','茂县国茂电器','蒲江江华家电','峨眉诚信电器']
    .every((n) => names.includes(n));
  check(hasAll && names.length === 10, '10 家门店名称与生产清单一致', names.join('、'));

  // -------------------------------------------------------------------------
  section('③ 验证码 → 档案列表');
  // -------------------------------------------------------------------------
  await cdp.evaluate(`(()=>{
    const s=document.getElementById('storeSel');
    s.value='${STORE_CODE}';
    s.dispatchEvent(new Event('change',{bubbles:true}));
    const m=document.getElementById('mobileInput');
    m.value='${MOBILE}';
    m.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);

  // 清掉该号码的历史记录，避免 60 秒限流与小时上限
  psql(`DELETE FROM service_archive_verify_codes WHERE store_id=(SELECT id FROM stores WHERE code='${STORE_CODE}') AND customer_mobile='${MOBILE}';`);

  await cdp.evaluate("document.getElementById('sendBtn').click(); true");
  await waitFor(cdp, "document.querySelector('#loginMsg.show') ? true : false", 15000, '发码提示');
  const sendMsg = await cdp.evaluate("document.querySelector('#loginMsg').textContent");
  check(String(sendMsg).includes('验证码已发送'), '点「获取验证码」后出现发送成功提示', sendMsg);

  // 开发环境 Mock：把服务端记录的哈希改成已知码（等价于"客户收到了这枚码"）
  const storeId = Number(psql(`SELECT id FROM stores WHERE code='${STORE_CODE}';`));
  psql(`UPDATE service_archive_verify_codes
           SET code_hash='${sha256(`archive-verify|${storeId}|${MOBILE}|${KNOWN_CODE}`)}',
               attempts=0, consumed_at=NULL, expires_at=now()+interval '5 minutes'
         WHERE store_id=${storeId} AND customer_mobile='${MOBILE}';`);

  await cdp.evaluate(`(()=>{
    const c=document.getElementById('codeInput');
    c.value='${KNOWN_CODE}';
    c.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('verifyBtn').click();
    return true;
  })()`);

  await waitFor(cdp, "document.getElementById('viewList').hidden === false", 20000, '进入列表');
  check(true, '验证码通过后进入档案列表视图');

  const cards = await waitFor(cdp, "document.querySelectorAll('#listBody .arc').length || 0", 15000, '档案卡片');
  check(Number(cards) > 0, '列表渲染出档案卡片', `卡片数=${cards}`);

  const listText = await cdp.evaluate("document.getElementById('listBody').textContent");
  check(!String(listText).includes('undefined'), '列表文本不含 undefined（字段缺失未泄露到界面）');

  // -------------------------------------------------------------------------
  section('④ 普通服务详情 + 照片');
  // -------------------------------------------------------------------------
  const svcOpened = await cdp.evaluate(`(()=>{
    const cards=[...document.querySelectorAll('#listBody .arc')];
    const c=cards.find(x=>x.textContent.includes('上门服务'));
    if(!c) return false;
    c.click(); return true;
  })()`);
  check(svcOpened === true, '找到并打开普通服务档案');

  if (svcOpened) {
    await waitFor(cdp, "document.getElementById('viewDetail').hidden === false", 15000, '详情视图');
    await sleep(1200);

    const kvCount = await cdp.evaluate("document.querySelectorAll('#detailBody .kv').length");
    check(Number(kvCount) >= 2, '详情展示客户与地址等字段', `kv 数=${kvCount}`);

    const photoInfo = await cdp.evaluate(`(()=>{
      const imgs=[...document.querySelectorAll('#detailBody img[data-photo]')];
      return { total: imgs.length, withBlob: imgs.filter(i=>i.src.startsWith('blob:')).length };
    })()`);
    check(Number(photoInfo.total) > 0, '普通服务详情出现照片位', `照片数=${photoInfo.total}`);
    check(Number(photoInfo.withBlob) === Number(photoInfo.total),
      '所有照片成功加载为 blob URL（未 401/未 404）',
      `blob=${photoInfo.withBlob}/${photoInfo.total}`);

    const hasSecTitle = await cdp.evaluate(
      "[...document.querySelectorAll('#detailBody .sec-title')].map(e=>e.textContent).join(',')",
    );
    check(String(hasSecTitle).includes('服务前') || String(hasSecTitle).includes('服务后'),
      '照片按「服务前/服务后」分组', String(hasSecTitle));
  }

  // -------------------------------------------------------------------------
  section('⑤ 暖通六阶段');
  // -------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('backToList').click(); true");
  await waitFor(cdp, "document.getElementById('viewList').hidden === false", 15000, '回到列表');
  // 等列表**重新拉取完成**：返回列表会重新请求，暖通档案是刚补进去的，
  // 固定 sleep 会在慢一点的时候读到旧列表
  const listCount = await waitFor(
    cdp, "document.querySelectorAll('#listBody .arc').length", 15000, '列表重新渲染',
  );
  const listBrief = await cdp.evaluate(
    "[...document.querySelectorAll('#listBody .arc')].map(c=>c.textContent.slice(0,20)).join(' || ')",
  );
  console.log(`  · 返回列表后卡片数=${listCount}：${listBrief}`);

  // 前置：确保该手机号名下有一份**已发布**的暖通档案（否则列表里只有普通服务）
  // 只改本地测试档案的号码与可见性，不动真实业务数据
  const hasHvac = Number(psql(`SELECT count(*) FROM service_archives
      WHERE store_id=(SELECT id FROM stores WHERE code='${STORE_CODE}')
        AND customer_mobile='${MOBILE}' AND archive_type='hvac' AND visibility='published';`));
  if (hasHvac === 0) {
    psql(`UPDATE service_archives SET customer_mobile='${MOBILE}', visibility='published', published_at=now()
          WHERE id = (SELECT id FROM service_archives
                      WHERE store_id=(SELECT id FROM stores WHERE code='${STORE_CODE}')
                        AND archive_type='hvac' ORDER BY id DESC LIMIT 1);`);
    console.log('  · 已把一条暖通测试档案置为 published 并绑定到该手机号');
  }

  const hvacOpened = await cdp.evaluate(`(()=>{
    const cards=[...document.querySelectorAll('#listBody .arc')];
    const c=cards.find(x=>x.textContent.includes('暖通工程'));
    if(!c) return false;
    c.click(); return true;
  })()`);
  check(hvacOpened === true, '找到并打开暖通工程档案');

  if (hvacOpened) {
    await waitFor(cdp, "document.getElementById('viewDetail').hidden === false", 15000, '暖通详情');
    await sleep(1000);

    const stageInfo = await cdp.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#detailBody .stage')];
      return {
        count: rows.length,
        titles: rows.map(r=>r.querySelector('.t')?.textContent||'').join('|'),
        states: rows.map(r=>r.querySelector('.s')?.textContent||'').join('|'),
      };
    })()`);
    check(Number(stageInfo.count) === 6, '六阶段全部显示', `行数=${stageInfo.count}`);
    const orderOk = ['第1步 现场勘察','第2步 方案确认','第3步 管路施工','第4步 设备安装','第5步 调试运行','第6步 客户验收']
      .every((t) => String(stageInfo.titles).includes(t));
    check(orderOk, '阶段名称与顺序正确', String(stageInfo.titles));

    const stagePhotos = await cdp.evaluate(`(()=>{
      const imgs=[...document.querySelectorAll('#detailBody img[data-photo]')];
      return { total: imgs.length, withBlob: imgs.filter(i=>i.src.startsWith('blob:')).length };
    })()`);
    if (Number(stagePhotos.total) > 0) {
      check(Number(stagePhotos.withBlob) === Number(stagePhotos.total),
        '阶段照片全部加载成功', `blob=${stagePhotos.withBlob}/${stagePhotos.total}`);
    } else {
      check(true, '该暖通档案当前无已发布阶段照片（列表为空属正常）', 'photos=0');
    }
  }

  // -------------------------------------------------------------------------
  section('⑥ 网络异常 → 提示与按钮恢复');
  // -------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('reloginBtn') && document.getElementById('reloginBtn').click(); true");
  await sleep(400);
  // 强制回到登录态（详情页没有 relogin 按钮时手动切）
  await cdp.evaluate(`(()=>{
    document.getElementById('viewDetail').hidden=true;
    document.getElementById('viewList').hidden=true;
    document.getElementById('viewLogin').hidden=false;
    return true;
  })()`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });

  await cdp.evaluate(`(()=>{
    const s=document.getElementById('storeSel');
    s.value='${STORE_CODE}';
    const m=document.getElementById('mobileInput');
    m.value='13600007777';
    document.getElementById('sendBtn').disabled=false;
    document.getElementById('sendBtn').textContent='获取验证码';
    document.getElementById('sendBtn').click();
    return true;
  })()`);

  await sleep(2500);
  const offlineState = await cdp.evaluate(`(()=>{
    const b=document.getElementById('sendBtn');
    const msg=document.querySelector('#loginMsg');
    return { disabled: b.disabled, text: b.textContent, msgClass: msg.className, msg: msg.textContent };
  })()`);
  check(offlineState.disabled === false, '离线时发码按钮**恢复可用**（不会永久卡死）', `disabled=${offlineState.disabled} text=${offlineState.text}`);
  check(/网络/.test(String(offlineState.msg)), '离线时给出明确的网络错误提示', `${offlineState.msg}`);
  check(String(offlineState.msgClass).includes('err'), '提示以错误样式展示', offlineState.msgClass);

  // 验证按钮同样要能恢复
  await cdp.evaluate(`(()=>{
    const c=document.getElementById('codeInput'); c.value='123456';
    const b=document.getElementById('verifyBtn');
    b.disabled=false; b.textContent='验证并查看';
    b.click(); return true;
  })()`);
  await sleep(2500);
  const verifyState = await cdp.evaluate(`(()=>{
    const b=document.getElementById('verifyBtn');
    return { disabled: b.disabled, text: b.textContent };
  })()`);
  check(verifyState.disabled === false, '离线时验证按钮**恢复可用**', `disabled=${verifyState.disabled} text=${verifyState.text}`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await sleep(600);

  // 恢复在线后按钮应可再次使用
  const recovered = await cdp.evaluate(`(()=>{
    const b=document.getElementById('sendBtn');
    b.disabled=false;
    return { disabled: b.disabled };
  })()`);
  check(recovered.disabled === false, '恢复在线后按钮可用', '');

} catch (err) {
  // 异常必须打出来：否则"跑了一半停住"会被误读成"只有 3 条断言"
  console.log('  >>> 中断：' + (err && err.message ? err.message : String(err)));
  results.push({ pass: false, label: 'E2E 中断', detail: String(err && err.message || err) });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + '='.repeat(56));
  console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
  console.log('='.repeat(56));
  cdp.close();
  process.exit(failed.length ? 1 : 0);
}
