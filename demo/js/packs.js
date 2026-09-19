// 素材包：来源解析、清单校验、原子安装、卸载、垃圾回收
// 格式约定见 docs/08-pack-format.md
import { DB } from './db.js';
import { sha256 } from './hash.js';

export const FORMAT_VERSION = 1;
// 内核认识的内容类型 → 文件种类
export const TYPES = { sticker: 'image', board: 'image', background: 'image', bgm: 'audio', skin: 'json', 'skin-asset': 'image' };
export const LIMITS = { fileBytes: 32 * 1024 * 1024, entries: 2000, packBytes: 300 * 1024 * 1024, skinAssetEdge: 2048 };
export const SKIN_VERSION = 1;   // 皮肤配置（skin.json）的格式版本
// 安装器版本：安装记录里开始存新字段、或 TYPES 变了就加一（2：贴纸纸排版 sheet/scale；3：skin 类型 + 跳过的条目 skipped）。
// 旧安装器装的记录缺这些字段（或当年跳过了它不认识的条目），启动时自动重装一次；文件没变的不重下
export const INSTALLER = 3;

// 安装 / 卸载 / 回收互斥：同一标签页串成一条链，跨标签页再用 Web Locks。
// 回收只认已提交的包，进行中的安装写了 blob 还没写 packs 记录，这时回收会把它删掉
let chain = Promise.resolve();
function exclusive(fn) {
  const run = () => (navigator.locks?.request ? navigator.locks.request('petalpop-packs', fn) : fn());
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const AUDIO_EXT = /\.(mp3|ogg|m4a)$/i;
const JSON_EXT = /\.json$/i;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// ---------- 来源 ----------
// 支持两种写法：
//   local:packs/default                 跟游戏放在一起的目录（相对项目根）
//   owner/repo  或  owner/repo@tag      GitHub 仓库，经 jsDelivr 拉取
export function parseSource(text) {
  text = String(text || '').trim();
  if (text.startsWith('local:')) {
    const path = text.slice(6).replace(/^\/+|\/+$/g, '');
    if (!path || path.includes('..')) throw new Error('本地路径不合法');
    return { kind: 'local', path };
  }
  const m = text.replace(/^gh:/, '').replace(/^https?:\/\/github\.com\//, '')
    .match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w.\/-]+))?$/);
  if (m) return { kind: 'gh', owner: m[1], repo: m[2], ref: m[3] || '' };
  throw new Error('看不懂的来源。写成「用户名/仓库名」或「用户名/仓库名@标签」，本地目录写「local:packs/xxx」');
}

export function sourceText(src) {
  return src.kind === 'local' ? 'local:' + src.path
    : `${src.owner}/${src.repo}${src.ref ? '@' + src.ref : ''}`;
}

// 把来源解析成「文件基地址 + 版本锁」。
// GitHub 来源不走 GitHub API（匿名每小时只有 60 次，很容易用光），全靠 jsDelivr：
//   写了 @版本  → 锁到这个标签 / 分支 / commit
//   没写版本    → 问 jsDelivr 这个仓库最新的标签；一个标签都没有就用默认分支（靠清单哈希判断更新）
export async function resolveSource(src) {
  if (src.kind === 'local') {
    const base = new URL('../' + src.path + '/', location.href).href;
    return { base, lock: null, label: '本地 ' + src.path };
  }
  const { owner, repo } = src;
  let ref = src.ref;
  if (!ref) {
    try {
      const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}`);
      if (r.ok) ref = (await r.json()).versions?.[0]?.version || '';   // jsDelivr 会把 v1.0.0 记作 1.0.0
    } catch {}
  }
  const at = ref ? '@' + ref : '';
  // jsDelivr 单文件 20MB 上限，超了退回 GitHub raw（100MB 上限，也带跨域头）。
  // raw 需要真实标签名，jsDelivr 可能去掉了 v 前缀，所以两种都试。
  const rawRefs = ref ? [ref, 'v' + ref] : ['HEAD'];
  return {
    base: `https://cdn.jsdelivr.net/gh/${owner}/${repo}${at}/`,
    fallbackBases: rawRefs.map(x => `https://raw.githubusercontent.com/${owner}/${repo}/${x}/`),
    lock: ref || null,
    label: `${owner}/${repo}${at || '@默认分支'}`,
  };
}

async function fetchFile(res, file, signal) {
  const opts = { ...(res.lock ? {} : { cache: 'no-cache' }), signal };
  let r = await fetch(res.base + file, opts);
  for (const b of res.fallbackBases || []) {
    if (r.ok) break;
    r = await fetch(b + file, opts);
  }
  return r;
}

// ---------- 清单校验 ----------
// 只取内核认识的字段；不认识的字段忽略（向前兼容）。缺 id 的条目直接拒绝。
export function validateManifest(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('manifest.json 顶层必须是对象');
  const fv = json.formatVersion;
  if (!Number.isInteger(fv) || fv < 1) throw new Error('缺少 formatVersion');
  if (fv > FORMAT_VERSION) throw new Error(`这个包的格式版本 ${fv} 比播放器认识的 ${FORMAT_VERSION} 新，请升级游戏`);
  if (typeof json.id !== 'string' || !ID_RE.test(json.id)) throw new Error('包 id 不合法（小写字母/数字/-/_，字母数字开头）');
  if (typeof json.version !== 'string' || !json.version) throw new Error('缺少 version');
  if (!Array.isArray(json.entries)) throw new Error('缺少 entries 数组');
  if (json.entries.length > LIMITS.entries) throw new Error(`条目超过 ${LIMITS.entries} 个`);

  const seen = new Set(), skipped = [];
  const entries = json.entries.map((e, i) => {
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object') throw new Error(`${at} 不是对象`);
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) throw new Error(`${at} 缺少合法 id（每个条目必须声明稳定的 id）`);
    if (seen.has(e.id)) throw new Error(`条目 id 重复: ${e.id}`);
    seen.add(e.id);
    // 不认识的类型（更新的包格式）：跳过不装，记下来给设置页看；升级游戏后重装会补上
    if (!Object.hasOwn(TYPES, e.type)) {
      console.warn(`${at}(${e.id}) 类型不认识，已跳过: ${e.type}`);
      skipped.push({ id: e.id, type: String(e.type), file: typeof e.file === 'string' ? e.file : '' });
      return null;
    }
    if (typeof e.file !== 'string' || !e.file || e.file.startsWith('/') || e.file.split('/').includes('..')) throw new Error(`${at}(${e.id}) file 不合法`);
    const kind = TYPES[e.type];
    if (kind === 'image' && !IMAGE_EXT.test(e.file)) throw new Error(`${e.id}: 图片只收 png/jpg/webp/gif（不收 svg）`);
    if (kind === 'audio' && !AUDIO_EXT.test(e.file)) throw new Error(`${e.id}: 音频只收 mp3/ogg/m4a`);
    if (kind === 'json' && !JSON_EXT.test(e.file)) throw new Error(`${e.id}: 皮肤配置只收 .json`);
    if (e.sha256 != null && !HEX64.test(e.sha256)) throw new Error(`${e.id}: sha256 格式不对`);
    const out = { id: e.id, type: e.type, file: e.file };
    if (e.sha256) out.sha256 = e.sha256;
    if (Number.isFinite(e.w) && Number.isFinite(e.h)) { out.w = e.w; out.h = e.h; }
    for (const k of ['name', 'tags', 'anchor', 'deprecated']) if (e[k] != null) out[k] = e[k];
    if (Number.isFinite(e.sheet?.x) && Number.isFinite(e.sheet?.y)) out.sheet = { x: e.sheet.x, y: e.sheet.y };
    return out;
  }).filter(Boolean);
  if (!entries.length && skipped.length) throw new Error('这个包里的条目一个都不认识，可能要先升级游戏');

  // 可选：贴纸纸原图尺寸（配合条目的 sheet 位置照原样排版），手动缩放比例
  const sheet = json.sheet?.w > 0 && json.sheet?.h > 0 ? { w: json.sheet.w, h: json.sheet.h } : null;
  const scale = Number.isFinite(json.scale) && json.scale > 0 && json.scale <= 4 ? json.scale : null;

  return {
    sheet, scale,
    formatVersion: fv,
    id: json.id,
    name: json.name ?? json.id,
    version: json.version,
    author: typeof json.author === 'string' ? json.author : '',
    license: typeof json.license === 'string' ? json.license : '',
    description: typeof json.description === 'string' ? json.description : '',
    entries, skipped,
  };
}

export function displayName(name) {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name.zh || name.en || Object.values(name)[0] || '';
  return '';
}

// ---------- 文件体检：不只信 MIME 声明 ----------
async function verifyBlob(blob, kind, entry) {
  if (kind === 'image') {
    if (!blob.type.startsWith('image/')) throw new Error(`${entry.file} 不是图片（${blob.type || '无类型'}）`);
    let bmp;
    try { bmp = await createImageBitmap(blob); }
    catch { throw new Error(`${entry.file} 图片解码失败`); }
    const dims = { w: bmp.width, h: bmp.height };
    bmp.close();
    if (entry.type === 'skin-asset' && Math.max(dims.w, dims.h) > LIMITS.skinAssetEdge) throw new Error(`${entry.file} 皮肤纹理最长边不能超过 ${LIMITS.skinAssetEdge}px`);
    return dims;
  }
  if (kind === 'json') {   // 不查 MIME：本地静态服务器可能给 text/plain 甚至空。内容形状在这里把关，装进去的皮肤一定能读
    let j;
    try { j = JSON.parse(await blob.text()); } catch { throw new Error(`${entry.file} 不是合法 JSON`); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${entry.file} 顶层必须是对象`);
    if (entry.type === 'skin') {
      const v = j.skinVersion;
      if (!Number.isInteger(v) || v < 1) throw new Error(`${entry.file} 缺少 skinVersion`);
      if (v > SKIN_VERSION) throw new Error(`${entry.file} 的皮肤格式版本 ${v} 比游戏认识的 ${SKIN_VERSION} 新，请升级游戏`);
    }
    return {};
  }
  if (!blob.type.startsWith('audio/')) throw new Error(`${entry.file} 不是音频（${blob.type || '无类型'}）`);
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...head);
  const isMp3 = s.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  const isOgg = s.startsWith('OggS');
  const isM4a = s.slice(4, 8) === 'ftyp';
  if (!isMp3 && !isOgg && !isM4a) throw new Error(`${entry.file} 不像 mp3/ogg/m4a`);
  return {};
}

// n 个 worker 分食任务；一个失败就不再取新任务、中断其余下载（signal），等全部退出后再抛
export async function pool(items, n, fn) {
  let i = 0, failed = null;
  const ac = new AbortController();
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && !failed) {
      try { await fn(items[i++], ac.signal); }
      catch (e) { if (!failed) { failed = e; ac.abort(); } }
    }
  }));
  if (failed) throw failed;
}

// ---------- 安装（原子）----------
// 1. 解析来源、钉死版本  2. 拉清单、校验  3. 全部文件下载 + 体检 + 对 sha256，按哈希写入 blobs
// 4. 全部成功后才写 packs 记录（这一步就是“翻转”）。中途失败：旧版本记录原样保留，
//    已写入的 blobs 是孤儿，垃圾回收会收走。
export const installPack = (text, onProgress) => exclusive(() => doInstall(text, onProgress));
async function doInstall(text, onProgress = () => {}) {
  const src = parseSource(text);
  onProgress({ phase: 'resolve' });
  const res = await resolveSource(src);

  onProgress({ phase: 'manifest' });
  const mr = await fetch(res.base + 'manifest.json', { cache: 'no-cache' });
  if (!mr.ok) throw new Error(`没找到 manifest.json（HTTP ${mr.status}）`);
  const mblob = await mr.blob();
  const manifestSha256 = await sha256(mblob);
  let json;
  try { json = JSON.parse(await mblob.text()); } catch { throw new Error('manifest.json 不是合法 JSON'); }
  const man = validateManifest(json);

  const existing = await DB.get('packs', man.id);
  if (existing && existing.manifestSha256 === manifestSha256 && existing.lock === res.lock && existing.installer === INSTALLER) {
    return { pack: existing, unchanged: true };
  }

  const total = man.entries.length;
  let done = 0, bytes = 0;
  const entries = new Array(total);
  const known = new Map((existing?.entries || []).map(e => [e.sha256, e]));
  await pool(man.entries.map((e, i) => [e, i]), 6, async ([e, i], signal) => {
    // 增量更新：清单写了哈希、这份字节上次已经体检过并存在库里，就不用再下载
    const prev = e.sha256 && known.get(e.sha256);
    if (prev && await DB.has('blobs', e.sha256)) {
      entries[i] = { ...e, ...(prev.w != null && { w: prev.w, h: prev.h }), sha256: e.sha256, bytes: prev.bytes };
      bytes += prev.bytes;
      onProgress({ phase: 'files', done: ++done, total, bytes });
      return;
    }
    const r = await fetchFile(res, e.file, signal);
    if (!r.ok) throw new Error(`下载失败 ${e.file}（HTTP ${r.status}）`);
    const blob = await r.blob();
    if (blob.size > LIMITS.fileBytes) throw new Error(`${e.file} 超过单文件上限 32MB`);
    const dims = await verifyBlob(blob, TYPES[e.type], e);
    const hash = await sha256(blob);
    if (e.sha256 && e.sha256 !== hash) throw new Error(`${e.file} 内容和清单里的 sha256 对不上，文件可能被改过或传坏了`);
    if (!(await DB.has('blobs', hash))) await DB.put('blobs', hash, blob);
    bytes += blob.size;
    if (bytes > LIMITS.packBytes) throw new Error('整包超过 300MB 上限');
    entries[i] = { ...e, ...dims, sha256: hash, bytes: blob.size };
    onProgress({ phase: 'files', done: ++done, total, bytes });
  });

  const pack = {
    id: man.id, name: man.name, version: man.version, author: man.author,
    license: man.license, description: man.description, formatVersion: man.formatVersion,
    sheet: man.sheet, scale: man.scale,
    source: sourceText(src), base: res.base, lock: res.lock, label: res.label,
    manifestSha256, installer: INSTALLER, installedAt: Date.now(), bytes, entries, skipped: man.skipped,
  };
  await DB.put('packs', man.id, pack);
  return { pack, unchanged: false, updated: !!existing };
}

export const listPacks = () => DB.getAll('packs');

export const uninstallPack = id => exclusive(async () => { await DB.del('packs', id); return sweep(); });

// 垃圾回收：从已安装清单出发找可达哈希，其余 blobs 全删（和安装互斥，见 exclusive）
export const gc = () => exclusive(sweep);
async function sweep() {
  const packs = await DB.getAll('packs');
  const live = new Set();
  for (const p of packs) for (const e of p.entries) live.add(e.sha256);
  const keys = await DB.keys('blobs');
  let removed = 0;
  for (const k of keys) if (!live.has(k)) { await DB.del('blobs', k); removed++; }
  return removed;
}

// 检查来源有没有新版本（不下载）
export async function checkUpdate(pack) {
  const res = await resolveSource(parseSource(pack.source));
  if (res.lock && pack.lock) return { available: res.lock !== pack.lock, label: res.label };
  const mr = await fetch(res.base + 'manifest.json', { cache: 'no-cache' });
  if (!mr.ok) throw new Error('清单读不到');
  const h = await sha256(await mr.blob());
  return { available: h !== pack.manifestSha256, label: res.label };
}

export async function storageInfo() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

// ---------- Blob → 对象地址（懒加载 + 缓存） ----------
// 缓存里存地址或进行中的 Promise：并发要同一个哈希时不重复读库、不重复建地址。库里没有的不缓存（装上后能再试）
const urlCache = new Map();
export function urlFor(hash) {
  if (urlCache.has(hash)) return Promise.resolve(urlCache.get(hash));
  const p = DB.get('blobs', hash).then(blob => {
    if (!blob) { urlCache.delete(hash); return null; }
    const u = URL.createObjectURL(blob);
    urlCache.set(hash, u);
    return u;
  }, e => { urlCache.delete(hash); throw e; });
  urlCache.set(hash, p);
  return p;
}
export const urlSync = hash => { const v = urlCache.get(hash); return typeof v === 'string' ? v : null; };
