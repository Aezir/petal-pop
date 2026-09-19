// 贴纸条：右栏里一包一条，可折叠。贴纸按**轮廓**见缝插针地排——不是一人一个隐形方块，
// 而是像真的贴纸纸那样，小件钻进大件的透明角落和缝隙里。
// 条上的缩略图只是"取材"用的缩小显示；贴纸的真实大小由 scaleOf 决定（下面的 768×512 规则），贴到画布上就是那个大小。
import { DB } from './db.js';

export const SHEET_BOX = { w: 768, h: 512 };   // "标准贴纸纸"：一个包的贴纸整体放进这么大的纸，得出这个包的世界比例
export const STRIP_THUMB = 64;                  // 条上缩略图的目标短边（世界像素 × k ≈ 这么大）
export const STRIP_INNER_MIN = 160;             // 条内可用宽度的兜底：右栏还没量出来时用它
const GAP = 10;

// ---------- 占用格：排版的底层数据结构 ----------
// 把条身看成一张 2 像素一格的方格纸，每张贴纸按自己的 alpha 烤出一块"掩膜"（哪些格子被图案占住），
// 再向外膨胀 1 格当作贴纸之间的视觉间隙。排版 = 把掩膜一块块往方格纸上按，不许重叠。
// 一行格子用 Uint32 位图存（134 格 → 5 个字），碰撞检测就是几次与运算。
const CELL = 2;                                       // 一格多少屏幕像素
const ALPHA = 96;                                     // 这个透明度以上算"有图案"，和 silhouette.js 一致
// 条宽是右栏量出来的（自绘滚动条不占位，所以就是整个内容宽），所以格数和每行的字数都随宽度算
const geoOf = innerW => { const W = Math.max(8, Math.floor(innerW / CELL)); return { W, WORDS: Math.ceil(W / 32) }; };
const LAYOUT_VER = 'v2';
// 注：这版不做倾斜摆放。要让贴纸歪着贴，每个角度都得单独烤一份掩膜，排版和命中检测都要跟着改。

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const popcount = v => { v = v - ((v >> 1) & 0x55555555); v = (v & 0x33333333) + ((v >> 2) & 0x33333333); return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24; };

// 从图片烤掩膜：先按缩略显示尺寸画到画布上，一格里只要有一个像素够不透明就算占住，再膨胀 1 格
function buildMask(g, src, w, h) {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const cw = Math.ceil(W / CELL), ch = Math.ceil(H / CELL);
  const raw = new Uint8Array(cw * ch);
  for (let y = 0; y < H; y++) {
    const cy = (y / CELL) | 0;
    for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] >= ALPHA) raw[cy * cw + ((x / CELL) | 0)] = 1;
  }
  // 膨胀 1 格：掩膜四周各多出一格，所以贴纸自己的左上角在掩膜的 (1,1) 格上
  const mw = Math.min(g.W, cw + 2), mh = ch + 2;
  const rows = new Uint32Array(mh * g.WORDS), count = new Int32Array(mh);
  const box = cw * ch;   // 没膨胀的包围盒格数：估条高用它最准（实心面积会低估，膨胀后的会高估）
  let total = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (!raw[y * cw + x]) continue;
    for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) {
      const mx = x + dx, my = y + dy;
      if (mx >= mw) continue;
      const i = my * g.WORDS + (mx >> 5), bit = 1 << (mx & 31);
      if (!(rows[i] & bit)) { rows[i] |= bit; count[my]++; total++; }
    }
  }
  return { w: mw, h: mh, rows, count, total, box };
}

function makeGrid(g) {
  const rows = [], free = [];
  return {
    rows, free, g,
    ensure(y) { while (rows.length <= y) { rows.push(new Uint32Array(g.WORDS)); free.push(g.W); } },
  };
}
// 先用"每行的空位数够不够"快速排除一个 y，省掉 134 次逐列试位
function rowsCouldFit(grid, y, m) {
  for (let r = 0; r < m.h; r++) if (m.count[r] && grid.free[y + r] < m.count[r]) return false;
  return true;
}
// 掩膜整体右移 sx 格后，落在网格第 w 个字上的那些位
function shifted(g, m, base, w, q, s) {
  const k = w - q;
  let v = (k >= 0 && k < g.WORDS ? m.rows[base + k] : 0) << s;
  if (s > 0) { const k2 = k - 1; if (k2 >= 0 && k2 < g.WORDS) v |= m.rows[base + k2] >>> (32 - s); }
  return v;
}
function fits(grid, m, sx, y) {
  const q = sx >> 5, s = sx & 31, G = grid.g;
  for (let r = 0; r < m.h; r++) {
    if (!m.count[r]) continue;
    const base = r * G.WORDS, row = grid.rows[y + r];
    for (let w = 0; w < G.WORDS; w++) {
      const v = shifted(G, m, base, w, q, s);
      if (v && (row[w] & v)) return false;
    }
  }
  return true;
}
function stamp(grid, m, sx, y) {
  const q = sx >> 5, s = sx & 31, G = grid.g;
  for (let r = 0; r < m.h; r++) {
    if (!m.count[r]) continue;
    const base = r * G.WORDS, row = grid.rows[y + r];
    let used = 0;
    for (let w = 0; w < G.WORDS; w++) {
      const v = shifted(G, m, base, w, q, s);
      if (!v) continue;
      used += popcount(v & ~row[w]);
      row[w] |= v;
    }
    grid.free[y + r] -= used;
  }
}
// 从第 y0 行往下找第一个放得下的位置；xs 给定列的尝试顺序（不给就从左到右）
function drop(grid, m, y0, xs) {
  const maxX = grid.g.W - m.w;
  if (maxX < 0) return null;
  for (let y = Math.max(0, y0); y < y0 + 6000; y++) {
    grid.ensure(y + m.h);
    if (!rowsCouldFit(grid, y, m)) continue;
    if (xs) {
      for (const sx of xs) if (sx >= 0 && sx <= maxX && fits(grid, m, sx, y)) { stamp(grid, m, sx, y); return { cx: sx, cy: y }; }
    } else {
      for (let sx = 0; sx <= maxX; sx++) if (fits(grid, m, sx, y)) { stamp(grid, m, sx, y); return { cx: sx, cy: y }; }
    }
  }
  return null;
}

// 排版主过程。entries: [{ id, mask }]
// 大图（实心格数超过中位数两倍）当「锚」，先沿整条高度均匀撒开、左右交错；
// 剩下的小件再按从上到下、从左到右见缝插针——它们会自然钻进锚的透明角落和锚之间的缝
function packStrip(g, items) {
  const grid = makeGrid(g);
  const sorted = [...items].sort((a, b) => b.mask.total - a.mask.total);
  const median = sorted[sorted.length >> 1].mask.total;
  const anchors = sorted.filter(it => it.mask.total > median * 2);
  const fillers = anchors.length ? sorted.filter(it => it.mask.total <= median * 2) : sorted;
  const pos = {};

  if (anchors.length) {
    // 估个初始高度，把锚均匀铺在这个高度上。包围盒面积 ÷ 条宽 的估法实测和最终条高只差 3%
    const box = sorted.reduce((s, it) => s + it.mask.box, 0);
    const h0 = Math.max(1, box / g.W);   // 单位：格
    const n = anchors.length;
    // 锚按面积从大到小处理，但落到哪一档高度要打散——照 i 的顺序排会变成"上面全是大图、越往下越小"。
    // 用一个和 n 互质的黄金比例步长跳着分配档位，大图就均匀散在整条上
    let step = Math.max(1, Math.round(n * 0.618));
    while (step > 1 && gcd(step, n) !== 1) step--;
    anchors.forEach((it, i) => {
      const band = (i * step) % n;
      const target = Math.round((band + 0.5) * h0 / n - it.mask.h / 2);
      const left = 0, right = g.W - it.mask.w, mid = Math.floor(right / 2);
      const xs = band % 2 ? [right, left, mid] : [left, right, mid];   // 左右交错，别全挤一边
      const r = drop(grid, it.mask, target, xs) || drop(grid, it.mask, 0, null);
      if (r) pos[it.id] = r;
    });
  }
  for (const it of fillers) {
    const r = drop(grid, it.mask, 0, null);
    if (r) pos[it.id] = r;
  }

  let bottom = 0;
  const out = {};
  for (const it of sorted) {
    const r = pos[it.id];
    if (!r) continue;
    out[it.id] = [r.cx * CELL + CELL, r.cy * CELL + CELL];   // 掩膜多膨胀了一格，贴纸自己的左上角在里面 (1,1) 格
    bottom = Math.max(bottom, (r.cy + it.mask.h) * CELL);
  }
  return { h: bottom + CELL, pos: out };
}

// ---------- 世界比例 / 缩略比例（和贴纸纸时代完全一致，旧存档大小不变） ----------
// 按条目 id 算一个固定的小角度（-3°～3°）——只用于自动排版算包围盒，保证 scaleOf 不变
function tiltOf(id) {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 7) - 3;
}

// 没写排版的包：按行把贴纸挤进一张宽高比约 3:2 的纸（单位：原图像素）。只为了算尺寸
function autoLayout(stickers) {
  const items = stickers.map(e => {
    const rot = tiltOf(e.id), r = Math.abs(rot) * Math.PI / 180;
    return { bw: e.w * Math.cos(r) + e.h * Math.sin(r), bh: e.w * Math.sin(r) + e.h * Math.cos(r) };
  }).sort((a, b) => b.bh - a.bh);
  const area = items.reduce((s, it) => s + (it.bw + GAP) * (it.bh + GAP), 0);
  const W = Math.max(Math.sqrt(area * 1.5 / 0.85), ...items.map(it => it.bw));
  let rowW = 0, y = 0, rowH = 0, first = true;
  for (const it of items) {
    if (!first && rowW + GAP + it.bw <= W) { rowW += GAP + it.bw; continue; }
    if (!first) y += rowH + GAP;
    rowW = it.bw; rowH = it.bh; first = false;
  }
  return { w: W, h: y + rowH };
}

// 一个包的世界比例：贴纸纸原图（或自动排版）放进 768×512 得出；包自己写了 scale 就用它
export function scaleOfPack(p) {
  const stickers = p.entries.filter(e => e.type === 'sticker' && !e.deprecated);
  if (!stickers.length) return 1;
  if (p.scale > 0) return p.scale;
  const raw = p.sheet && stickers.every(e => e.sheet) ? { w: p.sheet.w, h: p.sheet.h } : autoLayout(stickers);
  return Math.min(1, SHEET_BOX.w / raw.w, SHEET_BOX.h / raw.h);
}

// 条上的缩略比例（屏幕像素 / 世界像素）：让典型贴纸短边约 64px，同时最长的一张也不超过条宽；永远不放大
function thumbKOf(p, scale, innerW) {
  const shorts = [], longs = [];
  for (const e of p.entries) if (e.type === 'sticker' && !e.deprecated) { shorts.push(Math.min(e.w, e.h) * scale); longs.push(Math.max(e.w, e.h) * scale); }
  if (!shorts.length) return 1;
  shorts.sort((a, b) => a - b);
  const median = shorts[shorts.length >> 1];
  let k = Math.min(1, Math.max(0.1, STRIP_THUMB / median));
  k = Math.min(k, innerW / Math.max(...longs));
  return k;
}

// 贴纸编号：优先取条目 id 末尾的数字（asset-049 → 49），没有就用它在清单里的名次
function numberOf(entry, i) {
  const m = /(\d+)$/.exec(entry.id);
  return m ? String(+m[1]) : String(i + 1);
}

// 排版算不出来之前的临时排法：按行摆一摆，别让玩家先看见一堆叠在一起的贴纸
function shelfLayout(sizes, innerW) {
  const pos = {}, gap = 2;
  let x = 0, y = 0, rowH = 0;
  for (const s of sizes) {
    if (x && x + s.w > innerW) { x = 0; y += rowH + gap; rowH = 0; }
    pos[s.id] = [x, y];
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return { h: y + rowH, pos };
}

export function createStrips({ root, urlOf, nameOf, ui, onToggle }) {
  let packsKey = '', seq = 0, lastPacks = [], innerW = STRIP_INNER_MIN;
  // 条宽 = 右栏的内容宽。自绘滚动条是浮在上面的、不占布局，所以这里就是整宽
  // 面板收起来时 clientWidth 是 0，退回样式上写的宽度，免得按兜底宽度白排一遍
  const measure = () => Math.max(STRIP_INNER_MIN, Math.round(root.clientWidth || parseFloat(getComputedStyle(root).width) || 0));
  const scales = new Map(), thumbs = new Map();
  const slots = new Map();      // ref → { el, img, packId, entry, label, number, packName }
  const sections = new Map();   // packId → { sec, body, count, total }

  function applyLayout(packId, layout) {
    const s = sections.get(packId);
    if (!s || !layout) return;
    for (const [ref, slot] of slots) {
      if (slot.packId !== packId) continue;
      const p = layout.pos[slot.entry.id];
      if (!p) { slot.el.hidden = true; continue; }
      slot.el.hidden = false;
      slot.el.style.left = p[0] + 'px';
      slot.el.style.top = p[1] + 'px';
    }
    s.body.style.height = (layout.h + 12) + 'px';   // 上下各 6px padding
  }

  // 栏宽变了（窗口缩放、皮肤改字号）就整条重排：清掉 packsKey 让 setPacks 重新建一遍
  new ResizeObserver(() => {
    if (Math.abs(measure() - innerW) <= 1) return;
    packsKey = '';
    if (lastPacks.length) setPacks(lastPacks);
  }).observe(root);

  // 真正的轮廓排版：从 IndexedDB 里读原图 → 烤掩膜 → 见缝插针。算完存起来，下次开同一个包直接用
  async function computeLayout(pack, scale, k, w0, my) {
    const g = geoOf(w0);
    const key = `stripLayout:${pack.id}:${pack.manifestSha256}:${w0}:${k.toFixed(4)}:${LAYOUT_VER}`;
    let layout = await DB.get('kv', key).catch(() => null);
    if (!layout) {
      const t0 = performance.now();
      const stickers = pack.entries.filter(e => e.type === 'sticker' && !e.deprecated);
      const items = [];
      for (const e of stickers) {
        const blob = await DB.get('blobs', e.sha256).catch(() => null);
        if (!blob) continue;
        const bmp = await createImageBitmap(blob);
        items.push({ id: e.id, mask: buildMask(g, bmp, e.w * scale * k, e.h * scale * k) });
        bmp.close?.();
      }
      if (!items.length) return;
      layout = packStrip(g, items);
      console.info(`贴纸条排版 ${pack.id}：${items.length} 张，条宽 ${w0}px、条高 ${layout.h}px，用时 ${Math.round(performance.now() - t0)}ms`);
      DB.put('kv', key, layout).catch(() => {});
    }
    if (my !== seq) return;   // 算的过程中包列表换了，这份结果作废
    applyLayout(pack.id, layout);
  }

  function setPacks(packs) {
    const key = packs.map(p => p.id + '@' + p.manifestSha256).join('|');
    if (key === packsKey) return;
    packsKey = key;
    lastPacks = packs;
    innerW = measure();
    const my = ++seq;
    root.innerHTML = '';
    slots.clear(); sections.clear(); scales.clear(); thumbs.clear();
    for (const p of packs) {
      const scale = scaleOfPack(p), k = thumbKOf(p, scale, innerW);
      scales.set(p.id, scale); thumbs.set(p.id, k);
      const stickers = p.entries.filter(e => e.type === 'sticker' && !e.deprecated);
      if (!stickers.length) continue;
      const packName = nameOf(p.name) || p.id;
      const sec = document.createElement('section');
      sec.className = 'strip';
      sec.dataset.pack = p.id;
      sec.innerHTML = '<header class="strip-head"><i class="chev ri-arrow-down-s-line"></i><span class="strip-name"></span><span class="strip-count"></span></header><div class="strip-body"></div>';
      sec.querySelector('.strip-name').textContent = packName;
      sec.querySelector('.strip-head').onclick = () => onToggle(p.id, !sec.classList.contains('collapsed'));
      const body = sec.querySelector('.strip-body');
      const sizes = [];
      stickers.forEach((e, i) => {
        const url = urlOf(e.sha256) || '';
        const w = e.w * scale * k, h = e.h * scale * k;
        const d = document.createElement('div');
        d.className = 'slot' + (k * scale < 0.999 ? ' smooth' : '');
        d.style.cssText = `width:${w}px;height:${h}px;--m:url("${url}")`;
        const img = document.createElement('img');
        img.src = url;
        img.draggable = false;
        d.appendChild(img);
        body.appendChild(d);
        const ref = `${p.id}:${e.id}`;
        d.dataset.ref = ref;
        const number = numberOf(e, i);
        slots.set(ref, { el: d, img, packId: p.id, entry: e, packName, number, label: e.name || '#' + number });
        sizes.push({ id: e.id, w, h });
      });
      root.appendChild(sec);
      sections.set(p.id, { sec, body, count: sec.querySelector('.strip-count'), total: stickers.length });
      applyLayout(p.id, shelfLayout(sizes, innerW));   // 先摆个临时的，真排版算完再重排
      computeLayout(p, scale, k, innerW, my).catch(console.warn);
    }
  }

  // used：已经撕走（贴在桌上或本子上）的贴纸引用
  function render(packs, used) {
    setPacks(packs);
    const left = new Map();
    for (const [ref, s] of slots) {
      const u = used.has(ref);
      s.el.classList.toggle('used', u);
      if (!u) left.set(s.packId, (left.get(s.packId) || 0) + 1);
    }
    for (const [id, { sec, count, total }] of sections) {
      sec.classList.toggle('collapsed', !!ui().strips[id]?.collapsed);
      count.textContent = `${left.get(id) || 0} / ${total}`;
    }
  }

  // 贴纸按轮廓排，包围盒会正当地互相重叠，所以"点到哪一张"不能看 event.target。
  // 这里只交出"矩形罩住这个点"的候选，最上面的（DOM 里靠后的）排前面，由调用方按透明度逐个试
  function slotsAt(x, y) {
    const out = [];
    for (const [ref, s] of slots) {
      const r = s.el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      out.push({ ref, rect: r, used: s.el.classList.contains('used'), ...s });
    }
    return out.reverse();
  }

  return {
    render, slotsAt,
    scaleOf: packId => scales.get(packId) ?? 1,
    thumbKOf: packId => thumbs.get(packId) ?? 1,
  };
}
