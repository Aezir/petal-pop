// 花漾贴贴 · 运行时内核入口
// 内核只认几种槽位：background / board / sticker / bgm，外加界面皮肤 skin。所有内容都来自素材包。
import { DB } from './db.js';
import * as Packs from './packs.js';
import { normalize, apply, project, findItem, STATE_VERSION } from './state.js';
import { createRenderer } from './render.js';
import { createSheet } from './sheet.js';
import { silhouetteOf } from './silhouette.js';
import { createPeeler, DETACH_AT } from './peel.js';
import { applySkin, clearSkin, readSkin, preloadSkinCache } from './skin.js';

preloadSkinCache();   // 赶在读存档、装包之前先把上次的皮肤颜色刷上，加载页不闪默认色
const STAGE_W = 1672, STAGE_H = 941;
// 默认包来源，按顺序试：本地开发目录 → GitHub 资源仓库（线上部署时本地目录不存在）
const DEFAULT_SOURCES = ['local:packs/default', 'Aezir/petal-pop-assets'];
const $ = s => document.querySelector(s);

const stage = $('#stage'), layer = $('#layer'), boardWrap = $('#boardWrap'), boardEl = $('#board'),
      boardLayer = $('#boardLayer'), toast = $('#toast'), audio = $('#bgm'), loading = $('#loading'), loadText = $('#load-text'),
      bar = $('#bar'), modal = $('#modal'), packList = $('#pack-list');

// 撕贴纸用的 WebGL 层；浏览器不支持 WebGL 时为 null，贴纸从边缘按下就直接拿起
const peeler = createPeeler($('#peel'));

// ---------- 舞台缩放 ----------
let scale = 1;
function fit() {
  scale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  stage.style.transform = `translate(-50%,-50%) scale(${scale})`;
  peeler?.resize(scale);
}
addEventListener('resize', fit);
fit();

// ---------- 状态 ----------
let state = normalize(await DB.get('kv', 'state').catch(() => null));
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.put('kv', 'state', state).catch(console.warn), 150);
}

// ---------- 素材包索引 ----------
let installed = [];          // 已安装（DB 里的记录）
let enabledPacks = [];       // 启用中，按 order 排
const refIndex = new Map();  // 'pack:id' → { pack, entry }

async function reloadPacks() {
  installed = await Packs.listPacks();
  for (const p of installed) if (!state.packs[p.id]) apply(state, { type: 'setPack', id: p.id, patch: {} });
  enabledPacks = installed
    .filter(p => state.packs[p.id]?.enabled !== false)
    .sort((a, b) => (state.packs[a.id].order || 0) - (state.packs[b.id].order || 0));
  refIndex.clear();
  for (const p of enabledPacks) for (const e of p.entries) refIndex.set(p.id + ':' + e.id, { pack: p, entry: e });
}
const resolveRef = ref => (ref && refIndex.get(ref)) || null;
const refsOfType = type => enabledPacks.flatMap(p => p.entries.filter(e => e.type === type).map(e => p.id + ':' + e.id));

// 缺省值：只在“从没选过”时填第一个可用的。选了但暂时找不到（包被禁用/卸载）的不动，
// 显示时用 effective() 临时兜底，包装回来选择自动恢复。
function fillDefaults() {
  const p = project(state);
  if (p.board == null) p.board = refsOfType('board')[0] || null;
  if (p.background == null) p.background = refsOfType('background')[0] || null;
  if (state.settings.bgmRef == null) state.settings.bgmRef = refsOfType('bgm')[0] || null;
}
const effective = (type, ref) => (resolveRef(ref) ? ref : refsOfType(type)[0] || null);
function view() {
  const p = project(state);
  return {
    board: effective('board', p.board),
    background: effective('background', p.background),
    bgm: effective('bgm', state.settings.bgmRef),
  };
}
// 皮肤和底板一样：选了但暂时找不到（包被禁用/卸载）不清选择，显示回默认，包回来自动恢复。
// 皮肤不进 fillDefaults——"默认主题"本身就是一个合法选择
async function syncSkin() {
  const ref = state.settings.skinRef;
  if (ref && resolveRef(ref)?.entry.type === 'skin') return applySkin(ref, resolveRef);
  clearSkin();
  return null;
}

// 把画面要用到的 blob 都换成对象地址（第一次从 IndexedDB 读，之后命中缓存）
async function ensureUrls() {
  const p = project(state), v = view();
  const refs = [v.board, v.background, v.bgm, ...p.items.map(i => i.ref), ...refsOfType('sticker')];
  await Promise.all(refs.map(r => { const h = resolveRef(r); return h ? Packs.urlFor(h.entry.sha256) : null; }));
}

// ---------- 选中 ----------
let sel = null;   // { kind:'board' } | null（本子被选中时描一圈粉边；贴纸没有选中状态）
function select(s) { sel = s; }

// ---------- 渲染 ----------
const sheet = createSheet({
  root: $('#sheetObj'), slotsEl: $('#sheetSlots'), titleEl: $('#sheetTitle'), pageEl: $('#sheetPage'),
  urlOf: Packs.urlSync, nameOf: Packs.displayName,
});
// 贴纸的显示尺寸 = 原图尺寸 × 所在包的缩放比例（由这个包的贴纸纸摆上桌的大小决定，见 sheet.js）
function sizeOf(ref) {
  const h = resolveRef(ref);
  if (!h) return null;
  const k = sheet.scaleOf(h.pack.id);
  return { w: h.entry.w * k, h: h.entry.h * k, smooth: k < 0.999 };
}
const renderer = createRenderer({ stage, layer, boardWrap, boardEl, boardLayer, resolveRef, sizeOf });
const usedRefs = () => new Set(project(state).items.map(i => i.ref));
// 同步重画（图片地址已经备好时用）。先画纸：纸算出各包的缩放，贴纸按它定尺寸
function paint() {
  sheet.render(project(state), enabledPacks, usedRefs());
  renderer.render(state, view(), sel);
}
// 纸整张留在桌面内（换了更大的纸、或者旧存档的位置靠边时）
function clampSheet() {
  const s = sheet.size();
  if (!s) return;
  const t = project(state).sheetT;
  const x = Math.min(Math.max(t.x, s.w / 2), STAGE_W - s.w / 2);
  const y = Math.min(Math.max(t.y, s.h / 2), STAGE_H - s.h / 2);
  if (x !== t.x || y !== t.y) apply(state, { type: 'sheetMove', x, y });
}
async function render() {
  await ensureUrls();
  paint();
  syncBgm();
}

// ---------- 撤销 ----------
const history = [];
function snapshot() {
  history.push(structuredClone(project(state)));
  if (history.length > 60) history.shift();
}
let lastCommit = { type: '', t: 0 };
function commit(action, { coalesce = false } = {}) {
  const now = Date.now();
  const merge = coalesce && lastCommit.type === action.type && now - lastCommit.t < 500;
  if (!merge) snapshot();
  lastCommit = { type: action.type, t: now };
  const r = apply(state, action);
  save();
  return r;
}
function undo() {
  const snap = history.pop();
  if (!snap) return showToast('没有可撤销的了');
  state.projects[snap.id] = snap;
  lastCommit = { type: '', t: 0 };
  save();
  render();
}

// ---------- 坐标 ----------
function toStage(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}
function inside(el, e) {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
// 舞台坐标 ⇄ 本子局部坐标（以本子中心为原点）
const stageToLocal = (pt, t) => ({ x: pt.x - t.x, y: pt.y - t.y });
const localToStage = (pt, t) => ({ x: t.x + pt.x, y: t.y + pt.y });
const itemStagePos = (it, t) => (it.on === 'board' ? localToStage(it, t) : { x: it.x, y: it.y });
const overBoard = e => !boardWrap.hidden && inside(boardEl, e);
// 舞台上的一段位移 → 贴纸自身坐标（去掉贴纸的旋转，y 向下）
function unrotate(dx, dy, rot) {
  const r = -rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// ---------- 命中检测 ----------
// 舞台上的指针事件统一在这里判断点到了谁，从上往下找：桌上的贴纸 → 贴纸页上的贴纸 → 贴纸页 → 本子上的贴纸 → 本子。
// 贴纸只认图案本身（透明的角落点不到）；离轮廓边缘近的地方才撕得起来（edge）。
function hitSticker(pt, c, rot, ref, el) {
  const h = resolveRef(ref), size = sizeOf(ref);
  const w = size ? size.w : 110, hh = size ? size.h : 110;   // 缺图的占位块是 110×110
  const l = unrotate(pt.x - c.x, pt.y - c.y, rot);
  if (Math.abs(l.x) > w / 2 || Math.abs(l.y) > hh / 2) return null;
  const sil = h && el?.tagName === 'IMG' ? silhouetteOf(`${h.entry.sha256}@${Math.round(w)}`, el, w, hh) : null;
  if (sil && !sil.opaque(l.x, l.y)) return null;
  return { local: l, sil, w, h: hh, smooth: !!size?.smooth, c, rot, ref, el, edge: sil ? sil.nearEdge(l.x, l.y) : true };
}
function hitTest(e) {
  const pt = toStage(e), p = project(state), byZ = (a, b) => b.z - a.z;
  for (const it of p.items.filter(i => i.on === 'desk').sort(byZ)) {
    const hit = hitSticker(pt, { x: it.x, y: it.y }, it.rot, it.ref, renderer.node(it.uid));
    if (hit) return { kind: 'item', uid: it.uid, ...hit };
  }
  for (const s of sheet.freeSlots()) {
    const hit = hitSticker(pt, s.c, s.rot, s.ref, s.img);
    if (hit) return { kind: 'slot', ...hit };
  }
  if (sheet.contains(pt)) return { kind: 'sheet' };
  if (boardWrap.hidden) return null;
  for (const it of p.items.filter(i => i.on === 'board').sort(byZ)) {
    const hit = hitSticker(pt, localToStage(it, p.boardT), it.rot, it.ref, renderer.node(it.uid));
    if (hit) return { kind: 'item', uid: it.uid, ...hit };
  }
  return inside(boardEl, e) ? { kind: 'board' } : null;
}
const cursorFor = hit => !hit ? '' : hit.kind === 'board' || hit.kind === 'sheet' ? 'move' : hit.edge ? 'grab' : 'default';

// ---------- 撕、拿、贴 ----------
// drag = { kind:'peel', src, handle, start }            正在从边缘揭起，还没离开
// drag = { kind:'hold', uid, dx, dy, handle, unrolling } 整张拿在手上，跟着手走
// drag = { kind:'board' | 'sheet', dx, dy }             挪本子 / 挪贴纸页
let drag = null;
let hintAt = 0;

stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const hit = hitTest(e), pt = toStage(e), p = project(state);
  if (!hit) { select(null); render(); return; }
  if (hit.kind === 'board' || hit.kind === 'sheet') {
    const t = hit.kind === 'board' ? p.boardT : p.sheetT;
    snapshot();
    drag = { kind: hit.kind, dx: t.x - pt.x, dy: t.y - pt.y };
    select(hit.kind === 'board' ? { kind: 'board' } : null);
    render();
    return;
  }
  if (!hit.edge) {
    // 按在贴纸中间：真贴纸抠不起来，提示一下
    if (Date.now() - hintAt > 4000) { hintAt = Date.now(); showToast('从贴纸边缘撕起来'); }
    render();
    return;
  }
  stage.style.cursor = 'grabbing';
  startPeel(hit, pt);
});

function startPeel(hit, pt) {
  snapshot();
  const src = { uid: hit.uid ?? null, ref: hit.ref, c: hit.c, rot: hit.rot, el: hit.el, grab: hit.local };
  const handle = peeler && hit.sil
    ? peeler.begin({ key: resolveRef(hit.ref).entry.sha256, img: hit.el, w: hit.w, h: hit.h, smooth: hit.smooth, c: hit.c, rot: hit.rot, grab: hit.local, sil: hit.sil })
    : null;
  if (!handle) { pickUp(src, pt, null); return; }
  hit.el.style.visibility = 'hidden';
  drag = { kind: 'peel', src, handle, start: pt };
}

// 整张离开：放进状态（桌面坐标、最上层），之后跟着手走。
// 捏住的那一点（src.grab）始终在指尖下面，所以贴纸中心 = 指尖 − 捏点相对中心的偏移（带上贴纸的旋转）
function pickUp(src, pt, handle) {
  const off = unrotate(src.grab.x, src.grab.y, -src.rot);
  const c = { x: pt.x - off.x, y: pt.y - off.y };
  let uid = src.uid;
  if (uid == null) {
    uid = apply(state, { type: 'place', ref: src.ref, x: c.x, y: c.y, rot: src.rot, on: 'desk' });
    src.el.style.visibility = '';   // 贴纸页上那一格交给 used 样式：露出底纸上的空位
  } else {
    apply(state, { type: 'move', uid, x: c.x, y: c.y, on: 'desk' });
    apply(state, { type: 'front', uid });
  }
  paint();
  const el = renderer.node(uid);
  drag = { kind: 'hold', uid, dx: -off.x, dy: -off.y, handle, unrolling: !!handle };
  if (!handle) { el?.classList.add('dragging'); return; }
  // 卷边在 WebGL 里展平、抬起来并滑到指尖下，播完再换成普通图片接着跟手
  if (el) el.style.visibility = 'hidden';
  handle.detach(c.x, c.y).then(() => {
    if (el) el.style.visibility = '';
    if (drag?.kind === 'hold' && drag.uid === uid) { drag.unrolling = false; el?.classList.add('dragging'); }
  });
}

// 松手：落在贴纸页上就放回去；落在本子上就贴在本子上（转局部坐标）；否则贴在桌面
function settle(d, e) {
  const p = project(state), el = renderer.node(d.uid);
  el?.classList.remove('dragging');
  if (sheet.contains(toStage(e))) {
    apply(state, { type: 'remove', uids: [d.uid] });
    return;
  }
  const onBoard = overBoard(e), it = findItem(p, d.uid);
  const pos = onBoard ? stageToLocal(it, p.boardT) : it;
  apply(state, { type: 'move', uid: d.uid, x: pos.x, y: pos.y, on: onBoard ? 'board' : 'desk' });   // 就贴在松手的地方，不做落下动画
}

// 没揭下来就松手：弹回贴平，状态没变，撤销记录也不留
function springBack(d) {
  history.pop();
  d.handle.release().then(() => { d.src.el.style.visibility = ''; });
}

addEventListener('pointermove', e => {
  if (!drag) {
    if (modal.hidden && stage.contains(e.target)) stage.style.cursor = cursorFor(hitTest(e));
    return;
  }
  const pt = toStage(e);
  if (drag.kind === 'peel') {
    const { src, handle, start } = drag;
    const d = unrotate(pt.x - start.x, pt.y - start.y, src.rot);
    if (handle.update(d.x, d.y) >= DETACH_AT) pickUp(src, pt, handle);
  } else if (drag.kind === 'hold') {
    const x = pt.x + drag.dx, y = pt.y + drag.dy;
    apply(state, { type: 'move', uid: drag.uid, x, y });
    const el = renderer.node(drag.uid), it = findItem(project(state), drag.uid);
    if (el && it) renderer.placeStyle(el, it);
    if (drag.unrolling) drag.handle.moveTo(x, y);
  } else {
    apply(state, { type: drag.kind === 'board' ? 'boardMove' : 'sheetMove', x: pt.x + drag.dx, y: pt.y + drag.dy });
    if (drag.kind === 'sheet') clampSheet();
    paint();
  }
});
addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  stage.style.cursor = '';
  if (d.kind === 'peel') return springBack(d);
  if (d.kind === 'hold') {
    if (d.unrolling) peeler.flush();   // 还在展平就松手了：立刻交接给普通图片，别等动画
    settle(d, e);
  }
  save();
  render();
});
addEventListener('pointercancel', () => {
  if (drag?.kind === 'peel') springBack(drag);
  else if (drag?.kind === 'hold') renderer.node(drag.uid)?.classList.remove('dragging');
  drag = null;
  save();
  render();
});

// 滚轮转贴纸（想放回就把贴纸拖回纸上）
stage.addEventListener('wheel', e => {
  const hit = hitTest(e);
  if (hit?.kind !== 'item') return;
  e.preventDefault();
  const it = findItem(project(state), hit.uid), d = e.deltaY || e.deltaX;
  commit({ type: 'rotate', uid: it.uid, rot: it.rot + (d < 0 ? -5 : 5) }, { coalesce: true });
  render();
}, { passive: false });

// 换一张纸（装了多个包时，每个包一张）
function turnPage(dir) {
  const p = project(state), n = sheet.count();
  const page = Math.max(0, Math.min(n - 1, p.sheetT.page + dir));
  if (page === p.sheetT.page) return;
  apply(state, { type: 'sheetPage', page });
  save();
  render();
}
$('#sheet-prev').onclick = () => turnPage(-1);
$('#sheet-next').onclick = () => turnPage(1);

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { if (!modal.hidden) modal.hidden = true; else { select(null); render(); } return; }
  if (!modal.hidden) return;
  if (e.key === 'ArrowLeft') return turnPage(-1);
  if (e.key === 'ArrowRight') return turnPage(1);
});

// ---------- 音乐 ----------
function syncBgm() {
  const hit = resolveRef(view().bgm);
  const u = hit ? Packs.urlSync(hit.entry.sha256) : '';
  if (u && audio.dataset.hash !== hit.entry.sha256) { audio.src = u; audio.dataset.hash = hit.entry.sha256; }
  audio.volume = state.settings.volume;
  const btn = $('#btn-bgm');
  btn.classList.toggle('on', state.settings.bgm && !!u);
  btn.querySelector('i').className = state.settings.bgm ? 'ri-music-2-line' : 'ri-volume-mute-line';
  if (state.settings.bgm && u) audio.play().catch(() => {}); else audio.pause();
}
addEventListener('pointerdown', () => { if (state.settings.bgm && audio.src && audio.paused) audio.play().catch(() => {}); });

// ---------- 工具条 ----------
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 1800);
}
function cycle(type, current) {
  const list = refsOfType(type);
  if (!list.length) return null;
  return list[(list.indexOf(current) + 1) % list.length];
}
$('#btn-bgm').onclick = () => { commit({ type: 'setBgm', on: !state.settings.bgm }); syncBgm(); };
$('#btn-board').onclick = () => {
  const ref = cycle('board', view().board);
  if (!ref) return showToast('没有可用的底板');
  commit({ type: 'setBoard', ref }); render();
  showToast(`底板 ${refsOfType('board').indexOf(ref) + 1} / ${refsOfType('board').length}`);
};
$('#btn-bg').onclick = () => {
  const ref = cycle('background', view().background);
  if (!ref) return showToast('没有可用的桌面');
  commit({ type: 'setBackground', ref }); render();
};
async function setSkin(ref) {
  apply(state, { type: 'setSetting', patch: { skinRef: ref } });
  save();
  const cfg = await syncSkin();
  if (!modal.hidden) renderSkinList();
  return cfg;
}
$('#btn-skin').onclick = async () => {
  const list = [null, ...refsOfType('skin')];   // 默认主题排第一
  if (list.length < 2) return showToast('还没有可用的皮肤（素材包里带 skin 条目才有）');
  const cur = resolveRef(state.settings.skinRef) ? state.settings.skinRef : null;
  const ref = list[(list.indexOf(cur) + 1) % list.length];
  const cfg = await setSkin(ref);
  showToast(`皮肤 ${list.indexOf(ref) + 1} / ${list.length}：${cfg ? cfg.name : '默认'}`);
};
$('#btn-undo').onclick = undo;
$('#btn-clear').onclick = () => {
  if (!project(state).items.length) return;
  commit({ type: 'clear' }); select(null); render();
  showToast('全部放回贴纸页啦（Ctrl+Z 可反悔）');
};

// ---------- 设置页 ----------
const tabs = modal.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  modal.querySelectorAll('[data-pane]').forEach(s => { s.hidden = s.dataset.pane !== name; });
  if (name === 'packs') renderPackList();
  if (name === 'skins') renderSkinList();
  if (name === 'storage') renderStorage();
}
tabs.forEach(t => { t.onclick = () => showTab(t.dataset.tab); });
$('#btn-settings').onclick = () => { modal.hidden = false; showTab('packs'); };
$('#btn-close').onclick = () => { modal.hidden = true; };
modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

function showLoading(text) { loadText.textContent = text; bar.style.width = '0%'; loading.classList.remove('hide'); }
function hideLoading() { loading.classList.add('hide'); }
function progressText(pr, prefix) {
  if (pr.phase === 'resolve') return prefix + '：定位版本…';
  if (pr.phase === 'manifest') return prefix + '：读取清单…';
  bar.style.width = (pr.done / pr.total * 100) + '%';
  return `${prefix}：${pr.done}/${pr.total} 个文件 · ${(pr.bytes / 1048576).toFixed(1)} MB`;
}
async function install(text) {
  showLoading('安装素材包…');
  let ok = false;
  try {
    const r = await Packs.installPack(text, pr => { loadText.textContent = progressText(pr, '安装 ' + text); });
    apply(state, { type: 'setPack', id: r.pack.id, patch: { enabled: true } });
    if (r.updated) await Packs.gc();
    showToast(r.unchanged ? '已经是最新版本' : (r.updated ? '已更新：' : '已安装：') + Packs.displayName(r.pack.name));
    ok = true;
  } catch (e) {
    console.error(e);
    showToast('安装失败：' + e.message);
  }
  hideLoading();
  await refresh();
  return ok;
}
async function installDefault() {
  for (const src of DEFAULT_SOURCES) if (await install(src)) return true;
  return false;
}
async function refresh() {
  await reloadPacks();
  fillDefaults();
  await syncSkin();
  await render();
  clampSheet();
  paint();
  save();
  if (!modal.hidden) { renderPackList(); renderSkinList(); }
}

const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';
async function renderPackList() {
  packList.innerHTML = '';
  if (!installed.length) packList.innerHTML = '<div class="dim">还没有素材包</div>';
  for (const p of installed) {
    const on = state.packs[p.id]?.enabled !== false;
    const row = document.createElement('div');
    row.className = 'pack-row' + (on ? '' : ' off');
    const counts = {};
    for (const e of p.entries) counts[e.type] = (counts[e.type] || 0) + 1;
    row.innerHTML = `
      <label class="pack-main">
        <input type="checkbox" ${on ? 'checked' : ''}>
        <span class="pack-name"></span>
        <span class="dim pack-meta"></span>
      </label>
      <div class="pack-actions">
        <button class="px-btn sm act-update" title="检查这个来源有没有新版本"><i class="ri-download-cloud-2-line"></i>更新</button>
        <button class="px-btn sm act-remove" title="卸载"><i class="ri-delete-bin-line"></i></button>
      </div>`;
    row.querySelector('.pack-name').textContent = `${Packs.displayName(p.name)}  v${p.version}`;
    row.querySelector('.pack-meta').textContent =
      `${p.label} · 贴纸 ${counts.sticker || 0} · 底板 ${counts.board || 0} · 桌面 ${counts.background || 0} · 音乐 ${counts.bgm || 0}` +
      `${counts.skin ? ` · 皮肤 ${counts.skin}` : ''} · ${fmtMB(p.bytes)} · ${p.license || '未注明许可'}`;
    if (p.skipped?.length) {   // 装的时候不认识的条目：说清楚跳过了什么，升级游戏后点「更新」补装
      const sk = document.createElement('div');
      sk.className = 'pack-skipped';
      sk.textContent = `跳过了 ${p.skipped.length} 个游戏还不认识的条目（${p.skipped.map(e => `${e.id}:${e.type}`).join('、')}），升级游戏后点「更新」补装`;
      row.querySelector('.pack-main').appendChild(sk);
    }
    row.querySelector('input').onchange = ev => {
      apply(state, { type: 'setPack', id: p.id, patch: { enabled: ev.target.checked } });
      refresh();
    };
    row.querySelector('.act-update').onclick = async ev => {
      ev.target.closest('button').disabled = true;
      try {
        const u = await Packs.checkUpdate(p);
        if (!u.available) showToast('已经是最新：' + u.label);
        else await install(p.source);
      } catch (e) { showToast('检查失败：' + e.message); }
      renderPackList();
    };
    row.querySelector('.act-remove').onclick = async () => {
      if (!confirm(`卸载「${Packs.displayName(p.name)}」？用了它的贴纸会显示为缺失，重新安装即可复原。`)) return;
      await Packs.uninstallPack(p.id);
      apply(state, { type: 'forgetPack', id: p.id });
      showToast('已卸载');
      await refresh();
    };
    packList.appendChild(row);
  }
}
// 皮肤列表：默认主题 + 启用包里的每个 skin 条目。读配置是异步的，用序号防止两次渲染交错
const skinList = $('#skin-list');
let skinListSeq = 0;
async function renderSkinList() {
  const my = ++skinListSeq;
  const cur = resolveRef(state.settings.skinRef) ? state.settings.skinRef : null;
  const items = [{ ref: null, name: '默认主题', swatch: ['#4a2e22', '#fff6e3', '#ff7fb0'], meta: '游戏自带' }];
  for (const ref of refsOfType('skin')) {
    const h = resolveRef(ref);
    try {
      const cfg = await readSkin(h);
      items.push({ ref, name: cfg.name, swatch: cfg.swatch, preview: cfg.preview && await Packs.urlFor(cfg.preview), warn: cfg.warn.length, meta: Packs.displayName(h.pack.name) });
    } catch (e) {
      items.push({ ref, name: h.entry.id, swatch: ['#888', '#ccc', '#aaa'], meta: '读取失败：' + e.message });
    }
  }
  if (my !== skinListSeq) return;
  skinList.innerHTML = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'skin-card' + (it.ref === cur ? ' on' : '');
    card.innerHTML = '<div class="skin-thumb"></div><div class="skin-main"><div class="skin-name"></div><div class="dim skin-meta"></div></div>';
    const thumb = card.querySelector('.skin-thumb');
    if (it.preview) { const img = document.createElement('img'); img.src = it.preview; img.alt = ''; thumb.appendChild(img); }
    else for (const c of it.swatch) { const s = document.createElement('span'); s.style.background = c; thumb.appendChild(s); }   // swatch 里的值都过了白名单
    card.querySelector('.skin-name').textContent = it.name;
    card.querySelector('.skin-meta').textContent = it.meta + (it.warn ? ` · ${it.warn} 处配置被忽略（详情看控制台）` : '');
    card.onclick = () => setSkin(it.ref);
    skinList.appendChild(card);
  }
}
$('#btn-add').onclick = async () => {
  const v = $('#pack-input').value.trim();
  if (!v) return;
  $('#pack-input').value = '';
  await install(v);
};
$('#pack-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-add').click(); });
$('#btn-default').onclick = installDefault;

// 存档导入导出
function exportSave() {
  const data = { app: 'petal-pop', version: STATE_VERSION, exportedAt: new Date().toISOString(), state };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `petal-pop-存档-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast('存档已导出');
}
async function importSave(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { return showToast('这个文件不是 JSON'); }
  const raw = obj?.app === 'petal-pop' ? obj.state : obj;
  if (!raw || typeof raw !== 'object' || !raw.projects) return showToast('不是花漾贴贴的存档');
  if (!confirm('导入会覆盖当前存档（素材包不受影响），继续？')) return;
  state = normalize(raw);
  history.length = 0;
  select(null);
  await reloadPacks();
  fillDefaults();
  await syncSkin();
  save();
  await render();
  const missing = project(state).items.filter(i => !resolveRef(i.ref)).length;
  showToast(missing ? `已导入，${missing} 张贴纸所在的素材包还没装` : '已导入');
  modal.hidden = true;
}
$('#btn-export').onclick = exportSave;
$('#btn-import').onclick = () => $('#import-file').click();
$('#import-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importSave(f); };

// 存储
async function renderStorage() {
  const info = await Packs.storageInfo();
  const blobs = (await DB.keys('blobs')).length;
  const packBytes = installed.reduce((s, p) => s + p.bytes, 0);
  $('#storage-info').innerHTML = info
    ? `本站点已用 <b>${fmtMB(info.usage)}</b> / 浏览器允许 <b>${fmtMB(info.quota)}</b><br>素材包 ${installed.length} 个，合计 ${fmtMB(packBytes)}；文件 ${blobs} 个（按内容去重后）`
    : '这个浏览器不提供用量信息';
}
$('#btn-gc').onclick = async () => { const n = await Packs.gc(); showToast(`清掉了 ${n} 个无引用文件`); renderStorage(); };
$('#btn-wipe').onclick = async () => {
  if (!confirm('清空全部本地数据：素材包缓存、存档、设置都会删掉，页面会重新加载。继续？')) return;
  if (!confirm('再确认一次：存档没导出的话就找不回来了。真的清空？')) return;
  await Promise.all([DB.clear('kv'), DB.clear('blobs'), DB.clear('packs')]);
  location.reload();
};

// 音量
const vol = $('#volume');
vol.value = Math.round(state.settings.volume * 100);
vol.oninput = () => { apply(state, { type: 'setSetting', patch: { volume: vol.value / 100 } }); audio.volume = state.settings.volume; save(); };

// ---------- 启动 ----------
try { await navigator.storage?.persist?.(); } catch {}
await reloadPacks();
if (!installed.length) {
  await installDefault();
} else {
  // 旧版安装器装的包：清单里后来加的字段（比如贴纸纸排版）没存下来，悄悄重装一次；文件没变的不会重下
  const stale = installed.filter(p => p.installer !== Packs.INSTALLER);
  for (const p of stale) await install(p.source);
  if (!stale.length) { hideLoading(); await refresh(); }
}
