#!/usr/bin/env node
/**
 * verify-store-create-ui.mjs —— 门店后台**「新建服务单」界面**的真实浏览器验收
 * （Phase 11 / P11-2 · 用户裁决二 · 第 1/2/3/4/6/7/8/9 条）
 *
 * ===========================================================================
 * 为什么单独一支、而且必须是真实浏览器
 * ===========================================================================
 *   ① 本项目在 P11-0 栽过一次：五个自定义动作「库里 35 行齐齐全全、断言全绿，
 *      **但页面上一个业务按钮都没有**」。⇒ "库里写对了"与"界面上出现"是两件事。
 *   ② 本轮最大的未知项是"挂在 `TableBlock.actions`（**区块工具栏**）上的动作到底
 *      渲不渲染"—— 旧注释说"不渲染"，但那次用的是 `record` 场景的模型；
 *      本模型是 `collection` 场景。**只能看一眼才算数。**
 *   ③ 用户第 9 条的字面要求就是"使用真实门店账号**在浏览器中**分别新建六类服务单"。
 *
 * ===========================================================================
 * 判据（逐条对应用户要求）
 * ===========================================================================
 *   §6 入口形态（第 1/2/3/4/7 条）
 *     · 「新建服务单」按钮存在，且**不在任何表格行内**（不塞进行级主动作）、**只有 1 个**；
 *     · 点开后有**取消**与**关闭（×）**；六类选项齐全且标签逐字正确；
 *     · **按类型显示字段**：投诉**不问**家电类别/服务地址；安装**要问**；
 *     · 未保存内容时关闭会二次确认（第 7 条）。
 *   §7 六类真实创建（第 5/9 条）
 *     · 逐类走界面提交 → **查库核对**：`ticket_type` / `source=staff` /
 *       `operator_kind=store` + **实际 `operator_user_id`** / `urgent` / `store_id` / `status=NEW`
 *       —— 只检查接口 201 **不算数**（用户明说）。
 *   §8 新建后可用（第 6 条）
 *     · 新单出现在自己的列表里；其行内**主动作是「处理」**，且**没有**「受理」字样。
 *
 * ⚠️ 浏览器启动必须带 `--ignore-certificate-errors`：本实例是自签演练证书，
 *    漏了它 Chrome 停在证书拦截页（DEV-132 第一条）。**这不等于放宽 TLS 校验** ——
 *    证书指纹由 `verify-tls.mjs` 独立钉住。
 * ⚠️ 此处是仓库里第 4 处 Chrome 启动实现。**抽成 `scripts/lib/chrome.mjs` 是明确的待办**，
 *    本文件在头部如实登记，不再默默复制第 4 份。
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import {
  EnvNotReady,
  assert,
  cleanupTicket,
  envValue,
  makeChecker,
  psqlExec,
  psqlRows,
  psqlScalar,
  runMain,
} from './technician-harness.mjs';

const BASE = SVC_BASE_URL;
const STORE_A = 'S01';
const STORE_PAGE_TITLE = '我的门店工单';
const STORE_A_LOGIN = 'uat.store.a@svc.local';

/** 六类：**界面标签**（与客户端 TYPE_CONFIG 逐字一致）→ 内部码 */
const SIX_TYPES = [
  { code: 'repair', label: '维修' },
  { code: 'installation', label: '安装' },
  { code: 'maintenance', label: '调试保养' },
  { code: 'relocation', label: '移机拆机' },
  { code: 'complaint', label: '投诉' },
  { code: 'other', label: '其他' },
];

/** 服务端 `operator_kind` 的期望值（⚠️ 是 `store`，不是 `staff`） */
const EXPECT_OPERATOR_KIND = 'store';

const created = [];

async function main() {
  const { check, checkAsync, summary } = makeChecker({ heading: '新建服务单界面' });

  const password = envValue('UAT_STORE_A_PASSWORD');
  if (!password) throw new EnvNotReady('.env 缺 UAT_STORE_A_PASSWORD');

  const schemaUid = psqlScalar(
    `SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='${STORE_PAGE_TITLE}' LIMIT 1`,
  );
  assert(schemaUid, `找不到「${STORE_PAGE_TITLE}」页面（desktopRoutes 无 type=flowPage 的同名行）`);

  const chromePath =
    process.env.CHROME_PATH ||
    'C:\\Users\\Administrator\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe';

  const storeAUserId = Number(
    psqlScalar(`SELECT id FROM users WHERE email = '${STORE_A_LOGIN}' LIMIT 1`),
  );
  assert(storeAUserId > 0, `取不到 ${STORE_A_LOGIN} 的 userId`);

  await withChrome(chromePath, async ({ ctx, evaluate, evaluateValue, evalJson, sleep }) => {
    // ---------------------------------------------------------------- 登录 + 进页面
    await ctx('Page.navigate', { url: `${BASE}/signin` });
    await sleep(18000);
    const filled = await evalJson(`(() => {
      const ins=[...document.querySelectorAll('input')];
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;s.call(el,v);
        el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
      if (ins.length < 2) return { ok:false, inputs: ins.length };
      set(ins[0], ${JSON.stringify(STORE_A_LOGIN)}); set(ins[1], ${JSON.stringify(password)});
      return { ok: ins[0].value === ${JSON.stringify(STORE_A_LOGIN)}, inputs: ins.length };
    })()`);
    assert(filled.ok, `登录页表单未填上（inputs=${filled.inputs}）`);
    await sleep(1500);
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('登录')); if(b) b.click(); return !!b; })()`,
    );
    await sleep(20000);

    await ctx('Page.navigate', { url: `${BASE}/admin/${schemaUid}` });
    let rows = 0;
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(2500);
      // eslint-disable-next-line no-await-in-loop
      const s = await evalJson(
        `({ rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length })`,
      );
      rows = s.rows;
      if (rows > 0) break;
    }
    assert(rows > 0, '门店列表页 60s 内没有渲染出行');

    // ---------------------------------------------------------------- §6 入口形态
    await checkAsync('⑥ 入口存在、**不在表格行内**、且只有一个（不塞行级、不重复）', async () => {
      const dom = await evalJson(`(() => {
        const btns=[...document.querySelectorAll('button')];
        const c=btns.filter((b)=>(b.innerText||'').replace(/\\s+/g,'').includes('新建服务单'));
        return {
          count: c.length,
          insideRow: c.filter((b)=>b.closest('tr.ant-table-row')).length,
          indexAmongButtons: btns.indexOf(c[0] ?? btns[0]),
        };
      })()`);
      assert(dom.count === 1, `页面上有 ${dom.count} 个「新建服务单」—— 期望恰好 1 个（重复按钮是明令禁止的）`);
      assert(dom.insideRow === 0, '「新建服务单」出现在表格行内 —— 用户明确要求不得塞进行级主动作');
      return `1 个入口 · 0 个在行内 · 按钮序号 ${dom.indexAmongButtons}`;
    });

    const openModal = async () => {
      await evaluate(
        `(() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.innerText||'').replace(/\\s+/g,'')==='新建服务单'); if(!b) return false; b.click(); return true; })()`,
      );
      for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
        // eslint-disable-next-line no-await-in-loop
        const ok = await evalJson(
          `({ open: !!document.querySelector('[data-testid="create-ticket-form"]') })`,
        );
        if (ok.open) return;
      }
      throw new Error('点了「新建服务单」但表单没有出现（弹窗未打开）');
    };
    const closeModal = async () => {
      await evaluate(
        `(() => { const x=document.querySelector('.ant-modal-close'); if(x) x.click(); return !!x; })()`,
      );
      await sleep(600);
      // 若有"未保存"确认，点"确定/关闭"
      await evaluate(`(() => {
        const btns=[...document.querySelectorAll('.ant-modal-confirm-btns button')];
        const ok=btns[btns.length-1]; if(ok) ok.click(); return btns.length;
      })()`);
      await sleep(800);
    };

    await checkAsync('⑥ 弹窗有取消与关闭（×），且六类选项齐全、标签逐字正确', async () => {
      await openModal();
      try {
        const dom = await evalJson(`(() => {
          const form=document.querySelector('[data-testid="create-ticket-form"]');
          const modal=form?.closest('.ant-modal');
          // 🔴 两个坑叠在一起，都记在这里：
          //   ① antd 会在**两个中文字之间插一个空格**（渲染出"取 消"）
          //     ⇒ 不能直接 includes('取消')；
          //   ② 而**本表达式住在模板字符串里** ⇒ 空白类必须写成两个反斜杠的 \\s，
          //     写成单反斜杠会被模板解码成字面的字母 s，变成 /s+/g —— **去掉的是字母 s**。
          //     2026-10-10 实测：正是这一条让"取 消"判不出来（DEV-132 同型，第三次）。
          // ① 原文：antd 会在**两个中文字之间插一个空格**（渲染出"取 消"、"创 建"）——
          //    直接写 includes(取消) 形式的比较会漏判。比对前先把空白全部去掉。
          const footBtns=[...(modal?.querySelectorAll('.ant-modal-confirm-btns button, .ant-modal-footer button') ?? [])]
            .map((b)=>(b.innerText||'').replace(/\\s+/g,'')).filter(Boolean);
          return {
            hasClose: !!modal?.querySelector('.ant-modal-close'),
            footBtns,
          };
        })()`);
        assert(dom.hasClose, '弹窗没有关闭（×）按钮 —— 用户第 7 条要求"明显的取消和关闭入口"');
        assert(
          dom.footBtns.some((t) => t.includes('取消')),
          `弹窗底部没有「取消」按钮（实际：${dom.footBtns.join(' / ')}）`,
        );

        // 打开类型下拉，数选项
        await evaluate(`(() => { const h=document.querySelector('[data-testid="create-ticket-type"]');
          const clk=h?.closest('.ant-select') || h; const sel=clk?.querySelector('.ant-select-selector') || clk;
          sel?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); sel?.click(); return !!sel; })()`);
        await sleep(1000);
        const opts = await evalJson(`(() => {
          const dd=[...document.querySelectorAll('.ant-select-dropdown')].filter((d)=>!d.classList.contains('ant-select-dropdown-hidden'));
          if(!dd.length) return { labels: [], why: 'NO_DROPDOWN' };
          return { labels: [...dd[dd.length-1].querySelectorAll('.ant-select-item-option')].map((o)=>(o.getAttribute('title')||o.innerText||'').trim()).filter(Boolean) };
        })()`);
        const want = SIX_TYPES.map((t) => t.label);
        assert(
          JSON.stringify(opts.labels) === JSON.stringify(want),
          `六类选项是 ${JSON.stringify(opts.labels)}，期望 ${JSON.stringify(want)}`,
        );
        // 关掉下拉再关弹窗
        await evaluate(`document.body.click()`);
        await sleep(400);
        return `× ✓ · 取消 ✓ · 六类 ${opts.labels.join(' / ')}`;
      } finally {
        await closeModal();
      }
    });

    await checkAsync('⑥ **按类型显示字段**：投诉不问家电类别/服务地址，安装要问（用户第 3 条）', async () => {
      const pickType = async (label) => {
        await evaluate(`(() => { const h=document.querySelector('[data-testid="create-ticket-type"]');
          const clk=h?.closest('.ant-select') || h; const sel=clk?.querySelector('.ant-select-selector') || clk;
          sel?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); sel?.click(); return !!sel; })()`);
        await sleep(900);
        await evaluate(`(() => {
          const dd=[...document.querySelectorAll('.ant-select-dropdown')].filter((d)=>!d.classList.contains('ant-select-dropdown-hidden'));
          if(!dd.length) return 'NO_DD';
          const opt=[...dd[dd.length-1].querySelectorAll('.ant-select-item-option')]
            .find((o)=>((o.getAttribute('title')||o.innerText||'').trim()===${JSON.stringify(label)}));
          if(!opt) return 'NO_OPT';
          opt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); opt.click(); return 'OK';
        })()`);
        await sleep(900);
      };
      const fieldsOf = () =>
        evalJson(`(() => ({
          appliance: !!document.querySelector('[data-testid="create-ticket-appliance"]'),
          address: !!document.querySelector('[data-testid="create-ticket-address"]'),
          brand: !!document.querySelector('[data-testid="create-ticket-brand"]'),
          urgent: !!document.querySelector('[data-testid="create-ticket-urgent"]'),
        }))()`);

      await openModal();
      try {
        await pickType('投诉');
        const complaint = await fieldsOf();
        assert(
          !complaint.appliance && !complaint.address && !complaint.brand,
          `投诉表单仍然显示 家电类别=${complaint.appliance} 服务地址=${complaint.address} 品牌型号=${complaint.brand}` +
            ' —— 用户明令"不要求投诉填写故障资料"',
        );
        assert(complaint.urgent, '投诉表单缺少紧急标记（它是所有类型都该有的授权项）');

        await pickType('安装');
        const install = await fieldsOf();
        assert(
          install.appliance && install.address && install.brand,
          `安装表单缺少必要字段：家电类别=${install.appliance} 服务地址=${install.address} 品牌型号=${install.brand}`,
        );
        return '投诉：3 项隐藏 ✓ · 安装：3 项显示 ✓ · 两者都有紧急标记 ✓';
      } finally {
        await closeModal();
      }
    });

    await checkAsync('⑦ 未保存内容时关闭会二次确认（用户第 7 条）', async () => {
      await openModal();
      await evaluate(`(() => { const el=document.querySelector('[data-testid="create-ticket-name"]');
        const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; s.call(el,'张三');
        el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; })()`);
      await sleep(600);
      const before = await evalJson(
        `({ modals: document.querySelectorAll('.ant-modal').length })`,
      );
      await evaluate(`(() => { const x=document.querySelector('.ant-modal-close'); if(x) x.click(); return !!x; })()`);
      await sleep(1200);
      const after = await evalJson(`(() => {
        const texts=[...document.querySelectorAll('.ant-modal-confirm-title, .ant-modal-confirm-content')].map((e)=>e.innerText||'');
        return { modals: document.querySelectorAll('.ant-modal').length, texts };
      })()`);
      const asked = after.texts.some((t) => t.includes('已有内容') || t.includes('重新填写') || t.includes('关闭'));
      assert(
        asked || after.modals >= before.modals,
        '填了内容后关闭**没有**任何未保存提示 —— 用户第 7 条要求"未保存内容有适当提示"',
      );
      await closeModal();
      await sleep(600);
      // 确认已关掉（不留在页面上）
      const closed = await evalJson(
        `({ open: !!document.querySelector('[data-testid="create-ticket-form"]') })`,
      );
      assert(!closed.open, '二次确认后弹窗仍未关闭');
      return `提示出现（${after.texts.join(' / ').slice(0, 60)}）· 确认后已关闭`;
    });

    // ---------------------------------------------------------------- §7 六类真实创建
    await checkAsync('⑦ 六类**逐类走界面创建**，并查库核对类型/来源/操作人/紧急/归属/状态', async () => {
      const notes = [];
      for (const t of SIX_TYPES) {
        const mobile = `137${String(Date.now() + notes.length * 733).slice(-8)}`;
        const content = `[P11-2-UI] 六类界面走查：${t.code}`;
        const useUrgent = t.code === 'installation'; // 只在一类上开紧急，验证它真的落库

        await openModal();
        // 选类型
        await evaluate(`(() => { const h=document.querySelector('[data-testid="create-ticket-type"]');
          const clk=h?.closest('.ant-select') || h; const sel=clk?.querySelector('.ant-select-selector') || clk;
          sel?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); sel?.click(); return !!sel; })()`);
        await sleep(900);
        const picked = await evaluateValue(`(() => {
          const dd=[...document.querySelectorAll('.ant-select-dropdown')].filter((d)=>!d.classList.contains('ant-select-dropdown-hidden'));
          if(!dd.length) return 'NO_DD';
          const opt=[...dd[dd.length-1].querySelectorAll('.ant-select-item-option')]
            .find((o)=>((o.getAttribute('title')||o.innerText||'').trim()===${JSON.stringify(t.label)}));
          if(!opt) return 'NO_OPT';
          opt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); opt.click(); return 'OK';
        })()`);
        assert(
          picked === 'OK',
          `${t.label}：类型下拉没有选中（${picked}）`,
        );
        await sleep(700);

        const fill = (testid, value) =>
          evaluateValue(`(() => { const el=document.querySelector('[data-testid="${testid}"]'); if(!el) return false;
            const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; s.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            return el.value === ${JSON.stringify(value)}; })()`);
        assert(await fill('create-ticket-name', '界面走查'), `${t.label}：联系人填不上`);
        assert(await fill('create-ticket-mobile', mobile), `${t.label}：手机号填不上`);
        assert(await fill('create-ticket-content', content), `${t.label}：内容填不上`);
        if (useUrgent) {
          await evaluate(`(() => { const el=document.querySelector('[data-testid="create-ticket-urgent"]');
            if (el) { el.click(); return true; } return false; })()`);
          await sleep(400);
        }

        // 提交
        await evaluate(`(() => {
          const btns=[...document.querySelectorAll('.ant-modal-confirm-btns button, .ant-modal-footer button')]
            .filter((b)=>(b.innerText||'').replace(/\\s+/g,'') !== '取消');
          const ok=btns[btns.length-1]; if(ok) ok.click(); return !!ok;
        })()`);

        // 等落库（按手机号查）
        let row = null;
        for (let i = 0; i < 20; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(900);
          // eslint-disable-next-line no-await-in-loop
          const found = psqlRows(
            `SELECT id, ticket_type, source, status, store_id, urgent::text, ` +
              `coalesce(service_address,'<NULL>'), coalesce(appliance_category,'<NULL>') ` +
              `FROM service_tickets WHERE customer_mobile = '${mobile}' ORDER BY id DESC LIMIT 1`,
          );
          if (found.length && found[0].length) {
            row = found[0];
            break;
          }
        }
        assert(row, `${t.label}：界面提交后 18s 内库里查不到这张单（请求没发出去或失败了）`);
        const id = Number(row[0]);
        created.push(id);

        assert(row[1] === t.code, `${t.label}：落库 ticket_type=${row[1]}，期望 ${t.code}`);
        assert(row[2] === 'staff', `${t.label}：落库 source=${row[2]}，期望 staff`);
        assert(row[3] === 'NEW', `${t.label}：落库 status=${row[3]}，期望 NEW（不得重新引入"受理"）`);
        assert(
          Number(row[4]) === Number(psqlScalar(`SELECT id FROM stores WHERE code='${STORE_A}'`)),
          `${t.label}：归属 store_id=${row[4]}，期望 ${STORE_A}`,
        );
        assert(
          row[5] === (useUrgent ? 'true' : 'false'),
          `${t.label}：urgent=${row[5]}，期望 ${useUrgent ? 'true（界面勾了）' : 'false（界面没勾）'}`,
        );

        // ⚠️ 用户点名：**必须检查实际 `operator_user_id`**，不只检查 201
        const ev = psqlRows(
          `SELECT event_type, operator_kind, coalesce(operator_user_id::text,'<NULL>'), summary ` +
            `FROM ticket_events WHERE ticket_id = ${id} AND event_type='created'`,
        )[0];
        assert(ev, `${t.label}：没有 created 事件`);
        assert(
          ev[1] === EXPECT_OPERATOR_KIND,
          `${t.label}：事件 operator_kind=${ev[1]}，期望 ${EXPECT_OPERATOR_KIND}`,
        );
        assert(
          ev[2] === String(storeAUserId),
          `${t.label}：事件 operator_user_id=${ev[2]}，期望 ${storeAUserId}（真实操作人）`,
        );
        assert(
          String(ev[3]).includes('门店提交'),
          `${t.label}：事件摘要=${JSON.stringify(ev[3])}，期望含「门店提交」`,
        );
        notes.push(`${t.label}${useUrgent ? '(紧急)' : ''}✓`);

        // 提交成功后弹窗应已自行关闭；若还开着（例如请求慢），先关掉再进下一类，
        // 否则下一轮 `openModal()` 会点到"还开着的那张表单"，读到上一类的字段值。
        const stillOpen = await evalJson(
          `({ open: !!document.querySelector('[data-testid="create-ticket-form"]') })`,
        );
        if (stillOpen.open) await closeModal();
      }
      return notes.join(' ');
    });

    // ---------------------------------------------------------------- §8 新建后可用
    await checkAsync('⑧ 新单出现在自己的列表里，且行内主动作是「处理」、**没有**「受理」', async () => {
      await ctx('Page.navigate', { url: `${BASE}/admin/${schemaUid}` });
      await sleep(12000);
      const dom = await evalJson(`(() => {
        const body=document.body.innerText || '';
        const rows=[...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
        const newRow=rows.find((r)=>(r.innerText||'').includes('界面走查'));
        // ⚠️ 判据收窄到「待受理」（而不是裸的「受理」）—— 这是本仓**既有裁定**：
        //    P11-0 的裁决范围是 NEW 的**状态文案**，而 constants.ts 里
        //    [EVENT_TYPE.ACCEPTED] = '门店已受理' 是"这张单过去真的发生过受理"的
        //    **如实记载**，硬纪律是不抹掉历史。写成裸的「受理」会把历史记载误判成违规
        //    （2026-10-10 实测：本判据第一版就是这么假红的）。
        const acceptIdx = body.indexOf('受理');
        return {
          rows: rows.length,
          hasNewRow: !!newRow,
          rowButtons: newRow ? [...newRow.querySelectorAll('button,a')].map((b)=>(b.innerText||'').replace(/\\s+/g,'')).filter(Boolean) : [],
          newRowText: newRow ? (newRow.innerText||'').replace(/\\s+/g,'') : '',
          bodyHasWaitAccept: body.includes('待受理'),
          acceptContext: acceptIdx >= 0 ? body.slice(Math.max(0, acceptIdx - 12), acceptIdx + 8).replace(/\\s+/g,' ') : null,
        };
      })()`);
      assert(dom.hasNewRow, `列表里找不到刚建的「界面走查」单（rows=${dom.rows}）`);
      assert(
        dom.rowButtons.includes('处理'),
        `新单行内的主动作是 ${JSON.stringify(dom.rowButtons)}，期望含「处理」`,
      );
      assert(
        !dom.bodyHasWaitAccept,
        '页面上出现了「待受理」—— P11-0 已把 NEW 的状态文案改成「待处理」，不得退回',
      );
      // NEW 那一行的状态列必须是「待处理」
      assert(
        dom.newRowText.includes('待处理'),
        `新单那一行的文本里没有「待处理」：${JSON.stringify(dom.newRowText.slice(0, 80))}`,
      );
      // 裸的「受理」若出现，**如实报出出处**（多半是历史事件名的如实记载），但不判红
      const note = dom.acceptContext ? `（页面另有「受理」字样，出处：…${dom.acceptContext}… 属历史事件名）` : '';
      return `新单在列表内 · 行内主动作=${dom.rowButtons.join('/')} · 状态列「待处理」✓${note}`;
    });

    // ---------------------------------------------------------------- §9 已有工单的紧急标记调整
    await checkAsync('⑨ 详情抽屉里可调整**已有工单**的紧急标记，且列表**没有**新增按钮（用户第 3 项）', async () => {
      // ---- 夹具单的状态要选"行内主动作 = 查看"的那一种 ----
      // ⚠️ 2026-10-10 实测踩到：第一版用了 PROCESSING，而它的行内主动作是**「跟进」**
      //    （开的是跟进对话框，不是详情抽屉）⇒ 无论等多久都找不到抽屉里的按钮，
      //    报出来的却是"抽屉里没有这个入口"，指向完全错误的方向。
      //    P11-0 的映射：NEW→处理 / PROCESSING→跟进 / 其余可看状态→**查看**（开抽屉）。
      //    ⇒ 用 WAIT_FEEDBACK。
      const stamp = String(Date.now()).slice(-7);
      const fixtureNo = `FWD9${stamp}`;
      const storeId = Number(psqlScalar(`SELECT id FROM stores WHERE code='${STORE_A}'`));
      const ins = psqlExec(
        'INSERT INTO service_tickets ' +
          '(created_at, updated_at, ticket_no, store_id, source_store_code, source, ticket_type, ' +
          ' content, customer_mobile, customer_name, status, urgent) ' +
          `VALUES (now(), now(), '${fixtureNo}', ${storeId}, '${STORE_A}', 'qr', 'repair', ` +
          ` '[P11-2-UI] 紧急标记调整走查', '13900000099', '紧急调整走查', 'WAIT_FEEDBACK', false)`,
      );
      assert(ins.ok, `夹具单插入失败：${ins.out}`);
      const fixtureId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${fixtureNo}'`));
      created.push(fixtureId);

      // ⚠️ 列表页必须**重载**才能看到新夹具（抽屉/列表都是加载时取的数）
      await ctx('Page.navigate', { url: `${BASE}/admin/${schemaUid}` });
      await sleep(14000);

      // ---- 反向前置：列表行内**不得**出现这个入口 ----
      const inRows = await evalJson(`(() => {
        const rows=[...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
        return {
          rows: rows.length,
          inRowCount: rows.filter((r)=>r.querySelector('[data-testid="toggle-urgent"]')).length,
          tableText: (document.querySelector('.ant-table')?.innerText || '').includes('设为紧急'),
        };
      })()`);
      assert(
        inRows.inRowCount === 0 && !inRows.tableText,
        `列表行内出现了紧急标记入口（${inRows.inRowCount} 个）—— 用户明令"不得为此增加列表按钮墙"`,
      );

      // ---- 找到夹具那一行，点它的行内主动作（查看 → 打开抽屉）----
      const clicked = await evalJson(`(() => {
        const rows=[...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
        const row=rows.find((r)=>(r.innerText||'').includes(${JSON.stringify(fixtureNo)}));
        if(!row) return { ok:false, why:'NO_ROW' };
        const btns=[...row.querySelectorAll('button,a')].filter((b)=>(b.innerText||'').replace(/\s+/g,'')!=='');
        const view=btns.find((b)=>(b.innerText||'').replace(/\s+/g,'')==='查看') || btns[btns.length-1];
        if(!view) return { ok:false, why:'NO_BTN' };
        view.click();
        return { ok:true, label:(view.innerText||'').replace(/\s+/g,'') };
      })()`);
      assert(clicked.ok, `打不开夹具单的详情抽屉：${clicked.why}`);

      // ---- 等抽屉里的切换按钮 ----
      let saw = null;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
        // eslint-disable-next-line no-await-in-loop
        const st = await evalJson(`(() => {
          const btn=document.querySelector('.ant-drawer [data-testid="toggle-urgent"]');
          return { found: !!btn, text: btn ? (btn.innerText||'').replace(/\s+/g,'') : '' };
        })()`);
        if (st.found) {
          saw = st;
          break;
        }
      }
      // 🔴 2026-10-10：本轮**未通过**，且原因**未确定** —— 如实记为待查，不当作已验证。
      //
      //    现场（独立取证脚本，已删：`.probe/dbg-drawer-urgent.mjs`）：
      //      · 夹具单（WAIT_FEEDBACK / S01）那一行的行内**有**「查看」按钮，labels=["查看"]；
      //      · `click()` 确实执行了；
      //      · 但 `.ant-drawer` 在 28 秒内**始终没有出现**（drawer:false）；
      //      · 补过 `created` 事件、换过夹具状态（PROCESSING→WAIT_FEEDBACK），现象不变。
      //
      //    ⚠️ 而**同一个账号、同一个页面**上，`uat-preflight` §3.7 的抽屉是**能打开的**
      //      （那一支今天刚修好并跑绿）。⇒ 所以"这个抽屉里的入口到底渲不渲染"
      //      目前**没有结论**：可能是产品没渲染，也可能是本支验收的取证方式问题。
      //
      //    ⇒ 判据**保留**（用户明令"不得通过删除断言或默认跳过变绿"），
      //      它就是"这一项尚未完成"的可视凭证。**不得**把它改成 warn/SKIP 来让整支变绿。
      //      下一轮要做的第一件事：先查清"抽屉在本支里为什么不打开"，再决定修产品还是修取证。
      assert(saw, '详情抽屉里没有找到紧急标记调整入口（data-testid=toggle-urgent）—— 本轮未通过，原因未定（抽屉在验收环境里未打开）');
      assert(
        saw.text === '设为紧急',
        `入口文案是 ${JSON.stringify(saw.text)}，期望「设为紧急」（夹具单当前 urgent=false）`,
      );

      // ---- 点它 → 确认弹窗 → 确定 ----
      const setUrgentViaUi = async (expectLabel) => {
        await evaluate(
          `(() => { const b=document.querySelector('.ant-drawer [data-testid="toggle-urgent"]'); if(!b) return false; b.click(); return true; })()`,
        );
        await sleep(1200);
        const confirmText = await evaluateValue(
          `(() => { const t=[...document.querySelectorAll('.ant-modal-confirm-title')].map((e)=>e.innerText||''); return t.join('|'); })()`,
        );
        assert(
          String(confirmText).includes(expectLabel),
          `点「${expectLabel}」后没有出现确认弹窗（实际标题：${JSON.stringify(confirmText)}）`,
        );
        await evaluate(`(() => {
          const btns=[...document.querySelectorAll('.ant-modal-confirm-btns button')]
            .filter((b)=>(b.innerText||'').replace(/\s+/g,'')!=='取消');
          const ok=btns[btns.length-1]; if(ok) ok.click(); return !!ok;
        })()`);
      };

      await setUrgentViaUi('标记为紧急');
      let dbUrgent = null;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(900);
        // eslint-disable-next-line no-await-in-loop
        dbUrgent = psqlScalar(`SELECT urgent::text FROM service_tickets WHERE id=${fixtureId}`);
        if (dbUrgent === 'true') break;
      }
      assert(dbUrgent === 'true', `界面点了「设为紧急」但库里 urgent=${dbUrgent}`);

      // 审计：事件必须带 原值/新值/操作者（用户点名）
      const ev = psqlRows(
        `SELECT operator_kind, coalesce(operator_user_id::text,'<NULL>'), summary, ` +
          ` coalesce(metadata_json->>'from',''), coalesce(metadata_json->>'to','') ` +
          `FROM ticket_events WHERE ticket_id=${fixtureId} AND event_type='metadata_corrected' ORDER BY id DESC LIMIT 1`,
      )[0];
      assert(ev, '界面改完之后没有 metadata_corrected 事件 —— 审计缺失');
      assert(ev[0] === 'store' && ev[1] === String(storeAUserId), `事件操作人=${ev[0]}/${ev[1]}，期望 store/${storeAUserId}`);
      assert(ev[3] === 'false' && ev[4] === 'true', `事件 from/to=${ev[3]}→${ev[4]}，期望 false→true`);

      // ---- 反向：再点一次（取消紧急）----
      await setUrgentViaUi('取消紧急标记');
      let back = null;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(900);
        // eslint-disable-next-line no-await-in-loop
        back = psqlScalar(`SELECT urgent::text FROM service_tickets WHERE id=${fixtureId}`);
        if (back === 'false') break;
      }
      assert(back === 'false', `界面点了「取消紧急」但库里 urgent=${back}`);

      return `列表内 0 个入口 · 抽屉内「设为紧急/取消紧急」均可 · 库值与事件(操作人 ${ev[1]}) 全部核对`;
    });
  });

  // ⚠️ summary() 在 withChrome **之外**：它统计的是整支门禁，不是回调内部的事。
  summary();
}

// ===========================================================================
// 极简 CDP 客户端（见文件头"第 4 处 Chrome 启动"的说明）
// ===========================================================================
async function withChrome(chromePath, run) {
  const port = 9847;
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=C:\\Users\\Administrator\\AppData\\Local\\Temp\\svc-createui-${Date.now()}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let ver = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        /* eslint-disable-next-line no-await-in-loop */
        await sleep(500);
      }
    }
    if (!ver) throw new EnvNotReady('CDP 未启动（Chrome 没起来）');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 0;
    const pending = new Map();
    const send = (method, params = {}, sessionId) => {
      const mid = ++id;
      const msg = { id: mid, method, params: params ?? {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    };
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const pr = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) pr.rej(new Error(`${m.method}: ${m.error.message}`));
        else pr.res(m.result);
      }
    });

    const targets = await send('Target.getTargets', {});
    const page = targets.targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const ctx = (method, params) => send(method, params, sessionId);
    await ctx('Runtime.enable');
    await ctx('Page.enable');

    const evaluate = (expr) => ctx('Runtime.evaluate', { expression: expr, returnByValue: true });
    /**
     * 取表达式的**返回值**。
     *
     * ⚠️ 2026-10-10 实录：本文件第一版用 `await evaluate(expr)` 的结果去做 `=== 'OK'`
     *    判断 —— 而它返回的是 CDP 的**结果对象**（`{result:{type:'string',value:'OK'}}`），
     *    永远不等于 `'OK'`，于是"类型没选中"这种真问题被报成对象比较失败；
     *    更糟的是 `assert(await fill(...))` **恒为真**（对象总是 truthy）——
     *    那是**假绿**：填不上也会"通过"。
     *    ⇒ 凡是要用返回值的地方，一律走这个函数。
     */
    const evaluateValue = async (expr) => {
      const r = await evaluate(expr);
      if (r.result?.subtype === 'error') throw new Error(`页面表达式抛错：${r.result.description}`);
      return r.result?.value;
    };
    const evalJson = async (expr) => {
      const r = await ctx('Runtime.evaluate', { expression: `JSON.stringify(${expr})`, returnByValue: true });
      if (r.result?.subtype === 'error') throw new Error(`页面表达式抛错：${r.result.description}`);
      try {
        return JSON.parse(r.result.value);
      } catch {
        throw new Error(`快照解析失败：${String(r.result?.value).slice(0, 160)}`);
      }
    };

    return await run({ ctx, evaluate, evaluateValue, evalJson, sleep });
  } finally {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
}

// ===========================================================================
// 清理（挂在 runMain 的 cleanup 上 —— 必然执行，见 DEV-134）
// ===========================================================================
function cleanup() {
  const ids = [...new Set(created.filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) {
    console.log('  · 无需清理');
    return;
  }
  let removed = 0;
  for (const id of ids) {
    try {
      if (Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${id}`)) === 0) continue;
      cleanupTicket(id);
      removed += 1;
    } catch (error) {
      console.log(`  ⚠️ 清理工单 ${id} 失败：${error?.message}`);
    }
  }
  const left = ids.filter((id) => Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${id}`)) > 0);
  console.log(
    left.length === 0
      ? `  · 已清理本轮自建工单 ${removed} 张（回查残留 0）`
      : `  ⚠️ 清理后仍残留 ${left.length} 张（id=${left.join(',')}）`,
  );
}

await runMain({ name: '新建服务单界面 · 真实浏览器', main, cleanup });
