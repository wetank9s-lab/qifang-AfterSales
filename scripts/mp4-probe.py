"""
独立 MP4/ISO-BMFF 探针（P11-4 · 诊断 iOS Safari 录音时长读不出的真因）

用途：**不猜**——把 mp4 的 box 树打出来，看时长字段到底在哪、值是多少。
重点看三处（MP4 时长的三个来源）：
    · moov > mvhd > duration          （普通 MP4 的总时长）
    · moov > mvex > mehd > fragment_duration （**分片 MP4（fMP4）的总时长**）
    · moov > trak > mdia > mdhd > duration/timescale （轨道时长）

用法：python scripts/mp4-probe.py <file>
"""
import struct
import sys

CONTAINERS = {
    b'moov', b'trak', b'mdia', b'minf', b'stbl', b'mvex', b'edts', b'dinf', b'udta',
    b'moof', b'traf', b'mfra', b'skip', b'strk', b'stsd', b'wave',
}
# 会用到的大端整数字段
UINT32_BOXES = {b'mvhd', b'mdhd', b'mehd', b'tfdt', b'elst', b'tkhd'}


def read_box_header(buf, pos):
    if pos + 8 > len(buf):
        return None
    size = struct.unpack('>I', buf[pos:pos + 4])[0]
    btype = buf[pos + 4:pos + 8]
    header = 8
    if size == 1:  # 64 位扩展尺寸
        if pos + 16 > len(buf):
            return None
        size = struct.unpack('>Q', buf[pos + 8:pos + 16])[0]
        header = 16
    elif size == 0:  # 到文件末尾
        size = len(buf) - pos
    if size < header:
        return None
    return {'type': btype, 'size': size, 'header': header, 'start': pos, 'payload': pos + header}


def walk(buf, start, end, depth, max_depth, out, path=''):
    pos = start
    while pos + 8 <= end:
        h = read_box_header(buf, pos)
        if not h:
            return
        payload_end = pos + h['size']
        if payload_end > end:
            payload_end = end
        out.append({'depth': depth, 'type': h['type'], 'offset': pos, 'size': h['size'], 'path': path})
        if h['type'] in CONTAINERS and depth < max_depth:
            walk(buf, h['payload'], payload_end, depth + 1, max_depth, out, path + '/' + h['type'].decode('latin1'))
        else:
            data = buf[h['payload']:payload_end]
            if h['type'] == b'mvhd' and len(data) >= 20:
                version = data[0]
                if version == 1 and len(data) >= 32:
                    timescale = struct.unpack('>I', data[20:24])[0]
                    duration = struct.unpack('>Q', data[24:32])[0]
                else:
                    timescale = struct.unpack('>I', data[12:16])[0]
                    duration = struct.unpack('>I', data[16:20])[0]
                out[-1]['detail'] = f'v{version} timescale={timescale} duration={duration}'
                out[-1]['timescale'] = timescale
                out[-1]['duration'] = duration
            elif h['type'] == b'mehd' and len(data) >= 8:
                version = data[0]
                if version == 1 and len(data) >= 12:
                    dur = struct.unpack('>Q', data[4:12])[0]
                else:
                    dur = struct.unpack('>I', data[4:8])[0]
                out[-1]['detail'] = f'v{version} fragment_duration={dur}'
                out[-1]['duration'] = dur
            elif h['type'] == b'mdhd' and len(data) >= 20:
                version = data[0]
                if version == 1 and len(data) >= 32:
                    timescale = struct.unpack('>I', data[20:24])[0]
                    duration = struct.unpack('>Q', data[24:32])[0]
                else:
                    timescale = struct.unpack('>I', data[12:16])[0]
                    duration = struct.unpack('>I', data[16:20])[0]
                out[-1]['detail'] = f'v{version} timescale={timescale} duration={duration}'
                out[-1]['timescale'] = timescale
                out[-1]['duration'] = duration
            elif h['type'] == b'hdlr' and len(data) >= 12:
                out[-1]['detail'] = f'handler={data[8:12].decode("latin1", "replace")}'
        pos = payload_end


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, 'rb') as f:
        buf = f.read()

    print(f'文件: {path}')
    print(f'大小: {len(buf)} 字节')
    print(f'magic: {buf[4:8] if buf[4:8] == b"ftyp" else buf[:8].hex()}')
    print('-' * 72)

    boxes = []
    walk(buf, 0, len(buf), 0, 8, boxes)
    for b in boxes:
        ind = '  ' * b['depth']
        detail = f"  {b['detail']}" if b.get('detail') else ''
        print(f"{ind}{b['type'].decode('latin1')} (offset={b['offset']}, size={b['size']}){detail}")

    print('-' * 72)
    print('时长来源（**按规范解析 box 树**，不是字节搜索）：')
    mvhd = [b for b in boxes if b['type'] == b'mvhd']
    mehd = [b for b in boxes if b['type'] == b'mehd']
    mdhd = [b for b in boxes if b['type'] == b'mdhd']
    hdlr = [b for b in boxes if b['type'] == b'hdlr']
    moof = [b for b in boxes if b['type'] == b'moof']

    for label, arr in (('mvhd（总时长）', mvhd), ('mehd（分片总时长）', mehd), ('mdhd（轨道时长）', mdhd)):
        if not arr:
            print(f'  {label}: 不存在')
            continue
        for b in arr:
            print(f"  {label}: {b.get('detail')}  @{b['offset']}")
    print(f"  hdlr（轨道类型）: {[b.get('detail') for b in hdlr] or '不存在'}")
    print(f"  moof（分片）数量: {len(moof)}")
    print('-' * 72)

    # 结论
    mvhd_ms = None
    if mvhd and mvhd[0].get('timescale'):
        mvhd_ms = mvhd[0]['duration'] / mvhd[0]['timescale'] * 1000
    print(f"  ⇒ mvhd 时长: {mvhd_ms:.1f} ms" if mvhd_ms is not None else '  ⇒ mvhd 时长: 读不出')
    print('  ⇒ **这是分片 MP4（fMP4）**：mvhd.duration 为 0，真实时长在 mehd / 分片里' if (mvhd and mvhd[0].get('duration') == 0) else '')


if __name__ == '__main__':
    main()