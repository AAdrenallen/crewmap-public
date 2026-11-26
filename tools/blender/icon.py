"""Render CrewMap's original app icon set from the avatar kit.

    blender -b -P tools/blender/icon.py -- apps/mobile/assets/models apps/mobile/assets

Outputs icon.png (1024, full bleed), android-icon-foreground.png (1024, transparent, 66% safe zone),
android-icon-background.png (1024, brand colour), android-icon-monochrome.png, splash-icon.png, favicon.png.
"""
import bpy
import math
import os
import re
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
MODELS, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
BRAND = (0.357, 0.424, 1.0, 1.0)  # #5B6CFF
CHOICE = {"body": "regular", "face": "grin", "hair": "curly", "top": "hoodie", "bottom": "jeans", "shoes": "sneakers", "hat": "none", "glasses": "none", "acc": "none"}
COLORS = {"skin": (0.85, 0.62, 0.45), "hair": (0.29, 0.19, 0.12), "top": (1.0, 0.42, 0.42), "bottom": (0.17, 0.24, 0.44), "accent": (1.0, 0.78, 0.27)}


def setup_scene(transparent):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, "avatar.glb"))
    for o in bpy.data.objects:
        for key, val in CHOICE.items():
            tag = re.search(r"_(B[a-z-]+|H|W)(?=_|$)", o.name[len(key) + len(val) + 1:])  # fit group / hair with or without hat
            g = tag.group(1) if tag else ""
            free = CHOICE["hat"] in ("none", "catEars", "headband", "crown")
            wrong = (g == "H" and not free) or (g == "W" and free) or (g.startswith("B") and CHOICE["body"] not in g[1:].split("-"))
            if o.name.startswith(key + "_") and (not (o.name == f"{key}_{val}" or o.name.startswith(f"{key}_{val}_")) or wrong):
                o.hide_render = True
                for c in o.children_recursive:
                    c.hide_render = True
    for m in bpy.data.materials:
        if m.name in COLORS and m.use_nodes:
            m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*COLORS[m.name], 1)
    # Map pin behind the character (original shape: sphere + cone).
    pin_mat = bpy.data.materials.new("pin")
    pin_mat.use_nodes = True
    pin_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1.0, 0.78, 0.27, 1)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.62, location=(0, 0.6, 0.75), segments=32, ring_count=16)
    pin = bpy.context.active_object
    pin.data.materials.append(pin_mat)
    bpy.ops.mesh.primitive_cone_add(radius1=0.48, radius2=0.0, depth=0.9, location=(0, 0.6, 0.18), rotation=(math.pi, 0, 0), vertices=32)
    bpy.context.active_object.data.materials.append(pin_mat)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = scene.render.resolution_y = 1024
    scene.render.film_transparent = transparent
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = BRAND
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
    scene.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.location = (0, -6, 1.2)
    cam.rotation_euler = (math.radians(84), 0, 0)
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.5
    sun.rotation_euler = (math.radians(40), math.radians(15), math.radians(-25))
    scene.collection.objects.link(sun)
    return scene, cam


def render(path, transparent, ortho):
    scene, cam = setup_scene(transparent)
    cam.data.ortho_scale = ortho
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


os.makedirs(OUT, exist_ok=True)
render(os.path.join(OUT, "icon-fg.png"), True, 2.3)
render(os.path.join(OUT, "android-icon-foreground.png"), True, 3.9)  # extra margin: adaptive-icon safe zone
render(os.path.join(OUT, "splash-icon.png"), True, 2.8)

# Solid background + monochrome silhouette + favicon from the foreground.
bpy.ops.wm.read_factory_settings(use_empty=True)
bg = bpy.data.images.new("bg", 1024, 1024, alpha=False)
bg.pixels = list(BRAND) * (1024 * 1024)
bg.filepath_raw = os.path.join(OUT, "android-icon-background.png")
bg.file_format = "PNG"
bg.save()
fg = bpy.data.images.load(os.path.join(OUT, "android-icon-foreground.png"))
px = list(fg.pixels)
mono = [0.0] * len(px)
for i in range(0, len(px), 4):
    a = px[i + 3]
    mono[i:i + 4] = [1.0, 1.0, 1.0, a]
m = bpy.data.images.new("mono", fg.size[0], fg.size[1], alpha=True)
m.pixels = mono
m.filepath_raw = os.path.join(OUT, "android-icon-monochrome.png")
m.file_format = "PNG"
m.save()
import numpy as np
src = bpy.data.images.load(os.path.join(OUT, "icon-fg.png"))
a = np.array(src.pixels[:], dtype=np.float32).reshape(-1, 4)
bgc = np.array(BRAND, dtype=np.float32)
out = a.copy()
out[:, :3] = a[:, :3] * a[:, 3:4] + bgc[:3] * (1 - a[:, 3:4])
out[:, 3] = 1.0
icon = bpy.data.images.new("icon", src.size[0], src.size[1], alpha=False)
icon.pixels = out.ravel().tolist()
icon.filepath_raw = os.path.join(OUT, "icon.png")
icon.file_format = "PNG"
icon.save()
os.remove(os.path.join(OUT, "icon-fg.png"))
ic = bpy.data.images.load(os.path.join(OUT, "icon.png"))
ic.scale(48, 48)
ic.filepath_raw = os.path.join(OUT, "favicon.png")
ic.save()
print("ICON_OK")
