"""Bake short-range static occlusion into the web mesh's COLOR_0 in linear space."""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def bake_surface_occlusion():
    structural = ("F2_Walls_", "F1_Shell", "Columns_", "IC_Columns", "Ceiling_", "IC_Ceiling",
                  "Accent_", "Void_Fascia", "Assembly_Walls", "Gym_Walls", "Atrium_Grid_Plenum")
    furniture = ("IC_Tables", "IC_Chairs", "IC_Eggs", "IC_Laptops", "Class_Desks",
                 "Class_Chairs", "Class_Cabinets", "Reception_Desks", "Reception_Chairs",
                 "Lockers_Body", "Lockers_Doors", "Lounge_Tables", "Ottomans_", "Seat_")
    solids = structural + furniture + ("Ground_", "Room_", "F2_Floor_", "Roof_", "Stairs",
                                       "Steps_", "Sofas_", "Lounge_Red_", "Lounge_Black_",
                                       "Gym_Floor", "Assembly_Floor", "IC_Table_Legs", "Class_Desk_Frames")
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH" and
               o.visible_get() and not o.hide_render and len(o.data.polygons)]
    vertices, polygons = [], []
    for obj in objects:
        if not obj.name.startswith(solids):
            continue
        start = len(vertices)
        vertices.extend(obj.matrix_world @ v.co for v in obj.data.vertices)
        polygons.extend(tuple(start + i for i in p.vertices) for p in obj.data.polygons)
    tree = BVHTree.FromPolygons(vertices, polygons)
    del vertices, polygons
    directions = []
    for i in range(16):
        radius = math.sqrt((i + .5) / 16)
        angle = math.pi * (3 - math.sqrt(5)) * i
        directions.append(Vector((radius * math.cos(angle), radius * math.sin(angle),
                                  math.sqrt(1 - radius**2))))
    cache = {}
    for obj in objects:
        if not obj.name.startswith(structural + furniture):
            continue
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        mesh = obj.data
        if obj.name.startswith(structural):
            # A few intermediate samples keep a single dark corner from tinting a whole wall.
            bm = bmesh.new()
            bm.from_mesh(mesh)
            for _ in range(2):
                long_edges = [e for e in bm.edges if e.calc_length() > 1.8]
                if long_edges:
                    bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
            bm.to_mesh(mesh)
            bm.free()
            mesh.update()
        attr = mesh.color_attributes.new(name="StaticOcclusion", type="BYTE_COLOR", domain="CORNER")
        mesh.color_attributes.active_color = attr
        rgba = np.ones((len(mesh.loops), 4), dtype=np.float32)
        mw = obj.matrix_world
        normals = mw.to_3x3().inverted_safe().transposed()
        for face in mesh.polygons:
            normal = (normals @ face.normal).normalized()
            if normal.length_squared < .9:
                continue
            centre = mw @ face.center
            rotation = normal.to_track_quat("Z", "Y")
            rays = [rotation @ d for d in directions]
            normal_key = tuple(round(c * 5) for c in normal)
            for loop in face.loop_indices:
                pos = (mw @ mesh.vertices[mesh.loops[loop].vertex_index].co).lerp(centre, .035)
                origin = pos + normal * .028
                key = tuple(round(c * 6) for c in origin) + normal_key
                value = cache.get(key)
                if value is None:
                    visibility = 0.
                    for ray in rays:
                        distance = tree.ray_cast(origin, ray, 2.1)[3]
                        visibility += 1 if distance is None else min(1., distance / 2.1)
                    value = .34 + .66 * visibility / len(rays)
                    cache[key] = value
                rgba[loop, :3] = value
        attr.data.foreach_set("color", rgba.ravel())
    print("Baked static occlusion samples:", len(cache))
