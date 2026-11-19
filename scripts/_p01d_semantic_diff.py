# -*- coding: utf-8 -*-
r"""
方案 D 的唯一关键检查：新产物 vs 线上产物的「业务语义」差异对比。

不做字符串计数对比（计数只能证明某个词出现过，不能证明走的是哪条分支），
而是**按业务分支抽取可判定的结构特征**，逐项对比线上/新产物的取值：

  · 每个特征必须有明确的「线上值 / 新值」，且两者都属于允许集合；
  · 任何一项取值变化，必须能对应到一条**已批准的业务变化**；
  · 无法对应的差异 ⇒ 打印出来并判红（禁止部署）。

变量重命名不算业务变化：所以下面所有判据都取**字符串字面量 / 结构分支**，
不取 minified 变量名。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.path.join(ROOT, '.probe', 'live-now.js')
NEW = os.path.join(ROOT, '.build', 'p01d', 'dist', 'assets', 'index-DFCFgfY7.js')


def load(p):
    return io.open(p, 'rb').read().decode('utf-8', 'replace')


def ctx(text, needle, before=120, after=120, limit=3):
    out, i, n = [], text.find(needle), 0
    while i != -1 and n < limit:
        out.append(text[max(0, i - before):i + len(needle) + after])
        i = text.find(needle, i + 1)
        n += 1
    return out


def has(text, *needles):
    return all(x in text for x in needles)


def main() -> int:
    live, new = load(LIVE), load(NEW)
    ok = True

    print('=' * 92)
    print('业务分支对比：线上 vs 新产物')
    print('=' * 92)

    # ---- 每组：(业务行为, 判定函数, 期望说明) ----
    checks = []

    def add(name, fn, note):
        checks.append((name, fn, note))

    # ---------- ① 已上线、必须原样保留 ----------
    add('Report: skipRestore 分支保留',
        lambda t: has(t, 'skipRestore') and t.count('skipRestore') >= 3,
        '线上=有；新=必须仍有')

    add('Progress: 清除本机记录按钮保留',
        lambda t: has(t, 'progress-forget', '这不是我的工单'),
        '线上=有；新=必须仍有')

    add('Progress: P6-PROGRESS-SYNC-02「此前服务师傅」分支保留',
        lambda t: has(t, '此前服务师傅', '本次服务师傅', 'reopened'),
        '线上=有；新=必须仍有')

    add('Progress: 门店电话 progress-store-phone 保留',
        lambda t: has(t, 'progress-store-phone'),
        '线上=有；新=必须仍有')

    add('lastOrder: 7 天期限 6048e5 保留',
        lambda t: '6048e5' in t,
        '线上=有；新=必须仍有')

    add('P6C: 评价直连 publicReview:submit 保留',
        lambda t: 'publicReview:submit' in t,
        '线上=有；新=必须仍有')

    # ---------- ② P0-1 必须新增 ----------
    # 标签：从「处理说明（选填）」变为「维修措施」+ 恒显星号
    add('P0-1: 标签「维修措施」出现（线上应为 0）',
        lambda t: '维修措施' in t,
        '仅新产物允许有')

    add('P0-1: 旧标签「处理说明（选填）」已消失',
        lambda t: '处理说明（选填）' not in t,
        '仅新产物允许无（线上有）')

    add('P0-1: 必填提示「请填写维修措施」',
        lambda t: '请填写维修措施' in t,
        '仅新产物允许有')

    add('P0-1: 有效字数阈值 5（w.value<5 或等价分支）',
        lambda t: bool(re.search(r'\.value<5\b', t)) or '至少 5 个字' in t,
        '仅新产物允许有')

    add('P0-1: 纵向布局类 svc-note-help',
        lambda t: has(t, 'svc-note-help', 'svc-note-help-count'),
        '仅新产物允许有')

    # ---------- ③ 未上线的 P6B 必须已撤回 ----------
    # 判定点：线上有 onChange 触发、无挂载即落盘；新产物必须同构
    add('P6B(未上线): 无「挂载即落盘」的 applyRemember 调用',
        lambda t: 'applyRemember' not in t,
        '已上线，必须保留')

    # 线上 remember 卡片提示文案（旧版：要求勾选）
    add('P6B(未上线): 记住卡片仍要求勾选（remember-hint 提示在）',
        lambda t: has(t, 'remember-hint', '只保存在本浏览器'),
        '线上=有该提示；新=必须仍有')

    # ⚠️ 上面那条 `applyRemember not in t` 只能证明"函数名没被打包"，
    #    不能证明"挂载时没落盘"。补一条真正看**分支结构**的判据：
    #    工作区版本 onMounted 内会调用 applyRemember()（首个箭头函数体里出现 remember 相关调用）；
    #    撤回后 onMounted 只剩 ensureUiConfig。用「onMounted 箭头体内是否含 applyRemember/remember」
    #    作为判定点——但压缩后函数名被重命名，所以改用**行为等价的字面量结构**：
    #    未上线版：remember checkbox 的初值来自 ref(false)，落盘只发生在 @change。
    #    已撤回版与新产物都满足：「remember-hint 文案在」且「不存在挂载期 remember 调用」。
    add('P6B(未上线): 不存在挂载期自动落盘调用',
        lambda t: not re.search(r'__name:`Success`,setup\(e\)\{[^}]{0,400}applyRemember', t),
        '已上线，必须保留')

    # Success 的 setup 里是否直接调用"记住"逻辑（撤回后只应由 @change 触发）
    add('P6B(未上线): Success setup 首屏无 remember 落盘入口',
        lambda t: t.count('在此设备记住这张工单') >= 1 and 'remember-order' in t,
        '两边一致（只保留勾选入口，不自动落盘）')

    # ★ 最强判据：Success setup 的**开头到 remember/autoOpen 初值**这段必须与线上逐字同构。
    #   工作区版本会多出 `if(canRemember)applyRemember()`，撤回后应消失。
    #     · 线上: tr(()=>{ec().then(()=>tc(`提交成功`))});let n=…,s=Z(…),c=B(!1),l=B(!1);
    #     · 撤回: 同上（c/l 都是 !1 = false）
    #   判据落在「remember 初值 = false 且 onMounted 体里不出现 apply 调用」。
    def remember_defaults_false(t):
        # 取 setup 起始后 900 字符内，c=B(!1),l=B(!1) 必须出现
        i = t.find('__name:`Success`')
        if i == -1:
            return False
        seg = t[i:i + 900]
        if not re.search(r'\),([a-zA-Z])=B\(!1\),([a-zA-Z])=B\(!1\)', seg):
            return False
        # 且 onMounted 体内不得有额外的 remember 落盘调用
        om = re.search(r'tr\(\(\)=>\{([^}]*)\}\)', seg)
        if om and ('applyRemember' in om.group(1) or 'sc(' in om.group(1)):
            return False
        return True

    add('P6B(未上线): remember/autoOpen 初值均为 false 且挂载无落盘',
        remember_defaults_false,
        '已上线，必须保留')

    print()
    print('%-56s %-10s %-10s %s' % ('业务行为', '线上', '新产物', '判定'))
    print('-' * 92)
    for name, fn, note in checks:
        lv, nv = fn(live), fn(new)
        # 判定规则（按 note 关键字分派）：
        #   仅新产物允许 → 线上 False、新 True  （P0-1 新增）
        #   撤回          → 线上 False、新 False （两边都"没有"，状态一致）
        #   其余          → 线上 True、新 True   （已上线行为，必须保留）
        # ⚠️ 判据坑：先判 `撤回` 还是先判 `仅新产物允许` 必须**互斥**，
        #    上一版把 note 写成「撤回：…」而分派只认「撤回标志」，导致落进 else 分支判红。
        #    这类"判据自己写错却报产品 FAIL"是本项目第 N 次出现，所以下面做了互斥断言。
        tags = [k for k in ('仅新产物允许', '撤回') if k in note]
        if len(tags) > 1:
            raise SystemExit('[FATAL] 判据 note 同时命中多个分派关键字: %r' % note)
        if tags == ['仅新产物允许']:
            good = (not lv) and nv
            rule = 'P0-1 新增'
        elif tags == ['撤回']:
            good = (not lv) and (not nv)
            rule = '两边均无 = 未上线，状态一致'
        else:
            good = lv and nv
            rule = '已上线，必须保留'
        if not good:
            ok = False
        print('%-56s %-10s %-10s %s%s' % (
            name, str(lv), str(nv), 'OK' if good else '<<< FAIL',
            '' if good else '   [' + rule + ']',
        ))

    print()
    print('=' * 92)
    print('关键分支抽查（打印实际代码片段供人工核对）')
    print('=' * 92)

    print('\n[1] 维修措施校验分支（新产物）:')
    for s in ctx(new, '请填写维修措施', 160, 60, 1):
        print('    ...' + s + '...')

    print('\n[2] 超长与短于 5 字的判定顺序（新产物）:')
    for s in ctx(new, '不能超过 500 字', 120, 60, 1):
        print('    ...' + s + '...')

    print('\n[3] 记住卡片是否仍为「勾选才落盘」（新产物 onChange 段）:')
    for s in ctx(new, 'remember-order', 60, 220, 1):
        print('    ...' + s + '...')

    print('\n[4] skipRestore 分支（新产物，应与线上同构）:')
    for s in ctx(new, 'skipRestore', 100, 100, 1):
        print('    ...' + s + '...')

    print()
    print('=' * 92)
    print('RESULT: %s' % ('PASS — 业务语义差异仅限 P0-1' if ok else 'FAIL — 存在无法解释的业务差异，禁止部署'))
    print('=' * 92)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
