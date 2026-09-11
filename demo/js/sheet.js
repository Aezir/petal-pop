// 贴纸页：桌上的一张印刷贴纸纸（paper doll sticker sheet）。一个素材包 = 一张纸，所有贴纸都在这一张上，不分页。
// 包里写了原图排版（manifest 的 sheet 字段）就照原样摆；没写就自动挤在一张纸上。
// 尺寸统一：每张纸按"标准贴纸纸"大小摆上桌（最大 768×512），由此得出这个包的缩放比例 scale；
// 贴纸在纸上、桌上、本子上都按这个比例显示，所以纸上看到多大，贴出去就多大。包也可以自己写 scale 覆盖。
export const SHEET_BOX = { w: 768, h: 512 };
export const MARGIN = 18, FOOT = 30;   // 纸边留白；底部一条放包名和换纸按钮
const GAP = 10;

// 按条目 id 算一个固定的小角度（-3°～3°），自动排版时有手工感，但每次打开都一样
function tiltOf(id) {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 7) - 3;
}

// 没写排版的包：按行把贴纸挤进一张宽高比约 3:2 的纸（单位：原图像素）
function autoLayout(stickers) {
  const items = stickers.map(e => {
    const rot = tiltOf(e.id), r = Math.abs(rot) * Math.PI / 180;
    return { entry: e, rot, bw: e.w * Math.cos(r) + e.h * Math.sin(r), bh: e.w * Math.sin(r) + e.h * Math.cos(r) };
  }).sort((a, b) => b.bh - a.bh || a.entry.id.localeCompare(b.entry.id));
  const area = items.reduce((s, it) => s + (it.bw + GAP) * (it.bh + GAP), 0);
  const W = Math.max(Math.sqrt(area * 1.5 / 0.85), ...items.map(it => it.bw));
  const rows = [];
  let row = null;
  for (const it of items) {
    if (row && row.w + GAP + it.bw <= W) { row.items.push(it); row.w += GAP + it.bw; continue; }
    row = { y: row ? row.y + row.h + GAP : 0, h: it.bh, w: it.bw, items: [it] };
    rows.push(row);
  }
  const slots = [];
  for (const r of rows) {
    const space = (W - r.w) / (r.items.length + 1);   // 多出来的宽度平均分到缝里
    let x = space;
    for (const it of r.items) {
      slots.push({ entry: it.entry, rot: it.rot, cx: x + it.bw / 2, cy: r.y + r.h / 2 });
      x += it.bw + GAP + space;
    }
  }
  const last = rows[rows.length - 1];
  return { w: W, h: last.y + last.h, slots };
}

// 纯函数：一个包 → 一张纸。返回的坐标、尺寸都已乘上缩放，单位是舞台像素；x/y 是贴纸中心在纸上的位置
export function layoutPack(p) {
  const stickers = p.entries.filter(e => e.type === 'sticker' && !e.deprecated);
  if (!stickers.length) return null;
  const raw = p.sheet && stickers.every(e => e.sheet)
    ? { w: p.sheet.w, h: p.sheet.h, slots: stickers.map(e => ({ entry: e, rot: 0, cx: e.sheet.x + e.w / 2, cy: e.sheet.y + e.h / 2 })) }
    : autoLayout(stickers);
  const scale = p.scale > 0 ? p.scale : Math.min(1, SHEET_BOX.w / raw.w, SHEET_BOX.h / raw.h);
  return {
    packId: p.id, scale,
    w: Math.round(raw.w * scale) + MARGIN * 2,
    h: Math.round(raw.h * scale) + MARGIN * 2 + FOOT,
    slots: raw.slots.map(s => ({
      ref: `${p.id}:${s.entry.id}`, entry: s.entry, rot: s.rot,
      w: s.entry.w * scale, h: s.entry.h * scale,
      x: MARGIN + s.cx * scale, y: MARGIN + s.cy * scale,
    })),
  };
}

export function createSheet({ root, slotsEl, titleEl, pageEl, urlOf, nameOf }) {
  let sheets = [], packsKey = '', shownKey = '';
  let names = new Map();
  const scales = new Map();   // 包 id → 缩放比例（没有贴纸的包也算，按 1）
  let cur = null;             // 最近一次画的：{ sh, t, used }
  const imgs = new Map();     // ref → 纸上的 img

  function setPacks(packs) {
    const key = packs.map(k => k.id + '@' + k.manifestSha256).join('|');
    if (key === packsKey) return;
    packsKey = key; shownKey = '';
    sheets = packs.map(layoutPack).filter(Boolean);
    names = new Map(packs.map(p => [p.id, nameOf(p.name)]));
    scales.clear();
    for (const s of sheets) scales.set(s.packId, s.scale);
  }

  function build(sh) {
    slotsEl.innerHTML = '';
    imgs.clear();
    root.style.width = sh.w + 'px';
    root.style.height = sh.h + 'px';
    root.style.margin = `${-sh.h / 2}px 0 0 ${-sh.w / 2}px`;
    for (const s of sh.slots) {
      const url = urlOf(s.entry.sha256) || '';
      const d = document.createElement('div');
      d.className = 'slot' + (sh.scale < 0.999 ? ' smooth' : '');
      d.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;` +
        `transform:translate(-50%,-50%) rotate(${s.rot}deg);--m:url("${url}")`;
      const img = document.createElement('img');
      img.src = url;
      img.draggable = false;
      d.appendChild(img);
      slotsEl.appendChild(d);
      imgs.set(s.ref, img);
    }
  }

  // used：已经撕走（贴在桌上或本子上）的贴纸引用；p.sheetT.page 是当前摆出来的是第几个包的纸
  function render(p, packs, used) {
    setPacks(packs);
    root.hidden = !sheets.length;
    if (!sheets.length) { cur = null; return; }
    const i = Math.min(p.sheetT.page, sheets.length - 1), sh = sheets[i];
    if (shownKey !== packsKey + '#' + i) { shownKey = packsKey + '#' + i; build(sh); }
    root.style.left = p.sheetT.x + 'px';
    root.style.top = p.sheetT.y + 'px';
    root.classList.toggle('single', sheets.length < 2);
    for (const s of sh.slots) imgs.get(s.ref)?.parentNode.classList.toggle('used', used.has(s.ref));
    titleEl.textContent = names.get(sh.packId) || sh.packId;
    pageEl.textContent = `${i + 1} / ${sheets.length}`;
    cur = { sh, t: p.sheetT, used };
  }

  // 当前这张纸上还没撕走的贴纸，带舞台坐标（命中检测用）
  function freeSlots() {
    if (!cur) return [];
    const ox = cur.t.x - cur.sh.w / 2, oy = cur.t.y - cur.sh.h / 2;
    return cur.sh.slots.filter(s => !cur.used.has(s.ref))
      .map(s => ({ ...s, c: { x: ox + s.x, y: oy + s.y }, img: imgs.get(s.ref) }));
  }
  const contains = pt => !!cur && Math.abs(pt.x - cur.t.x) <= cur.sh.w / 2 && Math.abs(pt.y - cur.t.y) <= cur.sh.h / 2;

  return {
    render, freeSlots, contains,
    count: () => sheets.length,
    size: () => (cur ? { w: cur.sh.w, h: cur.sh.h } : null),
    scaleOf: packId => scales.get(packId) ?? 1,
    setPacks,
  };
}
