// UI 皮肤：读素材包里的 skin.json，把值写成 :root 上的 CSS 变量；纹理走 blob 地址。
// 皮肤是第三方内容，所有值走字面量白名单——CSS.supports 拦不住 var(--x, url(...)) 这种替换后才生效的写法。
import { DB } from './db.js';
import { urlFor } from './packs.js';

// skin.json 的键 → CSS 变量。这张表就是白名单，不在表里的键一律忽略（含义见 docs/08 第 11 节）
const COLOR_VARS = {
  bg: '--bg', panel: '--panel', panel2: '--panel2', line: '--line', input: '--input',
  fg: '--fg', dim: '--dim', dim2: '--dim2', accent: '--accent', onAccent: '--on-accent', danger: '--danger',
  shadow: '--shadow', overlay: '--overlay',
  stageBg: '--stage-bg', deskShadow: '--desk-shadow',
  stripPaper: '--strip-paper', stripPaper2: '--strip-paper2', stripDot: '--strip-dot', stripCut: '--strip-cut',
  t1: '--t1', t2: '--t2', t3: '--t3', t4: '--t4', t5: '--t5',
};
const TEXTURE_VARS = {
  sheetPaper: '--skin-strip-bg', box: '--skin-box-img', button: '--skin-button-img',
  modal: '--skin-modal-img', toast: '--skin-toast-img', loading: '--skin-loading-img',
};
const ALL_VARS = [...Object.values(COLOR_VARS), ...Object.values(TEXTURE_VARS), '--font'];

// 颜色只收 HEX、纯数字参数的 rgb/rgba/hsl/hsla，和字面量 transparent（--line 用）；括号里不许出现字母，url()/var() 都进不来
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(rgba?|hsla?)\(\s*[\d.%\s,/]+\)$/i;
const FONT = /^[\p{L}\p{N}\s,"'-]{1,200}$/u;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const isColor = v => typeof v === 'string' && v.length <= 64 && (v.trim() === 'transparent' || HEX.test(v.trim()) || FUNC.test(v.trim()));

// 读一份皮肤配置并校验成"可直接写进 CSS 的东西"。按 包id:哈希 缓存
const cache = new Map();
export async function readSkin({ pack, entry }) {
  const key = pack.id + ':' + entry.sha256;
  if (cache.has(key)) return cache.get(key);
  const blob = await DB.get('blobs', entry.sha256);
  const raw = JSON.parse(await blob.text());   // 安装时已验过是对象且 skinVersion 合法
  const warn = [];
  const colors = {};
  for (const [k, v] of Object.entries(raw.colors || {})) {
    if (!COLOR_VARS[k]) { warn.push(`colors.${k}: 不认识的键`); continue; }
    if (v == null) continue;
    if (!isColor(v)) { warn.push(`colors.${k}: 不是合法颜色，已忽略`); continue; }
    colors[COLOR_VARS[k]] = v.trim();
  }
  const assetOf = id => (typeof id === 'string' && ID_RE.test(id) ? pack.entries.find(e => e.id === id && e.type === 'skin-asset') : null);
  const textures = {};
  for (const [k, v] of Object.entries(raw.textures || {})) {
    if (!TEXTURE_VARS[k]) { warn.push(`textures.${k}: 不认识的槽位`); continue; }
    if (v == null) continue;
    const a = assetOf(v);
    if (!a) { warn.push(`textures.${k}: 包里没有 skin-asset "${v}"，已忽略`); continue; }
    textures[TEXTURE_VARS[k]] = a.sha256;
  }
  if (raw.sheet != null) warn.push('sheet: 已不再支持（贴纸纸改成了右栏的贴纸条，纸色用 colors.stripPaper 等）');
  let font = null;
  if (raw.font != null) {
    if (typeof raw.font === 'string' && FONT.test(raw.font)) font = raw.font;
    else warn.push('font: 只收字体名列表（不加载远程字体），已忽略');
  }
  const preview = assetOf(raw.preview)?.sha256 || null;
  const cfg = {
    name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : entry.id,
    colors, textures, font, preview, warn,
    // 给设置页画色块用：没缩略图时拿 文字/面板/强调 三色拼一个
    swatch: [colors['--fg'] || '#292820', colors['--panel'] || '#f0efeb', colors['--accent'] || '#2268ff'],
  };
  if (warn.length) console.warn(`皮肤 ${pack.id}:${entry.id} 有 ${warn.length} 处被忽略：\n` + warn.join('\n'));
  cache.set(key, cfg);
  return cfg;
}

// 上次应用的颜色存一份到 localStorage，下次启动在读素材包之前就先刷上去，加载页不会先闪一下默认色再变。
// 纹理是 blob 地址、活不过刷新，不缓存。读回来的值再过一遍白名单——localStorage 也不比包内容更可信
const CACHE_KEY = 'petalpop.skin';
const COLOR_SET = new Set(Object.values(COLOR_VARS));
function saveCache(cfg) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...cfg.colors, ...(cfg.font && { '--font': cfg.font }) })); } catch {}
}
export function preloadSkinCache() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return; }
  if (!saved || typeof saved !== 'object') return;
  const st = document.documentElement.style;
  for (const [v, val] of Object.entries(saved)) {
    if (typeof val !== 'string') continue;
    if ((COLOR_SET.has(v) && isColor(val)) || (v === '--font' && FONT.test(val))) st.setProperty(v, val);
  }
}

let seq = 0, active = null;
export const activeSkin = () => active;

// 应用皮肤：先把配置和纹理地址都备好，再一口气"清掉旧的 + 写新的"，中间不闪默认色。
// 序号防乱序：先点 A 再点 B，A 后读完也不能盖掉 B
export async function applySkin(ref, resolveRef) {
  const my = ++seq;
  const hit = resolveRef(ref);
  if (!hit || hit.entry.type !== 'skin') { if (my === seq) clearSkin(); return null; }
  const cfg = await readSkin(hit);
  const urls = await Promise.all(Object.entries(cfg.textures).map(async ([v, sha]) => [v, await urlFor(sha)]));
  if (my !== seq) return null;
  clearSkin();
  const st = document.documentElement.style;
  for (const [v, val] of Object.entries(cfg.colors)) st.setProperty(v, val);
  for (const [v, u] of urls) if (u) st.setProperty(v, `url("${u}")`);
  if (cfg.font) st.setProperty('--font', cfg.font);
  active = ref;
  saveCache(cfg);
  return cfg;
}

export function clearSkin() {
  const st = document.documentElement.style;
  for (const v of ALL_VARS) st.removeProperty(v);
  active = null;
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}
