// 贴纸条：右栏里一包一条，可折叠；贴纸按缩略比例紧凑排（CSS flex 换行），撕走的格子留刀模空位。
// 条上的缩略图只是"取材"用的缩小显示；贴纸的真实大小由 scaleOf 决定（下面的 768×512 规则），贴到画布上就是那个大小。
export const SHEET_BOX = { w: 768, h: 512 };   // "标准贴纸纸"：一个包的贴纸整体放进这么大的纸，得出这个包的世界比例
export const STRIP_THUMB = 64;                  // 条上缩略图的目标短边（世界像素 × k ≈ 这么大）
export const STRIP_INNER = 268;                 // 条内可用宽度：最长的贴纸也不能超过它
const GAP = 10;

// 按条目 id 算一个固定的小角度（-3°～3°）——只用于自动排版算包围盒，和以前一致，保证 scaleOf 不变
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

// 一个包的世界比例：贴纸纸原图（或自动排版）放进 768×512 得出；包自己写了 scale 就用它。和贴纸纸时代完全一致，旧存档大小不变
export function scaleOfPack(p) {
  const stickers = p.entries.filter(e => e.type === 'sticker' && !e.deprecated);
  if (!stickers.length) return 1;
  if (p.scale > 0) return p.scale;
  const raw = p.sheet && stickers.every(e => e.sheet) ? { w: p.sheet.w, h: p.sheet.h } : autoLayout(stickers);
  return Math.min(1, SHEET_BOX.w / raw.w, SHEET_BOX.h / raw.h);
}

// 条上的缩略比例（屏幕像素 / 世界像素）：让典型贴纸短边约 64px，同时最长的一张也不超过条宽；永远不放大
function thumbKOf(p, scale) {
  const shorts = [], longs = [];
  for (const e of p.entries) if (e.type === 'sticker' && !e.deprecated) { shorts.push(Math.min(e.w, e.h) * scale); longs.push(Math.max(e.w, e.h) * scale); }
  if (!shorts.length) return 1;
  shorts.sort((a, b) => a - b);
  const median = shorts[shorts.length >> 1];
  let k = Math.min(1, Math.max(0.1, STRIP_THUMB / median));
  k = Math.min(k, STRIP_INNER / Math.max(...longs));
  return k;
}

export function createStrips({ root, urlOf, nameOf, ui, onToggle }) {
  let packsKey = '';
  const scales = new Map(), thumbs = new Map();
  const slots = new Map();      // ref → { el, img, packId, entry }
  const sections = new Map();   // packId → { sec, count, total }

  function setPacks(packs) {
    const key = packs.map(p => p.id + '@' + p.manifestSha256).join('|');
    if (key === packsKey) return;
    packsKey = key;
    root.innerHTML = '';
    slots.clear(); sections.clear(); scales.clear(); thumbs.clear();
    for (const p of packs) {
      const scale = scaleOfPack(p), k = thumbKOf(p, scale);
      scales.set(p.id, scale); thumbs.set(p.id, k);
      const stickers = p.entries.filter(e => e.type === 'sticker' && !e.deprecated);
      if (!stickers.length) continue;
      const sec = document.createElement('section');
      sec.className = 'strip';
      sec.dataset.pack = p.id;
      sec.innerHTML = '<header class="strip-head"><i class="chev ri-arrow-down-s-line"></i><span class="strip-name"></span><span class="strip-count"></span></header><div class="strip-body"></div>';
      sec.querySelector('.strip-name').textContent = nameOf(p.name) || p.id;
      sec.querySelector('.strip-head').onclick = () => onToggle(p.id, !sec.classList.contains('collapsed'));
      const body = sec.querySelector('.strip-body');
      for (const e of stickers) {
        const url = urlOf(e.sha256) || '';
        const d = document.createElement('div');
        d.className = 'slot' + (k * scale < 0.999 ? ' smooth' : '');
        d.style.cssText = `width:${e.w * scale * k}px;height:${e.h * scale * k}px;--m:url("${url}")`;
        const img = document.createElement('img');
        img.src = url;
        img.draggable = false;
        d.appendChild(img);
        body.appendChild(d);
        const ref = `${p.id}:${e.id}`;
        d.dataset.ref = ref;
        slots.set(ref, { el: d, img, packId: p.id, entry: e });
      }
      root.appendChild(sec);
      sections.set(p.id, { sec, count: sec.querySelector('.strip-count'), total: stickers.length });
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

  // 指针落在条上的哪一格（还没撕走的）
  function slotAt(target) {
    const el = target?.closest?.('.slot');
    if (!el || el.classList.contains('used')) return null;
    const s = slots.get(el.dataset.ref);
    return s ? { ref: el.dataset.ref, ...s } : null;
  }

  return {
    render, slotAt,
    scaleOf: packId => scales.get(packId) ?? 1,
    thumbKOf: packId => thumbs.get(packId) ?? 1,
  };
}
