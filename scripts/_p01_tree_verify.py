# -*- coding: utf-8 -*-
r"""
纯 P0-1 构建树的「发布范围」自证。

目的：证明 .build/p01 这棵树 = HEAD（生产基线）+ 且仅 + 两个 P0-1 文件。
做法：不做逐文件哈希（Git Bash 的 CRLF 转换会让哈希假不一致 —— 这一轮已经错过一次），
     而是**逐文件与 `git show HEAD:` 的字节流比对内容**，并显式列出「与 HEAD 不同的文件」。

判据：
  1. 差异文件集合必须**恰好等于** P0-1 白名单两个文件；
  2. 白名单外的任何差异 ⇒ exit 1（发布范围被污染）；
  3. P0-1 两个文件的差异内容必须**只包含** P0-1 语义（反向断言下面的 P6B 特征串一个都没有）。

⚠️ 判据坑（本项目已踩过多次）：零否定断言（"不含 X"）必须先证明**检查过东西**，
   所以下面先打印每个文件的比对状态，任何一个文件读不到都要报错而不是跳过。
"""
import io
import os
import subprocess
import sys

TREE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.build', 'p01')

# P0-1 允许改动的文件（本次发布范围的全部）
P01_ALLOWED = {
    'src/pages/Technician/Visit.vue',
    'src/styles/base.css',
}

# P6B 三项语义变化的特征串 —— 这些**绝不能**出现在本次产物里
P6B_MARKERS = [
    ('P6B Success 挂载即落盘', 'applyRemember 挂载即按当前状态落盘'),
    ('P6B Report skipRestore', 'skipRestore'),
    ('P6B remember 默认 true', 'const remember = ref(true)'),
    ('P6B autoOpen 默认 true', 'const autoOpen = ref(true)'),
    ('P6B last-order 7天', '7 * 24 * 60 * 60 * 1000'),
    ('P6B removeLastOrderByToken', 'removeLastOrderByToken'),
    ('P6B 清除本机记录按钮', '这不是我的工单'),
]

# 必须与 HEAD 保持一致的、特别关注的 P6B 文件
P6B_MUST_MATCH = [
    'src/pages/Report/Success.vue',
    'src/pages/Report/index.vue',
    'src/utils/last-order.ts',
    'src/pages/Customer/Progress.vue',
    'src/components/MediaUploader.vue',
    'src/pages/Review/index.vue',
    'src/api/media.ts',
    'src/api/review.ts',
]


def head_bytes(rel: str):
    """取 `git show HEAD:h5/<rel>` 的原始字节；不存在返回 None。"""
    p = subprocess.run(
        ['git', 'show', 'HEAD:h5/' + rel],
        cwd=os.path.dirname(TREE), capture_output=True,
    )
    if p.returncode != 0:
        return None
    return p.stdout


def norm(b: bytes) -> bytes:
    """归一化行尾：Git Bash / core.autocrlf 会把工作区写成 CRLF，
    而 `git show` 给的是 LF。只比内容、不比行尾 —— 否则每一行都会假不一致。"""
    return b.replace(b'\r\n', b'\n')


def main() -> int:
    if not os.path.isdir(TREE):
        print('[FATAL] 构建树不存在: %s' % TREE)
        return 1

    tree_files = []
    for dirpath, _dirnames, filenames in os.walk(os.path.join(TREE, 'src')):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, TREE).replace('\\', '/')
            tree_files.append(rel)
    tree_files.sort()

    print('[TREE] %s' % TREE)
    print('[TREE] src 下文件数 = %d' % len(tree_files))

    changed, missing_in_head, read_fail = [], [], []
    for rel in tree_files:
        hb = head_bytes(rel)
        if hb is None:
            missing_in_head.append(rel)
            continue
        try:
            local = io.open(os.path.join(TREE, rel), 'rb').read()
        except OSError as e:
            read_fail.append('%s (%s)' % (rel, e))
            continue
        if norm(local) != norm(hb):
            changed.append(rel)

    print()
    print('=' * 78)
    print('A. 与 HEAD 不一致的文件（= 本次发布实际带入的变化）')
    print('=' * 78)
    for rel in changed:
        mark = 'P0-1 ' if rel in P01_ALLOWED else '!!!  '
        print('  %s %s' % (mark, rel))
    if not changed:
        print('  （无）')

    print()
    print('B. HEAD 中没有的文件（新增，未接入 router ⇒ 不影响构建）')
    print('  ' + ('\n  '.join(missing_in_head) if missing_in_head else '（无）'))
    print('C. 读取失败')
    print('  ' + ('\n  '.join(read_fail) if read_fail else '（无）'))

    # ---- 判据 1：差异集合恒等于白名单 ----
    ok = True
    print()
    print('=' * 78)
    print('D. 发布范围判定')
    print('=' * 78)
    extra = [r for r in changed if r not in P01_ALLOWED]
    absent = [r for r in P01_ALLOWED if r not in changed]
    if extra:
        ok = False
        print('  [FAIL] 白名单外被改动: %s' % extra)
    else:
        print('  [ OK ] 白名单外无任何改动')
    if absent:
        ok = False
        print('  [FAIL] 白名单文件未生效: %s' % absent)
    else:
        print('  [ OK ] 两个 P0-1 文件均已并入')
    if read_fail:
        ok = False
        print('  [FAIL] 有文件读不到，判定不可信')

    # ---- 判据 2：P6B 特征串必须全部缺席 ----
    print()
    print('E. P6B 特征串反向检查（本次产物内必须全部为 0）')
    print('  %-34s %8s %8s' % ('marker', 'files', 'count'))
    blob = []
    for rel in tree_files:
        try:
            blob.append(io.open(os.path.join(TREE, rel), 'rb').read().decode('utf-8', 'replace'))
        except OSError:
            pass
    blob = '\n'.join(blob)
    for label, needle in P6B_MARKERS:
        n = blob.count(needle)
        flag = '' if n == 0 else '  <== 污染！'
        print('  %-34s %8s %8d%s' % (label, '-', n, flag))
        if n:
            ok = False

    # ---- 判据 3：P6B 关键文件必须与 HEAD 逐字节一致 ----
    print()
    print('F. P6B 关键文件与 HEAD 逐字节一致（归一化行尾后）')
    for rel in P6B_MUST_MATCH:
        hb = head_bytes(rel)
        try:
            local = io.open(os.path.join(TREE, rel), 'rb').read()
        except OSError:
            print('  [FAIL] 读不到 %s' % rel)
            ok = False
            continue
        if hb is None:
            print('  [FAIL] HEAD 无此文件 %s' % rel)
            ok = False
            continue
        if norm(local) == norm(hb):
            print('  [ OK ] %s' % rel)
        else:
            print('  [FAIL] 与 HEAD 不一致 %s' % rel)
            ok = False

    print()
    print('=' * 78)
    print('RESULT: %s' % ('PASS — 构建树只含 P0-1' if ok else 'FAIL — 发布范围被污染，禁止构建'))
    print('=' * 78)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
