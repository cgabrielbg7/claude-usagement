// Generates icon.ico — dark rounded square + gradient arc (blue → purple).
// Pure Node built-ins, no npm deps.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

function makePng(size) {
  const w = size, h = size;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0; // filter=None, fully transparent

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const off = y * (1 + w * 4) + 1 + x * 4;
    raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a;
  }
  function getPixel(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return [0, 0, 0, 0];
    const off = y * (1 + w * 4) + 1 + x * 4;
    return [raw[off], raw[off+1], raw[off+2], raw[off+3]];
  }
  function blend(x, y, r, g, b, a) {
    if (a === 0) return;
    const [dr, dg, db, da] = getPixel(x, y);
    const sa = a / 255, da2 = (da / 255) * (1 - sa), oa = sa + da2;
    if (oa < 0.001) return;
    setPixel(x, y,
      Math.round((r * sa + dr * da2) / oa),
      Math.round((g * sa + dg * da2) / oa),
      Math.round((b * sa + db * da2) / oa),
      Math.round(oa * 255));
  }
  function lerp(a, b, t) { return Math.round(a + (b - a) * Math.max(0, Math.min(1, t))); }

  const cx = w / 2, cy = h / 2;
  const AA = 0.8;

  // ── 1. Dark rounded-square background ──────────────────────────────────────
  const BG       = [0x0e, 0x0e, 0x14];
  const sqR      = w * 0.46;   // half-size of square
  const cornerR  = w * 0.20;   // corner radius (~iOS-style)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - cx + 0.5);
      const dy = Math.abs(y - cy + 0.5);
      const qx = Math.max(dx - (sqR - cornerR), 0);
      const qy = Math.max(dy - (sqR - cornerR), 0);
      const sdf = Math.sqrt(qx * qx + qy * qy) - cornerR; // <0 inside, >0 outside
      const a = sdf < -AA ? 255 : sdf > AA ? 0 :
        Math.round(255 * (-sdf + AA) / (2 * AA));
      if (a > 0) setPixel(x, y, BG[0], BG[1], BG[2], a);
    }
  }

  // ── 2. Gradient arc (blue → purple, 300° span, gap at upper-right) ─────────
  const arcR   = w * 0.30;    // ring center radius
  const strokeW = w * 0.115;  // ring thickness

  // Gap: -60° to 0° in atan2 coords (0=right, +90=down)
  const GAP_S  = -60;         // gap start angle (deg)
  const GAP_E  =   0;         // gap end angle   (deg)
  const ARC_SP = 360 - (GAP_E - GAP_S);  // 300° of arc

  const COL_A = [77, 157, 224];   // #4d9de0 blue  (at GAP_E / right side)
  const COL_B = [167, 139, 250];  // #a78bfa purple (at GAP_S / upper-right)

  function arcT(deg) {
    let a = deg - GAP_E;
    if (a < 0) a += 360;
    return a / ARC_SP;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const fc   = dist - arcR;
      if (fc < -(strokeW / 2 + AA) || fc > (strokeW / 2 + AA)) continue;

      const deg = Math.atan2(dy, dx) * 180 / Math.PI;
      if (deg >= GAP_S && deg <= GAP_E) continue; // inside gap

      const edgeA =
        fc < -(strokeW / 2) ? (fc + strokeW / 2 + AA) / AA :
        fc >  (strokeW / 2) ? (strokeW / 2 + AA - fc) / AA : 1;
      const a = Math.round(255 * Math.min(1, Math.max(0, edgeA)));
      if (a === 0) continue;

      const t = arcT(deg);
      blend(x, y,
        lerp(COL_A[0], COL_B[0], t),
        lerp(COL_A[1], COL_B[1], t),
        lerp(COL_A[2], COL_B[2], t), a);
    }
  }

  // ── 3. Filled cap dot at arc end (purple end, upper-right gap edge) ─────────
  const capAng = GAP_S * Math.PI / 180;
  const capX   = cx + arcR * Math.cos(capAng);
  const capY   = cy + arcR * Math.sin(capAng);
  const capR   = strokeW / 2 + w * 0.012;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - capX + 0.5, dy = y - capY + 0.5;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d > capR + AA) continue;
      const a = d < capR - AA ? 255 : Math.round(255 * (capR + AA - d) / (2 * AA));
      if (a > 0) blend(x, y, COL_B[0], COL_B[1], COL_B[2], a);
    }
  }

  // ── PNG encoder ─────────────────────────────────────────────────────────────
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t   = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([t, data]);
    const crc  = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }

  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO writer ────────────────────────────────────────────────────────────────
function makeIco(pngs) {
  const count = pngs.length;
  const dirSize = 6 + count * 16;
  let offset = dirSize;

  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);

  const images = [];
  for (let i = 0; i < count; i++) {
    const { size, data } = pngs[i];
    const entry = dir.slice(6 + i * 16, 6 + (i + 1) * 16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1,  4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    images.push(data);
  }

  return Buffer.concat([dir, ...images]);
}

const sizes = [256, 64, 32, 16];
const pngs  = sizes.map(s => ({ size: s, data: makePng(s) }));
const ico   = makeIco(pngs);

const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`Written ${ico.length} bytes → ${out}`);
