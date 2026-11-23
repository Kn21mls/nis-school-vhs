"""Render Cycles reference frames from the site's entry points (dist/views.json).

    blender -b models/SchoolWalk.blend -P tools/render_reference.py -- build/ref 960 540 64 [name ...]

Camera = the walk camera: eye 1.24 m above the floor under the spawn, vertical FOV 72 deg,
same yaw/pitch. Used to compare the web look against the real render.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index("--") + 1:]
out = Path(args[0]).resolve()
width, height, samples = int(args[1]), int(args[2]), int(args[3])
only = set(args[4:])
out.mkdir(parents=True, exist_ok=True)
views = json.loads((Path(__file__).resolve().parent.parent / "dist" / "views.json").read_text(encoding="utf-8"))

scene = bpy.context.scene
print("view transform:", scene.view_settings.view_transform, "look:", scene.view_settings.look,
      "exposure:", scene.view_settings.exposure, "engine:", scene.render.engine)
dg = bpy.context.evaluated_depsgraph_get()
verts, polys = [], []
for ob in scene.objects:
    if ob.type != "MESH" or ob.hide_render or not ob.visible_get():
        continue
    me = ob.evaluated_get(dg).to_mesh()
    base = len(verts)
    verts.extend(ob.matrix_world @ v.co for v in me.vertices)
    polys.extend([base + i for i in p.vertices] for p in me.polygons)
    ob.evaluated_get(dg).to_mesh_clear()
tree = BVHTree.FromPolygons(verts, polys)

cam_data = bpy.data.cameras.new("Web reference")
cam = bpy.data.objects.new(cam_data.name, cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(72)
cam_data.clip_start = 0.1
scene.render.engine = "CYCLES"
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"

for i, v in enumerate(views):
    key = f"view{i}"
    if only and key not in only:
        continue
    x, y, z = v["position"]                      # three.js (y up) -> Blender (z up)
    pos = Vector((x, -z, y))
    hit = tree.ray_cast(pos, Vector((0, 0, -1)), 2.5)
    if hit[0] is not None:
        pos.z = hit[0].z + 1.24
    dx, dy, dz = v["direction"]
    d = Vector((dx, -dz, dy)).normalized()
    cam.location = pos
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(out / f"{key}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", key, v["name"], tuple(round(c, 2) for c in pos))
