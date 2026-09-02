// 花漾贴贴 · 运行时内核入口
// 内核只认四种槽位：background / board / sticker / bgm。所有内容都来自素材包。
import { DB } from './db.js';
import * as Packs from './packs.js';
import { normalize, apply, project } from './state.js';
import { createRenderer } from './render.js';

const STAGE_W = 1672, STAGE_H = 941;
// 默认包来源，按顺序试：本地开发目录 → GitHub 资源仓库（线上部署时本地目录不存在）
const DEFAULT_SOURCES = ['local:packs/default', 'Aezir/petal-pop-assets'];
const $ = s => document.querySelector(s);

const stage = $('#stage'), layer = $('#layer'), boardEl = $('#board'), sheet = $('#sheet'),
      panel = $('#panel'), countEl = $('#count'), toast = $('#toast'), audio = $('#bgm'),
      loading = $('#loading'), loadText = $('#load-text'), bar = $('#bar'),
      modal = $('#modal'), packList = $('#pack-list');

// ---------- 舞台缩放 ----------
let scale = 1;
function fit() {
  scale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  stage.style.transform = `translate(-50%,-50%) scale(${scale})`;
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

// 缺省值：只在"从没选过"时填第一个可用的。选了但暂时找不到（包被禁用/卸载）的不动，
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

// ---------- 渲染 ----------
const renderer = createRenderer({ stage, layer, boardEl, sheet, countEl, resolveRef, bindItem });
async function render() {
  await ensureUrls();
  renderer.render(state, enabledPacks, view());
  syncBgm();
}

// ---------- 撤销 ----------
const history = [];
let lastCommit = { type: '', t: 0 };
function commit(action, { coalesce = false } = {}) {
  const now = Date.now();
  const merge = coalesce && lastCommit.type === action.type && now - lastCommit.t < 500;
  if (!merge) { history.push(structuredClone(project(state))); if (history.length > 50) history.shift(); }
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

// ---------- 已贴贴纸的交互 ----------
let drag = null;
function bindItem(el, uid) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    const it = project(state).items.find(i => i.uid === uid);
    if (!it) return;
    history.push(structuredClone(project(state)));
    apply(state, { type: 'front', uid });
    const p = toStage(e);
    drag = { type: 'move', uid, el, dx: p.x - it.x, dy: p.y - it.y };
    render();
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const it = project(state).items.find(i => i.uid === uid);
    if (!it) return;
    const d = e.deltaY || e.deltaX;
    const patch = e.shiftKey ? { s: it.s + (d < 0 ? 0.1 : -0.1) } : { rot: it.rot + (d < 0 ? -5 : 5) };
    commit({ type: 'transform', uid, ...patch }, { coalesce: true });
    render();
  }, { passive: false });
  el.addEventListener('dblclick', () => {
    el.classList.add('peel');
    setTimeout(() => { commit({ type: 'remove', uid }); render(); }, 220);
  });
}

// ---------- 从贴纸册撕下来 ----------
sheet.addEventListener('pointerdown', e => {
  const t = e.target.closest('.thumb');
  if (!t || t.classList.contains('used')) return;
  e.preventDefault();
  const ref = t.dataset.ref;
  const hit = resolveRef(ref);
  if (!hit) return;
  const g = document.createElement('img');
  g.src = Packs.urlSync(hit.entry.sha256);
  g.className = 'ghost';
  g.style.width = hit.entry.w + 'px';
  stage.appendChild(g);
  const p = toStage(e);
  g.style.left = p.x + 'px'; g.style.top = p.y + 'px';
  t.classList.add('lifting');
  drag = { type: 'new', ref, el: g, thumb: t };
});
addEventListener('pointermove', e => {
  if (!drag) return;
  const p = toStage(e);
  if (drag.type === 'new') {
    drag.el.style.left = p.x + 'px'; drag.el.style.top = p.y + 'px';
  } else {
    apply(state, { type: 'move', uid: drag.uid, x: p.x - drag.dx, y: p.y - drag.dy });
    const it = project(state).items.find(i => i.uid === drag.uid);
    if (it) renderer.placeStyle(drag.el, it);
  }
});
addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.type === 'new') {
    d.el.remove();
    d.thumb.classList.remove('lifting');
    if (inside(stage, e) && !inside(panel, e)) {
      const p = toStage(e);
      const uid = commit({ type: 'place', ref: d.ref, x: p.x, y: p.y, rot: +(Math.random() * 14 - 7).toFixed(1) });
      render().then(() => renderer.node(uid)?.classList.add('stick'));
    }
  } else {
    save();
  }
});
addEventListener('pointercancel', () => {
  if (drag?.type === 'new') { drag.el.remove(); drag.thumb.classList.remove('lifting'); }
  drag = null;
});

// ---------- 音乐 ----------
function syncBgm() {
  const hit = resolveRef(view().bgm);
  const u = hit ? Packs.urlSync(hit.entry.sha256) : '';
  if (u && audio.dataset.hash !== hit.entry.sha256) { audio.src = u; audio.dataset.hash = hit.entry.sha256; audio.volume = 0.5; }
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
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } });
$('#btn-clear').onclick = () => {
  if (!project(state).items.length) return;
  commit({ type: 'clear' }); render();
  showToast('全部撕回贴纸册啦（Ctrl+Z 可反悔）');
};

// ---------- 素材包管理 ----------
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
      `${p.label} · 贴纸 ${counts.sticker || 0} · 底板 ${counts.board || 0} · 桌面 ${counts.background || 0} · 音乐 ${counts.bgm || 0} · ${fmtMB(p.bytes)} · 清单 ${p.manifestSha256.slice(0, 8)}`;
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
  const info = await Packs.storageInfo();
  $('#storage').textContent = info ? `本地已用 ${fmtMB(info.usage)} / 可用 ${fmtMB(info.quota)}` : '';
}
$('#btn-packs').onclick = () => { modal.hidden = false; renderPackList(); };
$('#btn-close').onclick = () => { modal.hidden = true; };
modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
$('#btn-add').onclick = async () => {
  const v = $('#pack-input').value.trim();
  if (!v) return;
  $('#pack-input').value = '';
  await install(v);
};
$('#pack-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-add').click(); });
$('#btn-gc').onclick = async () => { const n = await Packs.gc(); showToast(`清掉了 ${n} 个无引用文件`); renderPackList(); };
$('#btn-default').onclick = installDefault;

// ---------- 启动 ----------
try { await navigator.storage?.persist?.(); } catch {}
await reloadPacks();
if (!installed.length) {
  await installDefault();
} else {
  hideLoading();
  await refresh();
}
