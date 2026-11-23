"""Encode the Cycles floor bake (tools/bake_floor_cycles.py) for the site.

    python tools/finish_floor_cycles.py build/bake dist

floor-light-f1.png / -f2.png / -f3.png
    RGB = radiance of an albedo-1 floor (Cycles linear), stored as sqrt(L / MAX);
    A = 255 where that floor was baked. 10 cm per pixel over x 4..132, three.js z 0..96.
floor-irradiance.json  {"max": MAX, "albedo": {material: tile size in metres}}
albedo-<mat>.jpg       sRGB colour tiles of the procedural floors (mirrored repeat in the shader).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
irr = np.load(src / "floor-irradiance.npy")            # (floors, H, W, 3)
lmax = float(np.nanpercentile(irr, 99.7)) * 1.25


def dilate(enc, mask, steps=3):
    """Grow values a few pixels past room edges so bilinear filtering never pulls in black."""
    m = mask.astype(np.float32)
    for _ in range(steps):
        sm = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(1)), np.float32) / 255
        grown = np.empty_like(enc)
        for c in range(3):
            sv = np.asarray(Image.fromarray((enc[..., c] * m * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(1)), np.float32) / 255
            grown[..., c] = np.where(sm > 0, sv / np.maximum(sm, 1e-4), 0)
        enc = np.where(m[..., None] > 0, enc, grown)
        m = np.maximum(m, (sm > 0).astype(np.float32))
    return enc


for level in range(irr.shape[0]):
    lin = irr[level]
    mask = ~np.isnan(lin[..., 0])
    enc = np.sqrt(np.clip(np.nan_to_num(lin, nan=0.0) / lmax, 0, 1))
    enc = dilate(enc, mask)
    rgba = np.dstack([enc, mask.astype(np.float32)])
    Image.fromarray((rgba * 255 + 0.5).clip(0, 255).astype(np.uint8), "RGBA") \
        .save(dst / f"floor-light-f{level + 1}.png", optimize=True)

tiles = {"floor_f2": 4.0, "floor_f1": 3.6, "room_class": 4.0, "room_lab": 4.0, "room_it": 4.0,
         "room_special": 4.0, "room_admin": 4.0, "room_service": 4.0}
albedo = {}
for name, tile in tiles.items():
    f = src / f"albedo-{name}.npy"
    if not f.exists():
        continue
    lin = np.clip(np.load(f), 0, 1)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    size = 1024 if name == "floor_f2" else 512
    Image.fromarray((srgb * 255 + 0.5).astype(np.uint8)).resize((size, size), Image.LANCZOS) \
        .save(dst / f"albedo-{name}.jpg", quality=88)
    albedo[name] = tile
(dst / "floor-irradiance.json").write_text(json.dumps({"max": round(lmax, 4), "albedo": albedo}), encoding="utf-8")
print("max", round(lmax, 3), "albedo", list(albedo))
