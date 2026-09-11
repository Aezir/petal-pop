// 渲染：只读状态 + 引用索引，把画面对齐到状态。不在这里改状态。
// 贴纸页由 sheet.js 画；指针事件统一在 app.js 里做命中检测，这里画出来的元素都不接事件。
import { urlSync } from './packs.js';
import { project } from './state.js';

export const BOARD_WIDTH = 760;   // 本子在舞台上的宽度

// sizeOf(ref) → { w, h, smooth }：贴纸按所在包的缩放比例显示，比例小于 1 时用平滑采样
export function createRenderer({ stage, layer, boardWrap, boardEl, boardLayer, resolveRef, sizeOf }) {
  const nodes = new Map();   // uid → 元素

  function placeStyle(el, it) {
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.transform = `translate(-50%,-50%) rotate(${it.rot}deg)`;
    el.style.zIndex = it.z;
  }

  function makeNode(it) {
    const hit = resolveRef(it.ref);
    let el;
    if (hit) {
      el = document.createElement('img');
      el.src = urlSync(hit.entry.sha256) || '';
      el.draggable = false;
      el.className = 'placed';
    } else {
      el = document.createElement('div');
      el.className = 'placed missing';
      el.textContent = '缺失\n' + it.ref;
      el.title = '这张贴纸所在的素材包没装或已禁用';
    }
    el.dataset.uid = it.uid;
    return el;
  }

  function renderItems(p, sel) {
    const seen = new Set();
    for (const it of p.items) {
      let el = nodes.get(it.uid);
      const hit = resolveRef(it.ref);
      const wantMissing = !hit;
      if (el && el.classList.contains('missing') !== wantMissing) { el.remove(); el = null; }
      if (!el) { el = makeNode(it); nodes.set(it.uid, el); }
      const parent = it.on === 'board' ? boardLayer : layer;
      if (el.parentNode !== parent) parent.appendChild(el);
      if (hit && el.tagName === 'IMG') {
        if (!el.src) el.src = urlSync(hit.entry.sha256) || '';
        const size = sizeOf(it.ref);
        el.style.width = size.w + 'px';
        el.classList.toggle('smooth', size.smooth);
      }
      placeStyle(el, it);
      el.classList.toggle('selected', sel?.kind === 'item' && sel.uid === it.uid);
      seen.add(it.uid);
    }
    for (const [uid, el] of nodes) if (!seen.has(uid)) { el.remove(); nodes.delete(uid); }
  }

  function renderBoard(p, view, sel) {
    const board = resolveRef(view.board);
    boardWrap.hidden = !board;
    if (!board) return;
    if (boardEl.dataset.hash !== board.entry.sha256) {
      boardEl.src = urlSync(board.entry.sha256) || '';
      boardEl.dataset.hash = board.entry.sha256;
    }
    boardWrap.style.left = p.boardT.x + 'px';
    boardWrap.style.top = p.boardT.y + 'px';
    boardWrap.classList.toggle('selected', sel?.kind === 'board');
  }

  // view：应用层算好的“实际显示”底板/背景引用；sel：当前选中（贴纸或本子）
  function render(state, view, sel) {
    const p = project(state);
    const bg = resolveRef(view.background);
    stage.style.backgroundImage = bg ? `url(${urlSync(bg.entry.sha256)})` : 'none';
    renderBoard(p, view, sel);
    renderItems(p, sel);
  }

  return { render, placeStyle, node: uid => nodes.get(uid) };
}
