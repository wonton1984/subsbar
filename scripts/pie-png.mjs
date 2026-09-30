// subs-bar - 零依赖饼图 PNG 生成器（node:zlib + 手写 PNG chunks）。
//
// 输出 18x18 RGBA（@1x，≤22px 见高的菜单栏图标推荐尺寸）。
// anti-aliasing：每像素 4x4 超采样，边缘平滑。
// 以 base64 字符串直接内联 PNG（无需 header= 与 data URI 前缀）。

import { deflateSync } from "zlib";

// ---- CRC32（PNG chunk 校验用） ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 生成菜单栏圆饼 PNG（RGBA）。remaining = 0..100，null = 无数据（灰）。
 * 返回 { png: Buffer, base64: string }。
 */
export function piePng(remaining, { size = 18, background = [0, 0, 0, 0] } = {}) {
  const radius = size / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const color = tierColor(remaining);

  // 每像素 4x4 超采样抗锯齿
  const SUB = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB;
          const py = y + (sy + 0.5) / SUB;
          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > radius) continue; // 外圈透明白
          // 饼图填充：从 -90°（顶部）顺时针扫描 remaining% 圆弧
          let angle = Math.atan2(dy, dx); // -π..π，右为 0，下为 +π/2
          angle = angle + Math.PI / 2; // 顶部变成 0
          if (angle < 0) angle += 2 * Math.PI;
          if (remaining === null || angle / (2 * Math.PI) <= remaining / 100) coverage++;
        }
      }
      const a = Math.round((coverage / (SUB * SUB)) * 255);
      const offset = 1 + x * 4;
      row[offset] = color.rgb[0];
      row[offset + 1] = color.rgb[1];
      row[offset + 2] = color.rgb[2];
      row[offset + 3] = a;
    }
    rows.push(row);
  }

  // 保护 unused 变量 background（保持参数向后兼容）
  void background;

  const raw = Buffer.concat(rows);
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { png, base64: png.toString("base64") };
}

/** 菜单栏首行 IMAGE= 参数值。 */
export function piePngBase64(remaining, options) {
  return piePng(remaining, options).base64;
}

// ---- 余量分档色 ----
export const GREEN = { rgb: [52, 199, 89], linuxHex: "#34c759" }; // iOS green
export const ORANGE = { rgb: [255, 159, 10], linuxHex: "#ff9f0a" }; // iOS orange
export const RED = { rgb: [255, 59, 48], linuxHex: "#ff3b30" }; // iOS red
export const GRAY = { rgb: [142, 142, 147], linuxHex: "#8e8e93" }; // iOS gray

export function tierColor(remaining) {
  if (remaining === null) return GRAY;
  if (remaining > 50) return GREEN;
  if (remaining > 20) return ORANGE;
  return RED;
}
