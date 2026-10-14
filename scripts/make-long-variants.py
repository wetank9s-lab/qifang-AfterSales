"""从真实样本派生"超时长"变体（只改 Info 里的 Duration 值，结构保持真实）

为什么要派生而不是手工拼：
    手工拼的容器**复现不出真实产物的结构特征**（多轨道、未知长度 Segment、
    SeekHead 里的 ID 引用…）—— 那正是上一版解析器出错的地方。
    这里只把 Duration 的 4 字节 float 改成目标值，**其余字节一字不动**。

用法：python storage/tmp/make-long-variants.py
"""
import struct
import sys

sys.path.insert(0, 'scripts')
import importlib.util as _ilu  # 文件名带连字符，不能直接 import
_spec = _ilu.spec_from_file_location('ebml_probe', 'scripts/ebml-probe.py')
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
read_vint = _mod.read_vint


def find_duration_offset(buf):
    """用规范解析器定位 Duration 的 payload 起点（不是字节搜索）"""
    found = []

    def rec(start, end, depth):
        pos = start
        while pos < end:
            idr = read_vint(buf, pos, keep_marker=True)
            if not idr[0] and idr[0] != 0:
                return
            elem_id, id_len, _ = idr
            sizr = read_vint(buf, pos + id_len, keep_marker=False)
            if sizr[0] is None:
                return
            size, size_len, unknown = sizr
            payload_at = pos + id_len + size_len
            payload_end = end if unknown else payload_at + size
            if elem_id == 0x4489:  # Duration
                found.append(payload_at)
            if elem_id in (0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0x1A45DFA3) and depth < 6:
                rec(payload_at, min(payload_end, end), depth + 1)
            if unknown:
                return
            pos = payload_end

    rec(0, len(buf), 0)
    return found


def make_variant(src, dst, target_ms):
    buf = bytearray(open(src, 'rb').read())
    offs = find_duration_offset(bytes(buf))
    if not offs:
        raise SystemExit(f'{src}: 找不到 Duration')
    off = offs[0]
    struct.pack_into('>f', buf, off, float(target_ms))
    open(dst, 'wb').write(bytes(buf))
    print(f'{dst}: Duration {target_ms}ms（payload @{off}，其余字节未动）')


base = 'nocobase/plugins/service-ticket/test-fixtures/real-media'
# 语音上限 60 秒 ⇒ 75 秒必拒
make_variant(f'{base}/audio-chrome.webm', f'{base}/audio-chrome-75s.webm', 75_000)
# 视频上限 30 秒 ⇒ 45 秒必拒（**同一段真实录像**，只是时长超限）
make_variant(f'{base}/video-chrome.webm', f'{base}/video-chrome-45s.webm', 45_000)
# 边界：视频 29 秒必须放行（证明拒绝是"过线才拒"，不是"一律拒"）
make_variant(f'{base}/video-chrome.webm', f'{base}/video-chrome-29s.webm', 29_000)
# 边界：语音 59 秒必须放行
make_variant(f'{base}/audio-chrome.webm', f'{base}/audio-chrome-59s.webm', 59_000)