"""
独立 EBML 解析器（P11-4 第三批 · 复核真实 MediaRecorder 产物）

用途：回答一个**必须用独立工具回答**的问题 ——
    真实浏览器产出的 webm **到底有没有 Tracks / TrackType**，
    还是我们自己那份 TS 解析器"没找到"？

为什么不能用手写解析器自证：**同一份错误的假设会同时出现在被测代码与复现脚本里**。
这里按 EBML 规范**解析元素树**（而不是字节搜索 ID），因此它能发现
"字节里确实存在 0x83 但它属于别的元素"这类情况。

用法：
    python scripts/ebml-probe.py <file.webm> [--max-depth 6]
"""
import sys
import struct

# EBML 元素 ID（按规范，ID 自带长度标记位，原样保留）
ID_NAMES = {
    0x1A45DFA3: 'EBML',
    0x4286: 'EBMLVersion',
    0x42F7: 'EBMLReadVersion',
    0x42F2: 'EBMLMaxIDLength',
    0x42F3: 'EBMLMaxSizeLength',
    0x4282: 'DocType',
    0x4287: 'DocTypeVersion',
    0x4285: 'DocTypeReadVersion',
    0x18538067: 'Segment',
    0x114D9B74: 'SeekHead',
    0x4DBB: 'Seek',
    0x53AB: 'SeekID',
    0x53AC: 'SeekPosition',
    0x1549A966: 'Info',
    0x2AD7B1: 'TimecodeScale',
    0x4489: 'Duration',
    0x4D80: 'MuxingApp',
    0x5741: 'WritingApp',
    0x1654AE6B: 'Tracks',
    0xAE: 'TrackEntry',
    0xD7: 'TrackNumber',
    0x73C5: 'TrackUID',
    0x83: 'TrackType',
    0x86: 'CodecID',
    0x258688: 'CodecName',
    0x9C: 'FlagLacing',
    0x22B59C: 'Language',
    0xB5: 'SamplingFrequency',
    0x9F: 'Channels',
    0xE1: 'Audio',
    0xE0: 'Video',
    0xB0: 'PixelWidth',
    0xBA: 'PixelHeight',
    0x1F43B675: 'Cluster',
    0xE7: 'Timecode',
    0xA3: 'SimpleBlock',
    0xA0: 'BlockGroup',
    0xA1: 'Block',
    0x1C53BB6B: 'Cues',
    0xBB: 'CuePoint',
    0x53B8: 'CueTrackPositions',
    0xEC: 'Void',
    0xBF: 'CRC-32',
    0xB6: 'TimecodeScale',
}

MASTER_IDS = {0x1A45DFA3, 0x18538067, 0x114D9B74, 0x4DBB, 0x1549A966, 0x1654AE6B,
              0xAE, 0xE1, 0xE0, 0x1F43B675, 0x1C53BB6B, 0xBB, 0x53B8, 0xA0}

# 无符号整数元素（值按字节读）
UINT_IDS = {0x4286, 0x42F7, 0x42F2, 0x42F3, 0x4287, 0x4285, 0x2AD7B1, 0x53AC,
            0xD7, 0x73C5, 0x83, 0x9C, 0x9F, 0xB0, 0xBA, 0xE7}
FLOAT_IDS = {0x4489, 0xB5}


def read_vint(buf, pos, keep_marker):
    """读变长整数。返回 (值, 长度, 是否未知长度)。未知长度 = 全部数据位为 1。"""
    if pos >= len(buf):
        return None, 0, False
    first = buf[pos]
    if first == 0:
        return None, 0, False
    length = 0
    for i in range(8):
        if first & (0x80 >> i):
            length = i + 1
            break
    if length == 0 or pos + length > len(buf):
        return None, 0, False
    if keep_marker:
        value = 0
        for i in range(length):
            value = (value << 8) | buf[pos + i]
    else:
        value = first & (0xFF >> length)
        for i in range(1, length):
            value = (value << 8) | buf[pos + i]
    all_ones = all((buf[pos + i] == 0xFF) for i in range(length))
    # 未知长度：数据位全 1（标记位之外的每一位都是 1）
    unknown = (value == (1 << (7 * length)) - 1) if not keep_marker else all_ones
    return value, length, unknown


def decode_uint(buf):
    v = 0
    for b in buf:
        v = (v << 8) | b
    return v


def decode_float(buf):
    if len(buf) == 4:
        return struct.unpack('>f', buf)[0]
    if len(buf) == 8:
        return struct.unpack('>d', buf)[0]
    return None


def walk(buf, start, end, depth, max_depth, out, path=''):
    """按 EBML 规范解析 [start, end) 区间，遇到未知长度的 master 就一路读到区间结束。"""
    pos = start
    while pos < end:
        elem_id, id_len, _ = read_vint(buf, pos, keep_marker=True)
        if elem_id is None or id_len == 0:
            return pos
        size, size_len, unknown = read_vint(buf, pos + id_len, keep_marker=False)
        if size is None:
            return pos
        name = ID_NAMES.get(elem_id, f'0x{elem_id:X}')
        payload_at = pos + id_len + size_len
        is_master = elem_id in MASTER_IDS

        if unknown:
            payload_end = end
            note = ' (长度未知)'
        else:
            payload_end = payload_at + size
            note = ''

        out.append({
            'depth': depth,
            'offset': pos,
            'id': elem_id,
            'name': name,
            'size': None if unknown else size,
            'unknown_len': unknown,
            'is_master': is_master,
        })

        if is_master and depth < max_depth:
            walk(buf, payload_at, min(payload_end, end), depth + 1, max_depth, out, path + '/' + name)
        elif elem_id in UINT_IDS and not unknown:
            val = decode_uint(buf[payload_at:payload_end])
            out[-1]['value'] = val
        elif elem_id in FLOAT_IDS and not unknown:
            val = decode_float(buf[payload_at:payload_end])
            out[-1]['value'] = val

        if unknown:
            # 未知长度 master：子元素读完之后就到区间结尾
            return payload_end
        pos = payload_end
    return pos


def fmt(entry):
    ind = '  ' * entry['depth']
    size = '未知' if entry['unknown_len'] else str(entry['size'])
    val = ''
    if 'value' in entry:
        v = entry['value']
        val = f"  = {round(v, 2) if isinstance(v, float) else v}"
    return f"{ind}{entry['name']} (offset={entry['offset']}, size={size}){val}"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    max_depth = 8
    if '--max-depth' in sys.argv:
        max_depth = int(sys.argv[sys.argv.index('--max-depth') + 1])

    with open(path, 'rb') as f:
        buf = f.read()

    print(f"文件: {path}")
    print(f"大小: {len(buf)} 字节")
    print(f"类型: {buf[:4].hex()} {'(EBML/WebM)' if buf[:4] == b'\\x1aE\\xdf\\xa3' else ''}")
    print('-' * 72)

    entries = []
    walk(buf, 0, len(buf), 0, max_depth, entries)
    for e in entries:
        print(fmt(e))

    print('-' * 72)
    tracks = [e for e in entries if e['name'] == 'Tracks']
    entries_ae = [e for e in entries if e['name'] == 'TrackEntry']
    tt = [e for e in entries if e['name'] == 'TrackType']
    cid = [e for e in entries if e['name'] == 'CodecID']
    dur = [e for e in entries if e['name'] == 'Duration']
    print('结论（按规范解析元素树，不是字节搜索）：')
    print(f"  Tracks 容器: {len(tracks)} 个" + (f" @ offset {tracks[0]['offset']}" if tracks else ' —— 不存在'))
    print(f"  TrackEntry : {len(entries_ae)} 个")
    print(f"  TrackType  : {len(tt)} 个" + (f" = {[e.get('value') for e in tt]}" if tt else ' —— 不存在'))
    print(f"  CodecID    : {[e.get('value') for e in cid] if cid else '—— 不存在'}")
    print(f"  Duration   : {[round(e.get('value'), 1) for e in dur if 'value' in e] if dur else '—— 不存在'}")
    if not tracks:
        print("  ⇒ 真实浏览器产物**确实没有 Tracks**（不是解析器找不到）")


if __name__ == '__main__':
    main()