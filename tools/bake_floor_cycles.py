"""Bake what Cycles actually sees on the floors, for interior.js.

    blender -b models/SchoolWalk.blend -P tools/bake_floor_cycles.py -- build [samples]

1. Irradiance: white diffuse receivers are laid 4 mm above every upward-facing floor face
   (floor 1 and floor 2 separately) and rendered top-down with an orthographic camera.
   Every other object is hidden from the camera but still emits, bounces and shadows light,
   so each pixel holds the outgoing radiance of an albedo-1 floor = what the floor would show
   with its real albedo multiplied in. Covers x 4..132 m,
   three.js z 0..96 m (Blender y 0..-96), 10 cm per pixel.
   -> build/floor-irradiance.npy  (2, H, W, 3) linear RGB per floor, NaN where there is no floor.
2. Albedo: the procedural floor colours (terrazzo, linoleum, tiles) baked on a flat
   patch with Cycles' diffuse colour pass, saved linear for tiling in the shader.
   -> build/albedo-<material>.npy (N, N, 3)
"""
import re
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
out = Path(args[0]).resolve()
samples = int(args[1]) if len(args) > 1 else 48
out.mkdir(parents=True, exist_ok=True)

X0, SIZE_X, SIZE_Z, PX = 4.0, 128.0, 96.0, 0.1
W, H = int(SIZE_X / PX), int(SIZE_Z / PX)
FLOOR = re.compile(r"^(floor_|room_|courtyard$|stair$)")
ALBEDO = {"floor_f2": 4.0, "floor_f1": 3.6, "room_class": 4.0, "room_lab": 4.0, "room_it": 4.0,
          "room_special": 4.0, "room_admin": 4.0, "room_service": 4.0}

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.render.use_compositing = False
scene.render.film_transparent = True
dg = bpy.context.evaluated_depsgraph_get()

# ---------- receivers
receiver_mat = bpy.data.materials.new("Irradiance receiver")
receiver_mat.use_nodes = True
nt = receiver_mat.node_tree
for n in list(nt.nodes):
    if n.bl_idname != "ShaderNodeOutputMaterial":
        nt.nodes.remove(n)
diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
nt.links.new(diffuse.outputs[0], nt.nodes["Material Output"].inputs["Surface"])

levels = {1: bmesh.new(), 2: bmesh.new()}
sources = [o for o in scene.objects if o.type == "MESH" and o.visible_get() and not o.hide_render]
for ob in sources:
    names = [s.material.name if s.material else "" for s in ob.material_slots]
    if not any(FLOOR.match(n) for n in names):
        continue
    me = ob.evaluated_get(dg).to_mesh()
    mw = ob.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    for p in me.polygons:
        if p.material_index >= len(names) or not FLOOR.match(names[p.material_index]):
            continue
        if (nm @ p.normal).normalized().z < 0.7:
            continue
        pts = [mw @ me.vertices[i].co for i in p.vertices]
        z = sum(v.z for v in pts) / len(pts)
        bm = levels[1 if z < 1.6 else 2]
        verts = [bm.verts.new((v.x, v.y, v.z + 0.004)) for v in pts]
        try:
            bm.faces.new(verts)
        except ValueError:
            pass
    ob.evaluated_get(dg).to_mesh_clear()

receivers = {}
for level, bm in levels.items():
    me = bpy.data.meshes.new(f"receiver_f{level}")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(me.name, me)
    ob.data.materials.append(receiver_mat)
    scene.collection.objects.link(ob)
    ob.visible_diffuse = ob.visible_glossy = ob.visible_shadow = ob.visible_transmission = False
    ob.visible_volume_scatter = False
    receivers[level] = ob
    print(f"floor {level}: {len(me.polygons)} receiver faces")

for ob in sources:
    ob.visible_camera = False

cam_data = bpy.data.cameras.new("Top")
cam_data.type = "ORTHO"
cam_data.ortho_scale = max(SIZE_X, SIZE_Z)
cam_data.clip_start, cam_data.clip_end = 0.1, 100
cam = bpy.data.objects.new("Top", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (X0 + SIZE_X / 2, -SIZE_Z / 2, 40)
cam.rotation_euler = (0, 0, 0)
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
cam_data.sensor_fit = "HORIZONTAL"
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"

result = np.full((2, H, W, 3), np.nan, dtype=np.float32)
for level in (1, 2):
    for lv, ob in receivers.items():
        ob.hide_render = lv != level
    path = out / f"irradiance-f{level}.exr"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(str(path))
    px = np.empty(len(im.pixels), dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)[::-1]                 # Blender rows start at the bottom
    alpha = px[..., 3:4]
    result[level - 1] = np.where(alpha > 0.5, px[..., :3] / np.maximum(alpha, 1e-3), np.nan)
    bpy.data.images.remove(im)
    print(f"floor {level}: mean {np.nanmean(result[level - 1].reshape(-1, 3), 0).round(3)}")
np.save(out / "floor-irradiance.npy", result)

# ---------- albedo of procedural floors
for ob in receivers.values():
    ob.hide_render = True
for ob in sources:
    ob.visible_camera = True
N = 1024
for name, tile in ALBEDO.items():
    mat = bpy.data.materials.get(name)
    if not mat:
        continue
    bpy.ops.mesh.primitive_plane_add(size=tile, location=(70 + tile / 2, -40 - tile / 2, 3.6))
    patch = bpy.context.object
    patch.data.materials.append(mat)
    img = bpy.data.images.new(f"albedo_{name}", N, N, float_buffer=True)
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    mat.node_tree.nodes.active = tex
    bpy.ops.object.select_all(action="DESELECT")
    patch.select_set(True)
    bpy.context.view_layer.objects.active = patch
    scene.cycles.samples = 4
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=0)
    px = np.empty(N * N * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    np.save(out / f"albedo-{name}.npy", px.reshape(N, N, 4)[::-1, :, :3])
    mat.node_tree.nodes.remove(tex)
    bpy.data.objects.remove(patch)
    print(f"albedo {name}: mean {px.reshape(-1, 4)[:, :3].mean(0).round(3)}")
print("done")
