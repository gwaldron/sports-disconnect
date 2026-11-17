// Draws the app's logo (baseball-gear.png, at the repo root) from the NearlyWorks one (nearlyworks.png):
// the same broken gear, with a white face drawn as a baseball (red seams and stitches) in place of
// the N and W. Then makes the site's logos and icons.
//   node scripts/baseball-gear-logo.cjs        (sharp comes with wrangler)
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const sharp = require(path.join(ROOT, 'node_modules/sharp'));
const SRC = path.join(ROOT, 'nearlyworks.png');

const CX = 455, CY = 516; // a point inside the gear's hole
const RED = '#d22630';    // baseball stitching

(async () => {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  // Drop the letters: anything cyan or orange (the gear is navy, about 0,80,128).
  for (let i = 0; i < data.length; i += C) {
    const [r, g] = [data[i], data[i + 1]];
    if (g > 140 || r > 150) data[i + 3] = 0;
  }
  const gearOnly = await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer();

  // The hole: everything not gear, reachable from the centre. Its bounds size the ball's seams.
  const navy = (p) => data[p * C + 3] > 128;
  const hole = new Uint8Array(W * H);
  const stack = [CX + CY * W]; hole[stack[0]] = 1;
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p - x) / W;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && !hole[q] && !navy(q)) { hole[q] = 1; stack.push(q); }
  }
  // A white face, grown a few px to tuck under the gear's edge.
  const face = Buffer.alloc(W * H * 4);
  const GROW = 5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let on = false;
    for (let d = -GROW; d <= GROW && !on; d++) {
      if (y + d >= 0 && y + d < H && hole[(y + d) * W + x]) on = true;
      if (x + d >= 0 && x + d < W && hole[y * W + x + d]) on = true;
    }
    if (on) face.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 4);
  }
  const gear = await sharp(face, { raw: { width: W, height: H, channels: 4 } })
    .composite([{ input: gearOnly }]).png().toBuffer();

  // The baseball's two seams: curves that start and end at the face's edge and bow toward the
  // middle, with V-shaped stitches along them.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const seam = (side) => {
    const a = (38 * Math.PI) / 180;                           // where the seam meets the edge
    const p0 = [cx + side * rx * Math.sin(a), cy - ry * Math.cos(a)];
    const p2 = [cx + side * rx * Math.sin(a), cy + ry * Math.cos(a)];
    const c = [cx + side * rx * 0.08, cy];                    // bows in toward the middle
    const at = (t) => [0, 1].map((k) => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p2[k]);
    const dir = (t) => {
      const d = [0, 1].map((k) => 2 * (1 - t) * (c[k] - p0[k]) + 2 * t * (p2[k] - c[k]));
      const n = Math.hypot(...d);
      return [d[0] / n, d[1] / n];
    };
    const L = rx * 0.11, K = rx * 0.07;                       // stitch half-width and lean
    let stitches = '';
    for (let i = 1; i <= 9; i++) {
      const t = 0.06 + (i * 0.88) / 10;
      const [px, py] = at(t);
      const [tx, ty] = dir(t);
      const [nx, ny] = [-ty, tx];
      stitches += `<polyline points="${px + nx * L - tx * K},${py + ny * L - ty * K} ${px},${py} ${px - nx * L - tx * K},${py - ny * L - ty * K}"/>`;
    }
    return `<path d="M${p0} Q${c} ${p2}" stroke-width="${rx * 0.045}"/>
      <g stroke-width="${rx * 0.04}">${stitches}</g>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <g fill="none" stroke="${RED}" stroke-linecap="round" stroke-linejoin="round">${seam(-1)}${seam(1)}</g>
  </svg>`;
  const logo = await sharp(gear).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  await sharp(logo).toFile(path.join(ROOT, 'baseball-gear.png'));

  const pub = (f) => path.join(ROOT, 'public', f);
  fs.mkdirSync(pub('img'), { recursive: true });
  const fit = (w, h) => sharp(logo).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png();
  await fit(75, 80).toFile(pub('img/logo.png'));          // 37 × 40 in the sidebar, 28 × 30 in the top bar, at 2×
  await fit(192, 192).toFile(pub('img/icon-192.png'));
  await fit(512, 512).toFile(pub('img/icon-512.png'));
  // Apple wants an opaque square with some room around the logo.
  await sharp({ create: { width: 180, height: 180, channels: 4, background: '#ffffff' } })
    .composite([{ input: await fit(150, 150).toBuffer(), left: 15, top: 15 }]).flatten({ background: '#ffffff' }).png()
    .toFile(pub('apple-touch-icon.png'));
  // favicon.ico: 16, 32 and 48 px PNGs in one ICO.
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map((n) => fit(n, n).toBuffer()));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(n, e); head.writeUInt8(n, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(pub('favicon.ico'), Buffer.concat([head, ...pngs]));
  console.log(`hole ${x1 - x0 + 1} × ${y1 - y0 + 1} at (${cx}, ${cy}); wrote baseball-gear.png and icons`);
})();
