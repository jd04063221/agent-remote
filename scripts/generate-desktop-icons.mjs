#!/usr/bin/env node
/**
 * Deterministic zero-dependency generator for agent-remote desktop & tray icons:
 * - apps/desktop/assets/icon.png                 (512x512 color PNG — Linux app & window icon)
 * - apps/desktop/assets/icon.ico                 (16/24/32/48 DIB + 256 PNG — Windows app/installer icon)
 * - apps/desktop/assets/icon.icns                (16/32/64/128/256/512 PNG chunks — macOS app icon)
 * - apps/desktop/assets/tray-icon.png            (32x32 color PNG — Linux tray icon)
 * - apps/desktop/assets/tray-icon.ico            (16/24/32/48 DIB — Windows multi-DPI tray icon)
 * - apps/desktop/assets/tray-icon-Template.png   (18x18 monochrome alpha — macOS menu bar @1x)
 * - apps/desktop/assets/tray-icon-Template@2x.png (36x36 monochrome alpha — macOS menu bar @2x)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "apps", "desktop", "assets");

// ---- PNG Encoder ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO Encoder (32-bit BGRA DIB for <256, PNG for 256) ----
function encodeIcoDib(width, height, rgba) {
  const xorSize = width * height * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const andSize = andStride * height;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  const xorBuf = Buffer.alloc(xorSize);
  const andBuf = Buffer.alloc(andSize);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // bottom-up
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * 4;
      const di = (y * width + x) * 4;
      const r = rgba[si];
      const g = rgba[si + 1];
      const b = rgba[si + 2];
      const a = rgba[si + 3];
      xorBuf[di] = b;
      xorBuf[di + 1] = g;
      xorBuf[di + 2] = r;
      xorBuf[di + 3] = a;
      if (a < 128) {
        const byteIdx = y * andStride + (x >> 3);
        andBuf[byteIdx] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, xorBuf, andBuf]);
}

function encodeIco(frames) {
  const count = frames.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // ICO
  dir.writeUInt16LE(count, 4);

  const payloads = frames.map((f) =>
    f.width >= 256 ? f.png : encodeIcoDib(f.width, f.height, f.rgba),
  );

  const entries = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const f = frames[i];
    const data = payloads[i];
    const base = i * 16;
    entries[base] = f.width >= 256 ? 0 : f.width;
    entries[base + 1] = f.height >= 256 ? 0 : f.height;
    entries[base + 2] = 0; // palette count
    entries[base + 3] = 0;
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bpp
    entries.writeUInt32LE(data.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += data.length;
  }

  return Buffer.concat([dir, entries, ...payloads]);
}

// ---- ICNS Encoder (PNG-backed chunks) ----
function encodeIcns(chunks) {
  const parts = chunks.map(({ type, png }) => {
    const hdr = Buffer.alloc(8);
    hdr.write(type, 0, 4, "ascii");
    hdr.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([hdr, png]);
  });
  const totalLen = 8 + parts.reduce((acc, p) => acc + p.length, 0);
  const fileHdr = Buffer.alloc(8);
  fileHdr.write("icns", 0, 4, "ascii");
  fileHdr.writeUInt32BE(totalLen, 4);
  return Buffer.concat([fileHdr, ...parts]);
}

// ---- Signed Distance & Anti-Aliased Supersampled Renderer ----
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    r
  );
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function alphaOver(dst, sr, sg, sb, sa) {
  const outA = sa + dst[3] * (1 - sa);
  if (outA <= 1e-6) return;
  dst[0] = (sr * sa + dst[0] * dst[3] * (1 - sa)) / outA;
  dst[1] = (sg * sa + dst[1] * dst[3] * (1 - sa)) / outA;
  dst[2] = (sb * sa + dst[2] * dst[3] * (1 - sa)) / outA;
  dst[3] = outA;
}

/**
 * Color icon: dark rounded-square with cyan border and a dual-node
 * "remote brain (cyan) <-> local hands (emerald)" bridge emblem.
 */
function sampleColorIcon(u, v) {
  // u, v in [-1, 1]
  const out = [0, 0, 0, 0];

  // Outer rounded square background
  const bgDist = sdRoundedBox(u, v, 0.9, 0.9, 0.3);
  if (bgDist <= 0) {
    const t = clamp01((u + v + 1.8) / 3.6);
    const bgR = lerp(13, 24, t);
    const bgG = lerp(22, 38, t);
    const bgB = lerp(40, 62, t);
    alphaOver(out, bgR, bgG, bgB, 1);

    // Subtle glowing radial highlight toward remote node
    const glowD = Math.hypot(u - 0.34, v + 0.34);
    const glow = clamp01(1 - glowD / 1.15) * 0.28;
    alphaOver(out, 56, 189, 248, glow);
  }

  // Crisp cyan outer rim inside rounded square
  const rimDist = Math.abs(bgDist + 0.045) - 0.045;
  if (rimDist <= 0 && bgDist <= 0.01) {
    const rimT = clamp01((u - v + 1.5) / 3.0);
    alphaOver(
      out,
      lerp(52, 56, rimT),
      lerp(211, 189, rimT),
      lerp(153, 248, rimT),
      0.85,
    );
  }

  // Dual-node coordinates: Remote Brain (top-right) <-> Local Hands (bottom-left)
  const rx = 0.34;
  const ry = -0.34;
  const lx = -0.34;
  const ly = 0.34;

  // Connecting signal bridge bar
  const segD = sdSegment(u, v, lx, ly, rx, ry);
  if (segD <= 0.115) {
    const bt = clamp01((u - v + 1.0) / 2.0);
    alphaOver(
      out,
      lerp(52, 56, bt),
      lerp(211, 189, bt),
      lerp(153, 248, bt),
      0.95,
    );
  }

  // Subtle orbital arc accent (upper-left & lower-right)
  const ringR = Math.hypot(u, v);
  if (Math.abs(ringR - 0.56) <= 0.042) {
    // Only draw the two off-diagonal arcs (top-left and bottom-right)
    const prod = u * v;
    if (prod > 0.04) {
      alphaOver(out, 148, 163, 184, 0.55);
    }
  }

  // Remote Brain Node (top-right, bright sky-cyan with luminous core)
  const rd = Math.hypot(u - rx, v - ry);
  if (rd <= 0.285) {
    alphaOver(out, 56, 189, 248, 1);
  }
  if (rd <= 0.135) {
    alphaOver(out, 232, 248, 255, 1);
  }

  // Local Hands Node (bottom-left, vibrant emerald with luminous core)
  const ld = Math.hypot(u - lx, v - ly);
  if (ld <= 0.285) {
    alphaOver(out, 52, 211, 153, 1);
  }
  if (ld <= 0.135) {
    alphaOver(out, 226, 253, 240, 1);
  }

  return out;
}

/**
 * macOS Menu Bar Template Icon: pure black (RGB 0,0,0) with alpha only.
 * macOS automatically tints it light/dark based on the menu bar appearance.
 */
function sampleTemplateIcon(u, v) {
  let alpha = 0;

  const rx = 0.36;
  const ry = -0.36;
  const lx = -0.36;
  const ly = 0.36;

  // Connecting bridge
  const segD = sdSegment(u, v, lx, ly, rx, ry);
  if (segD <= 0.12) {
    alpha = 1;
  }

  // Off-diagonal orbital signal arcs
  const ringR = Math.hypot(u, v);
  if (Math.abs(ringR - 0.62) <= 0.085 && u * v > 0.04) {
    alpha = 1;
  }

  // Remote node (hollow ring — distinguishes remote cloud/brain)
  const rd = Math.hypot(u - rx, v - ry);
  if (rd <= 0.33 && rd >= 0.13) {
    alpha = 1;
  }

  // Local node (solid circle — distinguishes local execution node)
  const ld = Math.hypot(u - lx, v - ly);
  if (ld <= 0.31) {
    alpha = 1;
  }

  // Cut out inner hole of remote node cleanly even over the bridge end
  if (rd < 0.13) {
    alpha = 0;
  }

  return [0, 0, 0, alpha];
}

function renderIcon(size, sampler, samplesPerAxis = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const totalSamples = samplesPerAxis * samplesPerAxis;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      for (let sy = 0; sy < samplesPerAxis; sy++) {
        for (let sx = 0; sx < samplesPerAxis; sx++) {
          const px = x + (sx + 0.5) / samplesPerAxis;
          const py = y + (sy + 0.5) / samplesPerAxis;
          const u = (px / size) * 2 - 1;
          const v = (py / size) * 2 - 1;
          const [r, g, b, a] = sampler(u, v);
          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
        }
      }
      const avgA = accA / totalSamples;
      const idx = (y * size + x) * 4;
      if (avgA > 1e-6) {
        rgba[idx] = Math.round(clamp01(accR / accA / 255) * 255);
        rgba[idx + 1] = Math.round(clamp01(accG / accA / 255) * 255);
        rgba[idx + 2] = Math.round(clamp01(accB / accA / 255) * 255);
        rgba[idx + 3] = Math.round(clamp01(avgA) * 255);
      }
    }
  }
  return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function makeColorFrame(size) {
  const samples = size <= 48 ? 6 : size <= 128 ? 4 : 2;
  const rgba = renderIcon(size, sampleColorIcon, samples);
  const png = encodePng(size, size, rgba);
  return { width: size, height: size, rgba, png };
}

const f16 = makeColorFrame(16);
const f24 = makeColorFrame(24);
const f32 = makeColorFrame(32);
const f48 = makeColorFrame(48);
const f64 = makeColorFrame(64);
const f128 = makeColorFrame(128);
const f256 = makeColorFrame(256);
const f512 = makeColorFrame(512);

const tpl18 = encodePng(18, 18, renderIcon(18, sampleTemplateIcon, 6));
const tpl36 = encodePng(36, 36, renderIcon(36, sampleTemplateIcon, 6));

const outputs = [
  ["icon.png", f512.png],
  ["icon.ico", encodeIco([f16, f24, f32, f48, f256])],
  [
    "icon.icns",
    encodeIcns([
      { type: "icp4", png: f16.png },
      { type: "icp5", png: f32.png },
      { type: "icp6", png: f64.png },
      { type: "ic07", png: f128.png },
      { type: "ic08", png: f256.png },
      { type: "ic09", png: f512.png },
    ]),
  ],
  ["tray-icon.png", f32.png],
  ["tray-icon.ico", encodeIco([f16, f24, f32, f48])],
  ["tray-icon-Template.png", tpl18],
  ["tray-icon-Template@2x.png", tpl36],
];

for (const [name, buf] of outputs) {
  const dest = path.join(OUT_DIR, name);
  fs.writeFileSync(dest, buf);
  console.log(`Generated ${path.relative(ROOT, dest)} (${buf.length} bytes)`);
}
