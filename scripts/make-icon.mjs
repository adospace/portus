// Generates the app icon (build/icon.png, 1024×1024) from the Lucide "ship"
// glyph — the same mark shown in the title bar — so the whole app shares one
// identity. No image libraries: the SVG path is flattened to polylines and
// stroked with a signed-distance field (analytic anti-aliasing, round caps to
// match Lucide's stroke-linecap), then encoded to PNG via Node's zlib.
//
// Run with `npm run icon` after changing the glyph or colors. electron-builder
// reads build/icon.png as the packaging source (it derives .ico/.icns from it),
// and scripts/build.mjs copies it to dist/renderer for the live window icon.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- design tokens (kept in sync with renderer/styles.css) ------------------
const N = 1024; // output size (square)
const ACCENT = [0xf7, 0x81, 0x66]; // --color-accent (dark theme)
const INK = [0xff, 0xff, 0xff]; // ship color
const CORNER = N * 0.22; // rounded-square radius
const MARGIN = N * 0.2; // padding around the 24-unit glyph
const VIEW = 24; // Lucide viewBox

// The Lucide "ship" body (stroke-width 2, round caps/joins).
const PATHS = [
  'M12 10.189V14m0-12v3m7 8V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6',
  'M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76',
  'M2 21c.6.5 1.2 1 2.5 1c2.5 0 2.5-2 5-2c1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2c1.3 0 1.9.5 2.5 1',
];

// --- SVG path → flattened polylines (viewBox units) -------------------------
function parsePath(d) {
  const tokens = [];
  const re = /([MmLlHhVvCcSsAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let m;
  while ((m = re.exec(d))) tokens.push(m[1] ?? m[2]);

  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const flag = () => parseFloat(tokens[i++]); // arc flags are single 0/1 values

  const subpaths = [];
  let pts = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = '';
  let prevCtrl = null; // last cubic control point, for S/s reflection

  const moveTo = (x, y) => {
    if (pts.length > 1) subpaths.push(pts);
    pts = [[x, y]];
    cx = sx = x;
    cy = sy = y;
  };
  const lineTo = (x, y) => {
    pts.push([x, y]);
    cx = x;
    cy = y;
  };
  const cubic = (x1, y1, x2, y2, x, y) => {
    const steps = 24;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const px = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x;
      const py = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y;
      pts.push([px, py]);
    }
    prevCtrl = [x2, y2];
    cx = x;
    cy = y;
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const C = cmd.toUpperCase();

    if (C === 'M') {
      moveTo(num() + ox, num() + oy);
      cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit line-tos
    } else if (C === 'L') {
      lineTo(num() + ox, num() + oy);
    } else if (C === 'H') {
      lineTo(num() + ox, cy);
    } else if (C === 'V') {
      lineTo(cx, num() + oy);
    } else if (C === 'C') {
      cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
    } else if (C === 'S') {
      const rx = prevCtrl ? 2 * cx - prevCtrl[0] : cx;
      const ry = prevCtrl ? 2 * cy - prevCtrl[1] : cy;
      cubic(rx, ry, num() + ox, num() + oy, num() + ox, num() + oy);
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const rot = (num() * Math.PI) / 180;
      const large = flag();
      const sweep = flag();
      const x = num() + ox;
      const y = num() + oy;
      arcTo(rx, ry, rot, large, sweep, x, y);
    } else if (C === 'Z') {
      lineTo(sx, sy);
    }
    if (C !== 'C' && C !== 'S') prevCtrl = null;
  }
  if (pts.length > 1) subpaths.push(pts);
  return subpaths;

  // Endpoint-parameterised arc → center form, then sample (SVG impl notes).
  function arcTo(rx, ry, phi, large, sweep, x, y) {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return lineTo(x, y);
    const dx = (cx - x) / 2;
    const dy = (cy - y) / 2;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const x1 = cosP * dx + sinP * dy;
    const y1 = -sinP * dx + cosP * dy;
    let rxs = rx * rx;
    let rys = ry * ry;
    const lambda = (x1 * x1) / rxs + (y1 * y1) / rys;
    if (lambda > 1) {
      const s = Math.sqrt(lambda);
      rx *= s;
      ry *= s;
      rxs = rx * rx;
      rys = ry * ry;
    }
    const sign = large === sweep ? -1 : 1;
    const num = rxs * rys - rxs * y1 * y1 - rys * x1 * x1;
    const den = rxs * y1 * y1 + rys * x1 * x1;
    const co = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = (co * rx * y1) / ry;
    const cyp = (-co * ry * x1) / rx;
    const centerX = cosP * cxp - sinP * cyp + (cx + x) / 2;
    const centerY = sinP * cxp + cosP * cyp + (cy + y) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const theta = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let delta = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil((Math.abs(delta) / Math.PI) * 24));
    for (let s = 1; s <= steps; s++) {
      const t = theta + (delta * s) / steps;
      const ex = centerX + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP;
      const ey = centerY + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP;
      pts.push([ex, ey]);
    }
    cx = x;
    cy = y;
  }
}

// --- rasterise --------------------------------------------------------------
const scale = (N - 2 * MARGIN) / VIEW;
const toCanvas = (p) => [MARGIN + p[0] * scale, MARGIN + p[1] * scale];

// Flatten all paths into canvas-space segments.
const segments = [];
for (const d of PATHS) {
  for (const sp of parsePath(d)) {
    const cp = sp.map(toCanvas);
    for (let k = 0; k + 1 < cp.length; k++) segments.push([cp[k], cp[k + 1]]);
  }
}

const halfW = scale * 1.0; // stroke-width 2 → half-width 1 viewBox unit
const cov = new Float32Array(N * N); // ship coverage [0..1]

function distToSeg(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (a[0] + t * vx);
  const dy = py - (a[1] + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

// Stamp each capsule into its bounding box only (round caps/joins via min-dist).
for (const [a, b] of segments) {
  const pad = halfW + 1.5;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - pad));
  const maxX = Math.min(N - 1, Math.ceil(Math.max(a[0], b[0]) + pad));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - pad));
  const maxY = Math.min(N - 1, Math.ceil(Math.max(a[1], b[1]) + pad));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = distToSeg(x + 0.5, y + 0.5, a, b);
      const c = Math.min(1, Math.max(0, halfW + 0.5 - d)); // analytic AA edge
      if (c > 0) {
        const idx = y * N + x;
        if (c > cov[idx]) cov[idx] = c;
      }
    }
  }
}

// Rounded-square background SDF (negative inside).
function bgCoverage(x, y) {
  const hx = N / 2;
  const hy = N / 2;
  const qx = Math.abs(x - hx) - (hx - CORNER);
  const qy = Math.abs(y - hy) - (hy - CORNER);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - CORNER;
  return Math.min(1, Math.max(0, 0.5 - d)); // AA edge
}

// --- compose RGBA -----------------------------------------------------------
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const bg = bgCoverage(x + 0.5, y + 0.5);
    const ship = cov[i];
    // Base: accent over transparent; then white ship over accent.
    const r = ACCENT[0] * (1 - ship) + INK[0] * ship;
    const g = ACCENT[1] * (1 - ship) + INK[1] * ship;
    const b = ACCENT[2] * (1 - ship) + INK[2] * ship;
    const a = bg; // ship only ever sits on top of background
    const o = i * 4;
    rgba[o] = Math.round(r);
    rgba[o + 1] = Math.round(g);
    rgba[o + 2] = Math.round(b);
    rgba[o + 3] = Math.round(a * 255);
  }
}

// --- encode PNG -------------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// raw scanlines with filter byte 0
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(ROOT, 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[icon] wrote ${out} (${N}×${N}, ${(png.length / 1024).toFixed(1)} KB)`);
