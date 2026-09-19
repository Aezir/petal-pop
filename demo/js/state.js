// 游戏状态：装机清单 + 作品列表 + 设置。
// 规矩：画面永远从这里算出来；改状态只走 apply(action)；读旧存档走 normalize()。
export const STATE_VERSION = 6;   // 6：桌面背景锁死，能缩放的是本子（project.boardZ）；ui 里换成两个浮层面板的开关
const DEFAULT_PACK = 'petalpop-default';

// 本子默认摆在桌面中央。贴纸和本子都是原始大小，不缩放、不翻转。
// BOARD_DEFAULT 是最早那版存档里本子的位置（读旧档时兜底用）；新开的本子摆在桌面中间偏下（贴纸纸已经搬到右栏，不用让位）
export const BOARD_DEFAULT = { x: 830, y: 585 };
const BOARD_START = { x: 836, y: 470 };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const r2 = v => +(+v).toFixed(2);

// boardZ：本子（画布）的缩放。桌面背景是锁死的，放大缩小只作用在本子身上，所以它是作品的一部分、跟着作品走
export function makeProject(id, name) {
  return { id, name, board: null, background: null, boardT: { ...BOARD_START }, boardZ: 1, seq: 1, items: [] };
}

export function makeState() {
  return {
    version: STATE_VERSION,
    activeProject: 'p1',
    projects: { p1: makeProject('p1', '我的本子') },
    settings: { bgm: true, bgmRef: null, volume: 0.5, skinRef: null },
    packs: {},          // 包 id → { enabled, order }
    ui: { sideOpen: true, stripsOpen: true, strips: {} },   // 面板开关：跟作品无关，撤销不管它
  };
}

export const ZOOM = [0.25, 4];
function normUi(u) {
  const ui = { sideOpen: true, stripsOpen: true, strips: {}, ...(u && typeof u === 'object' ? u : {}) };
  delete ui.cam;              // v5 的相机：背景锁死之后没有相机了
  delete ui.sideCollapsed;    // v5 的左栏折叠：换成 sideOpen
  ui.sideOpen = ui.sideOpen !== false;
  ui.stripsOpen = ui.stripsOpen !== false;
  ui.strips = Object.fromEntries(Object.entries(ui.strips && typeof ui.strips === 'object' ? ui.strips : {}).map(([k, v]) => [k, { collapsed: !!v?.collapsed }]));
  return ui;
}

// 贴纸条目字段：
//   on  'desk' 贴在桌面（x,y 是舞台坐标）| 'board' 贴在本子上（x,y 是相对本子中心的坐标，跟本子一起挪）
//   rot 旋转角度
// oldT 是本子在旧存档里的样子（v3 及以前可能带缩放 s 和翻转 flip），只用来迁移坐标
function normItem(i, oldT, legacy) {
  const { s, group, flip, ...rest } = i;   // v4 去掉了缩放、成组、翻转
  const it = {
    ...rest,
    uid: +i.uid || 0, x: +i.x || 0, y: +i.y || 0, rot: +i.rot || 0, z: +i.z || 0,
    on: i.on === 'board' ? 'board' : 'desk',
  };
  if (legacy) {
    // 旧存档（没有 on 字段）：落在本子范围内的贴纸转成本子坐标
    if (Math.abs(it.x - oldT.x) <= 380 && Math.abs(it.y - oldT.y) <= 240) {
      it.on = 'board';
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
    p.board ??= null;
    p.background ??= null;
    const t = { ...BOARD_DEFAULT, ...(p.boardT || {}) };
    const oldT = { x: +t.x || BOARD_DEFAULT.x, y: +t.y || BOARD_DEFAULT.y, s: +t.s || 1, flip: !!t.flip };
    p.boardT = { x: oldT.x, y: oldT.y };
    p.boardZ = clamp(+p.boardZ || 1, ZOOM);
    delete p.sheetT;   // v5 之前贴纸纸是桌上的物件，有位置和页码；现在是右栏的贴纸条，不再存
    p.items = (Array.isArray(p.items) ? p.items : [])
      .filter(i => i && typeof i.ref === 'string')
      .map(i => normItem(i, oldT, !('on' in i)));
    p.seq = Math.max(+p.seq || 1, ...p.items.map(i => i.uid + 1), ...p.items.map(i => i.z + 1));
  }
  if (!s.projects[s.activeProject]) s.activeProject = Object.keys(s.projects)[0];
  s.settings = { bgm: true, bgmRef: null, volume: 0.5, skinRef: null, ...(s.settings || {}) };
  s.settings.volume = clamp(+s.settings.volume || 0, [0, 1]);
  if (typeof s.settings.skinRef !== 'string') s.settings.skinRef = null;   // null = 默认主题，本身就是合法选择
  s.packs = Object.fromEntries(Object.entries(s.packs && typeof s.packs === 'object' ? s.packs : {})
    .map(([id, v]) => [id, { enabled: v?.enabled !== false, order: +v?.order || 0, pinned: !!v?.pinned, fav: !!v?.fav }]));
  s.ui = normUi(s.ui);
  return s;
}

// 最早那版 demo 的存档：{ notebook, theme, bgm, placed:[{f:'asset-001.png', ...}] }
function fromV1(v1) {
  const s = makeState();
  const p = s.projects.p1;
  const nb = String((Number(v1.notebook) || 0) + 1).padStart(2, '0');
  p.board = `${DEFAULT_PACK}:notebook-${nb}`;
  p.background = `${DEFAULT_PACK}:desk-${v1.theme === 'night' ? 'night' : 'day'}`;
  p.boardT = { ...BOARD_DEFAULT };   // 最早那版的本子在老位置，贴纸坐标按它换算
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
      p.items.push({ uid, ref: a.ref, x: a.x, y: a.y, rot: a.rot ?? 0, z: p.seq++, on: a.on === 'board' ? 'board' : 'desk' });
      return uid;
    }
    case 'move': {            // { uid, x, y, on? }
      const it = findItem(p, a.uid);
      if (!it) return;
      it.x = r2(a.x); it.y = r2(a.y);
      if (a.on) it.on = a.on === 'board' ? 'board' : 'desk';
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
    case 'setBoard': p.board = a.ref; return;
    case 'setBackground': p.background = a.ref; return;
    case 'boardMove': p.boardT.x = r2(a.x); p.boardT.y = r2(a.y); return;
    // 缩放本子不进撤销（调用方走 apply 而不是 commit），但作品快照里带着它，撤销时可能被一起还原——可以接受
    case 'boardZoom': p.boardZ = +clamp(+a.z || 1, ZOOM).toFixed(4); return;
    case 'setSetting': Object.assign(state.settings, a.patch); return;
    case 'setUi': Object.assign(state.ui, a.patch); return;
    case 'setStripUi': state.ui.strips[a.id] = { ...(state.ui.strips[a.id] || {}), ...a.patch }; return;
    case 'setBgm':
      if (a.on != null) state.settings.bgm = !!a.on;
      if (a.ref !== undefined) state.settings.bgmRef = a.ref;
      return;
    case 'setPack':
      state.packs[a.id] = { enabled: true, order: Date.now(), pinned: false, fav: false, ...(state.packs[a.id] || {}), ...a.patch };
      return;
    case 'packOrder':   // { ids }：按给定顺序重编 order（置顶组和普通组各自的相对顺序都在这一个序列里）
      a.ids.forEach((id, i) => { if (state.packs[id]) state.packs[id].order = i; });
      return;
    case 'forgetPack': delete state.packs[a.id]; return;
    default: throw new Error('未知动作 ' + a.type);
  }
}
