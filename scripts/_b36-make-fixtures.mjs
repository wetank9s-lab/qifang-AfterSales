/**
 * _b36-make-fixtures.mjs —— 生成 B-36 验证用的**真实图片字节**（一次性素材生成器）
 *
 * 为什么自己编码而不是找现成图：
 *   验证必须能**控制内容**（两张不同的图 → 指纹必须不同；同一张图 → 指纹必须相同）。
 *   找来的现成图无法保证这一点，而且"换图后文件名要变"这条判据
 *   **必须**用两张真的不同字节来证。
 *
 * 产出（写到 .tmp-media/b36-fixtures/）：
 *   banner-a.png     1280×360  纯色+色块   （合格的横幅）
 *   banner-b.png     1280×360  与 a 不同内容（验证指纹变化）
 *   banner-a-copy.png 与 banner-a.png **逐字节相同**（验证幂等复用）
 *   tiny.png           64×32    （过小 ⇒ 应被拒 422）
 *   active.svg                  （主动内容 ⇒ 应被拒 415）
 *   fake.jpg                    （声明 jpg 实为 HTML ⇒ 应被拒 415，靠 magic bytes）
 *   huge.png          5000×100  （超尺寸 ⇒ 应被拒 422）
 *
 * ⚠️ 本脚本只写 .tmp-media/（已被 .gitignore 覆盖），不碰 storage/。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve('.tmp-media/b36-fixtures');
fs.mkdirSync(OUT, { recursive: true });

/** CRC32（PNG chunk 校验） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 造一张真 PNG。`seed` 决定色块排布 —— 不同 seed ⇒ 不同字节 ⇒ 不同 sha256。
 */
function makePng(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行首字节是 filter type(0)，随后 width*3 字节 RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = rowStart + 1 + x * 3;
      // 三段色带 + 随 seed 偏移的条纹，保证肉眼可分且字节确定
      const band = Math.floor((x * 3 + seed * 37) / width);
      const stripe = (x + y + seed * 11) % 17 === 0 ? 40 : 0;
      raw[o] = (band === 0 ? 220 : band === 1 ? 30 : 90) + stripe;
      raw[o + 1] = (band === 0 ? 60 : band === 1 ? 150 : 90) + stripe;
      raw[o + 2] = (band === 0 ? 50 : band === 1 ? 220 : 160) + stripe;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const writer = (name, buf) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  return p;
};

const a = makePng(1280, 360, 0);
const b = makePng(1280, 360, 999);
const tiny = makePng(64, 32, 5);
const huge = makePng(5000, 100, 7);

const files = {
  'banner-a.png': writer('banner-a.png', a),
  'banner-b.png': writer('banner-b.png', b),
  'banner-a-copy.png': writer('banner-a-copy.png', Buffer.from(a)), // 逐字节相同
  'tiny.png': writer('tiny.png', tiny),
  'huge.png': writer('huge.png', huge),
  // 主动内容：SVG（可内嵌 script）。声明成 image/svg+xml 也必须被拒。
  'active.svg': writer(
    'active.svg',
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="360"><script>alert(1)</script><rect width="1280" height="360" fill="#c00"/></svg>`,
      'utf8',
    ),
  ),
  // 伪装：扩展名 .jpg、Content-Type 声明 image/jpeg，但内容是 HTML。
  // 只有 magic bytes 判定能拦住它 —— 这正是本条用例要证的。
  'fake.jpg': writer(
    'fake.jpg',
    Buffer.from('<!doctype html><html><body><script>alert(2)</script></body></html>', 'utf8'),
  ),
};

console.log('已生成 B-36 验证素材：');
for (const [name, p] of Object.entries(files)) {
  const size = fs.statSync(p).size;
  console.log(`  ${name.padEnd(20)} ${String(size).padStart(8)} B  ${p}`);
}
