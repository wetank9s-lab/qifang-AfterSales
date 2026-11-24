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

  /**
   * 产品清单（R2.2.4 §C）—— **客户详情页的产品区块**。
   *
   * ===========================================================================
   * 为什么不直接渲染 `a.product_description / a.purchase_date`
   * ===========================================================================
   *   这两个是**单值**旧列，服务端只把第一条产品镜像进去（`mirrorToLegacy`）。
   *   一台档案装三台设备时，旧列**只有第一台** —— 客户看到的清单比实际少两条，
   *   而界面上没有任何迹象说明"还有更多"。这正是用户 §C 第 8 条要防的：
   *   「更新客户 H5 与员工详情页的产品展示，**避免只显示第一项**」。
   *
   *   服务端 `ArchiveQueryService.detail()` 已下发 `products`
   *   （`projectForCustomer` 投影，只有 name/date/quantity，无 id/sort_order）。
   *
   * ===========================================================================
   * 三条渲染纪律
   * ===========================================================================
   *   ① **只用 `textContent`**（`text()` / `el()` 都是），不用 innerHTML：
   *      产品名是客户自己/员工输入的，`<img onerror>` 之类的载荷必须当**字符**显示。
   *      本文件其他区块都是这个口径，这里不例外（`h5/public/xss-test.html` 在守它）。
   *   ② `products` **不是数组**就整个不渲染 —— 不回落到旧列：
   *      旧客户端缓存的响应里没有这个键，回落会让"新界面"与"服务端事实"不一致。
   *      真正需要兼容的是**没有清单行的老档案**，那由服务端保证
   *      （迁移已回填 53 条；`projectForCustomer` 恒返回数组）。
   *   ③ 空数组 ⇒ **不渲染这个区块**（不是渲染一个"暂无产品"的空卡片）：
   *      客户查询页是信息页，一个空标题只会让页面变长。
   *
   * 数量只在 >1 时显示（"1 台"是默认值，写出来是噪音）。
   */
  function productBlock(products) {
    if (!Array.isArray(products) || products.length === 0) return null;
    var rows = [];
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i] || {};
      var name = (p.product_name === null || p.product_name === undefined)
        ? ''
        : String(p.product_name).trim();
      if (!name) name = '（未填写产品）';
      var qty = Number(p.quantity);
      var sub = [];
      if (p.purchase_date) sub.push('购买 ' + String(p.purchase_date));
      if (Number.isSafeInteger(qty) && qty > 1) sub.push('数量 ' + qty);
      rows.push(el('div', 'kv', [
        text('div', name, 'k'),
        text('div', sub.length ? sub.join(' · ') : '—', 'v'),
      ]));
    }
    return el('div', 'card', [
      text('div', '产品清单（' + products.length + '）', 'sec-title first'),
    ].concat(rows));
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
   * 详情页头部 + 产品清单（R2.2.4 §C）。
   *
   * ⚠️ `productBlock` 返回的是**独立卡片**，所以不能塞进 `archiveHeadCard`
   *    的 `var card` 里（那是 `el('div','card',…)`，一个 div 只能有一个 class）。
   *    ⇒ 单独导出 `archiveDetailCards` 让页面按顺序 append。
   */
  function archiveDetailCards(a) {
    var out = [archiveHeadCard(a)];
    var pb = productBlock(a && a.products);
    if (pb) out.push(pb);
    return out;
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
    /* ---- R2.2.4 §C：产品清单 ----
     * `productBlock(products)` 单独给出，便于页面自己决定插在哪。
     * `archiveDetailCards(archive)` = [头部卡, 产品卡?]，是详情页的推荐入口
     * —— 把"有没有产品"的判断留在渲染层，页面不必重复一遍 `Array.isArray`。
     *
     * ⚠️ 不放进 `arcCard`：那是**列表卡**，塞进产品清单会让列表从"一行一条"
     *    变成"每条占三行"，而摘要的用途恰恰是让人快速扫过。 */
    productBlock: productBlock,
    archiveDetailCards: archiveDetailCards,
    /* ---- R0-CHG-01 新增 ---- */
    summaryStoreBlock: summaryStoreBlock,
    statusInfo: statusInfo,
    serviceTypeText: serviceTypeText,
    fmtDate: fmtDate,
    stageTitle: stageTitle,
    stageNo: stageNo,
  };
})(window);
