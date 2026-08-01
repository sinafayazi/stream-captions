// Generates the extension/store icons as PNGs with no image dependencies: a
// dark rounded tile with two caption bars in Kick green — reads as "subtitles"
// even at 16px. Shapes are supersampled 4x4 per pixel for antialiasing, and the
// tile corners are transparent (RGBA), so it sits cleanly on any toolbar.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x16, 0x15, 0x1a]; // tile
const FG = [0x53, 0xfc, 0x18]; // caption bars
const SS = 4;                  // supersample factor per axis

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Point-in-rounded-rectangle: clamp the point to the corner-centre inset box,
// then it's just a radius test against that clamped centre.
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function png(size) {
  // Layout, all as fractions of the icon so every size stays identical.
  const tileR = size * 0.22;
  const pad = size * 0.19;
  const innerW = size - pad * 2;
  const barH = size * 0.135;
  const gap = size * 0.10;
  const y0 = (size - (barH * 2 + gap)) / 2;
  const bars = [
    [pad, y0, innerW, barH],
    [pad + (innerW - innerW * 0.6) / 2, y0 + barH + gap, innerW * 0.6, barH],
  ];

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let inside = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRoundRect(fx, fy, 0, 0, size, size, tileR)) continue;
          const onBar = bars.some(([bx, by, bw, bh]) => inRoundRect(fx, fy, bx, by, bw, bh, bh / 2));
          const c = onBar ? FG : BG;
          sr += c[0];
          sg += c[1];
          sb += c[2];
          inside++;
        }
      }
      const total = SS * SS;
      if (inside === 0) {
        raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0;
      } else {
        // Average only the covered samples, so edges don't fringe toward black.
        raw[p++] = Math.round(sr / inside);
        raw[p++] = Math.round(sg / inside);
        raw[p++] = Math.round(sb / inside);
        raw[p++] = Math.round((inside / total) * 255);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dir = new URL('../icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(new URL(`icon${s}.png`, dir), png(s));
console.log('Generated icons/icon{16,48,128}.png');
