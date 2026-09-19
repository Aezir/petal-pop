// 游戏状态：装机清单 + 作品列表 + 设置。
// 规矩：画面永远从这里算出来；改状态只走 apply(action)；读旧存档走 normalize()。
export const STATE_VERSION = 7;   // 7：桌上可以同时摆好几本子（project.boards），贴纸记自己贴在哪一本
const DEFAULT_PACK = 'petalpop-default';

// 本子默认摆在桌面中央。贴纸和本子都是原始大小，不缩放、不翻转。
// BOARD_DEFAULT 是最早那版存档里本子的位置（读旧档时兜底用）；新开的本子摆在桌面中间偏下（贴纸纸已经搬到右栏，不用让位）
export const BOARD_DEFAULT = { x: 830, y: 585 };
const BOARD_START = { x: 836, y: 470 };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const r2 = v => +(+v).toFixed(2);

// boards：桌上摆着的本子，一本 { id, ref, x, y }（x,y 是本子中心的桌面坐标），数组顺序 = 叠放顺序，最后一本在最上面。
// 一本本子上的贴纸留不留，靠「作品」（state.works）：取消勾选时要么先存进作品要么就丢掉，桌上不留隐形的东西。
// boardZ：所有本子共用一个缩放。桌面背景是锁死的，放大缩小只作用在本子身上，所以它是作品的一部分、跟着作品走
const BOARD_STEP = 24;   // 多开一本时的层叠错位
export function makeProject(id, name) {
  return { id, name, boards: [], background: null, boardZ: 1, seq: 1, bseq: 1, seeded: false, items: [] };
}

export function makeState() {
  return {
    version: STATE_VERSION,
    activeProject: 'p1',
    projects: { p1: makeProject('p1', '我的本子') },
    settings: { bgm: true, bgmRef: null, volume: 0.5, skinRef: null },
    // 作品：一张纸/一页本子 + 贴在它上面的贴纸。跟当前桌面分开存，不进撤销快照
    works: {},          // 作品 id → { id, name, ref, items, createdAt, updatedAt }
    packs: {},          // 包 id → { enabled, order, pinned, fav, addedAt }
    ui: { sideOpen: true, stripsOpen: true, strips: {}, packSort: { key: 'manual', dir: 1 } },   // 面板状态：跟作品无关，撤销不管它
  };
}

export const ZOOM = [0.25, 4];
export const PACK_SORTS = ['manual', 'name', 'added'];   // 自定义（拖出来的顺序）/ 名称 / 添加时间
function normUi(u) {
  const ui = { sideOpen: true, stripsOpen: true, strips: {}, ...(u && typeof u === 'object' ? u : {}) };
  delete ui.cam;              // v5 的相机：背景锁死之后没有相机了
  delete ui.sideCollapsed;    // v5 的左栏折叠：换成 sideOpen
  ui.sideOpen = ui.sideOpen !== false;
  ui.stripsOpen = ui.stripsOpen !== false;
  const ps = ui.packSort;
  ui.packSort = {
    key: PACK_SORTS.includes(ps?.key) ? ps.key : 'manual',
    dir: ps?.dir === -1 ? -1 : 1,
  };
  ui.strips = Object.fromEntries(Object.entries(ui.strips && typeof ui.strips === 'object' ? ui.strips : {}).map(([k, v]) => [k, { collapsed: !!v?.collapsed }]));
  return ui;
}

// 贴纸条目字段：
//   on  'desk' 贴在桌面（x,y 是舞台坐标）| 'board' 贴在本子上（x,y 是相对本子中心的坐标，跟本子一起挪）
//   rot 旋转角度
// oldT 是本子在旧存档里的样子（v3 及以前可能带缩放 s 和翻转 flip），只用来迁移坐标
function normItem(i, oldT, legacy, firstBoard) {
  const { s, group, flip, ...rest } = i;   // v4 去掉了缩放、成组、翻转
  const it = {
    ...rest,
    uid: +i.uid || 0, x: +i.x || 0, y: +i.y || 0, rot: +i.rot || 0, z: +i.z || 0,
    on: i.on === 'board' ? 'board' : 'desk',
  };
  if (it.on === 'board' && typeof it.board !== 'string') it.board = firstBoard;   // v6 的贴纸只会贴在唯一那本上
  if (it.on !== 'board') delete it.board;
  if (legacy) {
    // 旧存档（没有 on 字段）：落在本子范围内的贴纸转成本子坐标
    if (Math.abs(it.x - oldT.x) <= 380 && Math.abs(it.y - oldT.y) <= 240) {
      it.on = 'board';
      it.board = firstBoard;
      it.x = r2((it.x - oldT.x) / oldT.s);
      it.y = r2((it.y - oldT.y) / oldT.s);
    }
  } else if (it.on === 'board' && oldT.flip) {
    // v3 本子翻过面：去掉翻转后把贴纸镜像回原来看到的位置
    it.x = r2(-it.x);
  }
  return it;
}

// 幂等：normalize(normalize(x)) 与 normalize(x) 相同。不认识的字段尽量原样保留。
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return makeState();
  let s = structuredClone(raw);
  if (!s.version) s = fromV1(s);

  s.version = STATE_VERSION;
  s.projects = (s.projects && typeof s.projects === 'object') ? s.projects : {};
  if (!Object.keys(s.projects).length) s.projects.p1 = makeProject('p1', '我的本子');
  for (const [id, p] of Object.entries(s.projects)) {
    p.id = id;
    p.name ||= '未命名';
    p.background ??= null;
    const t = { ...BOARD_DEFAULT, ...(p.boardT || {}) };
    const oldT = { x: +t.x || BOARD_DEFAULT.x, y: +t.y || BOARD_DEFAULT.y, s: +t.s || 1, flip: !!t.flip };
    p.boardZ = clamp(+p.boardZ || 1, ZOOM);
    delete p.sheetT;   // v5 之前贴纸纸是桌上的物件，有位置和页码；现在是右栏的贴纸条，不再存
    // v6 及以前只有一本本子（p.board + p.boardT）：搬成 boards 里的第一本 b1
    if (!Array.isArray(p.boards)) {
      p.boards = typeof p.board === 'string' ? [{ id: 'b1', ref: p.board, x: oldT.x, y: oldT.y }] : [];
    }
    delete p.board; delete p.boardT;
    p.boards = p.boards
      .filter(b => b && typeof b.ref === 'string')
      .map((b, i) => ({ id: typeof b.id === 'string' && b.id ? b.id : 'b' + (i + 1), ref: b.ref, x: +b.x || oldT.x, y: +b.y || oldT.y, ...(typeof b.work === 'string' ? { work: b.work } : {}) }));
    delete p.hiddenBoards;
    const firstBoard = p.boards[0]?.id || 'b1';
    p.items = (Array.isArray(p.items) ? p.items : [])
      .filter(i => i && typeof i.ref === 'string')
      .map(i => normItem(i, oldT, !('on' in i), firstBoard));
    p.seeded = !!p.seeded || p.boards.length > 0;   // 第一次开档时自动摆一本；之后玩家收光了就是空桌子
    const liveBoards = new Set(p.boards.map(b => b.id));
    p.items = p.items.filter(i => i.on !== 'board' || liveBoards.has(i.board));   // 本子没了，贴在它上面的贴纸也就没了
    p.seq = Math.max(+p.seq || 1, ...p.items.map(i => i.uid + 1), ...p.items.map(i => i.z + 1));
    p.bseq = Math.max(+p.bseq || 1, ...p.boards.map(b => (+String(b.id).replace(/^b/, '') || 0) + 1));
  }
  if (!s.projects[s.activeProject]) s.activeProject = Object.keys(s.projects)[0];
  s.settings = { bgm: true, bgmRef: null, volume: 0.5, skinRef: null, ...(s.settings || {}) };
  s.settings.volume = clamp(+s.settings.volume || 0, [0, 1]);
  if (typeof s.settings.skinRef !== 'string') s.settings.skinRef = null;   // null = 默认主题，本身就是合法选择
  s.works = Object.fromEntries(Object.entries(s.works && typeof s.works === 'object' ? s.works : {})
    .filter(([, w]) => w && typeof w.ref === 'string')
    .map(([id, w]) => [id, {
      id, ref: w.ref,
      name: typeof w.name === 'string' && w.name ? w.name.slice(0, 60) : '未命名作品',
      items: (Array.isArray(w.items) ? w.items : []).filter(i => i && typeof i.ref === 'string')
        .map(i => ({ ref: i.ref, x: +i.x || 0, y: +i.y || 0, rot: +i.rot || 0, z: +i.z || 0 })),
      createdAt: +w.createdAt || 0, updatedAt: +w.updatedAt || +w.createdAt || 0,
    }]));
  s.packs = Object.fromEntries(Object.entries(s.packs && typeof s.packs === 'object' ? s.packs : {})
    .map(([id, v]) => [id, { enabled: v?.enabled !== false, order: +v?.order || 0, pinned: !!v?.pinned, fav: !!v?.fav, addedAt: +v?.addedAt || 0 }]));
  s.ui = normUi(s.ui);
  return s;
}

// 最早那版 demo 的存档：{ notebook, theme, bgm, placed:[{f:'asset-001.png', ...}] }
function fromV1(v1) {
  const s = makeState();
  const p = s.projects.p1;
  const nb = String((Number(v1.notebook) || 0) + 1).padStart(2, '0');
  p.boards = [{ id: 'b1', ref: `${DEFAULT_PACK}:notebook-${nb}`, ...BOARD_DEFAULT }];
  p.background = `${DEFAULT_PACK}:desk-${v1.theme === 'night' ? 'night' : 'day'}`;
  s.settings.bgm = v1.bgm !== false;
  p.items = (v1.placed || []).map(i => ({
    uid: i.uid, ref: `${DEFAULT_PACK}:${String(i.f).replace(/\.png$/i, '')}`,
    x: i.x, y: i.y, rot: i.rot, z: i.z,
  }));
  p.seq = +v1.seq || 1;
  return s;
}

export const project = state => state.projects[state.activeProject];
export const findItem = (p, uid) => p.items.find(i => i.uid === uid);

// 动作都是纯数据（可存、可回放）。返回值：place 返回新贴纸的 uid。
export function apply(state, a) {
  const p = project(state);
  switch (a.type) {
    case 'place': {
      const uid = p.seq++;
      p.items.push({ uid, ref: a.ref, x: a.x, y: a.y, rot: a.rot ?? 0, z: p.seq++, on: a.on === 'board' ? 'board' : 'desk', ...(a.on === 'board' && a.board ? { board: a.board } : {}) });
      return uid;
    }
    case 'move': {            // { uid, x, y, on?, board? } 换到本子上必须同时说是哪一本
      const it = findItem(p, a.uid);
      if (!it) return;
      it.x = r2(a.x); it.y = r2(a.y);
      if (a.on) {
        it.on = a.on === 'board' ? 'board' : 'desk';
        if (it.on === 'board') it.board = a.board || p.boards[p.boards.length - 1]?.id;
        else delete it.board;
      }
      return;
    }
    case 'rotate': {          // { uid, rot }
      const it = findItem(p, a.uid);
      if (it) it.rot = r2(a.rot);
      return;
    }
    case 'front': {
      const it = findItem(p, a.uid);
      if (it) it.z = p.seq++;
      return;
    }
    case 'remove': {
      const set = new Set(a.uids);
      p.items = p.items.filter(i => !set.has(i.uid));
      return;
    }
    case 'clear': p.items = []; return;
    case 'setBackground': p.background = a.ref; return;
    // ---- 桌上的本子 ----
    case 'addBoard': {          // { ref, work? } 摆在桌面中心；已经有本子就每本错开一点，返回新本子的 id
      const id = 'b' + p.bseq++;
      const n = p.boards.length;
      p.boards.push({ id, ref: a.ref, x: BOARD_START.x + n * BOARD_STEP, y: BOARD_START.y + n * BOARD_STEP, ...(a.work ? { work: a.work } : {}) });
      return id;
    }
    case 'removeBoard': {       // { id } 本子和贴在它上面的贴纸一起收走（想留就先存进作品）
      p.boards = p.boards.filter(b => b.id !== a.id);
      p.items = p.items.filter(i => !(i.on === 'board' && i.board === a.id));
      return;
    }
    case 'setBoardRef': { const b = p.boards.find(b => b.id === a.id); if (b) b.ref = a.ref; return; }
    case 'boardMove': { const b = p.boards.find(b => b.id === a.id); if (b) { b.x = r2(a.x); b.y = r2(a.y); } return; }
    case 'boardFront': {        // 数组顺序就是叠放顺序，拖过的那本挪到最后 = 最上面
      const i = p.boards.findIndex(b => b.id === a.id);
      if (i >= 0 && i < p.boards.length - 1) p.boards.push(p.boards.splice(i, 1)[0]);
      return;
    }
    case 'bindWork': { const b = p.boards.find(b => b.id === a.id); if (b) { if (a.work) b.work = a.work; else delete b.work; } return; }
    // ---- 作品 ----
    case 'saveWork': {          // { boardId, workId?, name? } 没给 workId 就新建一份并绑定；返回作品 id
      const b = p.boards.find(b => b.id === a.boardId);
      if (!b) return null;
      const now = Date.now();
      const id = a.workId || 'w' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
      const old = state.works[id];
      state.works[id] = {
        id, ref: b.ref,
        name: a.name || old?.name || '未命名作品',
        items: p.items.filter(i => i.on === 'board' && i.board === b.id).map(i => ({ ref: i.ref, x: i.x, y: i.y, rot: i.rot, z: i.z })),
        createdAt: old?.createdAt || now, updatedAt: now,
      };
      b.work = id;
      return id;
    }
    case 'renameWork': { const w = state.works[a.id]; if (w) { w.name = String(a.name || '').slice(0, 60) || w.name; w.updatedAt = Date.now(); } return; }
    case 'deleteWork': {        // 删作品；桌上绑着它的本子只是解绑，桌面上的东西一个不动
      delete state.works[a.id];
      for (const b of p.boards) if (b.work === a.id) delete b.work;
      return;
    }
    case 'openWork': {          // 在桌上开一本，把作品里的贴纸复制进来（新 uid，指向这本）
      const w = state.works[a.id];
      if (!w) return null;
      const id = apply(state, { type: 'addBoard', ref: w.ref, work: w.id });
      for (const i of w.items) p.items.push({ uid: p.seq++, ref: i.ref, x: i.x, y: i.y, rot: i.rot, z: p.seq++, on: 'board', board: id });
      return id;
    }
    // 缩放本子不进撤销（调用方走 apply 而不是 commit），但作品快照里带着它，撤销时可能被一起还原——可以接受
    case 'boardZoom': p.boardZ = +clamp(+a.z || 1, ZOOM).toFixed(4); return;
    case 'setSetting': Object.assign(state.settings, a.patch); return;
    case 'setUi': Object.assign(state.ui, a.patch); return;
    case 'setStripUi': state.ui.strips[a.id] = { ...(state.ui.strips[a.id] || {}), ...a.patch }; return;
    case 'setBgm':
      if (a.on != null) state.settings.bgm = !!a.on;
      if (a.ref !== undefined) state.settings.bgmRef = a.ref;
      return;
    case 'setPack':   // 第一次见到这个包时才写 addedAt；已有记录不动它
      state.packs[a.id] = { enabled: true, order: Date.now(), pinned: false, fav: false, addedAt: a.addedAt || Date.now(), ...(state.packs[a.id] || {}), ...a.patch };
      return;
    case 'packOrder':   // { ids }：按给定顺序重编 order（置顶组和普通组各自的相对顺序都在这一个序列里）
      a.ids.forEach((id, i) => { if (state.packs[id]) state.packs[id].order = i; });
      return;
    case 'forgetPack': delete state.packs[a.id]; return;
    default: throw new Error('未知动作 ' + a.type);
  }
}
