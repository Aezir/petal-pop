#!/usr/bin/env python3
"""把素材包里的贴纸对回原图贴纸纸上的位置，写进 manifest.json（包级 sheet 和条目 sheet 字段）。

用法：
    python tools/locate-on-sheet.py packs/default assets/dress-up-png/source-cleaned-transparent.png

原理：贴纸是从原图上直接裁下来的，所以每张贴纸在原图里一定有一个位置，颜色逐像素完全一样。
按颜色做"差的平方和"（用 FFT 一次算出每个偏移），取最小处；大贴纸先找，找到的像素标记为已占用，
避免长得几乎一样的小贴纸（比如三个娃娃、成对的鞋）抢到别人的位置。
有任何一张对不上就不写文件，免得把错的排版发出去。
"""
import json, os, sys
import numpy as np
from PIL import Image

MAX_RMS = 2.0   # 颜色均方根误差上限（0～255）；原图直接裁的应该是 0


def ssd_map(S, T, M, shape):
    """每个偏移下，掩码 M 覆盖处 (S-T)^2 之和。S: H×W×3，T: h×w×3，M: h×w"""
    H, W = S.shape[:2]
    h, w = M.shape
    FM = np.conj(np.fft.rfft2(M, s=shape))
    tot = np.zeros((H - h + 1, W - w + 1))
    for c in range(3):
        s = S[..., c]
        t = T[..., c] * M
        a = np.fft.irfft2(np.fft.rfft2(s * s, s=shape) * FM, s=shape)
        b = np.fft.irfft2(np.fft.rfft2(s, s=shape) * np.conj(np.fft.rfft2(t, s=shape)), s=shape)
        tot += (a - 2 * b)[:H - h + 1, :W - w + 1] + (t * T[..., c]).sum()
    return tot


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pack_dir, source = sys.argv[1], sys.argv[2]
    mpath = os.path.join(pack_dir, 'manifest.json')
    with open(mpath, encoding='utf-8') as f:
        manifest = json.load(f)

    src = np.array(Image.open(source).convert('RGBA')).astype(np.float64)
    H, W = src.shape[:2]
    solid = src[..., 3] > 128
    shape = (H + 512, W + 512)
    stickers = [e for e in manifest['entries'] if e['type'] == 'sticker' and not e.get('deprecated')]
    claimed = np.zeros((H, W), bool)
    found, bad = {}, []

    for e in sorted(stickers, key=lambda e: -(e['w'] * e['h'])):
        im = np.array(Image.open(os.path.join(pack_dir, e['file'])).convert('RGBA')).astype(np.float64)
        h, w = im.shape[:2]
        if h > H or w > W:
            bad.append((e['id'], '比原图还大')); continue
        M = (im[..., 3] > 128).astype(np.float64)
        S = src[..., :3].copy()
        S[claimed | ~solid] = 5000.0          # 已被认领的、透明的像素都不能再匹配
        d = ssd_map(S, im[..., :3], M, shape) / max(M.sum(), 1)
        y, x = np.unravel_index(np.argmin(d), d.shape)
        rms = float(np.sqrt(max(d[y, x], 0)))
        if rms > MAX_RMS:
            bad.append((e['id'], f'颜色误差 {rms:.1f}')); continue
        found[e['id']] = (int(x), int(y))
        claimed[y:y + h, x:x + w] |= M > 0

    if bad:
        for i, why in bad:
            print(f'  对不上: {i}（{why}）')
        sys.exit(f'{len(bad)} 张贴纸在原图里找不到，没有写入 manifest')

    manifest['sheet'] = {'w': W, 'h': H}
    for e in manifest['entries']:
        if e['id'] in found:
            e['sheet'] = {'x': found[e['id']][0], 'y': found[e['id']][1]}
    with open(mpath, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{mpath}: {len(found)} 张贴纸已对回 {W}×{H} 的原图')


if __name__ == '__main__':
    main()
