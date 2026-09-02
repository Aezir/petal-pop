#!/usr/bin/env python3
"""给一个素材包目录生成 / 更新 manifest.json。

用法：
    python tools/make-manifest.py packs/default
    python tools/make-manifest.py packs/default --id my-pack --name "我的包" --version 1.1.0

规则（详见 docs/08-pack-format.md）：
- 按目录约定扫描：stickers/ boards/ backgrounds/ bgm/
- 条目 id 默认取文件名去掉后缀；如果 manifest.json 已存在，
  旧条目的 id / name / tags / anchor 等人工字段原样保留，只刷新 w/h/sha256/bytes
- 新增文件会追加条目；已删除的文件会从清单里移除并打印提示
"""
import argparse, hashlib, json, os, re, sys
from PIL import Image

TYPE_DIRS = {
    'stickers': 'sticker',
    'boards': 'board',
    'backgrounds': 'background',
    'bgm': 'bgm',
}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
AUDIO_EXT = {'.mp3', '.ogg', '.m4a'}
ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
KEEP_FIELDS = ('name', 'tags', 'anchor', 'license', 'author', 'deprecated')


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def scan(root):
    found = []
    for d, typ in TYPE_DIRS.items():
        folder = os.path.join(root, d)
        if not os.path.isdir(folder):
            continue
        for fn in sorted(os.listdir(folder)):
            ext = os.path.splitext(fn)[1].lower()
            kind = 'image' if ext in IMAGE_EXT else 'audio' if ext in AUDIO_EXT else None
            if not kind:
                print(f'  跳过（不支持的后缀）: {d}/{fn}')
                continue
            path = os.path.join(folder, fn)
            entry = {
                'id': os.path.splitext(fn)[0].lower(),
                'type': typ,
                'file': f'{d}/{fn}',
                'sha256': sha256_of(path),
                'bytes': os.path.getsize(path),
            }
            if kind == 'image':
                with Image.open(path) as im:
                    entry['w'], entry['h'] = im.size
            found.append(entry)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pack_dir')
    ap.add_argument('--id')
    ap.add_argument('--name')
    ap.add_argument('--version')
    ap.add_argument('--author')
    ap.add_argument('--license')
    args = ap.parse_args()

    root = args.pack_dir
    mpath = os.path.join(root, 'manifest.json')
    old = {}
    if os.path.exists(mpath):
        with open(mpath, encoding='utf-8') as f:
            old = json.load(f)

    manifest = {
        'formatVersion': 1,
        'id': args.id or old.get('id') or os.path.basename(os.path.abspath(root)).lower(),
        'name': args.name or old.get('name') or os.path.basename(os.path.abspath(root)),
        'version': args.version or old.get('version') or '1.0.0',
        'author': args.author or old.get('author', ''),
        'license': args.license or old.get('license', 'all-rights-reserved'),
        'description': old.get('description', ''),
    }
    if not ID_RE.match(manifest['id']):
        sys.exit(f'包 id 不合法: {manifest["id"]}（只能小写字母/数字/-/_，字母数字开头）')

    old_by_file = {e['file']: e for e in old.get('entries', [])}
    entries = []
    seen_ids = set()
    for e in scan(root):
        prev = old_by_file.get(e['file'])
        if prev:
            e['id'] = prev['id']                    # id 一旦定下永不改
            for k in KEEP_FIELDS:
                if k in prev:
                    e[k] = prev[k]
        if not ID_RE.match(e['id']):
            sys.exit(f'条目 id 不合法: {e["id"]}（来自 {e["file"]}）')
        if e['id'] in seen_ids:
            sys.exit(f'条目 id 重复: {e["id"]}')
        seen_ids.add(e['id'])
        entries.append(e)

    removed = set(old_by_file) - {e['file'] for e in entries}
    for f in sorted(removed):
        print(f'  已移除（文件不存在）: {f}  id={old_by_file[f]["id"]}')

    manifest['entries'] = entries
    with open(mpath, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    total = sum(e['bytes'] for e in entries)
    print(f'{mpath}: {len(entries)} 个条目, {total / 1024 / 1024:.1f} MB')


if __name__ == '__main__':
    main()
