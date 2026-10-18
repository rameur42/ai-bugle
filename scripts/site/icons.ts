// scripts/site/icons.ts — draws the PWA icons (radar arcs on navy) as PNGs, zero deps.
// Run once after changing the design; the PNGs are committed.  node scripts/site/icons.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = fileURLToPath(new URL("../../site/icons/", import.meta.url));
const BG = [15, 23, 42]; // #0f172a
const FG = [56, 189, 248]; // #38bdf8

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type: string, data: Uint8Array): Buffer {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(td.length + 8);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(crc32(td), td.length + 4);
  return out;
}

// Coverage of the glyph at (x, y) in unit space centred on 0: three arcs opening up-right + a dot.
// `scale` sizes the glyph; the maskable icon uses a smaller one to stay inside the 80 % safe zone.
function ink(x: number, y: number, scale: number): number {
  const cx = -0.26 * scale;
  const cy = 0.26 * scale;
  const dx = x - cx;
  const dy = cy - y; // up is positive
  const r = Math.hypot(dx, dy);
  if (r < 0.085 * scale) return 1;
  const ang = Math.atan2(dy, dx);
  if (ang < 0.05 || ang > Math.PI / 2 - 0.05) return 0;
  for (const R of [0.26, 0.43, 0.6]) if (Math.abs(r - R * scale) < 0.045 * scale) return 1;
  return 0;
}

function icon(size: number, scale: number): Buffer {
  const SS = 4; // supersampling for anti-aliasing
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++)
          a += ink(((px + (sx + 0.5) / SS) / size) * 2 - 1, ((py + (sy + 0.5) / SS) / size) * 2 - 1, scale);
      a /= SS * SS;
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] + (FG[c] - BG[c]) * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

for (const [name, size, scale] of [
  ["icon-192.png", 192, 1.25],
  ["icon-512.png", 512, 1.25],
  ["maskable-512.png", 512, 0.95],
  ["apple-touch-icon.png", 180, 1.1],
] as const) {
  writeFileSync(OUT + name, icon(size, scale));
  console.log(`wrote site/icons/${name}`);
}
