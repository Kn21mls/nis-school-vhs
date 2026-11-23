"""Export a school .blend to glTF for the site.

    blender -b ..\\NIS_3D_plan\\NIS_v09.blend -P tools/export_scene.py -- build/school-raw.glb

Cameras, lights and hidden helper objects are left out; modifiers are applied.
Run gltfpack on the result afterwards (see tools/update_scene.ps1).
"""
import sys
from pathlib import Path
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from web_occlusion import bake_surface_occlusion

out = sys.argv[sys.argv.index("--") + 1]


def upstream_types(sock, depth=0):
    """Node types feeding a socket (a few levels deep, through groups' outputs)."""
    found = set()
    for link in sock.links:
        n = link.from_node
        found.add(n.bl_idname)
        if depth < 6:
            for i in n.inputs:
                if i.is_linked:
                    found |= upstream_types(i, depth + 1)
            if n.bl_idname == "ShaderNodeGroup" and n.node_tree:
                out = next((x for x in n.node_tree.nodes if x.bl_idname == "NodeGroupOutput"), None)
                if out:
                    for i in out.inputs:
                        if i.is_linked:
                            found |= upstream_types(i, depth + 1)
    return found


def uv_mapped(tex):
    """Image textures driven by world/generated coordinates cannot be exported to glTF (no UVs)."""
    vec = tex.inputs.get("Vector")
    if not vec or not vec.is_linked:
        return True
    feeds = upstream_types(vec)
    return "ShaderNodeUVMap" in feeds or not ({"ShaderNodeNewGeometry", "ShaderNodeTexCoord"} & feeds)


def image_mean(img):
    """Average colour of an image in linear space."""
    px = list(img.pixels[:])
    n = len(px) // 4
    if not n:
        return None
    rgb = [sum(px[c::4]) / n for c in range(3)]
    if img.colorspace_settings.name.lower().startswith("srgb") and not img.is_float:
        rgb = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return rgb + [1.0]


def has_image(sock, depth=0):
    for link in sock.links:
        n = link.from_node
        if n.bl_idname == "ShaderNodeTexImage" and n.image:
            return uv_mapped(n)
        if depth < 6 and any(has_image(i, depth + 1) for i in n.inputs if i.is_linked):
            return True
    return False


def drives_grid(sock):
    """True if a Mix factor comes from a Math chain (tile/grout grids)."""
    return any(l.from_node.bl_idname == "ShaderNodeMath" for l in sock.links)


def flat_color(sock):
    """Representative colour for a procedural base colour (glTF cannot export node math)."""
    n = sock.links[0].from_node
    if n.bl_idname == "ShaderNodeValToRGB":
        return list(n.color_ramp.evaluate(0.5))
    if n.bl_idname == "ShaderNodeMix" and n.data_type == "RGBA":
        fac, a, b = n.inputs[0], n.inputs[6], n.inputs[7]
        if a.is_linked or b.is_linked:
            return None
        w = 0.08 if drives_grid(fac) else 0.5          # grids: mostly tile colour, a little grout
        return [a.default_value[k] * (1 - w) + b.default_value[k] * w for k in range(4)]
    if n.bl_idname == "ShaderNodeRGB":
        return list(n.outputs[0].default_value)
    if n.bl_idname == "ShaderNodeTexImage" and n.image and not uv_mapped(n):
        return image_mean(n.image)
    return None


# Procedural base colours become flat colours so the exporter keeps them.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    bsdf = next((n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    if not bsdf:
        continue
    base = bsdf.inputs["Base Color"]
    if not base.is_linked or has_image(base):
        continue
    col = flat_color(base)
    if col is None:
        print("left as is:", mat.name, base.links[0].from_node.bl_idname)
        continue
    for link in list(base.links):
        mat.node_tree.links.remove(link)
    base.default_value = col
    print("flattened:", mat.name, [round(c, 3) for c in col[:3]])

# Bump/normal and roughness driven by world-coordinate textures would export with no UVs too.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    bsdf = next((n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    if not bsdf:
        continue
    for name in ("Normal", "Roughness", "Metallic"):
        sock = bsdf.inputs.get(name)
        if not sock or not sock.is_linked:
            continue
        feeds = upstream_types(sock)
        if "ShaderNodeTexImage" in feeds and "ShaderNodeUVMap" not in feeds and \
                {"ShaderNodeNewGeometry", "ShaderNodeTexCoord"} & feeds:
            for link in list(sock.links):
                mat.node_tree.links.remove(link)
            print("unlinked world-mapped", name, "on", mat.name)

# Open lockers: the black interior shares faces exactly with the steel body (0 mm) and uses the
# same material as monitors. Give it its own material so the site can pull it forward in depth.
for ob in bpy.data.objects:
    if ob.type == "MESH" and ob.name.startswith("Lockers_Inside"):
        for slot in ob.material_slots:
            if slot.material and not slot.material.name.startswith("locker_inside"):
                inside = slot.material.copy()
                inside.name = "locker_inside"
                slot.link = "OBJECT"
                slot.material = inside

# Upholstery in the Blender render has dense rounded surfaces. Keep planar faces and
# silhouettes through quadric reduction only on cushions, leaving the building shell intact.
for ob in bpy.context.view_layer.objects:
    if ob.type == "MESH" and ob.name in {"Sofas_Green", "Lounge_Black_Sofas", "Lounge_Red_Sofas"}:
        modifier = ob.modifiers.new("Web upholstery", "DECIMATE")
        modifier.ratio = 0.26

bake_surface_occlusion()

# Only what is actually visible in renders goes to the site.
for ob in bpy.context.view_layer.objects:
    ob.select_set(ob.type in {"MESH", "CURVE", "FONT", "SURFACE", "META"} and ob.visible_get() and not ob.hide_render)

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_vertex_color="ACTIVE",
    export_cameras=False,
    export_lights=False,
    export_extras=False,
    export_animations=False,
    export_image_format="AUTO",
)
print("exported", out)
