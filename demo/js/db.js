// IndexedDB 封装。三个仓库：
//   kv     游戏状态（装机清单 + 作品）
//   blobs  文件内容，键是 sha256（内容寻址：同一份字节只存一次）
//   packs  已安装的素材包记录（id → 清单 + 来源 + 版本锁）
const NAME = 'petalpop', VERSION = 2;
let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 时代按文件名整包缓存的仓库，已被 blobs 取代
      if (db.objectStoreNames.contains('assets')) db.deleteObjectStore('assets');
      for (const s of ['kv', 'blobs', 'packs']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被另一个标签页占着，关掉其它页面再刷新'));
  });
  return opening;
}

// 写操作要等事务真正提交（oncomplete）：put 的 onsuccess 早于提交，配额不足时会在提交阶段 abort，
// 只看 onsuccess 会"返回成功、实际没存"。读操作请求成功就返回
function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    let result;
    req.onsuccess = () => { result = req.result; if (mode === 'readonly') resolve(result); };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  }));
}

export const DB = {
  get: (store, key) => run(store, 'readonly', os => os.get(key)),
  has: (store, key) => run(store, 'readonly', os => os.getKey(key)).then(k => k !== undefined),
  put: (store, key, val) => run(store, 'readwrite', os => os.put(val, key)),
  del: (store, key) => run(store, 'readwrite', os => os.delete(key)),
  keys: store => run(store, 'readonly', os => os.getAllKeys()),
  getAll: store => run(store, 'readonly', os => os.getAll()),
  clear: store => run(store, 'readwrite', os => os.clear()),
};
