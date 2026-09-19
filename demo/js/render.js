// 渲染：只读状态 + 引用索引，把画面对齐到状态。不在这里改状态。
// 贴纸页由 sheet.js 画；指针事件统一在 app.js 里做命中检测，这里画出来的元素都不接事件。
import { urlSync } from './packs.js';
import { project } from './state.js';

export const BOARD_WIDTH = 760;   // 本子在舞台上的宽度

// sizeOf(ref) → { w, h, smooth }：贴纸按所在包的缩放比例显示，比例小于 1 时用平滑采样
export function createRenderer({ stage, layer, boardHost, resolveRef, sizeOf }) {
  const nodes = new Map();    // uid → 贴纸元素
  const boards = new Map();   // 本子 id → { wrap, img, layer }

  // 一本本子：wrap 是 0×0 的锚点（位置 = 本子中心），身上带共用的 scale(boardZ)；
  // 贴在它上面的贴纸放进它自己的 layer，跟着一起挪、一起缩放
  function boardNode(id) {
    let b = boards.get(id);
    if (b) return b;
    const wrap = document.createElement('div');
    wrap.className = 'board-wrap';
    wrap.dataset.board = id;
    const img = document.createElement('img');
    img.className = 'board-img';
    img.alt = 'board';
    img.draggable = false;
    const lay = document.createElement('div');
    lay.className = 'board-layer';
    wrap.append(img, lay);
    boardHost.appendChild(wrap);
    b = { wrap, img, layer: lay };
    boards.set(id, b);
    return b;
  }

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

  function renderBoards(p, sel) {
    const seen = new Set();
    p.boards.forEach((b, i) => {
      const hit = resolveRef(b.ref);
      const n = boardNode(b.id);
      seen.add(b.id);
      if (hit && n.img.dataset.hash !== hit.entry.sha256) {
        n.img.src = urlSync(hit.entry.sha256) || '';
        n.img.dataset.hash = hit.entry.sha256;
      }
      n.wrap.hidden = !hit;
      n.wrap.style.left = b.x + 'px';
      n.wrap.style.top = b.y + 'px';
      n.wrap.style.transform = `scale(${p.boardZ})`;
      n.wrap.style.zIndex = i + 1;
      n.wrap.classList.toggle('selected', sel?.kind === 'board' && sel.id === b.id);
    });
    for (const [id, n] of boards) if (!seen.has(id)) { n.wrap.remove(); boards.delete(id); }
  }

  function renderItems(p, sel) {
    const seen = new Set();
    for (const it of p.items) {
      let el = nodes.get(it.uid);
      const hit = resolveRef(it.ref);
      const wantMissing = !hit;
      if (el && el.classList.contains('missing') !== wantMissing) { el.remove(); el = null; }
      if (!el) { el = makeNode(it); nodes.set(it.uid, el); }
      // 正拿在手上的那张挂在 #hand 里、按屏幕像素摆（app.js 管），这里别抢回来、也别改它的位置
      if (el.classList.contains('in-hand')) { seen.add(it.uid); continue; }
      const parent = it.on === 'board' ? boards.get(it.board)?.layer : layer;
      if (!parent) { el.remove(); nodes.delete(it.uid); continue; }   // 本子已经不在桌上了
      if (el.parentNode !== parent) parent.appendChild(el);
      if (hit && el.tagName === 'IMG') {
        if (!el.src) el.src = urlSync(hit.entry.sha256) || '';
        const size = sizeOf(it.ref);
        el.style.width = size.w + 'px';
        el.classList.toggle('smooth', size.smooth);
      }
      placeStyle(el, it);
      seen.add(it.uid);
    }
    for (const [uid, el] of nodes) if (!seen.has(uid)) { el.remove(); nodes.delete(uid); }
  }

  // view：应用层算好的“实际显示”底板/背景引用；sel：当前选中（贴纸或本子）
  function render(state, view, sel) {
    const p = project(state);
    const bg = resolveRef(view.background);
    stage.style.backgroundImage = bg ? `url(${urlSync(bg.entry.sha256)})` : 'none';
    renderBoards(p, sel);
    renderItems(p, sel);
  }

  return { render, placeStyle, node: uid => nodes.get(uid), boardNode: id => boards.get(id) };
}
