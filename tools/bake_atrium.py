"""Bake the atrium reflection probe and diffuse floor illumination in Cycles.
    blender -b models/SchoolWalk.blend -P tools/bake_atrium.py -- dist
"""
from pathlib import Path
import json
import math
import sys
import tempfile
import bpy
import numpy as np

dest = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
# The emissive cores are capped cylinders. One point per upper cap drives a single halo draw.
cores = bpy.data.objects["Chandelier_Cores"]
centres = []
for face in cores.data.polygons:
    if len(face.vertices) > 4 and face.normal.z > 0.99:
        point = cores.matrix_world @ face.center
        centres.extend((round(point.x, 3), round(point.z - 0.05, 3), round(-point.y, 3)))
if not centres:
    raise ValueError("Chandelier cores have no upper caps")
(dest / "atrium-lamps.json").write_text(json.dumps(centres, separators=(",", ":")), encoding="ascii")
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 18
scene.cycles.max_bounces = 5
scene.cycles.use_denoising = True
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.use_compositing = False
scene.view_settings.exposure = 0
camera = bpy.data.cameras.new("Atrium probe")
probe = bpy.data.objects.new(camera.name, camera)
scene.collection.objects.link(probe)
scene.camera = probe
probe.location = (70, -40, 5.35)
probe.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
camera.type = "PANO"
camera.panorama_type = "EQUIRECTANGULAR"
scene.render.resolution_x, scene.render.resolution_y = 512, 256
scene.render.image_settings.file_format = "HDR"
scene.render.filepath = str(dest / "atrium-probe.hdr")
bpy.ops.render.render(write_still=True)

# Upward radiance gives the polished floor spatially placed reflections of ceiling fixtures.
camera.type = "ORTHO"
camera.ortho_scale = 36
probe.location = (68, -42, 3.67)
probe.rotation_euler = (math.pi, 0, 0)
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.image_settings.file_format = "OPEN_EXR"
with tempfile.TemporaryDirectory() as temp:
    scene.render.filepath = str(Path(temp) / "ceiling.exr")
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(scene.render.filepath)
    rgba = np.empty(len(im.pixels), dtype=np.float32)
    im.pixels.foreach_get(rgba)
    rgba = rgba.reshape(-1, 4)
    rgba[:, :3] = np.clip(np.log2(1 + np.maximum(rgba[:, :3], 0)) / 5, 0, 1)
    encoded = bpy.data.images.new("Ceiling radiance",512,512,alpha=False,is_data=True)
    encoded.pixels.foreach_set(rgba.ravel())
    encoded.filepath_raw = str(dest / "atrium-ceiling.png")
    encoded.file_format = "PNG"
    encoded.save()
    bpy.data.images.remove(im)

# A white receiver records incident light. Original surfaces still bounce light and cast shadows.
for obj in scene.objects:
    if obj.type in {"MESH", "CURVE", "FONT", "SURFACE"}:
        obj.visible_camera = False
bpy.ops.mesh.primitive_plane_add(size=36, location=(68, -42, 3.625))
receiver = bpy.context.object
receiver.visible_diffuse = receiver.visible_glossy = receiver.visible_shadow = False
receiver.visible_transmission = False
mat = bpy.data.materials.new("Diffuse irradiance receiver")
mat.use_nodes = True
nodes = mat.node_tree.nodes
diffuse = nodes.new("ShaderNodeBsdfDiffuse")
diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
mat.node_tree.links.new(diffuse.outputs[0], nodes.get("Material Output").inputs["Surface"])
receiver.data.materials.append(mat)
camera.type = "ORTHO"
camera.ortho_scale = 36
probe.location = (68, -42, 12)
probe.rotation_euler = (0, 0, 0)
scene.render.resolution_x = scene.render.resolution_y = 384
scene.render.image_settings.file_format = "OPEN_EXR"
with tempfile.TemporaryDirectory() as temp:
    scene.render.filepath = str(Path(temp) / "floor.exr")
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(scene.render.filepath)
    pixels = np.empty(len(im.pixels), dtype=np.float32)
    im.pixels.foreach_get(pixels)
    rgb = pixels.reshape(-1, 4)[:, :3]
    light = rgb @ np.array([0.2126, 0.7152, 0.0722])
    # Log encoding reserves precision for contact shadows and bright pools around fixtures.
    reference = max(0.01, np.percentile(light, 55))
    encoded = np.clip(0.5 + np.log2(np.maximum(light / reference, 0.001)) / 6, 0, 1)
    out = bpy.data.images.new("Atrium floor light",384,384,alpha=False,is_data=True)
    rgba = np.ones((384*384,4), dtype=np.float32)
    rgba[:, :3] = encoded[:, None]
    out.pixels.foreach_set(rgba.ravel())
    out.filepath_raw = str(dest / "atrium-light.png")
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(im)
