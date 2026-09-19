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
import { attachScrollbar } from './scrollbar.js';

preloadSkinCache();   // 赶在读存档、装包之前先把上次的皮肤颜色刷上，加载页不闪默认色
const STAGE_W = 1672, STAGE_H = 941;
// 默认包来源，按顺序试：本地开发目录 → GitHub 资源仓库（线上部署时本地目录不存在）
const DEFAULT_SOURCES = ['local:packs/default', 'Aezir/petal-pop-assets'];
const $ = s => document.querySelector(s);

const viewport = $('#viewport'), world = $('#world'), zoomReadout = $('#zoom-readout'), stripsEl = $('#strips'), sideEl = $('#side'),
      topbar = $('#topbar'), handEl = $('#hand'), layer = $('#layer'), boardsHost = $('#boards'), toast = $('#toast'), audio = $('#bgm'), loading = $('#loading'), loadText = $('#load-text'),
      bar = $('#bar'), modal = $('#modal'), packList = $('#pack-list');

// 撕贴纸用的 WebGL 层；浏览器不支持 WebGL 时为 null，贴纸从边缘按下就直接拿起
const peeler = createPeeler($('#peel'));

// ---------- 桌面（锁死）与本子（能缩放） ----------
// 桌面背景是锁死的：#world 铺满整个窗口（cover：按长边贴合、居中、多出来的部分裁掉），
// 只有窗口大小会改变 fit，玩家怎么操作都不动它。工具行和两个面板浮在它上面，开合不挤压画面。
// 能放大缩小的是本子（画布）：每本 .board-wrap 的 scale(boardZ)，存在 project.boardZ 里。
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
  const pt = toStage({ clientX, clientY });   // 鼠标处的桌面坐标（背景锁死，这个点永远不动）
  apply(state, { type: 'boardZoom', z: z1 });
  const k = p.boardZ / z0;
  // 每本本子的位置都绕这个点缩放：这样整桌东西是一次以鼠标为中心的整体缩放，鼠标底下那个点不漂
  for (const b of [...p.boards]) apply(state, { type: 'boardMove', id: b.id, x: pt.x + (b.x - pt.x) * k, y: pt.y + (b.y - pt.y) * k });
  syncZoom(); save(); paint();
}
addEventListener('resize', () => { applyFit(); peeler?.resize(); });
applyFit();
peeler?.resize();
// 工具行换行会变高，两个面板要跟着往下让
new ResizeObserver(() => viewport.style.setProperty('--bar-h', topbar.offsetHeight + 'px')).observe(topbar);
// 所有能滚的地方都换成自绘滚动条：原生的占宽度（贴纸条就撑不满了），也配不上皮肤
for (const el of [stripsEl, sideEl, packList]) attachScrollbar(el);
for (const el of modal.querySelectorAll('[data-pane], #skin-list')) attachScrollbar(el, { z: 95 });

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
// 排序：置顶的永远在上面，组内再按 ui.packSort（自定义 = 拖出来的 order / 名称 / 添加时间）。
// 算出来的顺序是唯一真相：左栏列表、右栏贴纸条、换本子/桌面/皮肤的循环顺序都用它
const nameOfPack = p => Packs.displayName(p.name) || p.id;
const packCmp = (a, b) => {
  const ma = state.packs[a.id] || {}, mb = state.packs[b.id] || {};
  const pin = (+!!mb.pinned - +!!ma.pinned);
  if (pin) return pin;
  const { key, dir } = state.ui.packSort;
  let d = 0;
  if (key === 'name') d = nameOfPack(a).localeCompare(nameOfPack(b), 'zh');
  else if (key === 'added') d = (ma.addedAt || 0) - (mb.addedAt || 0);
  else d = (ma.order || 0) - (mb.order || 0);
  return (d * dir) || nameOfPack(a).localeCompare(nameOfPack(b), 'zh');
};
async function reloadPacks() {
  installed = await Packs.listPacks();
  // 老存档里的包没有 addedAt，拿 packs 表里的安装时间补上（那张表也没有就算 0）
  for (const p of installed) {
    if (!state.packs[p.id]) apply(state, { type: 'setPack', id: p.id, patch: {}, addedAt: p.installedAt || Date.now() });
    else if (!state.packs[p.id].addedAt) apply(state, { type: 'setPack', id: p.id, patch: { addedAt: p.installedAt || 0 } });
  }
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
  if (!p.seeded) { const r = refsOfType('board')[0]; if (r) apply(state, { type: 'addBoard', ref: r }); p.seeded = true; }
  if (p.background == null) p.background = refsOfType('background')[0] || null;
  if (state.settings.bgmRef == null) state.settings.bgmRef = refsOfType('bgm')[0] || null;
}
const effective = (type, ref) => (resolveRef(ref) ? ref : refsOfType(type)[0] || null);
function view() {
  const p = project(state);
  return {
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
  const refs = [v.background, v.bgm, ...p.boards.map(b => b.ref), ...p.items.map(i => i.ref), ...refsOfType('sticker')];
  await Promise.all(refs.map(r => { const h = resolveRef(r); return h ? Packs.urlFor(h.entry.sha256) : null; }));
}

// ---------- 选中 ----------
let sel = null;   // { kind:'board', id } | null（本子被选中时描一圈粉边；贴纸没有选中状态）
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
const renderer = createRenderer({ stage: world, layer, boardHost: boardsHost, resolveRef, sizeOf });
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
// 桌面坐标 ⇄ 某一本本子的局部坐标：本子挪了（b.x/b.y）也缩放了（boardZ），两边都要算
const stageToBoard = (pt, b, p) => ({ x: (pt.x - b.x) / p.boardZ, y: (pt.y - b.y) / p.boardZ });
const boardToStage = (pt, b, p) => ({ x: b.x + pt.x * p.boardZ, y: b.y + pt.y * p.boardZ });
const boardOf = (p, id) => p.boards.find(b => b.id === id);
// 指针落在哪一本上：从最上面那本往下找（数组最后一本在最上面）
function boardAt(e) {
  const p = project(state);
  for (let i = p.boards.length - 1; i >= 0; i--) {
    const n = renderer.boardNode(p.boards[i].id);
    if (n && !n.wrap.hidden && inside(n.img, e)) return p.boards[i];
  }
  return null;
}
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
  // 本子从上往下：先试贴在这一本上的贴纸，再试本子自己，都没中就看下一本
  for (let i = p.boards.length - 1; i >= 0; i--) {
    const b = p.boards[i], n = renderer.boardNode(b.id);
    if (!n || n.wrap.hidden) continue;
    for (const it of p.items.filter(x => x.on === 'board' && x.board === b.id).sort(byZ)) {
      const hit = hitSticker(pt, toScreen(boardToStage(it, b, p)), it.rot, it.ref, renderer.node(it.uid), fit * p.boardZ);
      if (hit) return { kind: 'item', uid: it.uid, ...hit };
    }
    if (inside(n.img, e)) return { kind: 'board', id: b.id };
  }
  return null;
}
const cursorFor = hit => !hit ? '' : hit.kind === 'board' ? 'move' : hit.edge ? 'grab' : 'default';

// ---------- 撕、拿、贴 ----------
// drag = { kind:'peel', src, handle, start }            正在从边缘揭起，还没离开
// drag = { kind:'hold', uid, dx, dy, handle, unrolling } 整张拿在手上，跟着手走
// drag = { kind:'board', dx, dy, snapped }              挪本子
let drag = null;
let hintAt = 0;
// 双击贴纸 = 收回贴纸条。自己判，不用原生 dblclick：
// tapCand 是这一下按在谁身上（拉动超过 4px 就作废，那是在撕），松手时变成 lastTap；
// 下一次按在同一张上、间隔 ≤350ms、位置差 ≤4px 就算双击
const TAP_MS = 350, TAP_PX = 4;
let tapCand = null, lastTap = null;
const isDoubleTap = (uid, e) => !!lastTap && lastTap.uid === uid
  && Date.now() - lastTap.t <= TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= TAP_PX;

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
    apply(state, { type: 'boardFront', id: hit.id });   // 点过的那本挪到最上面
    const b = boardOf(p, hit.id);
    drag = { kind: 'board', id: hit.id, dx: b.x - pt.x, dy: b.y - pt.y, snapped: false };   // 快照等真的动了再打：点一下不算改动，不清重做栈
    select({ kind: 'board', id: hit.id });
    render();
    return;
  }
  // 双击一张贴出去的贴纸（桌面上的、本子上的都算）：收回贴纸条
  if (isDoubleTap(hit.uid, e)) {
    lastTap = tapCand = null;
    snapshot();
    apply(state, { type: 'remove', uids: [hit.uid] });
    save(); select(null); render();
    showToast('收回贴纸条（Ctrl+Z 可反悔）');
    return;
  }
  tapCand = { uid: hit.uid, x: e.clientX, y: e.clientY };
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
  if (!handle) { snapshot(); pickUp(src, e, null); return; }
  hit.el.style.visibility = 'hidden';
  drag = { kind: 'peel', src, handle, start: { x: e.clientX, y: e.clientY } };
}

// ---------- 拿在手上的那一张 ----------
// 手上的贴纸不跟着桌面层也不跟着本子层，而是单独挂在 #hand 里按屏幕像素画。
// 比例从脱离那一刻起**一直等于本子的比例**（fit × boardZ）——你是在给本子挑贴纸，手上看到的就该是它贴上去的大小。
// 捏住的那一点始终钉在指尖下面：中心 = 指尖 − 捏点偏移 × 当前比例，所以换比例时鼠标底下那个点不漂。
const POP_MS = 140;
const handK = () => fit * project(state).boardZ;
let hand = null;   // { el, uid, src, w, h, x, y, k, kFrom, kTo, t0, handle, raf }

function paintHand(now) {
  if (!hand) return false;
  const t = Math.min(1, (now - hand.t0) / POP_MS), ease = 1 - (1 - t) * (1 - t);
  hand.k = hand.kFrom + (hand.kTo - hand.kFrom) * ease;
  const off = unrotate(hand.src.grab.x, hand.src.grab.y, -hand.src.rot);
  const cx = hand.x - off.x * hand.k, cy = hand.y - off.y * hand.k;
  // 元素躺在 #hand 的 (0,0)、按自己的原始世界尺寸布局；这一串 transform 把它绕中心转好、缩放、再搬到 (cx,cy)
  hand.el.style.transform = `translate(${cx}px,${cy}px) scale(${hand.k}) rotate(${hand.src.rot}deg) translate(${-hand.w / 2}px,${-hand.h / 2}px)`;
  const d = toStage({ clientX: cx, clientY: cy });   // 状态里仍记桌面坐标，松手时才决定归桌面还是归本子
  apply(state, { type: 'move', uid: hand.uid, x: d.x, y: d.y });
  if (drag?.unrolling) hand.handle.moveTo(cx, cy);
  return t < 1;
}
function tick() {
  if (!hand || hand.raf) return;
  hand.raf = requestAnimationFrame(now => { if (!hand) return; hand.raf = 0; if (paintHand(now)) tick(); });
}
// 从缩略尺寸"弹"到本子比例：条上撕出来的那张起点是条上的缩略比例；画布上拿起来的本来就是这个比例，不弹
function popTo(k) {
  if (!hand) return;
  hand.kFrom = hand.k; hand.kTo = k;
  hand.t0 = Math.abs(k - hand.k) < 0.02 ? -1e9 : performance.now();
  paintHand(performance.now());
  tick();
}
function dropHand() {
  if (!hand) return;
  cancelAnimationFrame(hand.raf);
  hand.el.classList.remove('in-hand', 'dragging');
  hand.el.style.transformOrigin = '';
  hand.el.style.height = '';       // 还给渲染器：宽度它自己写，高度按图片比例自适应
  hand.el.style.visibility = '';
  hand = null;
}

// 整张离开：放进状态（桌面坐标、最上层），然后交给"手"层跟着手走
function pickUp(src, e, handle) {
  const k0 = handK(), off = unrotate(src.grab.x, src.grab.y, -src.rot);
  const sc = { x: e.clientX - off.x * k0, y: e.clientY - off.y * k0 };   // 贴纸中心此刻该在的屏幕位置
  const c = toStage({ clientX: sc.x, clientY: sc.y });
  let uid = src.uid;
  if (uid == null) {
    uid = apply(state, { type: 'place', ref: src.ref, x: c.x, y: c.y, rot: src.rot, on: 'desk' });
    src.el.style.visibility = '';   // 条上那一格交给 used 样式：露出底纸上的空位
  } else {
    apply(state, { type: 'move', uid, x: c.x, y: c.y, on: 'desk' });
    apply(state, { type: 'front', uid });
  }
  paint();
  drag = { kind: 'hold', uid, handle, unrolling: !!handle };
  const el = renderer.node(uid);
  if (!el) return;
  // 宽高写死成世界尺寸：图片刚建出来还没 load 完时 offsetHeight 是 0，量出来的中心会差半张贴纸
  const size = sizeOf(src.ref);
  const w = size ? size.w : (el.offsetWidth || 110), h = size ? size.h : (el.offsetHeight || 110);
  el.classList.add('in-hand', 'dragging');
  el.style.transformOrigin = '0 0';
  el.style.left = '0px'; el.style.top = '0px';
  el.style.width = w + 'px'; el.style.height = h + 'px';
  handEl.appendChild(el);
  hand = { el, uid, src, w, h, x: e.clientX, y: e.clientY, k: src.k, kFrom: src.k, kTo: src.k, t0: -1e9, handle, raf: 0 };
  if (!handle) { popTo(k0); return; }
  // 卷边在 WebGL 里展平、抬起来并滑到指尖下，播完再换成普通图片接着跟手
  el.style.visibility = 'hidden';
  paintHand(performance.now());
  handle.detach(sc.x, sc.y).then(() => {
    if (drag?.kind !== 'hold' || drag.uid !== uid) return;
    drag.unrolling = false;
    if (hand?.uid === uid) { hand.el.style.visibility = ''; popTo(handK()); }
  });
}

// 松手：落在贴纸条上就放回去；落在本子上就贴在本子上（转局部坐标，大小不变）；
// 否则贴在桌面——桌面是锁死的背景，贴纸按 fit 收回原大小，这是唯一允许的跳变
function settle(d, e) {
  const p = project(state);
  dropHand();
  if (inside(stripsEl, e)) {
    apply(state, { type: 'remove', uids: [d.uid] });
    return;
  }
  const b = boardAt(e), it = findItem(p, d.uid);
  const pos = b ? stageToBoard(it, b, p) : it;
  apply(state, { type: 'move', uid: d.uid, x: pos.x, y: pos.y, on: b ? 'board' : 'desk', board: b?.id });   // 就贴在松手的地方，不做落下动画
}

// 没揭下来就松手：弹回贴平，状态没变（快照还没打，撤销/重做栈都不动）
function springBack(d) {
  d.handle.release().then(() => { d.src.el.style.visibility = ''; });
}

addEventListener('pointermove', e => {
  if (!drag) {
    if (!overUi(e) && e.target instanceof Node && viewport.contains(e.target)) viewport.style.cursor = cursorFor(hitTest(e));
    else viewport.style.cursor = '';
    return;
  }
  const pt = toStage(e);
  if (drag.kind === 'peel') {
    const { src, handle, start } = drag;
    const d = unrotate(e.clientX - start.x, e.clientY - start.y, src.rot);   // 屏幕像素
    if (Math.hypot(d.x, d.y) > TAP_PX) tapCand = null;   // 拉动过了，这一下是撕不是点
    if (handle.update(d.x, d.y) >= DETACH_AT) { snapshot(); pickUp(src, e, handle); }
  } else if (drag.kind === 'hold') {
    if (hand) { hand.x = e.clientX; hand.y = e.clientY; paintHand(performance.now()); }
  } else {
    if (!drag.snapped) { snapshot(); drag.snapped = true; }
    apply(state, { type: 'boardMove', id: drag.id, x: pt.x + drag.dx, y: pt.y + drag.dy });
    paint();
  }
});
addEventListener('pointerup', e => {
  if (tapCand) { lastTap = { ...tapCand, t: Date.now() }; tapCand = null; }   // 没拉动就松手：记下来，可能是双击的第一下
  if (!drag) { if (hand) { dropHand(); render(); } return; }   // 兜底：拖动状态丢了也别把贴纸落在"手"里
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
  else if (drag?.kind === 'hold') dropHand();
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
  if (drag) return;   // 正在撕 / 拿着贴纸：别让缩放插一脚
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
  if (mod && k === 's') { e.preventDefault(); saveAll(); return; }
  if (e.key === 'Escape') { if (!modal.hidden) modal.hidden = true; else { select(null); render(); } return; }
});
addEventListener('keyup', e => { if (e.key.toLowerCase() === 'r') rHeld = false; });
addEventListener('blur', () => { rHeld = false; });   // 按着 R 切走窗口，回来时别还当它按着

// ---------- 音乐 ----------
// 音量：按钮点开一个小浮层（开关 + 横条）；在按钮上滚轮直接加减 5%。
// 调的时候图标临时换成百分数，停 800ms 换回来——省得为了看一眼音量还要点开
const bgmBtn = $('#btn-bgm'), volPop = $('#vol-pop'), volNum = $('#vol-num'), volRange = $('#volume'), volToggle = $('#vol-toggle');
let volNumTimer = 0;
function syncBgm() {
  const hit = resolveRef(view().bgm);
  const u = hit ? Packs.urlSync(hit.entry.sha256) : '';
  if (u && audio.dataset.hash !== hit.entry.sha256) { audio.src = u; audio.dataset.hash = hit.entry.sha256; }
  audio.volume = state.settings.volume;
  const on = state.settings.bgm && state.settings.volume > 0;
  bgmBtn.classList.toggle('on', state.settings.bgm && !!u);
  bgmBtn.querySelector('i').className = on ? 'ri-volume-up-line' : 'ri-volume-mute-line';
  volToggle.querySelector('i').className = state.settings.bgm ? 'ri-volume-up-line' : 'ri-volume-mute-line';
  volToggle.querySelector('span').textContent = state.settings.bgm ? '开' : '关';
  volToggle.classList.toggle('on', state.settings.bgm);
  volRange.value = Math.round(state.settings.volume * 100);
  if (state.settings.bgm && u) audio.play().catch(() => {}); else audio.pause();
}
// 调整时按钮上临时显示百分数
function flashVolume() {
  volNum.textContent = Math.round(state.settings.volume * 100) + '%';
  volNum.hidden = false;
  bgmBtn.querySelector('i').hidden = true;
  clearTimeout(volNumTimer);
  volNumTimer = setTimeout(() => { volNum.hidden = true; bgmBtn.querySelector('i').hidden = false; }, 800);
}
function setVolume(v) {
  const vol = Math.min(1, Math.max(0, v));
  if (Math.abs(vol - state.settings.volume) < 1e-4) return;
  apply(state, { type: 'setSetting', patch: { volume: vol } });
  save(); syncBgm(); flashVolume();
}
bgmBtn.onclick = () => { volPop.hidden = !volPop.hidden; };
volToggle.onclick = () => { commit({ type: 'setBgm', on: !state.settings.bgm }); syncBgm(); };
volRange.oninput = () => setVolume(volRange.value / 100);
// 滚轮在这个按钮上：一格 ±5%，而且绝不能传给本子缩放
bgmBtn.addEventListener('wheel', e => {
  e.preventDefault(); e.stopPropagation();
  setVolume(state.settings.volume + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });
// 点浮层外面就收起来
addEventListener('pointerdown', e => {
  const t = e.target instanceof Node ? e.target : null;
  if (!volPop.hidden && !(t && (volPop.contains(t) || bgmBtn.contains(t)))) volPop.hidden = true;
}, true);
addEventListener('pointerdown', () => { if (state.settings.bgm && audio.src && audio.paused) audio.play().catch(() => {}); });

// ---------- 工具条 ----------
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 1800);
}
async function setSkin(ref) {
  apply(state, { type: 'setSetting', patch: { skinRef: ref } });
  save();
  await syncSkin();
  renderSide();
}
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
  if (name === 'storage') renderStorage();
}
tabs.forEach(t => { t.onclick = () => showTab(t.dataset.tab); });
$('#btn-settings').onclick = () => { modal.hidden = false; showTab('save'); };
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
  renderSide();
}

const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';

// ---------- 小卡片：问一句 / 要个名字 ----------
// 不用原生 confirm / prompt：它们长得跟皮肤不搭，而且 confirm 只有两个按钮
const askEl = $('#ask');
function ask({ title, text = '', input = null, buttons }) {
  return new Promise(resolve => {
    askEl.querySelector('.ask-title').textContent = title;
    askEl.querySelector('.ask-text').textContent = text;
    const box = askEl.querySelector('.ask-input');
    box.hidden = input == null;
    box.value = input || '';
    const row = askEl.querySelector('.ask-btns');
    row.innerHTML = '';
    const done = v => { askEl.hidden = true; askEl.onclick = null; resolve(v === undefined ? null : v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      el.textContent = b.label;
      el.onclick = () => done(b.value === '@input' ? box.value.trim() : b.value);
      row.appendChild(el);
    }
    askEl.onclick = e => { if (e.target === askEl) done(null); };
    askEl.hidden = false;
    if (input != null) { box.focus(); box.select(); }
  });
}

// ---------- 作品 ----------
// 一个作品 = 一张纸/一页本子 + 贴在它上面的贴纸。桌上收起一本时贴纸只在作品里活下来
const fmtTime = t => { const d = new Date(t); const z = n => String(n).padStart(2, '0'); return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const entryName = ref => { const h = resolveRef(ref); return h ? (h.entry.name || h.entry.id) : ref; };
const bookOf = ref => resolveRef(ref)?.entry.book || null;
const stickersOn = (p, id) => p.items.filter(i => i.on === 'board' && i.board === id).length;

// 保存：桌上每一本都存成作品（没绑过的新建并绑定，绑过的更新）
function saveAll({ asNew = false, baseName = '' } = {}) {
  const p = project(state);
  if (!p.boards.length) return showToast('桌上还没有本子');
  snapshot();
  const n = p.boards.length;
  p.boards.forEach((b, i) => {
    const bound = !asNew && b.work && state.works[b.work];
    apply(state, {
      type: 'saveWork', boardId: b.id,
      workId: bound ? b.work : null,
      name: bound ? undefined : (asNew ? (n > 1 ? `${baseName}-${i + 1}` : baseName) : `${entryName(b.ref)} ${fmtTime(Date.now())}`),
    });
  });
  save();
  renderSide();
  showToast(`已保存 ${n} 个作品`);
}
$('#btn-save').onclick = () => saveAll();
$('#btn-saveas').onclick = async () => {
  if (!project(state).boards.length) return showToast('桌上还没有本子');
  const name = await ask({
    title: '另存为', text: '桌上每一本各存一份新作品，原来的作品不动。',
    input: fmtTime(Date.now()),
    buttons: [{ label: '取消', value: null }, { label: '保存', value: '@input', primary: true }],
  });
  if (name) saveAll({ asNew: true, baseName: name });
};

// 取消勾选桌上的一本：上面有贴纸就先问一句，别让玩家一不小心把半天的活丢了
async function closeBoard(b) {
  const p = project(state), n = stickersOn(p, b.id);
  const bound = b.work && state.works[b.work];
  if (n) {
    const v = await ask({
      title: '收起这本？',
      text: `这本上有 ${n} 张贴纸。${bound ? `要先更新到作品「${state.works[b.work].name}」吗？` : '收起之后贴纸就没了，要先存成作品吗？'}`,
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: bound ? '不更新' : '不保存', value: 'drop', danger: true },
        { label: bound ? '更新作品' : '存进作品', value: 'save', primary: true },
      ],
    });
    if (v !== 'drop' && v !== 'save') { renderSide(); return; }   // 取消：勾选框回到勾上
    snapshot();
    if (v === 'save') apply(state, { type: 'saveWork', boardId: b.id, workId: bound ? b.work : null, name: bound ? undefined : `${entryName(b.ref)} ${fmtTime(Date.now())}` });
  } else snapshot();
  apply(state, { type: 'removeBoard', id: b.id });
  save(); select(null); render(); renderSide();
}

// ---------- 左栏：分类 + 内容浏览器 ----------
// 「全部 / 贴纸」列的是包（启用、排序、卸载都在那儿）；其余几类列的是条目，勾一下就摆到桌上
const PACK_CATS = ['all', 'sticker'];
const SUBS = { board: [['sheet', '纸张'], ['book', '本子']], bgm: [['track', '单曲'], ['cloud', '网易云']] };
const SIDE_TITLE = { all: '素材包', sticker: '素材包', board: '本子', background: '桌面', bgm: '音乐', deco: '美化', work: '作品' };
let sideCat = 'all';
const subTab = { board: 'sheet', bgm: 'track' };
const browseEl = $('#browse');
attachScrollbar(browseEl);

const groupOpen = key => state.ui.groups?.[key] !== false;
function toggleGroup(key) {
  const groups = { ...(state.ui.groups || {}) };
  groups[key] = !groupOpen(key);
  apply(state, { type: 'setUi', patch: { groups } });
  save(); renderSide();
}

// 统一的一行：预览图 + 名字 + 小字 + 右边的勾选/单选和行内操作。thumb 传 sha256，没有就给个图标名
function itemRow({ thumb, icon, name, sub, checked, kind = 'checkbox', disabled, onToggle, acts = [], chevKey }) {
  const row = document.createElement('div');
  row.className = 'item-row' + (disabled ? ' off' : '') + (chevKey ? ' item-group' + (groupOpen(chevKey) ? '' : ' closed') : '');
  if (chevKey) { const c = document.createElement('i'); c.className = 'item-chev ri-arrow-down-s-line'; row.appendChild(c); }
  const th = document.createElement('div');
  th.className = 'item-thumb';
  if (thumb) {
    const img = document.createElement('img');
    img.alt = '';
    // 缩略图多半还没进缓存（ensureUrls 只备桌上用得到的），取不到就异步补一次
    const u = Packs.urlSync(thumb);
    if (u) img.src = u; else Packs.urlFor(thumb).then(v => { if (v) img.src = v; }).catch(() => {});
    th.appendChild(img);
  }
  else if (icon) { const i = document.createElement('i'); i.className = icon; th.appendChild(i); }
  row.appendChild(th);
  const main = document.createElement('div');
  main.className = 'item-main';
  main.innerHTML = '<div class="item-name"></div><div class="item-sub dim"></div>';
  main.querySelector('.item-name').textContent = name;
  main.querySelector('.item-sub').textContent = sub || '';
  row.appendChild(main);
  if (acts.length) {
    const box = document.createElement('div');
    box.className = 'item-acts';
    for (const a of acts) {
      const b = document.createElement('button');
      b.className = 'btn icon' + (a.danger ? ' danger' : '');
      b.title = a.title;
      b.innerHTML = `<i class="${a.icon}"></i>`;
      b.onclick = ev => { ev.stopPropagation(); a.run(); };
      box.appendChild(b);
    }
    row.appendChild(box);
  }
  if (onToggle) {
    const box = document.createElement('input');
    box.type = kind;
    box.checked = !!checked;
    box.disabled = !!disabled;
    box.title = disabled ? '素材包未启用' : '';
    box.onclick = ev => ev.stopPropagation();
    box.onchange = () => onToggle(box.checked);
    row.appendChild(box);
    if (!disabled && !chevKey) row.onclick = () => { box.checked = !box.checked; box.onchange(); };
  }
  if (chevKey) row.onclick = () => toggleGroup(chevKey);
  return row;
}
const emptyNote = text => { const d = document.createElement('div'); d.className = 'dim item-empty'; d.textContent = text; return d; };
const deskBoardsOf = ref => project(state).boards.filter(b => b.ref === ref);

// 本子：二级 tab 纸张 / 本子。勾一页 = 桌上开一张空白页（不带作品）
function renderBoardsTab(box) {
  const entries = enabledPacks.flatMap(pk => pk.entries.filter(e => e.type === 'board' && !e.deprecated).map(e => ({ pk, e })));
  const toggle = (ref, on) => {
    if (on) { snapshot(); apply(state, { type: 'addBoard', ref }); save(); render(); renderSide(); }
    else { const list = deskBoardsOf(ref); if (list.length) closeBoard(list[list.length - 1]); }
  };
  const one = ({ pk, e }, kid) => {
    const ref = pk.id + ':' + e.id, n = deskBoardsOf(ref).length;
    return itemRow({
      thumb: e.sha256, name: e.name || e.id,
      sub: kid ? (n ? `桌上 ${n} 本` : '') : `${Packs.displayName(pk.name)}${n ? ` · 桌上 ${n} 本` : ''}`,
      checked: n > 0, onToggle: on => toggle(ref, on),
    });
  };
  if (subTab.board === 'sheet') {
    const sheets = entries.filter(x => !x.e.book);
    if (!sheets.length) return box.appendChild(emptyNote('启用的素材包里没有单张的纸'));
    for (const x of sheets) box.appendChild(one(x));
    return;
  }
  const books = new Map();
  for (const x of entries) if (x.e.book) {
    const key = x.pk.id + '::' + x.e.book;
    if (!books.has(key)) books.set(key, { key, name: x.e.book, pk: x.pk, pages: [] });
    books.get(key).pages.push(x);
  }
  if (!books.size) return box.appendChild(emptyNote('启用的素材包里没有成本的本子（清单里给 board 条目写 book 就能归成一本）'));
  for (const b of books.values()) {
    const onDesk = b.pages.reduce((n, x) => n + deskBoardsOf(x.pk.id + ':' + x.e.id).length, 0);
    box.appendChild(itemRow({
      thumb: b.pages[0].e.sha256, name: b.name,
      sub: `${b.pages.length} 页${onDesk ? ` · 桌上 ${onDesk}` : ''} · ${Packs.displayName(b.pk.name)}`,
      chevKey: 'book:' + b.key,
    }));
    const kids = document.createElement('div');
    kids.className = 'item-kids';
    for (const x of b.pages) kids.appendChild(one(x, true));
    box.appendChild(kids);
  }
}

// 作品：按更新时间倒序；同一本子（同 book）的几个作品折成一行
function renderWorksTab(box) {
  const works = Object.values(state.works).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!works.length) return box.appendChild(emptyNote('还没有作品。在桌上摆一本、贴几张，点顶栏的「保存」就有了'));
  const row = w => {
    const h = resolveRef(w.ref), missing = !h;
    const boards = project(state).boards.filter(b => b.work === w.id);
    return itemRow({
      thumb: h?.entry.sha256, icon: missing ? 'ri-image-off-line' : null,
      name: w.name, sub: missing ? '素材包未启用' : `${w.items.length} 张贴纸 · ${fmtTime(w.updatedAt)}`,
      checked: boards.length > 0, disabled: missing,
      onToggle: on => {
        if (on) { snapshot(); apply(state, { type: 'openWork', id: w.id }); save(); render(); renderSide(); }
        else if (boards.length) closeBoard(boards[boards.length - 1]);
      },
      acts: [
        { icon: 'ri-edit-line', title: '改名', run: async () => {
          const name = await ask({ title: '给作品改名', input: w.name, buttons: [{ label: '取消', value: null }, { label: '改名', value: '@input', primary: true }] });
          if (name) { apply(state, { type: 'renameWork', id: w.id, name }); save(); renderSide(); }
        } },
        { icon: 'ri-delete-bin-line', title: '删除作品', danger: true, run: async () => {
          const v = await ask({ title: `删除作品「${w.name}」？`, text: '桌上的东西不会跟着删；这一份存下来的没了就找不回来。', buttons: [{ label: '取消', value: null }, { label: '删除', value: 'y', danger: true }] });
          if (v === 'y') { apply(state, { type: 'deleteWork', id: w.id }); save(); renderSide(); }
        } },
      ],
    });
  };
  const groups = new Map(), loose = [];
  for (const w of works) {
    const bk = bookOf(w.ref);
    if (!bk) { loose.push(w); continue; }
    if (!groups.has(bk)) groups.set(bk, []);
    groups.get(bk).push(w);
  }
  for (const [name, list] of groups) {
    if (list.length === 1) { box.appendChild(row(list[0])); continue; }
    box.appendChild(itemRow({ thumb: resolveRef(list[0].ref)?.entry.sha256, name, sub: `${list.length} 个作品`, chevKey: 'work:' + name }));
    const kids = document.createElement('div');
    kids.className = 'item-kids';
    for (const w of list) kids.appendChild(row(w));
    box.appendChild(kids);
  }
  for (const w of loose) box.appendChild(row(w));
}

function renderBackgroundTab(box) {
  const cur = view().background;
  const list = enabledPacks.flatMap(pk => pk.entries.filter(e => e.type === 'background' && !e.deprecated).map(e => ({ pk, e })));
  if (!list.length) return box.appendChild(emptyNote('启用的素材包里没有桌面'));
  for (const { pk, e } of list) {
    const ref = pk.id + ':' + e.id;
    box.appendChild(itemRow({
      thumb: e.sha256, name: e.name || e.id, sub: Packs.displayName(pk.name),
      checked: ref === cur, kind: 'radio',
      onToggle: () => { commit({ type: 'setBackground', ref }); render(); renderSide(); },
    }));
  }
}

function renderBgmTab(box) {
  if (subTab.bgm === 'cloud') return box.appendChild(emptyNote('网易云歌单：以后接入，现在还没做'));
  const cur = view().bgm;
  const list = enabledPacks.flatMap(pk => pk.entries.filter(e => e.type === 'bgm' && !e.deprecated).map(e => ({ pk, e })));
  if (!list.length) return box.appendChild(emptyNote('启用的素材包里没有音乐'));
  for (const { pk, e } of list) {
    const ref = pk.id + ':' + e.id;
    box.appendChild(itemRow({
      icon: 'ri-music-2-line', name: e.name || e.id, sub: Packs.displayName(pk.name),
      checked: ref === cur, kind: 'radio',
      onToggle: () => { apply(state, { type: 'setBgm', ref, on: true }); save(); syncBgm(); renderSide(); },
    }));
  }
}

// 美化：默认主题 + 启用包里的每个 skin 条目。读配置是异步的，用序号防止两次渲染交错
let skinSeq = 0;
async function renderSkinTab(box) {
  const my = ++skinSeq;
  const cur = resolveRef(state.settings.skinRef) ? state.settings.skinRef : null;
  const items = [{ ref: null, name: '默认主题', sub: '游戏自带' }];
  for (const ref of refsOfType('skin')) {
    const h = resolveRef(ref);
    try {
      const cfg = await readSkin(h);
      items.push({ ref, name: cfg.name, preview: cfg.preview, sub: Packs.displayName(h.pack.name) + (cfg.warn.length ? ` · ${cfg.warn.length} 处配置被忽略` : '') });
    } catch (e) {
      items.push({ ref, name: h.entry.id, sub: '读取失败：' + e.message });
    }
  }
  if (my !== skinSeq || sideCat !== 'deco') return;
  box.innerHTML = '';
  for (const it of items) {
    if (it.preview) await Packs.urlFor(it.preview).catch(() => {});
    box.appendChild(itemRow({
      thumb: it.preview, icon: it.preview ? null : 'ri-palette-line',
      name: it.name, sub: it.sub, checked: it.ref === cur, kind: 'radio',
      onToggle: () => setSkin(it.ref),
    }));
  }
}

$('#sub-chips').onclick = e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  subTab[sideCat] = c.dataset.sub;
  renderSide();
};

// 左栏总入口：按分类决定是列包还是列条目
function renderSide() {
  const isPack = PACK_CATS.includes(sideCat);
  for (const el of [$('#pack-sort'), $('#pack-input').parentElement, packList, $('.side-foot')]) el.hidden = !isPack;
  browseEl.hidden = isPack;
  const subs = SUBS[sideCat], subBox = $('#sub-chips');
  subBox.hidden = !subs;
  if (subs) {
    subBox.innerHTML = '';
    for (const [k, label] of subs) {
      const b = document.createElement('button');
      b.className = 'chip' + (subTab[sideCat] === k ? ' on' : '');
      b.dataset.sub = k;
      b.textContent = label;
      subBox.appendChild(b);
    }
  }
  $('#side-title').textContent = SIDE_TITLE[sideCat] || '素材包';
  const counts = { all: installed.length, sticker: 0, deco: 0, board: 0, background: 0, bgm: 0, work: Object.keys(state.works).length };
  for (const p of installed) if (catOf(p) === 'sticker') counts.sticker++;
  for (const pk of enabledPacks) for (const e of pk.entries) {
    if (e.type === 'board') counts.board++;
    else if (e.type === 'background') counts.background++;
    else if (e.type === 'bgm') counts.bgm++;
    else if (e.type === 'skin') counts.deco++;
  }
  for (const c of $('#pack-chips').querySelectorAll('.chip')) {
    c.classList.toggle('on', c.dataset.cat === sideCat);
    c.querySelector('i').textContent = counts[c.dataset.cat] || '';
  }
  if (isPack) return renderPackList();
  browseEl.innerHTML = '';
  if (sideCat === 'board') renderBoardsTab(browseEl);
  else if (sideCat === 'background') renderBackgroundTab(browseEl);
  else if (sideCat === 'bgm') renderBgmTab(browseEl);
  else if (sideCat === 'work') renderWorksTab(browseEl);
  else if (sideCat === 'deco') renderSkinTab(browseEl);
}

$('#pack-chips').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; sideCat = c.dataset.cat; renderSide(); };
// 排序：点当前项 = 反向，点别的项 = 切过去、方向回正
$('#pack-sort').onclick = e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  const cur = state.ui.packSort;
  setPackSort(c.dataset.sort === cur.key ? { key: cur.key, dir: -cur.dir } : { key: c.dataset.sort, dir: 1 });
};
function setPackSort(packSort) {
  apply(state, { type: 'setUi', patch: { packSort } });
  save();
  refresh();
}
function syncSortChips() {
  const { key, dir } = state.ui.packSort;
  for (const c of $('#pack-sort').querySelectorAll('.chip')) {
    const on = c.dataset.sort === key;
    c.classList.toggle('on', on);
    c.querySelector('i').textContent = on ? (dir > 0 ? '↑' : '↓') : '';
  }
}

// ---------- 左栏拖动排序 ----------
// 抓手上按下、移动超过 4px 才算拖：原行变半透明，跟着鼠标的是一个克隆的影子，列表里画一条插入线。
// 只允许在同一个置顶组里换位置（拖出组的范围就贴在组边界）。
// 在「名称 / 添加」模式下开始拖：先把眼前这个顺序固化成自定义，再拖——不然松手看到的顺序会跳回去
let packDrag = null;
function startPackDrag(e, row, id, pinned) {
  if (e.button !== 0) return;
  e.preventDefault();
  try { row.querySelector('.pack-grip').setPointerCapture(e.pointerId); } catch {}   // 合成事件没有真实指针，捕获失败不影响后面的 window 监听
  packDrag = { id, pinned, row, x: e.clientX, y: e.clientY, live: false, ghost: null, line: null, at: -1 };
}
function packRows() {
  return [...packList.querySelectorAll('.pack-row')];
}
function beginPackDrag() {
  const d = packDrag;
  d.live = true;
  // 名称/添加模式：把当前显示顺序固化成 order，再切回自定义
  if (state.ui.packSort.key !== 'manual') {
    apply(state, { type: 'packOrder', ids: [...installed].sort(packCmp).map(p => p.id) });
    apply(state, { type: 'setUi', patch: { packSort: { key: 'manual', dir: 1 } } });
    syncSortChips();
  }
  const r = d.row.getBoundingClientRect();
  const ghost = d.row.cloneNode(true);
  ghost.className = 'pack-row pack-ghost';
  ghost.style.width = r.width + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  d.offY = d.y - r.top;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.line = document.createElement('div');
  d.line.className = 'pack-drop-line';
  packList.appendChild(d.line);
  d.row.classList.add('dragging-row');
}
addEventListener('pointermove', e => {
  const d = packDrag;
  if (!d) return;
  if (!d.live) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    beginPackDrag();
  }
  d.ghost.style.top = (e.clientY - d.offY) + 'px';
  // 只在同一置顶组里找插入位置
  const rows = packRows().filter(r => r !== d.row && !!state.packs[r.dataset.pack]?.pinned === d.pinned);
  let at = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { at = i; break; }
  }
  d.at = at;
  d.group = rows;
  const ref = rows[at], pr = packList.getBoundingClientRect();
  const y = ref ? ref.getBoundingClientRect().top : (rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : d.row.getBoundingClientRect().top);
  d.line.style.top = (y - pr.top + packList.scrollTop - 3) + 'px';
}, true);
addEventListener('pointerup', () => {
  const d = packDrag;
  if (!d) return;
  packDrag = null;
  if (!d.live) return;
  d.ghost.remove(); d.line.remove();
  d.row.classList.remove('dragging-row');
  // 新顺序：整份排序后的列表里，把这一行抽出来插到目标位置（只在本组内动）
  const ids = [...installed].sort(packCmp).map(p => p.id).filter(x => x !== d.id);
  const target = d.group[d.at]?.dataset.pack;
  const i = target ? ids.indexOf(target) : -1;
  ids.splice(i < 0 ? (d.group.length ? ids.indexOf(d.group[d.group.length - 1].dataset.pack) + 1 : ids.length) : i, 0, d.id);
  apply(state, { type: 'packOrder', ids });
  refresh();
}, true);
// 左栏图包列表：置顶在前；每行 抓手 / 启用 / 名称 / 元信息 / 置顶 收藏 更新 卸载
function renderPackList() {
  syncSortChips();
  const sorted = [...installed].sort(packCmp);
  const shown = sorted.filter(p => sideCat === 'all' || catOf(p) === sideCat);
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
        <i class="pack-grip ri-draggable" title="拖动排序"></i>
        <input type="checkbox" title="启用 / 停用" ${on ? 'checked' : ''}>
        <span class="pack-name"></span>
      </div>
      <div class="pack-meta"></div>
      <div class="pack-actions">
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
    row.dataset.pack = p.id;
    row.querySelector('.pack-grip').addEventListener('pointerdown', ev => startPackDrag(ev, row, p.id, !!meta.pinned));
    row.querySelector('.act-pin').onclick = () => { apply(state, { type: 'setPack', id: p.id, patch: { pinned: !meta.pinned } }); refresh(); };
    row.querySelector('.act-fav').onclick = () => { apply(state, { type: 'setPack', id: p.id, patch: { fav: !meta.fav } }); save(); renderSide(); };
    row.querySelector('.act-update').onclick = async ev => {
      ev.target.closest('button').disabled = true;
      try {
        const u = await Packs.checkUpdate(p);
        if (!u.available) showToast('已经是最新：' + u.label);
        else await install(p.source);
      } catch (e) { showToast('检查失败：' + e.message); }
      renderSide();
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
