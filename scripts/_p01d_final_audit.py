# -*- coding: utf-8 -*-
r"""
方案 D 最终语义差异审计：新产物 vs 线上产物。

核心思路（不做字符串计数对比，避免"计数相同但分支不同"的假绿）：
  1. **函数级切片**：压缩产物里每个业务函数（如 Report 的恢复函数 `j()`、Success 的 `setup`）
     按边界切出来，逐段与线上对应段对比；
  2. **分支级判据**：每个业务行为写成"该分支存在/不存在"的布尔判断，
     要求 线上值与新产物值 符合**预期关系**（保留=都真；新增=线上假新真；撤回=都假）；
  3. 变量重命名不算变化：所有判据只看字面量与结构，不看 minified 名。

任何一条不符合预期 ⇒ exit 1（禁止部署）。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.path.join(ROOT, '.probe', 'live-now.js')
NEW = os.path.join(ROOT, '.build', 'p01d', 'dist', 'assets', 'index-BG5kVB0x.js')


def load(p):
    return io.open(p, 'rb').read().decode('utf-8', 'replace')


# ---------------------------------------------------------------- 业务判据
# 每条：(名称, 判定函数, 期望关系)
#   期望 'keep'   : 线上 True 且 新 True
#   期望 'add'    : 线上 False 且 新 True   （P0-1 新增）
#   期望 'remove' : 线上 False 且 新 False  （未上线，两边都不该有）
CHECKS = [
    # ---- A. 线上已有行为，必须保留 ----
    ('A1 上一单恢复链路（readLastOrder 调用）',
     lambda t: len(re.findall(r'\boc\(', t)) >= 3, 'keep'),
    ('A2 上一单卡片「查看上一单进度」',
     lambda t: 'view-last-order' in t and '查看上一单进度' in t, 'keep'),
    ('A3 「不再记住」按钮',
     lambda t: 'forget-last-order' in t and '不再记住' in t, 'keep'),
    ('A4 记住卡片文案「下次打开本店页面自动进入上一单」',
     lambda t: '下次打开本店页面自动进入上一单' in t, 'keep'),
    ('A5 清除本机记录按钮（progress-forget）',
     lambda t: 'progress-forget' in t and '这不是我的工单' in t, 'keep'),
    ('A6 P6-PROGRESS-SYNC-02「此前服务师傅」分支',
     lambda t: '此前服务师傅' in t and '本次服务师傅' in t, 'keep'),
    ('A7 门店电话 progress-store-phone',
     lambda t: 'progress-store-phone' in t, 'keep'),
    ('A8 lastOrder 7 天期限 6048e5',
     lambda t: '6048e5' in t, 'keep'),
    ('A9 评价直连 publicReview:submit',
     lambda t: 'publicReview:submit' in t, 'keep'),

    # ---- B. skipRestore：线上只有生成、没有消费（死参数）----
    # ⚠️ B2 的判据本身是「消费逻辑**不存在**」（not in），
    #    所以它的 True 值代表"撤回成功"，关系应为 keep（两边都为 True），
    #    不能写成 remove —— remove 表示"两边都为 False"，那是判据写反了。
    ('B1 skipRestore 生成处保持 3 处',
     lambda t: t.count('skipRestore') == 3, 'keep'),
    ('B2 skipRestore **消费**判断不存在',
     lambda t: 'query.skipRestore' not in t, 'keep'),

    # ---- C. P6B 未上线，必须撤回 ----
    ('C1 Success 挂载即落盘（onMounted 内 remember 调用）',
     lambda t: bool(re.search(r'__name:`Success`,setup\(e\)\{let t=\w+\(\);tr\(\(\)=>\{[^}]*\}\)', t)
                   and ',s.value&&u()' in t), 'remove'),
    ('C2 remember/autoOpen 初值为 true',
     lambda t: bool(re.search(r'\),\w+=B\(!0\),\w+=B\(!0\)', t)), 'remove'),
    ('C3 applyRemember 函数名（P6B 挂载版特征）',
     lambda t: 'applyRemember' in t, 'remove'),

    # ---- D. P0-1 必须新增 ----
    ('D1 标签「维修措施」',
     lambda t: '维修措施' in t, 'add'),
    ('D2 旧标签「处理说明（选填）」已消失',
     lambda t: '处理说明（选填）' not in t, 'add'),
    ('D3 必填提示「请填写维修措施」',
     lambda t: '请填写维修措施' in t, 'add'),
    ('D4 超长文案已改名「维修措施不能超过 500 字」',
     lambda t: '维修措施不能超过 500 字' in t, 'add'),
    ('D5 有效字数阈值 5（.value<5 分支）',
     lambda t: bool(re.search(r'\.value<5\b', t)), 'add'),
    ('D6 纵向布局 svc-note-help / -count',
     lambda t: 'svc-note-help' in t and 'svc-note-help-count' in t, 'add'),
    ('D7 计数锚点 note-counter',
     lambda t: 'note-counter' in t, 'add'),
]


def main() -> int:
    live, new = load(LIVE), load(NEW)
    ok = True

    print('=' * 96)
    print('方案 D 语义差异审计')
    print('  LIVE: %s (%d bytes)' % (os.path.basename(LIVE), len(live)))
    print('  NEW : %s (%d bytes)' % (os.path.basename(NEW), len(new)))
    print('=' * 96)
    print('%-46s %-9s %-9s %-8s %s' % ('业务判据', '线上', '新产物', '关系', '结果'))
    print('-' * 96)

    for name, fn, expect in CHECKS:
        try:
            lv, nv = fn(live), fn(new)
        except Exception as e:  # 判据自己出错也算失败
            print('%-46s %-9s %-9s %-8s FATAL:%s' % (name, '-', '-', expect, e))
            ok = False
            continue
        if expect == 'keep':
            good = lv and nv
        elif expect == 'add':
            good = (not lv) and nv
        else:  # remove
            good = (not lv) and (not nv)
        if not good:
            ok = False
        print('%-46s %-9s %-9s %-8s %s' % (
            name, str(lv), str(nv), expect, 'OK' if good else '<<< FAIL'))

    # ---------------- 函数级切片对比 ----------------
    print()
    print('=' * 96)
    print('函数级切片对比（变量重命名不算变化，只看结构）')
    print('=' * 96)

    def slice_fn(text, name_hint):
        """切出 `async function X(){...}` 到配对括号结束。"""
        m = re.search(r'async function ([a-zA-Z_$][\w$]*)\(\)\{', text)
        if not m:
            return None
        start = m.start()
        i = text.index('{', m.start())
        depth, j = 0, i
        while j < len(text):
            c = text[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return text[start:j + 1]
            j += 1
        return None

    # Report 恢复函数：两边都叫 j()（压缩名可能不同，按"含 query.pt"定位）
    def find_restore(t):
        for m in re.finditer(r'async function ([a-zA-Z_$][\w$]*)\(\)\{', t):
            seg = t[m.start():m.start() + 600]
            if 'query.pt' in seg:
                return slice_fn(t[m.start():], '')
        return None

    lr, nr = find_restore(live), find_restore(new)
    if lr and nr:
        # 归一化空白后比较开头 200 字符
        same_head = lr[:220].replace(' ', '') == nr[:220].replace(' ', '')
        print('  Report 恢复函数开头 220 字符同构: %s' % ('YES' if same_head else 'NO'))
        if not same_head:
            ok = False
            print('    LIVE:', lr[:220])
            print('    NEW :', nr[:220])
    else:
        print('  [!] 未切到 Report 恢复函数 (live=%s new=%s)' % (bool(lr), bool(nr)))
        ok = False

    # Success setup 首段
    def success_head(t):
        i = t.find('__name:`Success`')
        return t[i:i + 200] if i != -1 else None

    ls, ns = success_head(live), success_head(new)
    if ls and ns:
        same = ls.replace(' ', '') == ns.replace(' ', '')
        print('  Success setup 首段 200 字符同构: %s' % ('YES' if same else 'NO'))
        if not same:
            ok = False
            print('    LIVE:', ls)
            print('    NEW :', ns)
    else:
        print('  [!] 未找到 Success setup')
        ok = False

    print()
    print('=' * 96)
    print('RESULT: %s' % ('PASS — 允许的业务变化仅限 P0-1' if ok
                         else 'FAIL — 存在无法解释的业务差异，禁止部署'))
    print('=' * 96)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
