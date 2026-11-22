"""Bake the floor visibility map used by interior.js (floor-light.png).

    blender -b ..\\NIS_3D_plan\\NIS_v09.blend -P tools/bake_floor_light.py -- build/floor-light.npy

Layout of the map (must match interior.js): 640x480 px over 128x96 m,
u = (x - 4) / 128, v = z / 96 in three.js world space (= Blender x, -y).
R = floor 1, G = floor 2. Values are ambient-occlusion style visibility
(1 = open, lower = close to walls / under furniture); NaN where there is no floor.
Post-processing to 8-bit happens in tools/finish_floor_light.py.
"""
import math
import random
import re
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

out = sys.argv[sys.argv.index("--") + 1]
W, H, SIZE_X, SIZE_Z, X0 = 640, 480, 128.0, 96.0, 4.0
RAYS, REACH = 48, 2.4

dg = bpy.context.evaluated_depsgraph_get()
verts, polys, is_floor = [], [], []
FLOOR = re.compile(r"^(floor_|room_|courtyard$|granite$)")
floor_z = {"floor_f1": [], "floor_f2": []}
for ob in bpy.context.view_layer.objects:
    if ob.type != "MESH" or ob.hide_render or not ob.visible_get():
        continue
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ob.matrix_world
    base = len(verts)
    verts.extend(mw @ v.co for v in me.vertices)
    polys.extend([base + i for i in p.vertices] for p in me.polygons)
    slot_floor = [bool(s.material and FLOOR.match(s.material.name)) for s in ob.material_slots]
    is_floor.extend(slot_floor[p.material_index] if p.material_index < len(slot_floor) else False for p in me.polygons)
    for slot_i, slot in enumerate(ob.material_slots):
        if slot.material and slot.material.name in floor_z:
            zs = [(mw @ me.vertices[p.vertices[0]].co).z for p in me.polygons if p.material_index == slot_i]
            floor_z[slot.material.name].extend(zs)
    ev.to_mesh_clear()
tree = BVHTree.FromPolygons(verts, polys, epsilon=0.0)
f1 = float(np.median(floor_z["floor_f1"])) if floor_z["floor_f1"] else 0.0
f2 = float(np.median(floor_z["floor_f2"])) if floor_z["floor_f2"] else 4.0
print(f"floor levels f1={f1:.2f} f2={f2:.2f}, {len(polys)} polys")

# Cosine-weighted hemisphere directions, a few rotated sets to avoid banding.
random.seed(3)
sets = []
for _ in range(16):
    rot = random.random() * math.tau
    dirs = []
    for k in range(RAYS):
        r1, r2 = (k + random.random()) / RAYS, random.random()
        phi = math.tau * r2 + rot
        s = math.sqrt(r1)
        dirs.append(Vector((s * math.cos(phi), s * math.sin(phi), math.sqrt(max(0.0, 1 - r1)))))
    sets.append(dirs)

up = Vector((0, 0, 1))
down = Vector((0, 0, -1))
result = np.full((H, W, 2), np.nan, dtype=np.float32)
for ch, (top, reach) in enumerate(((f1 + 1.5, 2.2), (f2 + 1.6, 2.8))):
    for j in range(H):
        by = -(j + 0.5) * SIZE_Z / H
        for i in range(W):
            bx = X0 + (i + 0.5) * SIZE_X / W
            # Walk down through furniture until the actual floor surface (shaded material) is hit.
            start, left, loc = Vector((bx, by, top)), reach, None
            while left > 0:
                hit_loc, nrm, idx, dist = tree.ray_cast(start, down, left)
                if hit_loc is None:
                    break
                if is_floor[idx] and nrm.z > 0.5:
                    loc = hit_loc
                    break
                start = hit_loc + down * 0.005
                left -= dist + 0.005
            if loc is None:
                continue
            o = loc + nrm * 0.03
            dirs = sets[(i * 7 + j * 13) % 16]
            free = sum(1 for d in dirs if tree.ray_cast(o, d, REACH)[0] is None)
            result[j, i, ch] = free / RAYS
        if j % 60 == 0:
            print(f"channel {ch} row {j}/{H}", flush=True)
np.save(out, result)
print("saved", out)
