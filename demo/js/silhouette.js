// 贴纸轮廓：从图片的透明度算出"哪里是贴纸、离边多远"。
// 用来做命中检测（透明的角落点不到）和"只能从边缘撕起来"。坐标都是贴纸自身坐标：中心为原点、y 向下。
const cache = new Map();   // sha256 → 轮廓

// 边缘热区宽度：贴纸越大热区越宽，限制在 10～22 像素
const edgeZone = s => Math.max(10, Math.min(22, 0.14 * s));

// img 必须已经加载完；没加载完返回 null（调用方按整个矩形处理）
export function silhouetteOf(key, img, w, h) {
  let s = cache.get(key);
  if (s) return s;
  if (!img || !img.complete || !img.naturalWidth) return null;
  s = build(img, Math.round(w), Math.round(h));
  cache.set(key, s);
  return s;
}

function build(img, W, H) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = px[i * 4 + 3] >= 96 ? 1 : 0;

  // 每个像素到最近透明像素的距离（两遍倒角距离变换，图外算透明）
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = solid[i] ? 1e9 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  const D = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D, at(x + 1, y - 1) + D);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D, at(x - 1, y + 1) + D);
  }

  // 每 3 像素抽一个实心点：算重心、算"沿某方向最远到哪"
  const pts = [];
  let sx = 0, sy = 0;
  for (let y = 1; y < H; y += 3) for (let x = 1; x < W; x += 3) {
    if (!solid[y * W + x]) continue;
    const lx = x + 0.5 - W / 2, ly = y + 0.5 - H / 2;
    pts.push(lx, ly); sx += lx; sy += ly;
  }
  const n = pts.length / 2 || 1;
  const zone = edgeZone(Math.min(W, H));
  const idx = (lx, ly) => {
    const x = Math.floor(lx + W / 2), y = Math.floor(ly + H / 2);
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  };

  return {
    centroid: { x: sx / n, y: sy / n },
    opaque(lx, ly) { const i = idx(lx, ly); return i >= 0 && solid[i] === 1; },
    nearEdge(lx, ly) { const i = idx(lx, ly); return i >= 0 && solid[i] === 1 && d[i] <= zone; },
    // 从 g 出发逆着 dir 走，多远走出贴纸（手指离身后那条边多远）
    backToEdge(g, dir) {
      for (let t = 0; t < 160; t++) if (!this.opaque(g.x - dir.x * t, g.y - dir.y * t)) return t;
      return 160;
    },
    // 从 o 出发沿 dir，贴纸最远伸到哪
    maxAlong(o, dir) {
      let m = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const v = (pts[i] - o.x) * dir.x + (pts[i + 1] - o.y) * dir.y;
        if (v > m) m = v;
      }
      return m;
    },
  };
}
