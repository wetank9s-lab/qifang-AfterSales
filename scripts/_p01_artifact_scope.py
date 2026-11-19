# -*- coding: utf-8 -*-
r"""
纯 P0-1 产物 vs 生产旧产物的差异归类（分句级）。

为什么必须分句：产物是单行 JS，字符级 difflib 会把 esbuild 的变量重命名
（`let s=` → `let c=`）放大成几百个假差异块。按 `;`（及部分结构符）切句后，
只剩下真正的语义差异，可以逐块人工归类并**机械断言**。

判定（P0-1-only 发布的门禁）：
  - 差异块中**允许**出现的 P0-1 语义：维修措施标签、有效字数、必填校验、
    svc-note-help 布局、处理结果控件移除；
  - 差异块中**禁止**出现的 P6B 语义：P6B 特征串一个都不许有；
  - 除 P0-1 相关分句外，其余分句必须与旧产物**逐字相同**（否则就是夹带了别的东西）。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW_JS = os.path.join(ROOT, '.build', 'p01', 'dist', 'assets', 'index-Bwv3_-Ce.js')
OLD_JS = os.path.join(ROOT, '.probe', 'prod-B-QCspWq.js')

# 本次发布**必须**带来的 P0-1 语义（产物内必须存在）
P01_REQUIRED = [
    ('维修措施标签', '维修措施'),
    ('必填提示文案', '请填写维修措施'),
    ('至少5字说明', '至少 5 个字'),
    ('有效字数布局类-容器', 'svc-note-help'),
    ('有效字数布局类-文本', 'svc-note-help-text'),
    ('有效字数布局类-计数', 'svc-note-help-count'),
    ('计数测试锚点', 'note-counter'),
    ('超长文案已改名', '维修措施不能超过 500 字'),
]

# 本次发布**绝不能**带来的 P6B / 其它语义（产物内必须为 0）
FORBIDDEN = [
    ('P6B skipRestore', 'skipRestore'),
    ('P6B 清除本机记录按钮', '这不是我的工单'),
    ('P6B 提交新工单入口', '提交新工单'),
    ('P6B removeLastOrderByToken', 'removeLastOrderByToken'),
    ('P6B 7天期限魔法数', '6048e5'),
    ('旧标签（选填）', '处理说明（选填）'),
    ('旧超长文案', '处理说明不能超过'),
    ('旧必填文案', '请填写处理说明'),
]

# 旧产物里**应当仍然存在**的基线特征（证明未误删既有功能）
BASELINE = [
    ('P6C 评价直连Action', 'publicReview:submit'),
    ('BASE 服务报修标题', '服务报修'),
    ('BASE 感谢页', '感谢您的评价'),
    ('BASE 隐私页', '个人信息处理说明'),
]


def split_clauses(src: str):
    """按 `;` 切句（保留分隔符），产物是压缩单行，这样切粒度足够细分。"""
    parts = src.split(';')
    return [p + ';' for p in parts]


def main() -> int:
    for p in (NEW_JS, OLD_JS):
        if not os.path.exists(p):
            print('[FATAL] 缺少 %s' % p)
            return 1

    new = io.open(NEW_JS, 'rb').read().decode('utf-8', 'replace')
    old = io.open(OLD_JS, 'rb').read().decode('utf-8', 'replace')

    ok = True
    print('=' * 78)
    print('A. P0-1 语义必须在场')
    print('=' * 78)
    print('  %-24s %6s %6s' % ('needle', 'new', 'old'))
    for label, w in P01_REQUIRED:
        n, o = new.count(w), old.count(w)
        print('  %-24s %6d %6d' % (label, n, o))
        if n == 0:
            ok = False
            print('       <== [FAIL] 新产物缺失该项')

    print()
    print('=' * 78)
    print('B. P6B / 旧文案必须缺席（新产物内恒为 0）')
    print('=' * 78)
    print('  %-24s %6s %6s' % ('needle', 'new', 'old'))
    for label, w in FORBIDDEN:
        n, o = new.count(w), old.count(w)
        flag = ''
        if n:
            ok = False
            flag = '  <== [FAIL] 污染'
        print('  %-24s %6d %6d%s' % (label, n, o, flag))

    print()
    print('=' * 78)
    print('C. 基线特征必须仍在（未误删既有功能）')
    print('=' * 78)
    for label, w in BASELINE:
        n, o = new.count(w), old.count(w)
        flag = ''
        if n == 0:
            ok = False
            flag = '  <== [FAIL] 既有功能丢失'
        print('  %-24s new=%-4d old=%-4d%s' % (label, n, o, flag))

    print()
    print('=' * 78)
    print('D. 分句级差异（new 有、old 无 → 本次新增的语义）')
    print('=' * 78)
    old_set = set(split_clauses(old))
    new_clauses = split_clauses(new)
    added = [c for c in new_clauses if c not in old_set]
    print('  新增分句数 = %d' % len(added))
    for c in added:
        snippet = c.strip()
        if len(snippet) > 200:
            snippet = snippet[:200] + '…'
        print('  ---')
        print('  ' + snippet)

    print()
    print('=' * 78)
    print('E. 分句级差异（old 有、new 无 → 本次删掉的语义）')
    print('=' * 78)
    new_set = set(new_clauses)
    removed = [c for c in split_clauses(old) if c not in new_set]
    print('  删除分句数 = %d' % len(removed))
    for c in removed:
        snippet = c.strip()
        if len(snippet) > 200:
            snippet = snippet[:200] + '…'
        print('  ---')
        print('  ' + snippet)

    print()
    print('=' * 78)
    print('F. 差异块归属判定（机械分类，任何 unclassified 都判红）')
    print('=' * 78)

    # 关键词 → 归属
    P01_KW = ('维修措施', 'svc-note-help', 'note-counter', '至少 5 个字',
              'service_note', 'f-note', 'textarea', 'note', 'w.value')
    P6B_KW = ('skipRestore', '这不是我的工单', '提交新工单', 'remember', 'autoOpen',
              'applyRemember', 'lastOrder', 'last-order', '6048e5', 'removeLastOrderByToken')
    UNCLASSIFIED = ('已解决', 'review', 'opened', '感谢', '进度', 'upload', 'photo', 'media')

    tally = {'P0-1 相关': 0, 'P6B 命中': 0, '无法归类': 0}
    for kind, items in (('ADD', added), ('DEL', removed)):
        for c in items:
            if any(k in c for k in P6B_KW):
                tally['P6B 命中'] += 1
                ok = False
                print('  [FAIL][%s] 命中 P6B 关键词: %s' % (kind, c.strip()[:160]))
            elif any(k in c for k in P01_KW):
                tally['P0-1 相关'] += 1
            else:
                tally['无法归类'] += 1
                print('  [WARN][%s] 无法自动归类: %s' % (kind, c.strip()[:160]))

    print()
    for k, v in tally.items():
        print('  %-10s %d' % (k, v))

    print()
    print('=' * 78)
    print('RESULT: %s' % ('PASS — 产物只含 P0-1' if ok else 'FAIL — 产物混入其它改动'))
    print('=' * 78)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
