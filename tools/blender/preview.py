"""Render previews of composed avatars and the cars (sanity check / docs).

    blender -b -P tools/blender/preview.py -- apps/mobile/assets/models out.png [lineup|closeup|cars]

lineup: four avatar compositions + the eight cars, map-like 3/4 view. closeup: one avatar, face-level.
cars: the eight cars larger.
"""
import bpy
import math
import os
import re
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
MODELS, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
MODE = argv[2] if len(argv) > 2 else "lineup"
bpy.ops.wm.read_factory_settings(use_empty=True)

LOOKS = [
    ({"body": "regular", "face": "grin", "hair": "curly", "top": "hoodie", "bottom": "jeans", "shoes": "sneakers", "hat": "none", "glasses": "round", "acc": "backpack"},
     {"skin": (0.85, 0.62, 0.45), "hair": (0.25, 0.14, 0.08), "top": (0.36, 0.42, 1.0), "bottom": (0.17, 0.24, 0.44)}),
    ({"body": "curvy", "face": "wink", "hair": "long", "top": "tee", "bottom": "skirt", "shoes": "hightops", "hat": "none", "glasses": "none", "acc": "chain"},
     {"skin": (0.95, 0.78, 0.66), "hair": (0.75, 0.45, 0.18), "top": (1.0, 0.85, 0.3), "bottom": (0.25, 0.55, 0.45)}),
    ({"body": "broad", "face": "cool", "hair": "short", "top": "jacket", "bottom": "cargo", "shoes": "boots", "hat": "cap", "glasses": "shades", "acc": "none"},
     {"skin": (0.45, 0.28, 0.18), "hair": (0.05, 0.04, 0.04), "top": (0.12, 0.13, 0.16), "bottom": (0.45, 0.42, 0.3)}),
    ({"body": "slim", "face": "smile", "hair": "ponytail", "top": "sweater", "bottom": "joggers", "shoes": "sneakers", "hat": "tuque", "glasses": "none", "acc": "scarf"},
     {"skin": (0.7, 0.5, 0.35), "hair": (0.1, 0.07, 0.05), "top": (0.9, 0.35, 0.45), "bottom": (0.3, 0.3, 0.34)}),
]
if MODE == "closeup":
    LOOKS = LOOKS[:1] + [LOOKS[1]]
if MODE == "cars":
    LOOKS = []


def base(name):
    return re.sub(r"\.\d{3}$", "", name)


def tag_ok(rest, choice):
    """Variant tags (see build_assets.py consolidate): _B<body>-... fit group, _H hair without a hat, _W with one."""
    tag = re.search(r"_(B[a-z-]+|H|W)(?=_|$)", rest)
    hat_free = choice.get("hat", "none") in ("none", "catEars", "headband", "crown")
    if not tag:
        return True
    t = tag.group(1)
    return hat_free if t == "H" else (not hat_free) if t == "W" else choice.get("body") in t[1:].split("-")


def visible(name, choice):
    name = base(name)
    for key, val in choice.items():
        if name.startswith(key + "_"):
            if not (name == f"{key}_{val}" or name.startswith(f"{key}_{val}_")):
                return False
            return tag_ok(name[len(key) + len(val) + 1:], choice)
    return True


def ancestors(o):
    while o.parent is not None:
        o = o.parent
        yield o


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def recolour(objs, colours, tag):
    for o in objs:
        if o.type != "MESH":
            continue
        for slot in o.material_slots:
            m = slot.material
            key = re.sub(r"\.\d{3}$", "", m.name)
            if key in colours:
                if not m.name.endswith(tag):
                    m = m.copy()
                    m.name = f"{key}{tag}"
                    slot.material = m
                bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                bsdf.inputs["Base Color"].default_value = (*colours[key], 1)


x = 0.0
for i, (choice, colours) in enumerate(LOOKS):
    objs = import_glb(os.path.join(MODELS, "avatar.glb"))
    for o in objs:
        o.hide_render = not visible(o.name, choice) or any(not visible(p.name, choice) for p in ancestors(o))
    recolour(objs, colours, f"_look{i}")
    root = next(o for o in objs if o.parent is None)
    root.rotation_mode = "XYZ"
    root.location = (x, 0, 0)
    root.rotation_euler = (0, 0, math.radians(-20 if MODE == "lineup" else -12))
    x += 0.75

if MODE != "closeup":
    objs = import_glb(os.path.join(MODELS, "cars.glb"))
    k = 0
    for o in objs:
        if o.parent is None and o.name.startswith("car_"):
            s = 0.2 if MODE == "lineup" else 0.5
            o.scale = (s, s, s)
            o.rotation_mode = "XYZ"
            o.rotation_euler = (0, 0, math.radians(-145))
            if MODE == "lineup":
                o.location = (-0.3 + (k % 4) * 0.85, 1.6 + (k // 4) * 1.2, 0)
            else:
                o.location = ((k % 4) * 2.6, (k // 4) * 3.2, 0)
            k += 1

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Punchy"
scene.eevee.taa_render_samples = 64
if MODE == "lineup":
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1200
elif MODE == "closeup":
    scene.render.resolution_x, scene.render.resolution_y = 1200, 1000
else:
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.78, 0.84, 0.92, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.45
scene.world = world

bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
ground = bpy.context.active_object
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.6, 0.66, 1)
ground.data.materials.append(gm)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
cam.data.type = "ORTHO"
if MODE == "lineup":
    cam.data.ortho_scale = 3.7
    cam.location = (1.1, -6.0, 5.2)
    cam.rotation_euler = (math.radians(52), 0, 0)
elif MODE == "closeup":
    cam.data.ortho_scale = 1.55
    cam.location = (0.38, -6.0, 1.55)
    cam.rotation_euler = (math.radians(82), 0, 0)
else:
    cam.data.ortho_scale = 11.5
    cam.location = (3.9, -9.0, 9.2)
    cam.rotation_euler = (math.radians(50), 0, 0)
scene.camera = cam


def light(name, kind, energy, rot, color=(1, 1, 1), size=None, loc=(0, 0, 5)):
    lo = bpy.data.objects.new(name, bpy.data.lights.new(name, kind))
    lo.data.energy = energy
    lo.data.color = color
    if size is not None:
        lo.data.angle = size
    lo.rotation_euler = [math.radians(a) for a in rot]
    lo.location = loc
    scene.collection.objects.link(lo)


light("key", "SUN", 3.2, (40, 0, -35), (1.0, 0.96, 0.9), size=math.radians(8))
light("fill", "SUN", 0.9, (60, 0, 60), (0.8, 0.88, 1.0), size=math.radians(30))
light("rim", "SUN", 2.0, (-55, 0, 10), (1.0, 1.0, 1.0), size=math.radians(10))
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("PREVIEW_OK", OUT)
