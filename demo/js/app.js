// 花漾贴贴 · 运行时内核入口
// 内核只认几种槽位：background / board / sticker / bgm，外加界面皮肤 skin。所有内容都来自素材包。
import { DB } from './db.js';
import * as Packs from './packs.js';
import { normalize, apply, project, findItem, STATE_VERSION } from './state.js';
import { createRenderer } from './render.js';
import { createStrips } from './strips.js';
import { silhouetteOf } from './silhouette.js';
import { createPeeler, DETACH_AT } from './peel.js';
import { applySkin, clearSkin, readSkin, preloadSkinCache } from './skin.js';

preloadSkinCache();   // 赶在读存档、装包之前先把上次的皮肤颜色刷上，加载页不闪默认色
const STAGE_W = 1672, STAGE_H = 941;
// 默认包来源，按顺序试：本地开发目录 → GitHub 资源仓库（线上部署时本地目录不存在）
const DEFAULT_SOURCES = ['local:packs/default', 'Aezir/petal-pop-assets'];
const $ = s => document.querySelector(s);

const viewport = $('#viewport'), world = $('#world'), zoomReadout = $('#zoom-readout'), stripsEl = $('#strips'), sideEl = $('#side'),
      topbar = $('#topbar'), layer = $('#layer'), boardWrap = $('#boardWrap'), boardEl = $('#board'),
      boardLayer = $('#boardLayer'), toast = $('#toast'), audio = $('#bgm'), loading = $('#loading'), loadText = $('#load-text'),
      bar = $('#bar'), modal = $('#modal'), packList = $('#pack-list');

// 撕贴纸用的 WebGL 层；浏览器不支持 WebGL 时为 null，贴纸从边缘按下就直接拿起
const peeler = createPeeler($('#peel'));

// ---------- 桌面（锁死）与本子（能缩放） ----------
// 桌面背景是锁死的：#world 铺满整个窗口（cover：按长边贴合、居中、多出来的部分裁掉），
// 只有窗口大小会改变 fit，玩家怎么操作都不动它。工具行和两个面板浮在它上面，开合不挤压画面。
// 能放大缩小的是本子（画布）：#boardWrap 的 scale(boardZ)，存在 project.boardZ 里。
const ZMIN = 0.25, ZMAX = 4;
const clampZ = z => Math.min(ZMAX, Math.max(ZMIN, z));
// fit = 每桌面单位多少屏幕像素；fitX/fitY 是世界层左上角在窗口里的位置（cover 时通常是负的）
let fit = 1, fitX = 0, fitY = 0;
function applyFit() {
  const vw = innerWidth, vh = innerHeight;
  fit = Math.max(vw / STAGE_W, vh / STAGE_H);
  fitX = (vw - STAGE_W * fit) / 2;
  fitY = (vh - STAGE_H * fit) / 2;
  world.style.transform = `translate(${fitX}px,${fitY}px) scale(${fit})`;
}
const boardZ = () => project(state).boardZ;
function syncZoom() { zoomReadout.textContent = Math.round(boardZ() * 100) + '%'; }
// 滚轮缩放本子：把鼠标底下那个「本子上的点」钉住不动。本子锚点在中心，所以缩放同时要挪 boardT。
// 走 apply 不走 commit：缩放不是对作品的改动，不打快照、不清重做栈
function boardZoomAt(clientX, clientY, factor) {
  const p = project(state), z0 = p.boardZ, z1 = clampZ(z0 * factor);
  if (Math.abs(z1 - z0) < 1e-6) return;
  const pt = toStage({ clientX, clientY });                                  // 鼠标处的桌面坐标（不会变）
  const l = { x: (pt.x - p.boardT.x) / z0, y: (pt.y - p.boardT.y) / z0 };    // 它落在本子上的哪一点
  apply(state, { type: 'boardZoom', z: z1 });
  apply(state, { type: 'boardMove', x: pt.x - l.x * p.boardZ, y: pt.y - l.y * p.boardZ });
  syncZoom(); save(); paint();
}
addEventListener('resize', () => { applyFit(); peeler?.resize(); });
applyFit();
peeler?.resize();
// 工具行换行会变高，两个面板要跟着往下让
new ResizeObserver(() => viewport.style.setProperty('--bar-h', topbar.offsetHeight + 'px')).observe(topbar);

// ---------- 状态 ----------
let state = normalize(await DB.get('kv', 'state').catch(() => null));
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.put('kv', 'state', state).catch(console.warn), 150);
}
syncZoom();
syncPanels();

// ---------- 素材包索引 ----------
let installed = [];          // 已安装（DB 里的记录）
let enabledPacks = [];       // 启用中，按 order 排
const refIndex = new Map();  // 'pack:id' → { pack, entry }

// 包的分类按内容推导：有贴纸的算「贴纸」，只有本子/桌面/音乐/皮肤的算「美化」
const catOf = p => (p.entries.some(e => e.type === 'sticker') ? 'sticker' : 'deco');
// 排序：置顶的在前，然后按 order；这个顺序同时决定左栏列表、右栏贴纸条、换本子/桌面/皮肤的循环顺序
const packCmp = (a, b) => {
  const ma = state.packs[a.id] || {}, mb = state.packs[b.id] || {};
  return (+!!mb.pinned - +!!ma.pinned) || ((ma.order || 0) - (mb.order || 0)) || Packs.displayName(a.name).localeCompare(Packs.displayName(b.name));
};
async function reloadPacks() {
  installed = await Packs.listPacks();
  for (const p of installed) if (!state.packs[p.id]) apply(state, { type: 'setPack', id: p.id, patch: {} });
  enabledPacks = installed.filter(p => state.packs[p.id]?.enabled !== false).sort(packCmp);
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
const strips = createStrips({
  root: stripsEl, urlOf: Packs.urlSync, nameOf: Packs.displayName, ui: () => state.ui,
  onToggle: (id, collapsed) => { apply(state, { type: 'setStripUi', id, patch: { collapsed } }); save(); paint(); },
});
// 贴纸的世界尺寸 = 原图尺寸 × 所在包的比例（768×512 规则，见 strips.js）。条上的缩略图另有自己的比例，不影响它
function sizeOf(ref) {
  const h = resolveRef(ref);
  if (!h) return null;
  const k = strips.scaleOf(h.pack.id);
  return { w: h.entry.w * k, h: h.entry.h * k, smooth: k < 0.999 };
}
const renderer = createRenderer({ stage: world, layer, boardWrap, boardEl, boardLayer, resolveRef, sizeOf });
const usedRefs = () => new Set(project(state).items.map(i => i.ref));
// 同步重画（图片地址已经备好时用）。先画条：条算出各包的比例，贴纸按它定尺寸
function paint() {
  strips.render(enabledPacks, usedRefs());
  renderer.render(state, view(), sel);
  syncZoom();   // 撤销/导入存档可能把 boardZ 一起换掉，读数跟着状态走
}
async function render() {
  await ensureUrls();
  paint();
  syncBgm();
  syncHistoryButtons();
}

// ---------- 撤销 / 重做 ----------
// 两条快照栈：改动前把当前作品整份存进 past；撤销 = 当前进 future、取 past 顶；重做反过来。任何新改动清空 future
const past = [], future = [];
function snapshot() {
  past.push(structuredClone(project(state)));
  if (past.length > 60) past.shift();
  future.length = 0;
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
function restore(snap, to) {
  to.push(structuredClone(project(state)));
  state.projects[snap.id] = snap;
  lastCommit = { type: '', t: 0 };
  save();
  render();
}
function undo() { const s = past.pop(); s ? restore(s, future) : showToast('没有可撤销的了'); }
function redo() { const s = future.pop(); s ? restore(s, past) : showToast('没有可重做的了'); }
function syncHistoryButtons() {
  $('#btn-undo').disabled = !past.length;
  $('#btn-redo').disabled = !future.length;
}

// ---------- 坐标 ----------
// 两套坐标：桌面坐标（1672×941 的世界，屏幕 = 桌面 × fit + fitX/fitY）和本子局部坐标（以本子中心为原点，屏幕 = ... × fit × boardZ）。
// 存档里 on:'desk' 的贴纸用桌面坐标，on:'board' 的用本子局部坐标。
const toStage = e => ({ x: (e.clientX - fitX) / fit, y: (e.clientY - fitY) / fit });
const toScreen = pt => ({ x: fitX + pt.x * fit, y: fitY + pt.y * fit });
function inside(el, e) {
  if (el.hidden) return false;
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
// 桌面坐标 ⇄ 本子局部坐标：本子挪了（boardT）也缩放了（boardZ），两边都要算
const stageToBoard = (pt, p) => ({ x: (pt.x - p.boardT.x) / p.boardZ, y: (pt.y - p.boardT.y) / p.boardZ });
const boardToStage = (pt, p) => ({ x: p.boardT.x + pt.x * p.boardZ, y: p.boardT.y + pt.y * p.boardZ });
const overBoard = e => !boardWrap.hidden && inside(boardEl, e);
// 浮层（工具行、两个面板、弹窗）上的指针事件不算点在桌面上
const overUi = e => !!e.target?.closest?.('#topbar,#side,#strips,.modal,#loading');
// 舞台上的一段位移 → 贴纸自身坐标（去掉贴纸的旋转，y 向下）
function unrotate(dx, dy, rot) {
  const r = -rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// ---------- 命中检测 ----------
// 画布上的指针事件统一在这里判断点到了谁，从上往下找：桌上的贴纸 → 本子上的贴纸 → 本子。贴纸条上的格子另走 stripsEl 的 pointerdown。
// 贴纸只认图案本身（透明的角落点不到）；离轮廓边缘近的地方才撕得起来（edge）。
// 全部在屏幕像素里算：k = 每世界单位多少屏幕像素（桌上的贴纸 = fit，本子上的 = fit × boardZ，条上的 = 缩略比例）。
// 轮廓按显示尺寸建、键里带宽度，所以边缘热区在任何缩放下手感一致，撕纸层也直接吃这些屏幕量
function hitSticker(pt, c, rot, ref, el, k) {
  const h = resolveRef(ref), size = sizeOf(ref);
  const w = (size ? size.w : 110) * k, hh = (size ? size.h : 110) * k;   // 缺图的占位块是 110×110
  const l = unrotate(pt.x - c.x, pt.y - c.y, rot);
  if (Math.abs(l.x) > w / 2 || Math.abs(l.y) > hh / 2) return null;
  const sil = h && el?.tagName === 'IMG' ? silhouetteOf(`${h.entry.sha256}@${Math.round(w)}`, el, w, hh) : null;
  if (sil && !sil.opaque(l.x, l.y)) return null;
  return { local: l, sil, w, h: hh, smooth: !!size?.smooth, c, rot, ref, el, k, edge: sil ? sil.nearEdge(l.x, l.y) : true };
}
function hitTest(e) {
  const pt = { x: e.clientX, y: e.clientY }, p = project(state), byZ = (a, b) => b.z - a.z;
  for (const it of p.items.filter(i => i.on === 'desk').sort(byZ)) {
    const hit = hitSticker(pt, toScreen(it), it.rot, it.ref, renderer.node(it.uid), fit);
    if (hit) return { kind: 'item', uid: it.uid, ...hit };
  }
  if (boardWrap.hidden) return null;
  for (const it of p.items.filter(i => i.on === 'board').sort(byZ)) {
    const hit = hitSticker(pt, toScreen(boardToStage(it, p)), it.rot, it.ref, renderer.node(it.uid), fit * p.boardZ);
    if (hit) return { kind: 'item', uid: it.uid, ...hit };
  }
  return inside(boardEl, e) ? { kind: 'board' } : null;
}
const cursorFor = hit => !hit ? '' : hit.kind === 'board' ? 'move' : hit.edge ? 'grab' : 'default';

// ---------- 撕、拿、贴 ----------
// drag = { kind:'peel', src, handle, start }            正在从边缘揭起，还没离开
// drag = { kind:'hold', uid, dx, dy, handle, unrolling } 整张拿在手上，跟着手走
// drag = { kind:'board', dx, dy, snapped }              挪本子
let drag = null;
let hintAt = 0;

function hintEdge() {   // 按在贴纸中间：真贴纸抠不起来，提示一下
  if (Date.now() - hintAt > 4000) { hintAt = Date.now(); showToast('从贴纸边缘撕起来'); }
}
// 浮层上的按下事件到此为止，别被当成"点在桌面上"（贴纸条自己的撕纸那条路在它自己的监听里已经处理过了）
for (const el of [topbar, sideEl, stripsEl]) el.addEventListener('pointerdown', e => e.stopPropagation());
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const hit = hitTest(e), pt = toStage(e), p = project(state);
  if (!hit) { select(null); render(); return; }   // 点空白 = 取消选中（背景锁死，没有平移）
  if (hit.kind === 'board') {
    const t = p.boardT;
    drag = { kind: 'board', dx: t.x - pt.x, dy: t.y - pt.y, snapped: false };   // 快照等真的动了再打：点一下不算改动，不清重做栈
    select({ kind: 'board' });
    render();
    return;
  }
  if (!hit.edge) { hintEdge(); render(); return; }
  viewport.style.cursor = 'grabbing';
  startPeel(hit, e);
});
// 贴纸条上的格子：同一套撕法，k 换成这个包的缩略比例。不抓指针（拖出去的那张图片在画布世界里）。
// 贴纸是按轮廓见缝插针排的，包围盒会互相重叠，所以不能看 event.target：
// 从最上面那张往下逐个按透明度试，上面那张的透明角落会自然"漏"到下面那张
function slotHitAt(clientX, clientY, { skipUsed = true } = {}) {
  for (const s of strips.slotsAt(clientX, clientY)) {
    if (skipUsed && s.used) continue;   // 撕走的格子只留刀模空位，穿过去找下面那张
    const r = s.rect;
    const hit = hitSticker({ x: clientX, y: clientY }, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, 0, s.ref, s.img, strips.thumbKOf(s.packId));
    if (hit) return { slot: s, hit };
  }
  return null;
}
stripsEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('.strip-head')) return;
  const found = slotHitAt(e.clientX, e.clientY);
  if (!found) return;
  e.preventDefault();
  hideTip();
  if (!found.hit.edge) return hintEdge();
  startPeel(found.hit, e);
});

// 悬停提示：贴纸名（没有就 #编号）+ 包名。同样按透明度找是哪一张，撕走的格子也报得出来
const tipEl = $('#tip');
let tipRef = null;
function hideTip() { tipEl.hidden = true; tipRef = null; }
stripsEl.addEventListener('pointermove', e => {
  if (drag || e.buttons) return hideTip();
  const found = slotHitAt(e.clientX, e.clientY, { skipUsed: false });
  if (!found) return hideTip();
  const s = found.slot;
  if (s.ref !== tipRef) {
    tipRef = s.ref;
    tipEl.innerHTML = '<b></b><span></span>';
    tipEl.querySelector('b').textContent = s.label;
    tipEl.querySelector('span').textContent = s.packName;
  }
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 8) + 'px';
  tipEl.style.top = Math.min(e.clientY + 16, innerHeight - r.height - 8) + 'px';
});
stripsEl.addEventListener('pointerleave', hideTip);

// 快照不在这里打，等真的揭下来那一刻（pickUp 之前）再打：撕到一半放弃不算一次改动，也不该清掉重做栈。
// 撕纸层按屏幕像素画（w/h/c/grab 都是屏幕量）；捏点另存一份世界局部坐标（除以 k）给 pickUp 定位用
function startPeel(hit, e) {
  const src = { uid: hit.uid ?? null, ref: hit.ref, rot: hit.rot, el: hit.el, k: hit.k, grab: { x: hit.local.x / hit.k, y: hit.local.y / hit.k } };
  const handle = peeler && hit.sil
    ? peeler.begin({ key: resolveRef(hit.ref).entry.sha256, img: hit.el, w: hit.w, h: hit.h, smooth: hit.smooth, c: hit.c, rot: hit.rot, grab: hit.local, sil: hit.sil })
    : null;
  if (!handle) { snapshot(); pickUp(src, toStage(e), null); return; }
  hit.el.style.visibility = 'hidden';
  drag = { kind: 'peel', src, handle, start: { x: e.clientX, y: e.clientY } };
}

// 整张离开：放进状态（桌面坐标、最上层），之后跟着手走。
// 捏住的那一点（src.grab）始终在指尖下面，所以贴纸中心 = 指尖 − 捏点相对中心的偏移（带上贴纸的旋转）
function pickUp(src, pt, handle) {
  const off = unrotate(src.grab.x, src.grab.y, -src.rot);
  const c = { x: pt.x - off.x, y: pt.y - off.y };
  let uid = src.uid;
  if (uid == null) {
    uid = apply(state, { type: 'place', ref: src.ref, x: c.x, y: c.y, rot: src.rot, on: 'desk' });
    src.el.style.visibility = '';   // 条上那一格交给 used 样式：露出底纸上的空位
  } else {
    apply(state, { type: 'move', uid, x: c.x, y: c.y, on: 'desk' });
    apply(state, { type: 'front', uid });
  }
  paint();
  const el = renderer.node(uid);
  // 从条上撕下来的那张：交接时从缩略尺寸"弹"到画布上的实际尺寸（独立的 scale 属性，不碰 placeStyle 的 transform）
  // 刚撕下来的贴纸一律先落在桌面层，显示比例就是 fit；落到本子上要等松手那一刻才换算
  const pop = () => {
    if (!el || Math.abs(src.k / fit - 1) < 0.02) return;
    el.style.setProperty('--pop-from', src.k / fit);
    el.classList.add('pop');
    el.addEventListener('animationend', () => el.classList.remove('pop'), { once: true });
  };
  drag = { kind: 'hold', uid, dx: -off.x, dy: -off.y, handle, unrolling: !!handle };
  if (!handle) { el?.classList.add('dragging'); pop(); return; }
  // 卷边在 WebGL 里展平、抬起来并滑到指尖下，播完再换成普通图片接着跟手
  if (el) el.style.visibility = 'hidden';
  const sc = toScreen(c);
  handle.detach(sc.x, sc.y).then(() => {
    if (el) el.style.visibility = '';
    pop();
    if (drag?.kind === 'hold' && drag.uid === uid) { drag.unrolling = false; el?.classList.add('dragging'); }
  });
}

// 松手：落在贴纸条上就放回去；落在本子上就贴在本子上（转局部坐标）；否则贴在桌面
function settle(d, e) {
  const p = project(state), el = renderer.node(d.uid);
  el?.classList.remove('dragging');
  if (inside(stripsEl, e)) {
    apply(state, { type: 'remove', uids: [d.uid] });
    return;
  }
  // 拿在手上时贴纸一直用桌面坐标，落到本子上才换算（本子可能被放大缩小过，所以要连 boardZ 一起除）
  const onBoard = overBoard(e), it = findItem(p, d.uid);
  const pos = onBoard ? stageToBoard(it, p) : it;
  apply(state, { type: 'move', uid: d.uid, x: pos.x, y: pos.y, on: onBoard ? 'board' : 'desk' });   // 就贴在松手的地方，不做落下动画
}

// 没揭下来就松手：弹回贴平，状态没变（快照还没打，撤销/重做栈都不动）
function springBack(d) {
  d.handle.release().then(() => { d.src.el.style.visibility = ''; });
}

addEventListener('pointermove', e => {
  if (!drag) {
    if (!overUi(e) && viewport.contains(e.target)) viewport.style.cursor = cursorFor(hitTest(e));
    else viewport.style.cursor = '';
    return;
  }
  const pt = toStage(e);
  if (drag.kind === 'peel') {
    const { src, handle, start } = drag;
    const d = unrotate(e.clientX - start.x, e.clientY - start.y, src.rot);   // 屏幕像素
    if (handle.update(d.x, d.y) >= DETACH_AT) { snapshot(); pickUp(src, pt, handle); }
  } else if (drag.kind === 'hold') {
    const x = pt.x + drag.dx, y = pt.y + drag.dy;
    apply(state, { type: 'move', uid: drag.uid, x, y });
    const el = renderer.node(drag.uid), it = findItem(project(state), drag.uid);
    if (el && it) renderer.placeStyle(el, it);
    if (drag.unrolling) { const s = toScreen({ x, y }); drag.handle.moveTo(s.x, s.y); }
  } else {
    if (!drag.snapped) { snapshot(); drag.snapped = true; }
    apply(state, { type: 'boardMove', x: pt.x + drag.dx, y: pt.y + drag.dy });
    paint();
  }
});
addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  viewport.style.cursor = '';
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

// 滚轮：默认以鼠标为中心缩放本子（桌面背景不动）；按住 R 且指着贴纸时改为转贴纸。撕到一半时不响应。
// 滚在浮层面板上就让它自己滚，别去缩放本子
let rHeld = false;
viewport.addEventListener('wheel', e => {
  if (overUi(e)) return;
  e.preventDefault();
  if (drag?.kind === 'peel') return;
  const hit = rHeld ? hitTest(e) : null;
  if (hit?.kind !== 'item') {
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    boardZoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
    return;
  }
  const it = findItem(project(state), hit.uid), d = e.deltaY || e.deltaX;
  commit({ type: 'rotate', uid: it.uid, rot: it.rot + (d < 0 ? -5 : 5) }, { coalesce: true });
  render();
}, { passive: false });

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === 'r' && !mod) rHeld = true;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { if (!modal.hidden) modal.hidden = true; else { select(null); render(); } return; }
});
addEventListener('keyup', e => { if (e.key.toLowerCase() === 'r') rHeld = false; });
addEventListener('blur', () => { rHeld = false; });   // 按着 R 切走窗口，回来时别还当它按着

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
$('#btn-redo').onclick = redo;
// 本子回到 100%：锚点就是本子中心，只改 boardZ 就地缩回去，本子不会跑位
$('#btn-zoom-reset').onclick = () => {
  if (Math.abs(boardZ() - 1) < 1e-6) return;
  apply(state, { type: 'boardZoom', z: 1 });
  syncZoom(); save(); paint();
};
// 两个浮层面板：开合只是盖住 / 让开画面，桌面和本子一动不动
function syncPanels() {
  sideEl.hidden = !state.ui.sideOpen;
  stripsEl.hidden = !state.ui.stripsOpen;
  $('#btn-side').classList.toggle('on', state.ui.sideOpen);
  $('#btn-strips').classList.toggle('on', state.ui.stripsOpen);
}
function togglePanel(key) {
  apply(state, { type: 'setUi', patch: { [key]: !state.ui[key] } });
  syncPanels(); save();
}
$('#btn-side').onclick = () => togglePanel('sideOpen');
$('#btn-strips').onclick = () => togglePanel('stripsOpen');
$('#btn-side-toggle').onclick = () => togglePanel('sideOpen');
$('#btn-clear').onclick = () => {
  if (!project(state).items.length) return;
  commit({ type: 'clear' }); select(null); render();
  showToast('全部放回贴纸条啦（Ctrl+Z 可反悔）');
};

// ---------- 设置页 ----------
const tabs = modal.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  modal.querySelectorAll('[data-pane]').forEach(s => { s.hidden = s.dataset.pane !== name; });
  if (name === 'skins') renderSkinList();
  if (name === 'storage') renderStorage();
}
tabs.forEach(t => { t.onclick = () => showTab(t.dataset.tab); });
$('#btn-settings').onclick = () => { modal.hidden = false; showTab('skins'); };
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
  save();
  renderPackList();
  if (!modal.hidden) renderSkinList();
}

const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';
// 左栏图包列表：分类 chip 过滤，置顶在前；每行 启用 / 名称 / 元信息 / 上移 下移 置顶 收藏 更新 卸载
let packCat = 'all';
$('#pack-chips').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; packCat = c.dataset.cat; renderPackList(); };
function renderPackList() {
  const sorted = [...installed].sort(packCmp);
  const counts = { all: sorted.length, sticker: 0, deco: 0 };
  for (const p of sorted) counts[catOf(p)]++;
  for (const c of $('#pack-chips').querySelectorAll('.chip')) {
    c.classList.toggle('on', c.dataset.cat === packCat);
    c.querySelector('i').textContent = counts[c.dataset.cat] || '';
  }
  const shown = sorted.filter(p => packCat === 'all' || catOf(p) === packCat);
  packList.innerHTML = '';
  if (!shown.length) { packList.innerHTML = `<div class="dim side-help">${installed.length ? '这个分类下没有包' : '还没有素材包'}</div>`; return; }
  for (const p of shown) {
    const meta = state.packs[p.id] || {}, on = meta.enabled !== false;
    const row = document.createElement('div');
    row.className = 'pack-row' + (on ? '' : ' off') + (meta.pinned ? ' pinned' : '');
    const n = {};
    for (const e of p.entries) n[e.type] = (n[e.type] || 0) + 1;
    row.innerHTML = `
      <div class="pack-main">
        <input type="checkbox" title="启用 / 停用" ${on ? 'checked' : ''}>
        <span class="pack-name"></span>
      </div>
      <div class="pack-meta"></div>
      <div class="pack-actions">
        <button class="btn icon act-up" title="上移"><i class="ri-arrow-up-s-line"></i></button>
        <button class="btn icon act-down" title="下移"><i class="ri-arrow-down-s-line"></i></button>
        <button class="btn icon act-pin${meta.pinned ? ' lit' : ''}" title="${meta.pinned ? '取消置顶' : '置顶'}"><i class="${meta.pinned ? 'ri-pushpin-fill' : 'ri-pushpin-line'}"></i></button>
        <button class="btn icon act-fav${meta.fav ? ' lit' : ''}" title="${meta.fav ? '取消收藏' : '收藏'}"><i class="${meta.fav ? 'ri-star-fill' : 'ri-star-line'}"></i></button>
        <button class="btn icon act-update" title="检查这个来源有没有新版本"><i class="ri-download-cloud-2-line"></i></button>
        <button class="btn icon danger act-remove" title="卸载"><i class="ri-delete-bin-line"></i></button>
      </div>`;
    const name = row.querySelector('.pack-name');
    name.textContent = `${Packs.displayName(p.name)}  v${p.version}`;
    name.title = p.label;
    row.querySelector('.pack-meta').textContent =
      `贴纸 ${n.sticker || 0} · 本子 ${n.board || 0} · 桌面 ${n.background || 0} · 音乐 ${n.bgm || 0}${n.skin ? ` · 皮肤 ${n.skin}` : ''} · ${fmtMB(p.bytes)} · ${p.license || '未注明许可'}`;
    if (p.skipped?.length) {   // 装的时候不认识的条目：说清楚跳过了什么，升级游戏后点「更新」补装
      const sk = document.createElement('div');
      sk.className = 'pack-skipped';
      sk.textContent = `跳过了 ${p.skipped.length} 个游戏还不认识的条目（${p.skipped.map(e => `${e.id}:${e.type}`).join('、')}），升级游戏后点「更新」补装`;
      row.querySelector('.pack-meta').after(sk);
    }
    const box = row.querySelector('input');
    box.onchange = () => { apply(state, { type: 'setPack', id: p.id, patch: { enabled: box.checked } }); refresh(); };
    name.onclick = () => { box.checked = !box.checked; box.onchange(); };
    // 上移 / 下移：只和同一置顶组里的邻居换位置（换的是排序后整份列表里的位置，然后按新顺序重编 order）
    const swap = dir => {
      const ids = sorted.map(q => q.id), i = ids.indexOf(p.id), j = i + dir;
      if (j < 0 || j >= ids.length || !!state.packs[ids[j]]?.pinned !== !!meta.pinned) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      apply(state, { type: 'packOrder', ids });
      refresh();
    };
    row.querySelector('.act-up').onclick = () => swap(-1);
    row.querySelector('.act-down').onclick = () => swap(1);
    row.querySelector('.act-pin').onclick = () => { apply(state, { type: 'setPack', id: p.id, patch: { pinned: !meta.pinned } }); refresh(); };
    row.querySelector('.act-fav').onclick = () => { apply(state, { type: 'setPack', id: p.id, patch: { fav: !meta.fav } }); save(); renderPackList(); };
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
  past.length = future.length = 0;
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
