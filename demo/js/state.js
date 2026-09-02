// 游戏状态：装机清单 + 作品列表 + 设置。
// 规矩：画面永远从这里算出来；改状态只走 apply(action)；读旧存档走 normalize()。
export const STATE_VERSION = 3;
const DEFAULT_PACK = 'petalpop-default';

// 本子默认摆在桌面空位中央；s 是缩放，flip 是水平翻转
export const BOARD_DEFAULT = { x: 830, y: 585, s: 1, flip: false };
// 放大上限：像素素材超过 2 倍就明显糊，本子更保守
export const SCALE = { item: [0.5, 2], board: [0.6, 1.6] };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const r2 = v => +(+v).toFixed(2);

export function makeProject(id, name) {
  return { id, name, board: null, background: null, boardT: { ...BOARD_DEFAULT }, seq: 1, items: [] };
}

export function makeState() {
  return {
    version: STATE_VERSION,
    activeProject: 'p1',
    projects: { p1: makeProject('p1', '我的本子') },
    settings: { bgm: true, bgmRef: null, volume: 0.5, panelOpen: true },
    packs: {},          // 包 id → { enabled, order }
  };
}

// 贴纸条目字段：
//   on    'desk' 贴在桌面（x,y 是舞台坐标）| 'board' 贴在本子上（x,y 是本子局部坐标，跟本子一起缩放翻转）
//   group 成组编号，同组一起挪；null 表示单独
//   flip  水平翻转
function normItem(i, boardT, legacy) {
  const it = {
    ...i,
    uid: +i.uid || 0, x: +i.x || 0, y: +i.y || 0, rot: +i.rot || 0,
    s: clamp(+i.s || 1, SCALE.item), z: +i.z || 0,
    flip: !!i.flip,
    on: i.on === 'board' ? 'board' : 'desk',
    group: i.group == null ? null : +i.group,
  };
  // 旧存档（没有 on 字段）：落在本子范围内的贴纸转成本子坐标
  if (legacy && Math.abs(it.x - boardT.x) <= 380 && Math.abs(it.y - boardT.y) <= 240) {
    it.on = 'board';
    it.x = r2((it.x - boardT.x) / boardT.s);
    it.y = r2((it.y - boardT.y) / boardT.s);
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
    p.boardT = { x: +t.x || BOARD_DEFAULT.x, y: +t.y || BOARD_DEFAULT.y, s: clamp(+t.s || 1, SCALE.board), flip: !!t.flip };
    p.items = (Array.isArray(p.items) ? p.items : [])
      .filter(i => i && typeof i.ref === 'string')
      .map(i => normItem(i, p.boardT, !('on' in i)));
    p.seq = Math.max(+p.seq || 1, ...p.items.map(i => i.uid + 1), ...p.items.map(i => i.z + 1), ...p.items.map(i => (i.group ?? 0) + 1));
  }
  if (!s.projects[s.activeProject]) s.activeProject = Object.keys(s.projects)[0];
  s.settings = { bgm: true, bgmRef: null, volume: 0.5, panelOpen: true, ...(s.settings || {}) };
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
  s.settings.bgm = v1.bgm !== false;
  p.items = (v1.placed || []).map(i => ({
    uid: i.uid, ref: `${DEFAULT_PACK}:${String(i.f).replace(/\.png$/i, '')}`,
    x: i.x, y: i.y, rot: i.rot, s: i.s, z: i.z,
  }));
  p.seq = +v1.seq || 1;
  return s;
}

export const project = state => state.projects[state.activeProject];
export const findItem = (p, uid) => p.items.find(i => i.uid === uid);
export const groupOf = (p, uid) => {
  const it = findItem(p, uid);
  if (!it) return [];
  return it.group == null ? [it] : p.items.filter(i => i.group === it.group);
};

// 动作都是纯数据（可存、可回放）。返回值：place 返回新贴纸的 uid。
export function apply(state, a) {
  const p = project(state);
  switch (a.type) {
    case 'place': {
      const uid = p.seq++;
      p.items.push({
        uid, ref: a.ref, x: a.x, y: a.y, rot: a.rot ?? 0, s: clamp(a.s ?? 1, SCALE.item),
        z: p.seq++, flip: !!a.flip, on: a.on === 'board' ? 'board' : 'desk', group: null,
      });
      return uid;
    }
    case 'moveMany':          // [{uid, x, y, on?}]
      for (const m of a.items) {
        const it = findItem(p, m.uid);
        if (!it) continue;
        it.x = r2(m.x); it.y = r2(m.y);
        if (m.on) it.on = m.on === 'board' ? 'board' : 'desk';
      }
      return;
    case 'transform': {
      const it = findItem(p, a.uid);
      if (!it) return;
      if (a.rot != null) it.rot = r2(a.rot);
      if (a.s != null) it.s = r2(clamp(a.s, SCALE.item));
      if (a.flip != null) it.flip = !!a.flip;
      return;
    }
    case 'front':
      for (const uid of a.uids) { const it = findItem(p, uid); if (it) it.z = p.seq++; }
      return;
    case 'group':             // { uids, group }  group 为 null 即拆开
      for (const uid of a.uids) { const it = findItem(p, uid); if (it) it.group = a.group; }
      return;
    case 'remove': {
      const set = new Set(a.uids);
      p.items = p.items.filter(i => !set.has(i.uid));
      return;
    }
    case 'clear': p.items = []; return;
    case 'setBoard': p.board = a.ref; return;
    case 'setBackground': p.background = a.ref; return;
    case 'boardSet': {        // { x?, y?, s?, flip? }
      const t = p.boardT;
      if (a.x != null) t.x = r2(a.x);
      if (a.y != null) t.y = r2(a.y);
      if (a.s != null) t.s = r2(clamp(a.s, SCALE.board));
      if (a.flip != null) t.flip = !!a.flip;
      return;
    }
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
