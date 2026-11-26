"""Render every vehicle with a rider, composed from manifest.json `rides` exactly as the app's sprite bake does
(apps/mobile/src/avatar3d/kit.ts `buildRide`). Pose/proportion check, not a shading check (the app shades in three.js).

    blender -b -P tools/blender/preview_rides.py -- apps/mobile/assets/models out.png [cell_px]
"""
import bpy
import json
import math
import os
import re
import sys
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
MODELS, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
CELL = int(argv[2]) if len(argv) > 2 else 300
bpy.ops.wm.read_factory_settings(use_empty=True)
RIDES = json.load(open(os.path.join(MODELS, "manifest.json")))["rides"]
LOOK = {"body": "regular", "face": "grin", "hair": "curly", "top": "hoodie", "bottom": "jeans", "shoes": "sneakers", "hat": "cap", "glasses": "none", "acc": "none"}
COLS = 5
SPACING = 1.9
HEADING = math.radians(float(argv[3]) if len(argv) > 3 else -145)  # optional 4th arg: heading in degrees


def base(name):
    return re.sub(r"\.\d{3}$", "", name)


def visible(name):
    name = base(name)
    for key, val in LOOK.items():
        if name.startswith(key + "_"):
            return name == f"{key}_{val}" or name.startswith(f"{key}_{val}_")
    return True


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def rot(rx, rz):
    # three.js Euler XYZ (x then z) on a pivot; three Z = Blender -Y
    return Matrix.Rotation(rx, 4, "X") @ Matrix.Rotation(-rz, 4, "Y")


cars = import_glb(os.path.join(MODELS, "cars.glb"))
for m in bpy.data.materials:
    if base(m.name) == "glass" and m.node_tree:
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Alpha"].default_value = 0.3
        m.surface_render_method = "BLENDED"
for i, model in enumerate(sorted(RIDES)):
    r = RIDES[model]
    loc = Vector(((i % COLS) * SPACING, (i // COLS) * SPACING, 0))
    place = Matrix.Translation(loc) @ Matrix.Rotation(HEADING, 4, "Z")
    car = next(o for o in cars if o.parent is None and base(o.name) == f"car_{model}")
    car.matrix_world = place @ Matrix.Diagonal((r["scale"],) * 3 + (1,))
    objs = import_glb(os.path.join(MODELS, "avatar.glb"))
    for o in objs:
        chain = [o]
        while chain[-1].parent is not None:
            chain.append(chain[-1].parent)
        o.hide_render = not all(visible(p.name) for p in chain)
    root = next(o for o in objs if o.parent is None)
    p = r["pose"]
    for limb in ("legL", "legR", "armL", "armR"):
        piv = next(o for o in objs if base(o.name) == limb)
        piv.rotation_mode = "QUATERNION"
        piv.rotation_quaternion = rot(*p[limb]).to_quaternion()
    seat = Vector(r["seat"]) * r["scale"]
    root.matrix_world = place @ Matrix.Translation(seat) @ Matrix.Rotation(p["yaw"], 4, "Z") @ Matrix.Rotation(p["lean"], 4, "X") @ Matrix.Diagonal((r["rider"],) * 3 + (1,)) @ Matrix.Translation((0, 0, -0.3))

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.view_settings.view_transform = "AgX"
scene.eevee.taa_render_samples = 32
rows = math.ceil(len(RIDES) / COLS)
scene.render.resolution_x, scene.render.resolution_y = CELL * COLS, CELL * rows
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.78, 0.84, 0.92, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
scene.world = world
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
cam.data.type = "ORTHO"
cam.data.ortho_scale = SPACING * COLS
pitch = math.atan2(3.7, 2.6)  # the bake camera: (0, 2.6, 3.7) looking at the origin
cx, cy = (COLS - 1) * SPACING / 2, (rows - 1) * SPACING / 2
cam.rotation_euler = (pitch, 0, 0)
d = 20
cam.location = (cx, cy - d * math.sin(pitch), d * math.cos(pitch) + 0.3)
cam.data.shift_y = 0
scene.camera = cam
for name, energy, r_ in (("key", 3.0, (40, 0, -35)), ("fill", 1.0, (60, 0, 60)), ("rim", 1.5, (-55, 0, 10))):
    lo = bpy.data.objects.new(name, bpy.data.lights.new(name, "SUN"))
    lo.data.energy = energy
    lo.rotation_euler = [math.radians(a) for a in r_]
    scene.collection.objects.link(lo)
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("PREVIEW_OK", OUT)
