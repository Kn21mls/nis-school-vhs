"""Turn the baked visibility (build/floor-light.npy) into dist/floor-light.png.

    python tools/finish_floor_light.py build/floor-light.npy dist/floor-light.png [reference.png]

Brightness is matched to a reference map (by default the current floor-light.png)
by quantile mapping, so the scene keeps the same overall exposure.
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
ref_path = sys.argv[3] if len(sys.argv) > 3 else dst
vis = np.load(src)
ref = np.asarray(Image.open(ref_path).convert("RGB")).astype(np.float32)
out = np.full(vis.shape[:2] + (3,), 255.0, dtype=np.float32)

for c in (0, 1):
    v = vis[..., c]
    m = ~np.isnan(v)
    target = np.sort(ref[..., c][m])               # reference values on the same floor area
    order = np.argsort(np.argsort(v[m], kind="stable"), kind="stable")
    mapped = target[(order * (len(target) - 1) / max(1, len(order) - 1)).astype(int)]
    ch = np.full(v.shape, 255.0, dtype=np.float32)
    ch[m] = mapped
    soft = np.asarray(Image.fromarray(ch.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32)
    out[..., c] = np.where(m, soft, 255.0)

Image.fromarray(out.clip(0, 255).astype(np.uint8)).save(dst, optimize=True)
print("saved", dst)
