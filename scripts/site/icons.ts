// scripts/site/icons.ts — draws the PWA icons (the bugle logo, accent on ink) as PNGs, zero deps.
// Run once after changing the design; the PNGs are committed.  node scripts/site/icons.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = fileURLToPath(new URL("../../site/icons/", import.meta.url));
const BG = [17, 18, 20]; // #111214
const FG = [232, 68, 26]; // #e8441a

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

// The site's logo glyph, in its own 24×24 stroke units (path "M3 10v4h3l7 5V5L6 10H3z" + an arc), stroke 2.4.
const HALF_W = 1.2;
const HORN: [number, number][] = [[3, 10], [3, 14], [6, 14], [13, 19], [13, 5], [6, 10]];
function segDist(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
// Coverage at (x, y) in unit space centred on 0. `scale` = share of the icon the 24-unit box spans;
// the maskable icon uses a smaller one to stay inside the 80 % safe zone.
function ink(x: number, y: number, scale: number): number {
  const gx = 10.7 + (x * 12) / scale; // glyph's visual centre is x≈10.7
  const gy = 12 + (y * 12) / scale;
  for (let i = 0; i < HORN.length; i++) if (segDist(gx, gy, HORN[i], HORN[(i + 1) % HORN.length]) <= HALF_W) return 1;
  // Arc from (16.5, 8.5) to (16.5, 15.5), radius 5: centre (16.5 − √12.75, 12); round caps at the ends.
  const cx = 16.5 - Math.sqrt(12.75);
  if (gx >= 16.5 && Math.abs(Math.hypot(gx - cx, gy - 12) - 5) <= HALF_W) return 1;
  if (Math.hypot(gx - 16.5, gy - 8.5) <= HALF_W || Math.hypot(gx - 16.5, gy - 15.5) <= HALF_W) return 1;
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
  ["icon-192.png", 192, 0.62],
  ["icon-512.png", 512, 0.62],
  ["maskable-512.png", 512, 0.48],
  ["apple-touch-icon.png", 180, 0.58],
] as const) {
  writeFileSync(OUT + name, icon(size, scale));
  console.log(`wrote site/icons/${name}`);
}
