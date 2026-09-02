// 花漾贴贴 · 运行时内核入口
// 内核只认四种槽位：background / board / sticker / bgm。所有内容都来自素材包。
import { DB } from './db.js';
import * as Packs from './packs.js';
import { normalize, apply, project, findItem, groupOf, STATE_VERSION, SCALE } from './state.js';
import { createRenderer } from './render.js';

const STAGE_W = 1672, STAGE_H = 941;
// 默认包来源，按顺序试：本地开发目录 → GitHub 资源仓库（线上部署时本地目录不存在）
const DEFAULT_SOURCES = ['local:packs/default', 'Aezir/petal-pop-assets'];
const LONG_PRESS_MS = 600;     // 长按多久算“撕”
const DRAG_THRESHOLD = 6;      // 移动超过多少舞台像素才算拖动
const $ = s => document.querySelector(s);

const stage = $('#stage'), layer = $('#layer'), boardWrap = $('#boardWrap'), boardEl = $('#board'),
      boardLayer = $('#boardLayer'), sheet = $('#sheet'), panel = $('#panel'), countEl = $('#count'),
      toast = $('#toast'), audio = $('#bgm'), loading = $('#loading'), loadText = $('#load-text'),
      bar = $('#bar'), modal = $('#modal'), packList = $('#pack-list'), mini = $('#mini');

// ---------- 舞台缩放 ----------
let scale = 1;
function fit() {
  scale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  stage.style.transform = `translate(-50%,-50%) scale(${scale})`;
}
addEventListener('resize', () => { fit(); placeMini(); });
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

// 把画面要用到的 blob 都换成对象地址（第一次从 IndexedDB 读，之后命中缓存）
async function ensureUrls() {
  const p = project(state), v = view();
  const refs = [v.board, v.background, v.bgm, ...p.items.map(i => i.ref), ...refsOfType('sticker')];
  await Promise.all(refs.map(r => { const h = resolveRef(r); return h ? Packs.urlFor(h.entry.sha256) : null; }));
}

// ---------- 选中 ----------
let sel = null;   // { kind:'item', uid } | { kind:'board' } | null
function select(s) { sel = s; }

// ---------- 渲染 ----------
const renderer = createRenderer({ stage, layer, boardWrap, boardEl, boardLayer, sheet, countEl, resolveRef, bindItem });
async function render() {
  await ensureUrls();
  renderer.render(state, enabledPacks, view(), sel);
  syncBgm();
  syncPanel();
  placeMini();
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
  if (sel?.kind === 'item' && !findItem(project(state), sel.uid)) select(null);
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
// 舞台坐标 ⇄ 本子局部坐标（考虑本子的缩放和翻转）
function stageToLocal(pt, t) { const x = (pt.x - t.x) / t.s; return { x: t.flip ? -x : x, y: (pt.y - t.y) / t.s }; }
function localToStage(pt, t) { const x = t.flip ? -pt.x : pt.x; return { x: t.x + x * t.s, y: t.y + pt.y * t.s }; }
const itemStagePos = (it, t) => (it.on === 'board' ? localToStage(it, t) : { x: it.x, y: it.y });
const overBoard = e => !boardWrap.hidden && inside(boardEl, e);
const overPanel = e => state.settings.panelOpen && inside(panel, e);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 组里只剩一张就解散
function tidyGroups() {
  const p = project(state);
  const count = {};
  for (const it of p.items) if (it.group != null) count[it.group] = (count[it.group] || 0) + 1;
  const lonely = p.items.filter(it => it.group != null && count[it.group] < 2).map(it => it.uid);
  if (lonely.length) apply(state, { type: 'group', uids: lonely, group: null });
}

// ---------- 拖拽：撕下 / 挪动 / 成组 / 撕开 ----------
let drag = null;
// drag = { kind:'item', grab, uids, offsets(uid→{dx,dy}), start, moved, fresh, lifted, timer }
// drag = { kind:'board', dx, dy, moved }

function startItemDrag(e, uid, fresh) {
  const p = project(state), t = p.boardT;
  const uids = groupOf(p, uid).map(i => i.uid);
  apply(state, { type: 'front', uids });
  const pt = toStage(e);
  const offsets = new Map(uids.map(u => {
    const sp = itemStagePos(findItem(p, u), t);
    return [u, { dx: sp.x - pt.x, dy: sp.y - pt.y }];
  }));
  drag = { kind: 'item', grab: uid, uids, offsets, start: pt, moved: false, fresh, lifted: fresh, timer: null };
  if (!fresh) drag.timer = setTimeout(longPress, LONG_PRESS_MS);
  select({ kind: 'item', uid });
  render().then(() => { if (drag?.fresh) renderer.node(uid)?.classList.add('dragging'); });
}

// 长按：把这张贴纸从组里撕开
function longPress() {
  if (!drag || drag.kind !== 'item' || drag.moved) return;
  const p = project(state);
  const it = findItem(p, drag.grab);
  if (!it || it.group == null) return;
  apply(state, { type: 'group', uids: [it.uid], group: null });
  tidyGroups();
  drag.uids = [it.uid];
  const el = renderer.node(it.uid);
  el?.classList.add('peel-off');
  setTimeout(() => el?.classList.remove('peel-off'), 500);
  showToast('撕开了，现在可以单独挪');
  save();
  render();
}

// 拖动开始：把要挪的贴纸暂时转成桌面坐标，浮到最上层（本子层有自己的变换，浮不出来）
function lift() {
  const p = project(state), t = p.boardT;
  const items = drag.uids.map(u => { const sp = itemStagePos(findItem(p, u), t); return { uid: u, x: sp.x, y: sp.y, on: 'desk' }; });
  apply(state, { type: 'moveMany', items });
  drag.lifted = true;
  renderer.render(state, enabledPacks, view(), sel);
  for (const u of drag.uids) renderer.node(u)?.classList.add('dragging');
  mini.hidden = true;
}

// 松手：落在贴纸册上就收回；落在本子上就贴在本子上（转局部坐标）；否则贴在桌面
function settle(d, e) {
  const p = project(state), t = p.boardT;
  for (const u of d.uids) renderer.node(u)?.classList.remove('dragging');
  if (overPanel(e)) {
    apply(state, { type: 'remove', uids: d.uids });
    tidyGroups();
    select(null);
    return;
  }
  const onBoard = overBoard(e);
  const items = d.uids.map(u => {
    const it = findItem(p, u);
    const pos = onBoard ? stageToLocal(it, t) : it;
    return { uid: u, x: pos.x, y: pos.y, on: onBoard ? 'board' : 'desk' };
  });
  apply(state, { type: 'moveMany', items });
  mergeGroups(d.uids, onBoard ? 'board' : 'desk');
  for (const u of d.uids) {
    const el = renderer.node(u);
    el?.classList.add('stick');
    setTimeout(() => el?.classList.remove('stick'), 300);
  }
}

// 落点和别的贴纸重叠 → 吸在一起（合并成一组）
function rectOverlap(a, b) {
  const k = 0.2;   // 各缩进两成，擦边不算
  const ax = a.width * k, ay = a.height * k, bx = b.width * k, by = b.height * k;
  return a.left + ax < b.right - bx && a.right - ax > b.left + bx && a.top + ay < b.bottom - by && a.bottom - ay > b.top + by;
}
function mergeGroups(uids, surface) {
  const p = project(state);
  const set = new Set(uids);
  const rects = uids.map(u => renderer.node(u)?.getBoundingClientRect()).filter(Boolean);
  const hits = p.items.filter(it => {
    if (set.has(it.uid) || it.on !== surface) return false;
    const r = renderer.node(it.uid)?.getBoundingClientRect();
    return r && rects.some(a => rectOverlap(a, r));
  });
  if (!hits.length) return;
  const all = [...uids, ...hits.map(i => i.uid)];
  const gids = new Set(all.map(u => findItem(p, u).group).filter(g => g != null));
  const members = new Set(all);
  for (const it of p.items) if (gids.has(it.group)) members.add(it.uid);
  apply(state, { type: 'group', uids: [...members], group: p.seq++ });
  showToast(`吸在一起了（${members.size} 张）· 长按可撕开`);
}

// 从贴纸册撕下：按下的瞬间贴纸就已经在画布上了，跟着手指走，松手即贴好
sheet.addEventListener('pointerdown', e => {
  const th = e.target.closest('.thumb');
  if (!th || th.classList.contains('used')) return;
  e.preventDefault();
  const ref = th.dataset.ref;
  if (!resolveRef(ref)) return;
  const pt = toStage(e);
  snapshot();
  const uid = apply(state, { type: 'place', ref, x: pt.x, y: pt.y, rot: +(Math.random() * 14 - 7).toFixed(1), on: 'desk' });
  th.classList.add('peeling');
  setTimeout(() => th.classList.remove('peeling'), 400);
  startItemDrag(e, uid, true);
});

function bindItem(el, uid) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    snapshot();
    startItemDrag(e, uid, false);
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const it = findItem(project(state), uid);
    if (!it) return;
    const d = e.deltaY || e.deltaX;
    const patch = e.shiftKey ? { s: it.s + (d < 0 ? 0.1 : -0.1) } : { rot: it.rot + (d < 0 ? -5 : 5) };
    commit({ type: 'transform', uid, ...patch }, { coalesce: true });
    render();
  }, { passive: false });
  el.addEventListener('dblclick', () => returnToSheet([uid]));
}
function returnToSheet(uids) {
  for (const u of uids) renderer.node(u)?.classList.add('peel');
  setTimeout(() => {
    commit({ type: 'remove', uids });
    tidyGroups();
    if (sel?.kind === 'item' && uids.includes(sel.uid)) select(null);
    render();
  }, 220);
}

// 本子：点选、拖动、滚轮缩放
boardEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const t = project(state).boardT, pt = toStage(e);
  snapshot();
  drag = { kind: 'board', dx: t.x - pt.x, dy: t.y - pt.y, moved: false };
  select({ kind: 'board' });
  render();
});
boardEl.addEventListener('wheel', e => {
  e.preventDefault();
  const t = project(state).boardT;
  const d = e.deltaY || e.deltaX;
  commit({ type: 'boardSet', s: t.s + (d < 0 ? 0.05 : -0.05) }, { coalesce: true });
  render();
}, { passive: false });

// 点空白桌面：取消选中
stage.addEventListener('pointerdown', e => {
  if (e.target === stage || e.target === layer) { select(null); render(); }
});

addEventListener('pointermove', e => {
  if (!drag) return;
  const pt = toStage(e);
  if (drag.kind === 'item') {
    if (!drag.moved) {
      if (dist(pt, drag.start) < DRAG_THRESHOLD) return;
      drag.moved = true;
      clearTimeout(drag.timer);
      if (!drag.lifted) lift();
    }
    const p = project(state);
    const items = drag.uids.map(u => { const o = drag.offsets.get(u); return { uid: u, x: pt.x + o.dx, y: pt.y + o.dy }; });
    apply(state, { type: 'moveMany', items });
    for (const u of drag.uids) { const el = renderer.node(u), it = findItem(p, u); if (el && it) renderer.placeStyle(el, it, p.boardT); }
  } else if (drag.kind === 'board') {
    drag.moved = true;
    apply(state, { type: 'boardSet', x: pt.x + drag.dx, y: pt.y + drag.dy });
    renderer.render(state, enabledPacks, view(), sel);
    mini.hidden = true;
  }
});
addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'item') {
    clearTimeout(d.timer);
    if (d.moved || d.fresh) settle(d, e);
  }
  save();
  render();
});
addEventListener('pointercancel', () => {
  if (drag?.kind === 'item') { clearTimeout(drag.timer); if (drag.fresh) apply(state, { type: 'remove', uids: drag.uids }); }
  drag = null;
  render();
});

// ---------- 选中后的小工具条 ----------
function placeMini() {
  if (!sel || drag || !state.settings) { mini.hidden = true; return; }
  const el = sel.kind === 'board' ? boardEl : renderer.node(sel.uid);
  if (!el || boardWrap.hidden && sel.kind === 'board') { mini.hidden = true; return; }
  const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  mini.hidden = false;
  mini.dataset.kind = sel.kind;
  mini.style.left = ((r.left + r.width / 2 - sr.left) / scale) + 'px';
  mini.style.top = ((r.bottom - sr.top) / scale + 12) + 'px';
}
mini.addEventListener('pointerdown', e => e.stopPropagation());
function selItem() { return sel?.kind === 'item' ? findItem(project(state), sel.uid) : null; }
function flipSel() {
  if (sel?.kind === 'board') commit({ type: 'boardSet', flip: !project(state).boardT.flip });
  else if (selItem()) commit({ type: 'transform', uid: sel.uid, flip: !selItem().flip });
  render();
}
function zoomSel(dir) {
  if (sel?.kind === 'board') commit({ type: 'boardSet', s: project(state).boardT.s + dir * 0.1 });
  else if (selItem()) commit({ type: 'transform', uid: sel.uid, s: selItem().s + dir * 0.25 });   // 四分之一档，像素更整齐
  render();
}
$('#mini-flip').onclick = flipSel;
$('#mini-in').onclick = () => zoomSel(1);
$('#mini-out').onclick = () => zoomSel(-1);
$('#mini-back').onclick = () => { if (selItem()) returnToSheet([sel.uid]); };

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { if (!modal.hidden) modal.hidden = true; else { select(null); render(); } return; }
  if (!sel) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selItem()) returnToSheet([sel.uid]); }
  else if (e.key.toLowerCase() === 'f') flipSel();
  else if (e.key === '+' || e.key === '=') zoomSel(1);
  else if (e.key === '-') zoomSel(-1);
});

// ---------- 贴纸册折叠 ----------
function syncPanel() {
  panel.classList.toggle('collapsed', !state.settings.panelOpen);
}
$('#btn-fold').onclick = e => { e.stopPropagation(); apply(state, { type: 'setSetting', patch: { panelOpen: !state.settings.panelOpen } }); save(); render(); };
panel.addEventListener('pointerdown', () => {
  if (!state.settings.panelOpen) { apply(state, { type: 'setSetting', patch: { panelOpen: true } }); save(); render(); }
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
$('#btn-undo').onclick = undo;
$('#btn-clear').onclick = () => {
  if (!project(state).items.length) return;
  commit({ type: 'clear' }); select(null); render();
  showToast('全部撕回贴纸册啦（Ctrl+Z 可反悔）');
};

// ---------- 设置页 ----------
const tabs = modal.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  modal.querySelectorAll('[data-pane]').forEach(s => { s.hidden = s.dataset.pane !== name; });
  if (name === 'packs') renderPackList();
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
  save();
  await render();
  if (!modal.hidden) renderPackList();
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
      `${p.label} · 贴纸 ${counts.sticker || 0} · 底板 ${counts.board || 0} · 桌面 ${counts.background || 0} · 音乐 ${counts.bgm || 0} · ${fmtMB(p.bytes)} · ${p.license || '未注明许可'}`;
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
  hideLoading();
  await refresh();
}
