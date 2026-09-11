// 游戏状态：装机清单 + 作品列表 + 设置。
// 规矩：画面永远从这里算出来；改状态只走 apply(action)；读旧存档走 normalize()。
export const STATE_VERSION = 4;
const DEFAULT_PACK = 'petalpop-default';

// 本子默认摆在桌面空位中央。贴纸和本子都是原始大小，不缩放、不翻转。
// BOARD_DEFAULT 是老存档里本子的位置（读旧档时兜底用）；新开的本子摆在左边，给右边的贴纸纸让位
export const BOARD_DEFAULT = { x: 830, y: 585 };
const BOARD_START = { x: 420, y: 560 };
// 贴纸纸默认摆在桌面右下；page 是当前摆出来的是第几个包的纸（从 0 数）
export const SHEET_DEFAULT = { x: 1262, y: 640, page: 0 };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const r2 = v => +(+v).toFixed(2);

export function makeProject(id, name) {
  return { id, name, board: null, background: null, boardT: { ...BOARD_START }, sheetT: { ...SHEET_DEFAULT }, seq: 1, items: [] };
}

export function makeState() {
  return {
    version: STATE_VERSION,
    activeProject: 'p1',
    projects: { p1: makeProject('p1', '我的本子') },
    settings: { bgm: true, bgmRef: null, volume: 0.5 },
    packs: {},          // 包 id → { enabled, order }
  };
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
    const st = { ...SHEET_DEFAULT, ...(p.sheetT || {}) };
    p.sheetT = { x: +st.x || SHEET_DEFAULT.x, y: +st.y || SHEET_DEFAULT.y, page: Math.max(0, Math.floor(+st.page) || 0) };
    p.items = (Array.isArray(p.items) ? p.items : [])
      .filter(i => i && typeof i.ref === 'string')
      .map(i => normItem(i, oldT, !('on' in i)));
    p.seq = Math.max(+p.seq || 1, ...p.items.map(i => i.uid + 1), ...p.items.map(i => i.z + 1));
  }
  if (!s.projects[s.activeProject]) s.activeProject = Object.keys(s.projects)[0];
  s.settings = { bgm: true, bgmRef: null, volume: 0.5, ...(s.settings || {}) };
  s.settings.volume = clamp(+s.settings.volume || 0, [0, 1]);
  s.packs = (s.packs && typeof s.packs === 'object') ? s.packs : {};
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
    case 'sheetMove': p.sheetT.x = r2(a.x); p.sheetT.y = r2(a.y); return;
    case 'sheetPage': p.sheetT.page = Math.max(0, a.page | 0); return;
    case 'setSetting': Object.assign(state.settings, a.patch); return;
    case 'setBgm':
      if (a.on != null) state.settings.bgm = !!a.on;
      if (a.ref !== undefined) state.settings.bgmRef = a.ref;
      return;
    case 'setPack':
      state.packs[a.id] = { enabled: true, order: Date.now(), ...(state.packs[a.id] || {}), ...a.patch };
      return;
    case 'forgetPack': delete state.packs[a.id]; return;
    default: throw new Error('未知动作 ' + a.type);
  }
}
