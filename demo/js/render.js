// 渲染：只读状态 + 引用索引，把画面对齐到状态。不在这里改状态。
import { urlSync, displayName } from './packs.js';
import { project } from './state.js';

export function createRenderer({ stage, layer, boardEl, sheet, countEl, resolveRef, bindItem }) {
  const nodes = new Map();   // uid → 元素
  let sheetKey = '';

  function placeStyle(el, it) {
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.transform = `translate(-50%,-50%) rotate(${it.rot}deg) scale(${it.s})`;
    el.style.zIndex = it.z;
  }

  function makeNode(it) {
    const hit = resolveRef(it.ref);
    let el;
    if (hit) {
      el = document.createElement('img');
      el.src = urlSync(hit.entry.sha256) || '';
      el.style.width = hit.entry.w + 'px';
      el.draggable = false;
      el.className = 'placed';
    } else {
      el = document.createElement('div');
      el.className = 'placed missing';
      el.textContent = '缺失\n' + it.ref;
      el.title = '这张贴纸所在的素材包没装或已禁用';
    }
    el.dataset.uid = it.uid;
    bindItem(el, it.uid);
    return el;
  }

  function renderItems(p) {
    const seen = new Set();
    for (const it of p.items) {
      let el = nodes.get(it.uid);
      const hit = resolveRef(it.ref);
      const wantMissing = !hit;
      if (el && el.classList.contains('missing') !== wantMissing) { el.remove(); el = null; }
      if (!el) { el = makeNode(it); nodes.set(it.uid, el); layer.appendChild(el); }
      if (hit && el.tagName === 'IMG' && !el.src) el.src = urlSync(hit.entry.sha256) || '';
      placeStyle(el, it);
      seen.add(it.uid);
    }
    for (const [uid, el] of nodes) if (!seen.has(uid)) { el.remove(); nodes.delete(uid); }
  }

  // 贴纸册：包变了才重建；用没用过每次都从状态同步
  function buildSheet(packs) {
    const key = packs.map(p => p.id + '@' + p.manifestSha256).join('|');
    if (key === sheetKey) return;
    sheetKey = key;
    const top = sheet.scrollTop;
    sheet.innerHTML = '';
    for (const p of packs) {
      const stickers = p.entries.filter(e => e.type === 'sticker');
      if (!stickers.length) continue;
      const head = document.createElement('div');
      head.className = 'pack-head';
      head.textContent = `${displayName(p.name)} · ${stickers.length}`;
      sheet.appendChild(head);
      for (const e of stickers) {
        const d = document.createElement('div');
        d.className = 'thumb';
        d.dataset.ref = p.id + ':' + e.id;
        d.title = displayName(e.name) || e.id;
        const img = document.createElement('img');
        img.src = urlSync(e.sha256) || '';
        img.draggable = false;
        d.appendChild(img);
        sheet.appendChild(d);
      }
    }
    sheet.scrollTop = top;
  }

  function syncSheet(p) {
    const used = new Set(p.items.map(i => i.ref));
    let total = 0;
    for (const t of sheet.querySelectorAll('.thumb')) {
      total++;
      t.classList.toggle('used', used.has(t.dataset.ref));
    }
    countEl.textContent = `剩 ${total - used.size} / ${total}`;
  }

  // view：应用层算好的“实际显示”底板/背景引用（选中的找不到时临时兜底）
  function render(state, packs, view) {
    const p = project(state);
    const bg = resolveRef(view.background);
    stage.style.backgroundImage = bg ? `url(${urlSync(bg.entry.sha256)})` : 'none';
    const board = resolveRef(view.board);
    boardEl.hidden = !board;
    if (board) boardEl.src = urlSync(board.entry.sha256) || '';
    renderItems(p);
    buildSheet(packs);
    syncSheet(p);
  }

  return { render, placeStyle, node: uid => nodes.get(uid) };
}
