"""Bake the atrium reflection probe (atrium-probe.hdr) and chandelier lamp points in Cycles.
Floor light comes from tools/bake_floor_cycles.py.
    blender -b models/SchoolWalk.blend -P tools/bake_atrium.py -- dist
"""
from pathlib import Path
import json
import math
import sys
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
