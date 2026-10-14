"""从真实 Chromium 录音派生「**没有 Info > Duration**」的变体 —— 复现 iPhone 实测形态。

iPhone 的日志结构摘要是：tracks=yes | trackTypes=[2] | duration=null
⇒ 流式写出，Duration 字段被写成 0（或缺失）。
这里把真实样本的 Duration 改成 0（等价于"没有"），其余字节一字不动。
"""
import io
import importlib.util as ilu
import struct

spec = ilu.spec_from_file_location('ebml_probe', 'scripts/ebml-probe.py')
mod = ilu.module_from_spec(spec)
spec.loader.exec_module(mod)

import sys
src = sys.argv[1] if len(sys.argv) > 1 else 'nocobase/plugins/service-ticket/test-fixtures/real-media/audio-chrome.webm'
buf = bytearray(io.open(src, 'rb').read())


def find_duration_payload(b):
    found = []

    def rec(start, end, depth):
        pos = start
        while pos < end:
            idr = mod.read_vint(b, pos, keep_marker=True)
            if idr[0] is None:
                return
            elem_id, id_len, _ = idr
            siz = mod.read_vint(b, pos + id_len, keep_marker=False)
            if siz[0] is None:
                return
            size, size_len, unknown = siz
            payload_at = pos + id_len + size_len
            payload_end = end if unknown else payload_at + size
            if elem_id == 0x4489:
                found.append(payload_at)
            if elem_id in (0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0x1A45DFA3) and depth < 6:
                rec(payload_at, min(payload_end, end), depth + 1)
            if unknown:
                return
            pos = payload_end

    rec(0, len(b), 0)
    return found


for off in find_duration_payload(buf):
    struct.pack_into('>f', buf, off, 0.0)          # Duration = 0 ⇒ 等价于"没有"
    print(f'把 Duration 置 0 @ {off}')

out = sys.argv[2] if len(sys.argv) > 2 else 'nocobase/plugins/service-ticket/test-fixtures/real-media/audio-chrome-noduration.webm'
io.open(out, 'wb').write(bytes(buf))
print('已写出', out)
