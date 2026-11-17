/**
 * ARC-V1 / A4-FIX · 档案渲染函数（纯函数，无副作用）
 *
 * 抽成独立文件的**唯一理由**：让 XSS 测试页与真实页面跑**同一份代码**。
 * 如果测试页自己抄一份渲染逻辑，它证明的只是"抄的那份是安全的"，
 * 而真实页面里那处漏转义照样存在 —— 这正是"验证器自己也会错"的经典形态。
 *
 * 约定：
 *   · 所有函数只接收数据、返回 DOM 节点，不读全局、不发请求；
 *   · **任何函数都不得使用 innerHTML / outerHTML / insertAdjacentHTML**；
 *   · 一切动态文本走 `textContent`，属性用 `setAttribute`/`dataset`（值不参与 HTML 解析）。
 */
(function (global) {
  'use strict';

  /** 档案编号形态白名单：进 dataset 前必须通过 */
  var ARCHIVE_NO_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function text(tag, value, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = (value === null || value === undefined) ? '' : String(value);
    return node;
  }

  function el(tag, className, children) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (children) {
      for (var i = 0; i < children.length; i += 1) if (children[i]) node.appendChild(children[i]);
    }
    return node;
  }

  function statusInfo(s) {
    var map = {
      pending: ['待安排', ''],
      scheduled: ['已预约', 'doing'],
      serving: ['进行中', 'doing'],
      completed: ['已完成', 'done'],
      accepted: ['已验收', 'done'],
    };
    var hit = map[s] || [String(s || '—'), ''];
    return { label: hit[0], cls: hit[1] };
  }

  function serviceTypeText(t) {
    var map = {
      delivery: '送货安装', install: '安装调试', repair: '维修检测',
      clean: '清洗保养', guide: '使用指导', other: '其他',
    };
    return map[t] || String(t || '');
  }

  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function stageTitle(st) {
    var map = {
      survey: '现场勘察', plan: '方案确认', pipe: '管路施工',
      device: '设备安装', test: '调试运行', accept: '客户验收',
    };
    return map[st.stage_code] || String(st.stage_code || '');
  }

  function stageNo(st) {
    var order = ['survey', 'plan', 'pipe', 'device', 'test', 'accept'];
    var i = order.indexOf(st.stage_code);
    return i >= 0 ? '第' + (i + 1) + '步' : '阶段';
  }

  function kv(k, v) {
    if (v === null || v === undefined || v === '') return null;
    return el('div', 'kv', [text('div', String(k), 'k'), text('div', String(v), 'v')]);
  }

  function arcCard(a) {
    var st = statusInfo(a.status);
    var typeLabel = a.archive_type === 'hvac' ? '暖通工程' : '上门服务';
    var title = a.product_description ? String(a.product_description) : typeLabel;

    var head = el('div', 'head', [
      el('div', null, [
        text('div', title, 'name'),
        text('div', String(a.archive_no || ''), 'no'),
      ]),
      text('span', st.label, 'badge' + (st.cls ? ' ' + st.cls : '')),
    ]);

    var meta = el('div', 'meta');
    var line1 = el('div', null, [el('b', null, [document.createTextNode(typeLabel)])]);
    if (a.service_type) line1.appendChild(document.createTextNode(' · ' + serviceTypeText(a.service_type)));
    meta.appendChild(line1);
    if (a.service_address) meta.appendChild(text('div', '地址：' + a.service_address));
    if (a.service_date) meta.appendChild(text('div', '服务日期：' + fmtDate(a.service_date)));

    var card = el('div', 'arc', [head, meta]);
    var no = String(a.archive_no || '');
    // 只写 dataset；点击行为由页面绑定（渲染函数不持有业务跳转）
    if (ARCHIVE_NO_RE.test(no)) card.dataset.no = no;
    return card;
  }

  function stageRow(st) {
    var cls = st.status === 'done' ? 'done' : (st.status === 'withdrawn' ? 'with' : '');
    var label = st.status === 'done' ? '已完成' : (st.status === 'withdrawn' ? '已撤回' : '未完成');
    var sub = label;
    if (st.stage_date) sub += ' · ' + fmtDate(st.stage_date);
    // ⚠️ **不渲染阶段备注**（2026-11-11 A5-F / A5-G）：
    //    阶段备注是内部信息（现场勘察里常写「业主不在家 / 墙体有问题」这类话），
    //    服务端已从客户投影里删除 `note`（DEV-221）。这里同步去掉渲染分支 ——
    //    留着它等于给未来留一条「谁把字段加回投影，就自动对客户泄露」的通道。

    return el('div', 'stage', [
      el('div', 'dot ' + cls),
      el('div', 'info', [
        text('div', stageNo(st) + ' ' + stageTitle(st), 't'),
        text('div', sub, 's'),
      ]),
    ]);
  }

  function photoBlock(title, photos) {
    var grid = el('div', 'photos');
    for (var i = 0; i < photos.length; i += 1) {
      var p = photos[i];
      var id = Number(p.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;   // 只接受安全正整数
      var img = document.createElement('img');
      img.alt = title;
      img.dataset.photo = String(id);
      grid.appendChild(img);
    }
    return el('div', 'card', [text('div', title, 'sec-title first'), grid]);
  }

  function archiveHeadCard(a) {
    var typeLabel = a.archive_type === 'hvac' ? '暖通工程' : '上门服务';
    var title = a.product_description ? String(a.product_description) : typeLabel;
    var card = el('div', 'card', [el('h2', null, [document.createTextNode(title)])]);

    var st = statusInfo(a.status);
    card.appendChild(text('p', String(a.archive_no || '') + ' · ' + st.label, 'hint'));

    var fields = [
      kv('客户', a.customer_name),
      kv('地址', a.service_address),
      a.service_type ? kv('服务类型', serviceTypeText(a.service_type)) : null,
      a.service_date ? kv('服务日期', fmtDate(a.service_date)) : null,
      a.accepted_date ? kv('验收日期', fmtDate(a.accepted_date)) : null,
      kv('说明', a.public_note),
    ];
    for (var i = 0; i < fields.length; i += 1) if (fields[i]) card.appendChild(fields[i]);
    return card;
  }

  /**
   * 门店分组的**最小摘要**区块（ARC-V1 / R0-CHG-01）。
   *
   * 输入形状由服务端 `ArchiveQueryService.queryByMobileSummary()` 决定，
   * 且**只有四个字段**（`store_name` + 每条档案的
   * `archive_type_label` / `progress` / `progress_label`）：
   *
   *   { store_id, store_name, archives: [
   *       { archive_type, archive_type_label, progress, progress_label } ] }
   *
   * ⚠️ 这里**故意不接收** `archive_no`：匿名摘要查询不下发它，页面也就
   *    没有"点进去看详情"的入口。若将来有人把 `archive_no` 加进投影，
   *    本函数不会自动把它渲染出来 —— 少一个字段就少一条通往详情页的路。
   *
   * ⚠️ `store_id` 只用于排序与去重（服务端已排好），**不渲染** ——
   *    门店内部 id 属于内部标识，对外只需要名字。
   */
  function summaryStoreBlock(g) {
    var archives = (g && Array.isArray(g.archives)) ? g.archives : [];
    var storeName = (g && g.store_name != null) ? String(g.store_name) : '门店';

    var head = el('div', 'sum-head', [
      text('div', storeName, 'sum-store'),
      text('div', archives.length + ' 条档案', 'sum-count'),
    ]);

    var card = el('div', 'card', [head]);
    for (var i = 0; i < archives.length; i += 1) {
      var a = archives[i] || {};
      var done = a.progress === 'completed';
      var badge = text('span', String(a.progress_label || (done ? '已完成' : '进行中')),
        'badge' + (done ? ' done' : ' doing'));
      card.appendChild(el('div', 'sum-row', [
        text('div', String(a.archive_type_label || '服务档案'), 'sum-type'),
        badge,
      ]));
    }
    return card;
  }

  global.ArcRender = {
    ARCHIVE_NO_RE: ARCHIVE_NO_RE,
    text: text,
    el: el,
    kv: kv,
    /* ---- 以下 5 个函数服务于**受验证码保护的详情视图**（服务端 5 个
     * publicArchive Action 仍在，权限检查一个字未动）。
     * 手机号直查页面（R0-CHG-01）只调用 `summaryStoreBlock()` ——
     * 它拿不到 `archive_no`，因此走不到这些分支。
     * 保留它们是为了让 `xss-test.html` 继续对**同一份渲染代码**做 XSS 断言；
     * 删除会让那份 fixture 失去被测对象，反而削弱既有的安全验证。 ---- */
    arcCard: arcCard,
    stageRow: stageRow,
    photoBlock: photoBlock,
    archiveHeadCard: archiveHeadCard,
    /* ---- R0-CHG-01 新增 ---- */
    summaryStoreBlock: summaryStoreBlock,
    statusInfo: statusInfo,
    serviceTypeText: serviceTypeText,
    fmtDate: fmtDate,
    stageTitle: stageTitle,
    stageNo: stageNo,
  };
})(window);
