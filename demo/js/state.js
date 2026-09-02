// 游戏状态：装机清单 + 作品列表 + 设置。
// 规矩：画面永远从这里算出来；改状态只走 apply(action)；读旧存档走 normalize()。
export const STATE_VERSION = 2;
const DEFAULT_PACK = 'petalpop-default';

export function makeProject(id, name) {
  return { id, name, board: null, background: null, seq: 1, items: [] };
}

export function makeState() {
  return {
    version: STATE_VERSION,
    activeProject: 'p1',
    projects: { p1: makeProject('p1', '我的本子') },
    settings: { bgm: true, bgmRef: null },
    packs: {},          // 包 id → { enabled, order }
  };
}

// 幂等：normalize(normalize(x)) === normalize(x)。不认识的字段尽量原样保留。
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
    p.items = (Array.isArray(p.items) ? p.items : [])
      .filter(i => i && typeof i.ref === 'string')
      .map(i => ({ ...i, uid: +i.uid || 0, x: +i.x || 0, y: +i.y || 0, rot: +i.rot || 0, s: +i.s || 1, z: +i.z || 0 }));
    p.seq = Math.max(+p.seq || 1, ...p.items.map(i => i.uid + 1), ...p.items.map(i => i.z + 1));
  }
  if (!s.projects[s.activeProject]) s.activeProject = Object.keys(s.projects)[0];
  s.settings = { bgm: true, bgmRef: null, ...(s.settings || {}) };
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
const find = (p, uid) => p.items.find(i => i.uid === uid);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 动作都是纯数据（可存、可回放）。返回值：place 返回新贴纸的 uid。
export function apply(state, a) {
  const p = project(state);
  switch (a.type) {
    case 'place': {
      const uid = p.seq++;
      p.items.push({ uid, ref: a.ref, x: a.x, y: a.y, rot: a.rot ?? 0, s: a.s ?? 1, z: p.seq++ });
      return uid;
    }
    case 'move': { const it = find(p, a.uid); if (it) { it.x = a.x; it.y = a.y; } return; }
    case 'transform': {
      const it = find(p, a.uid);
      if (!it) return;
      if (a.rot != null) it.rot = a.rot;
      if (a.s != null) it.s = +clamp(a.s, 0.3, 3).toFixed(2);
      return;
    }
    case 'front': { const it = find(p, a.uid); if (it) it.z = p.seq++; return; }
    case 'remove': p.items = p.items.filter(i => i.uid !== a.uid); return;
    case 'clear': p.items = []; return;
    case 'setBoard': p.board = a.ref; return;
    case 'setBackground': p.background = a.ref; return;
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
