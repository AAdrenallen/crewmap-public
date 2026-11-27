"""
CrewMap asset pipeline (F8). Run headless:

    blender -b -P tools/blender/build_assets.py -- apps/mobile/assets/models [avatar|cars]   # one kit only; manifest merged
    node tools/blender/optimize.mjs apps/mobile/assets/models    # dedup + weld + quantize; always run after
    blender -b -P tools/blender/preview_rides.py -- apps/mobile/assets/models out.png    # rider pose check

Builds an original, stylised character kit and fifteen rides procedurally (no third-party assets) from a few modelling
primitives — lathed profiles, hardened-normal bevelled boxes, Bezier tubes and deformed ellipsoids — and exports:
  avatar.glb  — every part variant as a named node (body_*, face_*, hair_*, top_*, bottom_*, shoes_*, hat_*,
                glasses_*, acc_*); shared parts (head, neck, nose, ears) are unprefixed; legL/legR/armL/armR are
                pivots for the walk cycle. Materials skin / hair / top / bottom / shoe / shoe2 / hat / frame / extra / accent
                are recoloured at runtime from the avatar config; the rest (ink, white, iris, mouth, metal, gold, lens
                tints, ...) are fixed. Variant tags: `_B<body>-...` (clothes fitted for those bodies), `_H`/`_W` (hair without/with a hat).
  cars.glb    — car_<model> nodes with a clear-coated `paint` material (recoloured), glass, tyre, rim, light, trim.
  manifest.json — part ids, triangle counts (budget: ≤ 16k tris per worst-case composed avatar, ≤ 4k per ride) and
                  per-ride seat / scale / rider pose (`rides`), read by the app and preview_rides.py.
Meshes are joined per part variant, pivot and material before export (one draw call each).
Part ids must match packages/shared/src/avatar.ts (checked by packages/shared/test/avatar-assets.test.ts).
Blender frame: Z up, the figure faces -Y, ~1 unit tall.
"""
import bpy
import bmesh
import json
import math
import os
import re
import sys
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "apps/mobile/assets/models")
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------------------------------------------------------
# modelling helpers (everything is built in world space, then parented with a compensating inverse)

MATS = {}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


def mat(name, rgb=(0.8, 0.8, 0.8), rough=0.6, metal=0.0, emit=0.0, coat=0.0, sheen=0.0, double=False):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = not double
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.06
    if sheen:
        b.inputs["Sheen Weight"].default_value = sheen
    MATS[name] = m
    return m


def T(loc):
    return Matrix.Translation(Vector(loc))


def R(rot):
    return Euler(rot, "XYZ").to_matrix().to_4x4()


def S(sc):
    return Matrix.Diagonal((*sc, 1.0))


def wmat(o):
    m = T(o.location)
    return wmat(o.parent) @ m if o.parent is not None else m


def empty(name, loc=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.parent = parent
    return o


def from_bm(name, bm, material, parent=None, smooth=True, sharp=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    for p in me.polygons:
        p.use_smooth = smooth
    if sharp is not None:
        me.set_sharpness_by_angle(angle=math.radians(sharp))
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = wmat(parent).inverted()
    return o


def xform(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts[:])


def ellip(name, size, loc, material, parent=None, seg=16, rings=10, rot=(0, 0, 0), deform=None, keep=None):
    """Ellipsoid; `keep(co)` trims and `deform(co)` reshapes in unit-sphere space before scaling."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    if keep is not None:
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep(v.co)], context="VERTS")
    if deform is not None:
        for v in bm.verts:
            v.co = deform(v.co.copy())
    xform(bm, T(loc) @ R(rot) @ S(size))
    return from_bm(name, bm, material, parent)


def lathe(name, prof, material, parent=None, seg=16, M=None, wave=None, caps=(True, True), drop=None):
    """Surface of revolution around local Z. prof: [(z, r) | (z, rx, ry)] with z increasing; r=0 closes a tip.
    wave(angle, z) multiplies the radius (cloth folds, pleats, ribbing)."""
    bm = bmesh.new()
    rings = []
    for p in prof:
        z, rx, ry = (p[0], p[1], p[1]) if len(p) == 2 else p
        if rx < 1e-6:
            rings.append([bm.verts.new((0, 0, z))] * seg)
            continue
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            k = wave(a, z) if wave else 1.0
            ring.append(bm.verts.new((rx * k * math.cos(a), ry * k * math.sin(a), z)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            quad = [r0[i], r0[j], r1[j], r1[i]]
            vs = [v for k, v in enumerate(quad) if v not in quad[:k]]
            if len(vs) >= 3:
                bm.faces.new(vs)
    for idx, top in ((0, False), (-1, True)):
        ring = rings[idx]
        if caps[0 if idx == 0 else 1] and ring[0] is not ring[1]:
            c = bm.verts.new((0, 0, ring[0].co.z))
            for i in range(seg):
                j = (i + 1) % seg
                bm.faces.new((c, ring[i], ring[j]) if top else (c, ring[j], ring[i]))
    if drop is not None:  # drop(face centre) cuts openings (armholes, necklines), in local space before M
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if drop(f.calc_center_median())], context="FACES")
    if M is not None:
        xform(bm, M)
    return from_bm(name, bm, material, parent)


def loft(name, outline, layers, material, parent=None, M=None, caps=(True, True)):
    """Closed 2D outline [(u, v)] swept through layers [(w, scale[, du, dv])] in local (x, y, z) = (u, v, w); caps fan
    to the ring centre. Rounded soles, lenses, ears, wings."""
    bm = bmesh.new()
    rings = []
    for L in layers:
        du, dv = (L[2], L[3]) if len(L) > 3 else (0.0, 0.0)
        rings.append([bm.verts.new((u * L[1] + du, v * L[1] + dv, L[0])) for u, v in outline])
    n = len(outline)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    for idx, on in ((0, caps[0]), (-1, caps[1])):
        if on:
            rr = rings[idx]
            c = bm.verts.new(sum((v.co for v in rr), Vector()) / n)
            for i in range(n):
                j = (i + 1) % n
                bm.faces.new((c, rr[i], rr[j]) if idx == -1 else (c, rr[j], rr[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if M is not None:
        xform(bm, M)
    return from_bm(name, bm, material, parent)


def sgnpow(c, p):
    return math.copysign(abs(c) ** p, c)


def superellipse(w, h, p=2.0, n=20):
    return [(w * sgnpow(math.cos(a), 2 / p), h * sgnpow(math.sin(a), 2 / p)) for a in [2 * math.pi * k / n for k in range(n)]]


def tube(name, pts, r, material, parent=None, radii=None, res=3, bev=1, cyclic=False, caps=True):
    """Smooth Bezier tube through pts (auto handles); radii taper per point."""
    cu = bpy.data.curves.new(name + "_c", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = bev
    cu.resolution_u = res
    cu.use_fill_caps = caps
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    sp.use_cyclic_u = cyclic
    for i, (bp, co) in enumerate(zip(sp.bezier_points, pts)):
        bp.co = co
        bp.handle_left_type = bp.handle_right_type = "AUTO"
        bp.radius = radii[i] if radii else 1.0
    ob = bpy.data.objects.new(name + "_tmp", cu)
    bpy.context.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    return from_bm(name, bm, material, parent)


def ring(name, R_, r, loc, material, parent=None, rot=(0, 0, 0), n=20, scale=(1, 1), minor=6):
    """Torus (optionally elliptical) for hems, cuffs, collars and bands."""
    bm = bmesh.new()
    grid = []
    for i in range(n):
        a = 2 * math.pi * i / n
        cx, cy = R_ * scale[0] * math.cos(a), R_ * scale[1] * math.sin(a)
        nrm = Vector((scale[1] * math.cos(a), scale[0] * math.sin(a), 0)).normalized()
        grid.append([bm.verts.new((cx + nrm.x * r * math.cos(b), cy + nrm.y * r * math.cos(b), r * math.sin(b))) for b in [2 * math.pi * j / minor for j in range(minor)]])
    for i in range(n):
        for j in range(minor):
            i2, j2 = (i + 1) % n, (j + 1) % minor
            bm.faces.new((grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    xform(bm, T(loc) @ R(rot))
    return from_bm(name, bm, material, parent)


def bevel_mod(o, width, seg=3, angle=None):
    mod = o.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = seg
    mod.harden_normals = True
    mod.limit_method = "ANGLE" if angle else "NONE"
    if angle:
        mod.angle_limit = math.radians(angle)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier="bevel")
    return o


def rbox(name, size, loc, material, parent=None, b=0.25, seg=2, rot=(0, 0, 0), taper=None):
    """Rounded box with hardened normals. taper=(sx, sy) scales the top face (trapezoids, wedges)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    if taper:
        for v in bm.verts:
            if v.co.z > 0:
                v.co.x *= taper[0]
                v.co.y *= taper[1]
    xform(bm, S(size))
    o = from_bm(name, bm, material, None)
    if seg:  # seg=0: plain box (tiny parts)
        bevel_mod(o, b * min(size), seg)
    me = o.data
    me.transform(T(loc) @ R(rot))
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = wmat(parent).inverted()
    return o


def extrude_profile(name, prof, width, material, parent=None, top_taper=1.0, z_split=None, bevel=0.06, seg=3):
    """Side profile polygon in (y, z) extruded symmetrically along X; verts above z_split narrow by top_taper."""
    bm = bmesh.new()
    left = [bm.verts.new((-width / 2, y, z)) for y, z in prof]
    right = [bm.verts.new((width / 2, y, z)) for y, z in prof]
    n = len(prof)
    bm.faces.new(left[::-1])
    bm.faces.new(right)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if z_split is not None:
        for v in bm.verts:
            if v.co.z > z_split:
                v.co.x *= top_taper
    o = from_bm(name, bm, material, None)
    bevel_mod(o, bevel, seg, angle=25)
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = wmat(parent).inverted()
    return o


VARIANT_TAG = re.compile(r"_(B[a-z-]+|H|W)(?=_|$)")


def consolidate(variant_of):
    """Join meshes that always render together (same parent, same part variant, same material) into one object, so
    one draw call each. `variant_of(name)` gives the variant prefix (e.g. "hat_cap") or "" for shared parts; joined
    objects keep that prefix, so the runtime's name-based variant switch still works. A variant tag in the mesh name
    is kept as well: `_B<body>-<body>` (clothes fitted for those bodies), `_H` (hair hidden under a hat), `_W` (hair
    shown only under a hat); the runtime reads them (kit.ts variantVisible)."""
    groups = {}
    for o in list(bpy.data.objects):
        if o.type != "MESH" or not o.data.materials:
            continue
        variant = variant_of(o.name)
        tag = VARIANT_TAG.search(o.name) if variant else None
        key = (o.parent.name if o.parent else "", variant + (f"_{tag.group(1)}" if tag else ""), o.data.materials[0].name)
        groups.setdefault(key, []).append(o)
    for (parent, variant, material), objs in groups.items():
        head = objs[0]
        if len(objs) > 1:
            with bpy.context.temp_override(active_object=head, selected_editable_objects=objs, selected_objects=objs):
                bpy.ops.object.join()
        if variant and parent != variant:
            head.name = f"{variant}_{parent}_{material}"
        else:
            head.name = f"{variant or parent or 'part'}_{material}"
        head.data.name = head.name


def tris(obj):
    if obj.type != "MESH":
        return 0
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def export(path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_extras=True,
    )


# ----------------------------------------------------------------------------------------------------------------
# avatar kit — polished chibi: head ≈ 40 % of height, ~1.0 unit tall

HEAD_C = Vector((0, 0, 0.74))
HR = (0.205, 0.19, 0.2)  # head radii
HIP_Z = 0.3
SHOULDER_Z = 0.53
ARM_LEN = 0.19
ARM_TILT = math.radians(9)
# shoulder half-width, chest depth, waist half-width, hip half-width
BODIES = {"slim": (0.112, 0.085, 0.092, 0.1), "regular": (0.128, 0.094, 0.106, 0.112), "broad": (0.152, 0.104, 0.128, 0.122), "curvy": (0.122, 0.098, 0.094, 0.134)}
# Clothes are fitted per group of bodies (tag `_B<a>-<b>`): the largest torso of the group, sleeves on the group's mean
# arm line (each arm stays inside its sleeve). Two groups keep avatar.glb lean; broad shoulders need their own.
FIT_GROUPS = (("slim", "curvy", "regular"), ("broad",))
FITS = {"-".join(g): (*(max(BODIES[b][i] for b in g) for i in range(4)), sum(BODIES[b][0] for b in g) / len(g)) for g in FIT_GROUPS}


def jaw(c):
    """Head shaping in unit space: narrower jaw and chin, slightly fuller cheeks."""
    if c.z < 0:
        t = (-c.z) ** 1.6
        c.x *= 1 - 0.22 * t
        c.y *= 1 - 0.1 * t
    if c.y < 0 and -0.6 < c.z < 0.1:
        c.x *= 1 + 0.03 * math.cos((c.z + 0.25) * 4)
    return c


def surf(x, z, out=0.0):
    """Point on the face surface at head-relative (x, z), pushed `out` along the view axis, plus tangent rotation."""
    u, w = x / HR[0], z / HR[2]
    kx, ky = (1 - 0.22 * (-w) ** 1.6, 1 - 0.1 * (-w) ** 1.6) if w < 0 else (1, 1)
    u /= kx
    y = -HR[1] * ky * math.sqrt(max(0.0, 1 - u * u - w * w))
    yaw = math.atan2(u, math.sqrt(max(0.05, 1 - u * u - w * w)))
    pitch = math.atan2(w, math.sqrt(max(0.05, 1 - u * u - w * w)))
    return Vector((x, y - out, HEAD_C.z + z)), (-pitch * 0.8, 0, yaw * 0.9)


def face_pt(x, z, out=0.0):
    return surf(x, z, out)[0]


def build_avatar():
    reset()
    SKIN = mat("skin", (0.85, 0.62, 0.45), rough=0.55, sheen=0.2)
    HAIR = mat("hair", (0.25, 0.16, 0.10), rough=0.42, double=True)
    TOP = mat("top", (0.36, 0.42, 1.0), rough=0.85, sheen=0.4)
    BOTTOM = mat("bottom", (0.17, 0.24, 0.44), rough=0.8, sheen=0.3)
    INK = mat("ink", (0.04, 0.035, 0.05), rough=0.35)
    WHITE = mat("white", (0.97, 0.97, 0.96), rough=0.35)
    SHINE = mat("shine", (1.0, 1.0, 1.0), rough=0.2, emit=2.0)
    IRIS = mat("iris", (0.16, 0.09, 0.05), rough=0.15)
    MOUTH = mat("mouth", (0.33, 0.07, 0.09), rough=0.5)
    TONGUE = mat("tongue", (0.92, 0.42, 0.44), rough=0.5)
    RUBBER = mat("rubber", (0.16, 0.14, 0.13), rough=0.8)
    ACCENT = mat("accent", (1.0, 0.42, 0.42), rough=0.55, sheen=0.3)
    METAL = mat("metal", (0.78, 0.78, 0.82), rough=0.25, metal=1.0)
    GOLD = mat("gold", (1.0, 0.77, 0.3), rough=0.25, metal=1.0)
    LENS = mat("lens_dark", (0.05, 0.06, 0.09), rough=0.08, coat=1.0)

    # avatar-only tessellation (the shared helpers keep their defaults for the cars): at map size and in the editor
    # thin tubes read the same with a 4-sided section, and rings with a 4-sided one
    def ring(*a, minor=4, **k):
        return globals()["ring"](*a, minor=minor, **k)

    def tube(name, pts, r, material, parent=None, bev=None, res=3, **k):
        if bev is None:
            bev = 0 if r < 0.01 else 1
        return globals()["tube"](name, pts, r, material, parent, bev=bev, res=min(res, 2) if r < 0.01 else res, **k)

    root = empty("avatar")
    manifest = {k: [] for k in ("body", "hair", "face", "top", "bottom", "shoes", "hat", "glasses", "accessory")}
    head = empty("head", (0, 0, 0), root)

    # --- shared head: skull, ears, nose, neck
    ellip("head_skull", HR, HEAD_C, SKIN, head, seg=28, rings=18, deform=jaw)
    for side in (-1, 1):
        s = "L" if side < 0 else "R"
        ellip(f"ear_{s}", (0.022, 0.034, 0.046), (side * 0.192, 0.012, HEAD_C.z - 0.02), SKIN, head, seg=12, rings=8, rot=(0, 0, side * 0.35))
        ellip(f"ear_{s}_in", (0.01, 0.02, 0.028), (side * 0.205, 0.004, HEAD_C.z - 0.02), SKIN, head, seg=8, rings=6, rot=(0, 0, side * 0.35))
    p, r = surf(0, -0.045, -0.006)
    ellip("nose", (0.02, 0.016, 0.015), p, SKIN, head, seg=12, rings=8, rot=r)
    lathe("neck", [(0.5, 0.044), (0.6, 0.042), (0.64, 0.045)], SKIN, root, seg=14, caps=(False, False))

    # pivots for the walk cycle
    hipL, hipR = empty("legL", (-0.06, 0, HIP_Z), root), empty("legR", (0.06, 0, HIP_Z), root)
    shL, shR = empty("armL", (-0.13, 0, SHOULDER_Z), root), empty("armR", (0.13, 0, SHOULDER_Z), root)
    LEG_X = 0.06

    def arm_M(side, sw):
        return T((side * (sw * 0.95), 0, SHOULDER_Z)) @ R((0, -side * ARM_TILT, 0))

    def hand_pos(side, sw):
        return arm_M(side, sw) @ Vector((0, 0, -ARM_LEN - 0.03))

    def torso_prof(sw, d, ww, hw, t=0.0, z0=0.27, z1=0.6):
        prof = [(0.27, hw * 0.7 + t, d * 0.78 + t), (0.3, hw + t, d * 0.92 + t), (0.36, ww + t, d * 0.9 + t), (0.43, (ww + sw) / 2 + t, d + t),
                (0.49, sw + t, d * 1.03 + t), (0.53, sw * 0.95 + t, d * 0.97 + t), (0.565, sw * 0.68 + t, d * 0.74 + t), (0.59, 0.07 + t, 0.06 + t)]
        return [p for p in prof if z0 <= p[0] <= z1]

    # --- bodies: torso + arms + hands + legs (clothes layer over them)
    for name, (sw, d, ww, hw) in BODIES.items():
        manifest["body"].append(name)
        grp = empty(f"body_{name}", (0, 0, 0), root)
        lathe(f"body_{name}_torso", torso_prof(sw, d, ww, hw) + [(0.6, 0.0)], SKIN, grp, seg=20, caps=(True, False))
        for side, sp, hp in ((-1, shL, hipL), (1, shR, hipR)):
            s = "L" if side < 0 else "R"
            lathe(f"body_{name}_arm{s}", [(-ARM_LEN, 0.025), (-0.1, 0.028), (-0.02, 0.033), (0.01, 0.03), (0.03, 0.0)], SKIN, sp, seg=12, M=arm_M(side, sw), caps=(True, False))
            h = hand_pos(side, sw)
            ellip(f"body_{name}_hand{s}", (0.03, 0.024, 0.038), h, SKIN, sp, seg=12, rings=8, rot=(0, -side * ARM_TILT, 0))
            ellip(f"body_{name}_thumb{s}", (0.012, 0.012, 0.018), h + Vector((-side * 0.004, -0.018, 0.008)), SKIN, sp, seg=8, rings=6, rot=(0.4, 0, 0))
            lathe(f"body_{name}_leg{s}", [(0.04, 0.034), (0.1, 0.036), (0.2, 0.044), (0.31, 0.052)], SKIN, hp, seg=12, M=T((side * LEG_X, 0, 0)), caps=(True, False))

    # --- faces
    EYE_X, EYE_Z = 0.074, -0.006

    def eye_open(pre, grp, side, big=1.0):
        x = side * EYE_X
        p, r = surf(x, EYE_Z, -0.004)
        ellip(f"{pre}_sclera", (0.034 * big, 0.012, 0.043 * big), p, WHITE, grp, seg=12, rings=8, rot=r)
        p, r = surf(x + side * 0.002, EYE_Z - 0.003, 0.002)
        ellip(f"{pre}_iris", (0.026 * big, 0.008, 0.033 * big), p, IRIS, grp, seg=12, rings=8, rot=r)
        p, r = surf(x + side * 0.002, EYE_Z - 0.004, 0.006)
        ellip(f"{pre}_pupil", (0.013 * big, 0.005, 0.017 * big), p, INK, grp, seg=10, rings=6, rot=r)
        ellip(f"{pre}_shine", (0.0085 * big,) * 3, face_pt(x - 0.009, EYE_Z + 0.013, 0.011), SHINE, grp, seg=6, rings=4)
        ellip(f"{pre}_shine2", (0.0042 * big,) * 3, face_pt(x + 0.01, EYE_Z - 0.016, 0.01), SHINE, grp, seg=6, rings=4)
        # upper lash line, thicker towards the outside with a small flick
        pts, radii = [], []
        for k in range(7):
            a = math.radians(195 - k * 30) if side > 0 else math.radians(-15 + k * 30)
            pts.append(face_pt(x + 0.037 * big * math.cos(a), EYE_Z + 0.044 * big * math.sin(a) * (1 if math.sin(a) > 0 else 0.3), 0.003))
            radii.append(0.6 + 0.6 * (k / 6 if side > 0 else 1 - k / 6))
        flick = face_pt(x + side * 0.048 * big, EYE_Z + 0.018, 0.0)
        if side > 0:
            pts.append(flick)
            radii.append(0.4)
        else:
            pts.insert(0, flick)
            radii.insert(0, 0.4)
        tube(f"{pre}_lash", pts, 0.0048, INK, grp, radii=radii)

    def eye_closed(pre, grp, side, happy=True):
        x = side * EYE_X
        pts = [face_pt(x + 0.034 * math.cos(a), EYE_Z - 0.008 + (0.02 if happy else -0.012) * math.sin(a), 0.003) for a in [math.radians(v) for v in (180, 135, 90, 45, 0)]]
        tube(f"{pre}_closed", pts, 0.0055, INK, grp, radii=[0.5, 1, 1.1, 1, 0.5])

    def brow(pre, grp, side, z=0.07, tilt=0.0, arch=0.008):
        xs = (0.045, 0.075, 0.104)
        pts = [face_pt(side * x, z + tilt * (x - 0.075) / 0.03 + (arch if x == 0.075 else 0), 0.004) for x in xs]
        tube(f"{pre}_brow{side}", pts, 0.0075, HAIR, grp, radii=[1.1, 1.0, 0.55])

    def mouth_line(pre, grp, pts2, r=0.0055):
        tube(f"{pre}_mouth", [face_pt(x, z, 0.002) for x, z in pts2], r, INK, grp, radii=[0.6] + [1.0] * (len(pts2) - 2) + [0.6])

    def mouth_open(pre, grp, w=0.04, h=0.026, z=-0.092, teeth=True):
        p, r = surf(0, z, -0.004)
        ellip(f"{pre}_mouth", (w, 0.012, h), p, MOUTH, grp, seg=14, rings=8, rot=r, deform=lambda c: Vector((c.x, c.y, min(c.z, 0.35) if teeth else c.z)))
        p, r = surf(0, z - h * 0.55, 0.0)
        ellip(f"{pre}_tongue", (w * 0.55, 0.01, h * 0.38), p, TONGUE, grp, seg=12, rings=8, rot=r)
        if teeth:
            p, r = surf(0, z + h * 0.22, 0.001)
            ellip(f"{pre}_teeth", (w * 0.82, 0.008, h * 0.2), p, WHITE, grp, seg=12, rings=6, rot=r)

    faces = ["smile", "grin", "cool", "wink", "calm", "surprised"]
    for name in faces:
        manifest["face"].append(name)
        pre = f"face_{name}"
        grp = empty(pre, (0, 0, 0), head)
        for side in (-1, 1):
            s = f"{pre}_{'L' if side < 0 else 'R'}"
            if name == "calm" or (name == "wink" and side > 0):
                eye_closed(s, grp, side)
            else:
                eye_open(s, grp, side, big=1.12 if name == "surprised" else 1.0)
            if name == "cool":
                p, r = surf(side * EYE_X, EYE_Z + 0.03, -0.001)
                ellip(f"{s}_lid", (0.04, 0.016, 0.026), p, SKIN, grp, seg=12, rings=6, rot=r)
                tube(f"{s}_lidline", [face_pt(side * EYE_X + dx, EYE_Z + 0.008 + abs(dx) * -0.1, 0.013) for dx in (-0.036, 0, 0.036)], 0.005, INK, grp)
            brow(s, grp, side, z={"surprised": 0.09, "grin": 0.078}.get(name, 0.07), tilt={"cool": -0.012}.get(name, 0.0), arch=0.012 if name == "surprised" else 0.007)
        if name == "smile":
            mouth_line(pre, grp, [(-0.034, -0.082), (-0.017, -0.095), (0.0, -0.099), (0.017, -0.095), (0.034, -0.082)])
        elif name == "grin":
            mouth_open(pre, grp)
        elif name == "cool":
            mouth_line(pre, grp, [(-0.024, -0.094), (0.0, -0.096), (0.016, -0.092), (0.03, -0.083)])
        elif name == "wink":
            mouth_open(pre, grp, w=0.036, h=0.017, z=-0.09, teeth=False)
        elif name == "calm":
            mouth_line(pre, grp, [(-0.024, -0.086), (-0.012, -0.093), (0.0, -0.095), (0.012, -0.093), (0.024, -0.086)])
        elif name == "surprised":
            p, r = surf(0, -0.096, -0.004)
            ellip(f"{pre}_mouth", (0.017, 0.012, 0.022), p, MOUTH, grp, seg=14, rings=8, rot=r)

    # --- recolourable part materials (avatar config colour slots) and a few fixed ones for props
    SHOE = mat("shoe", (0.95, 0.95, 0.95), rough=0.5)
    SHOE2 = mat("shoe2", (0.12, 0.16, 0.22), rough=0.6)
    HAT = mat("hat", (1.0, 0.42, 0.42), rough=0.55, sheen=0.3)
    FRAME = mat("frame", (0.06, 0.05, 0.06), rough=0.35)
    EXTRA = mat("extra", (1.0, 0.42, 0.42), rough=0.55, sheen=0.3, double=True)
    HORN = mat("horn", (0.95, 0.9, 0.78), rough=0.5)
    TINT = mat("lens_tint", (0.36, 0.22, 0.08), rough=0.08, coat=1.0)
    PINK = mat("lens_pink", (0.95, 0.35, 0.58), rough=0.1, coat=1.0)
    RED3D = mat("lens_red3d", (0.92, 0.12, 0.12), rough=0.3)
    BLUE3D = mat("lens_blue3d", (0.1, 0.62, 0.95), rough=0.3)
    NEON = mat("lens_neon", (0.2, 0.95, 1.0), rough=0.2, emit=1.5)
    AMBER = mat("lens_amber", (0.98, 0.62, 0.12), rough=0.1, emit=0.3)
    MIRROR = mat("lens_mirror", (0.98, 0.5, 0.16), rough=0.1, metal=0.6)
    # clear lenses for open frames (rendered see-through; the lens colour tints them softly)
    CLEAR = mat("lens_clear", (0.86, 0.93, 1.0), rough=0.05, coat=1.0)

    def sub(slot, m):
        """Copy of a fixed trim material owned by one slot (`<slot>2_<name>`): the slot's optional trim colour
        repaints it; unset, it keeps the built-in colour."""
        name = f"{slot}_{m.name}"
        if name not in MATS:
            c = m.copy()
            c.name = name
            MATS[name] = c
        return MATS[name]

    HAIR2A = sub("hair2", ACCENT)
    TOP2W, TOP2I = sub("top2", WHITE), sub("top2", INK)
    BOT2W, BOT2I = sub("bottom2", WHITE), sub("bottom2", INK)
    HAT2W, HAT2I, HAT2A, HAT2H = sub("hat2", WHITE), sub("hat2", INK), sub("hat2", ACCENT), sub("hat2", HORN)
    EXT2I, EXT2G = sub("extra2", INK), sub("extra2", GOLD)

    def align(d):
        """Rotation taking local +Z onto direction d."""
        return Vector((0, 0, 1)).rotation_difference(Vector(d).normalized()).to_matrix().to_4x4()

    def dens(prof):
        """Insert a midpoint ring between every pair (finer cuts for armholes)."""
        out = []
        for a, b in zip(prof, prof[1:]):
            out += [a, tuple((x + y) / 2 for x, y in zip(a, b))]
        return out + [prof[-1]]

    def prof_at(prof, z):
        for a, b in zip(prof, prof[1:]):
            if a[0] <= z <= b[0]:
                k = (z - a[0]) / (b[0] - a[0])
                return (z, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)
        return (z, prof[-1][1], prof[-1][2])

    # --- hair: a sculpted shell over the skull + locks for volume
    HC = HEAD_C + Vector((0, 0.008, 0.012))

    def shell(name, grp, scale=1.07, front=0.42, side=-0.2, back=-0.55, puff=0.06, drop=0.0, flare=0.0, part=0.0, lump=0.0, vol=0.0, seg=24, rings=14):
        """Hair cap: its hairline sits on the scalp (`scale` just above the skin); `vol` swells it away from the
        hairline (afro, top volume) so there is never a gap between hair and head."""
        def level(c):
            return side + (front - side) * max(0.0, -c.y) ** 1.3 + (back - side) * max(0.0, c.y) ** 1.2

        def keep(c):
            return c.z > level(c) - 0.35

        def deform(c):
            lv = level(c)
            if c.z < lv:
                h = Vector((c.x, c.y, 0))
                h = h.normalized() if h.length > 1e-6 else Vector((0, 1, 0))
                c = Vector((h.x * math.sqrt(1 - lv * lv), h.y * math.sqrt(1 - lv * lv), lv))
            k = scale * (1 + puff * max(0.0, c.z) ** 2)
            if vol:
                k *= 1 + vol * min(1.0, max(0.0, (c.z - lv) / 0.45)) ** 0.6
            if lump:
                k *= 1 + lump * math.sin(7 * math.atan2(c.y, c.x) + 3 * c.z) * math.sin(6 * c.z + 1.0)
            if part:
                k *= 1 - part * math.exp(-((c.x - 0.25) ** 2) / 0.004) * max(0.0, c.z)
            v = Vector((c.x * k, c.y * k, c.z * k))
            if c.z < 0:
                v.x *= 1 + flare * (-c.z)
                v.y *= 1 + flare * 0.6 * (-c.z)
                v.z -= drop * (-c.z) ** 1.2 * min(1.0, max(0.0, (c.y + 0.35) / 0.6))
            return v
        return ellip(name, HR, HC, HAIR, grp, seg=seg, rings=rings, keep=keep, deform=deform)

    def lock(name, grp, pts, r=0.03, radii=(1.0, 0.85, 0.25), res=3, bev=1):
        rr = list(radii) if len(radii) == len(pts) else [1.0 - 0.75 * i / (len(pts) - 1) for i in range(len(pts))]
        return tube(name, [HC + Vector(p) for p in pts], r, HAIR, grp, radii=rr, res=res, bev=bev)

    def fringe(pre, grp, n=6, sweep=0.03, length=1.0, r=0.032):
        for i in range(n):
            x = -0.13 + i * 0.26 / (n - 1)
            lock(f"{pre}_fringe{i}", grp, [(x * 0.5, -0.08, 0.17), (x * 0.95, -0.175, 0.13), (x + sweep, -0.2, 0.135 - 0.075 * length)], r=r)

    def on(az, el, s=1.06):
        """Point on the (hair-centred) head at azimuth `az` from the front and elevation `el`, and its direction."""
        d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
        return HC + Vector((d.x * HR[0] * s, d.y * HR[1] * s, d.z * HR[2] * s)), d

    def ridge(name, grp, az, els, s=1.06, r=0.007):
        tube(name, [on(az, math.radians(e), s)[0] for e in els], r, HAIR, grp, res=3, bev=1)

    def tie(name, grp, at, axis, r=0.032):
        ring(name, r, 0.011, (0, 0, 0), HAIR2A, grp, n=12, minor=5)
        o = bpy.data.objects[name]
        o.data.transform(T(at) @ align(axis))

    hairs = ["none", "buzz", "short", "curly", "bob", "long", "bun", "mohawk", "afro", "ponytail",
             "fade", "wavy", "pigtails", "braids", "slicked", "quiff", "mullet", "spiky", "sidePart", "pixie",
             "dreads", "bowl", "spaceBuns", "undercut", "topKnot", "cornrows"]
    for name in hairs:
        manifest["hair"].append(name)
        pre = f"hair_{name}"
        grp = empty(pre, (0, 0, 0), head)
        if name == "buzz":
            shell(f"{pre}_shell", grp, scale=1.025, front=0.5, puff=0.0)
        elif name == "short":
            shell(f"{pre}_shell", grp, scale=1.06, front=0.45, puff=0.06, part=0.06)
            fringe(pre, grp, n=6, sweep=0.04, length=0.9)
            for side in (-1, 1):
                lock(f"{pre}_side{side}", grp, [(side * 0.17, -0.06, 0.08), (side * 0.2, -0.05, -0.02), (side * 0.19, -0.07, -0.07)], r=0.022)
        elif name == "curly":
            shell(f"{pre}_shell", grp, scale=1.06, front=0.42, puff=0.12, seg=20, rings=12)
            n, k = 20, 0
            for i in range(n * 3):
                z = 1 - 2 * (i + 0.5) / (n * 3)
                a = i * math.pi * (3 - math.sqrt(5))
                rr = math.sqrt(1 - z * z)
                c = Vector((rr * math.cos(a), rr * math.sin(a), z))
                level = -0.2 + 0.62 * max(0.0, -c.y) ** 1.3 - 0.35 * max(0.0, c.y)
                if c.z < level or k >= n:
                    continue
                pos = HC + Vector((c.x * HR[0] * 1.12, c.y * HR[1] * 1.12, c.z * HR[2] * 1.15))
                ellip(f"{pre}_curl{k}", (0.056, 0.053, 0.046), pos, HAIR, grp, seg=8, rings=6, rot=(a, z, 0), deform=lambda c: Vector((c.x, c.y, c.z + 0.25 * c.x * c.x)))
                k += 1
        elif name == "bob":
            shell(f"{pre}_shell", grp, scale=1.09, front=0.3, side=-0.75, back=-0.85, puff=0.08, drop=0.12, flare=0.18)
            fringe(pre, grp, n=7, sweep=0.0, length=1.05, r=0.03)
        elif name == "long":
            shell(f"{pre}_shell", grp, scale=1.08, front=0.4, side=-0.7, back=-0.95, puff=0.08, drop=0.55, flare=0.25, part=0.05)
            for side in (-1, 1):
                for j, dx in enumerate((0.0, 0.035)):
                    lock(f"{pre}_front{side}_{j}", grp, [(side * (0.17 + dx), -0.07 + dx, 0.0), (side * (0.2 + dx), -0.05 + dx, -0.15), (side * (0.17 + dx), -0.06 + dx, -0.3)], r=0.035, radii=(1, 0.9, 0.35))
            fringe(pre, grp, n=5, sweep=-0.05, length=0.8, r=0.034)
        elif name == "bun":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.5, puff=0.03)
            ellip(f"{pre}_knot", (0.075, 0.075, 0.068), HC + Vector((0, 0.07, 0.205)), HAIR, grp, seg=16, rings=10, deform=lambda c: c * (1 + 0.06 * math.sin(6 * math.atan2(c.y, c.x) + 4 * c.z)))
            ring(f"{pre}_tie", 0.05, 0.011, HC + Vector((0, 0.06, 0.15)), HAIR2A, grp, rot=(math.radians(-25), 0, 0))
        elif name == "mohawk":
            shell(f"{pre}_shell", grp, scale=1.02, front=0.55, puff=0.0)
            for j in range(7):
                t = j / 6
                a = math.radians(-60 + t * 150)
                base = (0, math.sin(a) * 0.2, math.cos(a) * 0.2)
                tip = (0, math.sin(a) * 0.3 + 0.04, math.cos(a) * 0.3 + 0.02)
                lock(f"{pre}_spike{j}", grp, [base, ((base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2 + 0.01, (base[2] + tip[2]) / 2), tip], r=0.042 - 0.012 * abs(t - 0.4), radii=(1.0, 0.75, 0.12))
        elif name == "afro":
            # wraps the scalp at the hairline and swells to a cloud above it (it used to float over the head)
            shell(f"{pre}_cloud", grp, scale=1.05, front=0.36, side=-0.3, back=-0.62, puff=0.05, lump=0.04, vol=0.45, seg=32, rings=20)
        elif name == "ponytail":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.48, puff=0.03, part=0.04)
            ring(f"{pre}_tie", 0.038, 0.012, HC + Vector((0, 0.205, 0.07)), HAIR2A, grp, rot=(math.radians(70), 0, 0))
            lock(f"{pre}_tail", grp, [(0, 0.2, 0.08), (0, 0.27, 0.04), (0, 0.29, -0.1), (0, 0.25, -0.24)], r=0.05, radii=(0.8, 1.0, 0.8, 0.2))
        elif name == "fade":
            shell(f"{pre}_shell", grp, scale=1.018, front=0.5, puff=0.0)
            shell(f"{pre}_top", grp, scale=1.045, front=0.44, side=0.25, back=0.05, puff=0.1, vol=0.06, seg=24, rings=14)
        elif name == "wavy":
            shell(f"{pre}_shell", grp, scale=1.08, front=0.4, side=-0.6, back=-0.85, puff=0.08, drop=0.32, flare=0.2, part=0.05, lump=0.035)
            for side in (-1, 1):
                lock(f"{pre}_wave{side}", grp, [(side * 0.17, -0.08, 0.02), (side * 0.21, -0.06, -0.06), (side * 0.18, -0.07, -0.13), (side * 0.21, -0.05, -0.2)], r=0.032, radii=(1, 0.95, 0.85, 0.3))
            fringe(pre, grp, n=5, sweep=0.06, length=0.7, r=0.032)
        elif name == "pigtails":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.46, puff=0.03, part=0.05)
            for side in (-1, 1):
                tie(f"{pre}_tie{side}", grp, HC + Vector((side * 0.2, 0.06, 0.03)), (side, 0.2, 0.3), r=0.03)
                lock(f"{pre}_tail{side}", grp, [(side * 0.2, 0.06, 0.03), (side * 0.27, 0.08, -0.03), (side * 0.29, 0.07, -0.15), (side * 0.26, 0.05, -0.26)], r=0.042, radii=(0.8, 1.0, 0.85, 0.25))
            fringe(pre, grp, n=6, sweep=0.0, length=0.85, r=0.028)
        elif name == "braids":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.46, puff=0.03, part=0.05)
            for side in (-1, 1):
                for k in range(7):
                    p = HC + Vector((side * (0.17 - 0.008 * k), 0.03 - 0.012 * k, -0.06 - 0.042 * k))
                    ellip(f"{pre}_plait{side}_{k}", (0.024, 0.024, 0.03), p, HAIR, grp, seg=8, rings=6, rot=(0.3 * (-1) ** k, 0, 0))
                tie(f"{pre}_tie{side}", grp, HC + Vector((side * 0.112, -0.054, -0.36)), (0, 0, 1), r=0.02)
        elif name == "slicked":
            shell(f"{pre}_shell", grp, scale=1.05, front=0.5, side=-0.2, back=-0.6, puff=0.03)
            for k in range(-2, 3):
                ridge(f"{pre}_comb{k}", grp, k * 0.25, (28, 60, 95, 130, 160), s=1.055)
        elif name == "quiff":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.5, puff=0.03)
            for j, dx in enumerate((-0.04, 0.03)):
                lock(f"{pre}_quiff{j}", grp, [(dx - 0.03, -0.1, 0.19), (dx, -0.19, 0.25), (dx + 0.03, -0.24, 0.21), (dx + 0.02, -0.21, 0.16)], r=0.06, radii=(0.8, 1.0, 0.8, 0.3))
        elif name == "mullet":
            shell(f"{pre}_shell", grp, scale=1.06, front=0.45, side=-0.3, back=-0.95, puff=0.06, drop=0.45, flare=0.08)
            fringe(pre, grp, n=5, sweep=0.03, length=0.55, r=0.03)
        elif name == "spiky":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.5, puff=0.02)
            for k, (az, el) in enumerate(((0, 40), (-35, 45), (35, 45), (-70, 35), (70, 35), (0, 75), (-50, 80), (50, 80), (180, 60), (-120, 55), (120, 55), (180, 25))):
                p, d = on(math.radians(az), math.radians(el), 1.0)
                d = (d + Vector((0, -0.25, 0.35))).normalized()
                lathe(f"{pre}_spike{k}", [(0, 0.05), (0.06, 0.025), (0.11, 0.0)], HAIR, grp, seg=8, M=T(p) @ align(d), caps=(False, False))
        elif name == "sidePart":
            shell(f"{pre}_shell", grp, scale=1.06, front=0.45, puff=0.06, part=0.08)
            lock(f"{pre}_sweep0", grp, [(0.05, -0.1, 0.19), (-0.02, -0.19, 0.15), (-0.11, -0.19, 0.1), (-0.16, -0.15, 0.05)], r=0.045, radii=(0.8, 1.0, 0.85, 0.3))
            lock(f"{pre}_sweep1", grp, [(0.06, -0.05, 0.21), (-0.04, -0.13, 0.2), (-0.13, -0.13, 0.14)], r=0.04, radii=(0.8, 1.0, 0.35))
        elif name == "pixie":
            shell(f"{pre}_shell", grp, scale=1.05, front=0.36, side=-0.25, back=-0.5, puff=0.05, lump=0.02)
            fringe(pre, grp, n=5, sweep=0.06, length=0.6, r=0.026)
            for side in (-1, 1):
                lock(f"{pre}_side{side}", grp, [(side * 0.17, -0.07, 0.05), (side * 0.2, -0.06, -0.03), (side * 0.18, -0.08, -0.08)], r=0.018)
        elif name == "dreads":
            shell(f"{pre}_shell", grp, scale=1.05, front=0.45, puff=0.04)
            for k in range(13):
                az = math.radians(55 + k * (250 / 12))
                p, d = on(az, math.radians(8), 1.0)
                hang = Vector((d.x * 0.06, d.y * 0.06, 0))
                tube(f"{pre}_lock{k}", [p, p + hang * 0.7 + Vector((0, 0, -0.12)), p + hang + Vector((0, 0, -0.3 + 0.06 * (k % 3)))], 0.022, HAIR, grp, radii=[1, 1, 0.8], res=3, bev=1)
            for k, x in enumerate((-0.08, 0.0, 0.08)):
                lock(f"{pre}_front{k}", grp, [(x * 0.6, -0.1, 0.17), (x, -0.19, 0.1), (x * 1.1, -0.21, 0.04)], r=0.022, radii=(1, 1, 0.7), res=3, bev=1)
        elif name == "bowl":
            shell(f"{pre}_shell", grp, scale=1.1, front=0.26, side=-0.3, back=-0.45, puff=0.1)
        elif name == "spaceBuns":
            shell(f"{pre}_shell", grp, scale=1.04, front=0.46, puff=0.03, part=0.05)
            for side in (-1, 1):
                p, d = on(side * math.radians(55), math.radians(55), 1.08)
                ellip(f"{pre}_bun{side}", (0.065, 0.065, 0.06), p + d * 0.03, HAIR, grp, seg=14, rings=10, deform=lambda c: c * (1 + 0.06 * math.sin(6 * math.atan2(c.y, c.x) + 4 * c.z)))
                tie(f"{pre}_tie{side}", grp, p - d * 0.01, d, r=0.045)
        elif name == "undercut":
            shell(f"{pre}_shell", grp, scale=1.02, front=0.5, puff=0.0)
            shell(f"{pre}_top", grp, scale=1.06, front=0.45, side=0.3, back=-0.1, puff=0.12, vol=0.08, seg=24, rings=14)
            lock(f"{pre}_sweep", grp, [(0.08, -0.08, 0.21), (0.0, -0.18, 0.2), (-0.1, -0.19, 0.15)], r=0.05, radii=(0.8, 1.0, 0.35))
        elif name == "topKnot":
            shell(f"{pre}_shell", grp, scale=1.035, front=0.5, puff=0.02)
            ellip(f"{pre}_knot", (0.045, 0.045, 0.06), HC + Vector((0, 0.03, 0.25)), HAIR, grp, seg=12, rings=8)
            ring(f"{pre}_tie", 0.035, 0.01, HC + Vector((0, 0.03, 0.205)), HAIR2A, grp, n=12, minor=5)
        elif name == "cornrows":
            shell(f"{pre}_shell", grp, scale=1.02, front=0.5, puff=0.0)
            for k in range(-3, 4):
                ridge(f"{pre}_row{k}", grp, k * 0.2, (32, 60, 95, 130, 155), s=1.04, r=0.011)

    # hair under hats: these pieces stand proud of the scalp (fringes, spikes, buns, quiffs, the afro cloud) and are
    # hidden when a hat is worn (`_H`); a few styles get a flatter stand-in shown only under a hat (`_W`)
    UNDER_HAT = {"short": ["_fringe"], "curly": ["_curl"], "bob": ["_fringe"], "long": ["_fringe"], "bun": ["_knot", "_tie"], "mohawk": ["_spike"],
                 "afro": ["_cloud"], "fade": ["_top"], "wavy": ["_fringe"], "pigtails": ["_fringe"], "slicked": ["_comb"], "quiff": ["_quiff"],
                 "mullet": ["_fringe"], "spiky": ["_spike"], "sidePart": ["_sweep"], "pixie": ["_fringe"], "dreads": ["_front"], "bowl": ["_shell"],
                 "spaceBuns": ["_bun", "_tie"], "undercut": ["_top", "_sweep"], "topKnot": ["_knot", "_tie"], "cornrows": ["_row"]}
    for o in list(bpy.data.objects):
        for hn, keys in UNDER_HAT.items():
            pre = f"hair_{hn}"
            rest = o.name[len(pre):]
            if o.name.startswith(pre + "_") and any(rest.startswith(k) for k in keys):
                o.name = f"{pre}_H{rest}"
    for hn, kw in (("afro", dict(scale=1.06, front=0.36, side=-0.3, back=-0.62, flare=0.35, drop=0.08, lump=0.04)), ("bowl", dict(scale=1.04, front=0.28, side=-0.3, back=-0.45))):
        shell(f"hair_{hn}_W_shell", bpy.data.objects[f"hair_{hn}"], **kw)

    # --- tops: torso shell with folds and seams, sleeves on the arm pivots; fitted per body (`_B<body>` tag) so the
    # sleeves sit on the arms and the shell hugs each torso
    def folds(amp, zmax):
        return lambda a, z: 1 + amp * math.sin(7 * a + 13 * z) * max(0.0, (zmax - z) / zmax)

    def smooth(e0, e1, x):
        k = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
        return k * k * (3 - 2 * k)

    def tank_top(a):
        """Upper edge of the tank top: low armholes at the sides, straps over the shoulders, a scoop neck."""
        u = abs(math.cos(a))
        z = 0.43 + (0.565 - 0.43) * smooth(0.8, 0.6, u)
        scoop = 0.5 if math.sin(a) < 0 else 0.535
        return scoop + (z - scoop) * smooth(0.1, 0.32, u)

    def tank_pt(prof, a, f, out=0.0):
        z = prof[0][0] + (tank_top(a) - prof[0][0]) * f
        _, rx, ry = prof_at(prof, z)
        u = abs(math.cos(a))
        k = (1 + 0.02 * math.sin(7 * a + 13 * z) * max(0.0, (0.42 - z) / 0.42))
        return Vector(((rx * k + out) * math.cos(a), (ry * k + out) * math.sin(a), z))

    def tank_shell(name, prof, grp, seg=40, rows=10):
        """Tank top as one shell whose rows follow tank_top, so armholes and neckline are smooth edges (cutting faces
        out of a lathe left stair steps) and the sides tuck in under the arms."""
        bm = bmesh.new()
        grid = [[bm.verts.new(tank_pt(prof, 2 * math.pi * i / seg, j / rows)) for i in range(seg)] for j in range(rows + 1)]
        for j in range(rows):
            for i in range(seg):
                k = (i + 1) % seg
                bm.faces.new((grid[j][i], grid[j][k], grid[j + 1][k], grid[j + 1][i]))
        return from_bm(name, bm, TOP, grp)

    tops = {"tee": (0.012, 0.075), "hoodie": (0.02, ARM_LEN - 0.01), "jacket": (0.022, ARM_LEN - 0.01), "tank": (0.01, 0.0), "sweater": (0.018, ARM_LEN - 0.005), "jersey": (0.014, 0.085)}
    for name, (t, sleeve) in tops.items():
        manifest["top"].append(name)
        pre = f"top_{name}"
        grp = empty(pre, (0, 0, 0), root)
        for bn, (sw, d, ww, hw, swa) in FITS.items():
            tg = f"{pre}_B{bn}"
            prof = torso_prof(sw, d, ww, hw, t=t, z0=0.28, z1=0.578)
            if name in ("hoodie", "sweater"):
                prof = [(0.27, prof[0][1] * 0.97, prof[0][2] * 0.97)] + prof
            if name == "tank":
                tank_shell(f"{tg}_torso", prof, grp)
            else:
                lathe(f"{tg}_torso", prof, TOP, grp, seg=18, wave=folds(0.025, 0.42), caps=(False, False))
            hem = prof[0]
            ring(f"{tg}_hem", 1.0, 0.009 if name != "sweater" else 0.014, (0, 0, hem[0] + 0.006), TOP, grp, n=24, scale=(hem[1] + 0.002, hem[2] + 0.002))
            neck = prof[-1]
            if name != "tank":
                ring(f"{tg}_collar", 1.0, 0.012 if name != "sweater" else 0.02, (0, 0, neck[0]), TOP2W if name == "jersey" else TOP, grp, n=20, scale=(neck[1], neck[2]))
            if sleeve > 0:
                for side, piv in ((-1, shL), (1, shR)):
                    s = "L" if side < 0 else "R"
                    M = arm_M(side, swa)
                    r0 = 0.033 + 0.014
                    sp = [(-sleeve, 0.028 + 0.012 + (0.006 if sleeve < 0.1 else 0)), (-sleeve * 0.5, r0 - 0.002), (0.0, r0 + 0.004), (0.025, r0 * 0.85), (0.045, 0.0)]
                    lathe(f"{tg}_sleeve{s}", sp, TOP, piv, seg=14, M=M, wave=lambda a, z: 1 + 0.03 * math.sin(5 * a + 30 * z), caps=(False, False))
                    ring(f"{tg}_cuff{s}", sp[0][1] + 0.002, 0.008, M @ Vector((0, 0, -sleeve + 0.006)), TOP2W if name == "jersey" else TOP, piv, rot=(0, -side * ARM_TILT, 0), n=14)
            fz = lambda z: prof_at(prof, z)[2]  # front depth of the shell at height z
            if name == "hoodie":
                ellip(f"{tg}_hood", (sw * 0.95, 0.08, 0.07), (0, d * 0.8, 0.6), TOP, grp, seg=16, rings=10, deform=lambda c: Vector((c.x, c.y, c.z * (1.2 if c.y > 0 else 0.7))))
                for side in (-1, 1):
                    tube(f"{tg}_string{side}", [(side * 0.028, -fz(0.56) - 0.006, 0.56), (side * 0.03, -fz(0.52) - 0.008, 0.52), (side * 0.026, -fz(0.47) - 0.008, 0.47)], 0.005, TOP2W, grp)
                rbox(f"{tg}_pocket", (0.15, 0.03, 0.075), (0, -fz(0.36) - 0.008, 0.36), TOP, grp, b=0.3, taper=(0.82, 1.0))
            elif name == "jacket":
                tube(f"{tg}_zip", [(0, -fz(0.29) - 0.004, 0.29), (0, -fz(0.43) - 0.004, 0.43), (0, -fz(0.55) - 0.003, 0.55)], 0.0055, METAL, grp)
                for side in (-1, 1):
                    rbox(f"{tg}_lapel{side}", (0.05, 0.016, 0.07), (side * 0.045, -fz(0.56) + 0.004, 0.585), TOP, grp, b=0.35, rot=(0.35, 0, side * 0.5))
                    rbox(f"{tg}_pocket{side}", (0.05, 0.008, 0.006), (side * 0.075, -fz(0.37) * 0.96 - 0.002, 0.37), TOP2I, grp, b=0.4, rot=(0, 0, -side * 0.3))
            elif name == "sweater":
                for z in (0.29, 0.305):
                    ring(f"{tg}_rib{int(z * 1000)}", 1.0, 0.006, (0, 0, z), TOP, grp, n=24, scale=(hem[1] + 0.006, hem[2] + 0.006))
            elif name == "jersey":
                for side in (-1, 1):
                    tube(f"{tg}_stripe{side}", [(side * (prof_at(prof, z)[1] + 0.003), 0, z) for z in (0.3, 0.37, 0.44, 0.5)], 0.008, TOP2W, grp)
                rbox(f"{tg}_number", (0.05, 0.01, 0.07), (0, -fz(0.43) - 0.003, 0.43), TOP2W, grp, b=0.3)
            elif name == "tank":
                tube(f"{tg}_trim", [tank_pt(prof, 2 * math.pi * k / 28, 1.0, 0.003) for k in range(28)], 0.0055, TOP, grp, cyclic=True, res=1, bev=1)

    # --- bottoms: per-body hip piece + legs (on pivots, shared by every body) with distinct silhouettes
    stitch = sub("bottom2", mat("stitch", (0.85, 0.6, 0.25), rough=0.7))
    LEGS = {
        "jeans": [(0.045, 0.053), (0.12, 0.052), (0.2, 0.055), (0.31, 0.064)],
        "shorts": [(0.19, 0.061), (0.25, 0.061), (0.31, 0.066)],
        "skirt": None,
        "joggers": [(0.062, 0.043), (0.09, 0.052), (0.16, 0.058), (0.31, 0.066)],
        "cargo": [(0.055, 0.057), (0.15, 0.061), (0.31, 0.068)],
        "bootcut": [(0.028, 0.067), (0.09, 0.054), (0.17, 0.05), (0.31, 0.063)],
        "skinny": [(0.05, 0.043), (0.1, 0.046), (0.2, 0.051), (0.31, 0.06)],
        "baggy": [(0.03, 0.069), (0.08, 0.073), (0.2, 0.075), (0.31, 0.077)],
        "leggings": [(0.045, 0.041), (0.1, 0.044), (0.2, 0.049), (0.31, 0.058)],
        "overalls": [(0.05, 0.058), (0.15, 0.059), (0.31, 0.067)],
        "pleated": None,
        "kilt": None,
        "capri": [(0.14, 0.049), (0.2, 0.053), (0.31, 0.062)],
        "flares": [(0.015, 0.088), (0.07, 0.064), (0.16, 0.05), (0.31, 0.062)],
        "harem": [(0.04, 0.043), (0.075, 0.052), (0.15, 0.081), (0.25, 0.084), (0.31, 0.07)],
        "chinos": [(0.04, 0.05), (0.15, 0.054), (0.31, 0.064)],
        "bikeshorts": [(0.2, 0.053), (0.25, 0.056), (0.31, 0.06)],
        "boardshorts": [(0.1, 0.076), (0.2, 0.078), (0.31, 0.079)],
        "cutoffs": [(0.2, 0.06), (0.25, 0.061), (0.31, 0.066)],
        "palazzo": [(0.015, 0.098), (0.1, 0.09), (0.2, 0.077), (0.31, 0.069)],
    }
    for name, legs in LEGS.items():
        manifest["bottom"].append(name)
        pre = f"bottom_{name}"
        grp = empty(pre, (0, 0, 0), root)
        for bn, (sw, d, ww, hw, swa) in FITS.items():
            tg = f"{pre}_B{bn}"
            body = torso_prof(sw, d, ww, hw, t=0.008)
            hip = [(0.235, hw * 0.55, d * 0.55)] + [p for p in body if p[0] <= 0.3] + [prof_at(body, 0.325)]
            lathe(f"{tg}_hip", hip, BOTTOM, grp, seg=24, caps=(True, False))
            if name in ("skirt", "pleated", "kilt"):
                bot = 0.17 if name == "skirt" else 0.2
                sk = [(bot, hw + 0.085, d + 0.075), ((bot + 0.3) / 2, hw + 0.045, d * 0.92 + 0.045), (0.3, hw + 0.014, d * 0.92 + 0.014), prof_at(torso_prof(sw, d, ww, hw, t=0.01), 0.325)]
                wave = (lambda a, z: 1 + 0.06 * abs(math.sin(8 * a)) * (0.33 - z) / 0.16) if name == "skirt" else (lambda a, z: 1 + 0.05 * (abs(((12 * a / math.pi) % 2) - 1) - 0.5) * (0.33 - z) / 0.13)
                lathe(f"{tg}_skirt", sk, BOTTOM, grp, seg=32 if name == "skirt" else 48, wave=wave, caps=(False, False))
                if name == "kilt":
                    for kz, kr in ((0.235, 0.0045), (0.27, 0.0045)):
                        kw, kd = prof_at(sk, kz)[1:3]
                        ring(f"{tg}_plaid{int(kz * 1000)}", 1.0, kr, (0, 0, kz), BOT2I, grp, n=32, scale=(kw + 0.004, kd + 0.004))
                    kw, kd = prof_at(sk, 0.19)[1:3]
                    ring(f"{tg}_hemstripe", 1.0, 0.005, (0, 0, 0.19), BOT2W, grp, n=32, scale=(kw + 0.004, kd + 0.004))
                    ellip(f"{tg}_pin", (0.012, 0.006, 0.02), (hw * 0.8, -(d * 0.92 + 0.045), 0.2), METAL, grp, seg=8, rings=6)
                if name in ("pleated", "kilt"):
                    ring(f"{tg}_band", 1.0, 0.009, (0, 0, 0.31), BOTTOM, grp, n=24, scale=(hw + 0.016, d * 0.92 + 0.016))
            if name == "overalls":
                bib = torso_prof(sw, d, ww, hw, t=0.028, z0=0.28, z1=0.5)
                lathe(f"{tg}_bib", bib, BOTTOM, grp, seg=24, caps=(False, False), drop=lambda c, sw=sw: c.z > 0.34 and (c.y > -0.02 or abs(c.x) > sw * 0.55))
                fy = prof_at(bib, 0.49)[2]
                for side in (-1, 1):
                    tube(f"{tg}_strap{side}", [(side * sw * 0.42, -fy, 0.49), (side * sw * 0.55, -d * 0.6, 0.575), (side * sw * 0.55, d * 0.6, 0.575), (side * sw * 0.45, d + 0.03, 0.43), (side * sw * 0.3, d + 0.02, 0.34)], 0.011, BOTTOM, grp)
                    ellip(f"{tg}_button{side}", (0.011, 0.006, 0.011), (side * sw * 0.42, -fy - 0.006, 0.475), GOLD, grp, seg=10, rings=6)
                rbox(f"{tg}_pocket", (0.07, 0.01, 0.05), (0, -prof_at(bib, 0.42)[2] - 0.003, 0.42), BOTTOM, grp, b=0.3)
            if name in ("jeans", "chinos", "cutoffs", "bikeshorts"):
                bw, bd = prof_at(body, 0.322)[1:3]
                ring(f"{tg}_waistband", 1.0, 0.008, (0, 0, 0.318), BOTTOM, grp, n=24, scale=(bw + 0.008, bd + 0.008))
            if name in ("jeans", "chinos", "cutoffs"):
                yf = prof_at(body, 0.3)[2]
                tube(f"{tg}_fly", [(0, -yf - 0.003, 0.318), (0.014, -yf - 0.003, 0.296), (0.014, -yf - 0.003, 0.262)], 0.0028, stitch, grp)
                ellip(f"{tg}_waistbutton", (0.007, 0.004, 0.007), (0, -prof_at(body, 0.318)[2] - 0.011, 0.318), GOLD if name == "jeans" else METAL, grp, seg=8, rings=4)
                for ang in (0.45, 1.05, 2.09, 2.69):
                    rbox(f"{tg}_loop{int(ang * 100)}", (0.009, 0.006, 0.034), ((bw + 0.012) * math.cos(ang), -(bd + 0.012) * math.sin(ang), 0.31), BOTTOM, grp, b=0.3, seg=1)
                for side in (-1, 1):
                    py = prof_at(body, 0.285)[2]
                    tube(f"{tg}_pk{side}", [(side * 0.03, -py - 0.002, 0.318), (side * 0.07, -py - 0.002, 0.292), (side * 0.072, -py - 0.002, 0.25)], 0.0028, stitch, grp)
                    if name == "jeans":
                        ellip(f"{tg}_rivet{side}", (0.004, 0.003, 0.004), (side * 0.03, -py - 0.004, 0.317), GOLD, grp, seg=5, rings=3)
                        ellip(f"{tg}_rivetb{side}", (0.004, 0.003, 0.004), (side * 0.072, -py - 0.004, 0.25), GOLD, grp, seg=5, rings=3)
                    if name == "chinos":
                        rbox(f"{tg}_welt{side}", (0.05, 0.005, 0.006), (side * 0.06, -prof_at(body, 0.285)[2] - 0.003, 0.29), BOTTOM, grp, b=0.4, rot=(0, 0, -side * 0.5))
        if legs is None:
            continue
        for side, piv in ((-1, hipL), (1, hipR)):
            s = "L" if side < 0 else "R"
            x = side * LEG_X
            fold = None
            if name in ("jeans", "overalls", "cutoffs"):
                fold = lambda a, z: 1 + 0.04 * math.sin(4 * a + 60 * z) * math.exp(-((z - 0.13) ** 2) / 0.001)
            elif name == "baggy":
                fold = lambda a, z: 1 + 0.06 * math.sin(5 * a + 90 * z) * max(0.0, (0.14 - z) / 0.11)
            elif name == "joggers":
                fold = lambda a, z: 1 + 0.04 * math.sin(6 * a + 70 * z) * math.exp(-((z - 0.1) ** 2) / 0.0012)
            lathe(f"{pre}_{s}", legs, BOTTOM, piv, seg=16 if name in ("baggy", "bootcut") else 14, M=T((x, 0, 0)), wave=fold, caps=(False, False))
            end, r0 = legs[0]
            if name in ("jeans", "overalls"):  # rolled hem + outseam stitching
                ring(f"{pre}_cuff{s}", r0 + 0.003, 0.01, (x, 0, end + 0.008), BOTTOM, piv, n=14)
                tube(f"{pre}_seam{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs)], 0.003, stitch, piv)
            elif name == "joggers":  # elastic ankle cuff, side stripe
                ring(f"{pre}_cuff{s}", r0 + 0.001, 0.013, (x, 0, end + 0.006), BOTTOM, piv, n=14)
                tube(f"{pre}_stripe{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs[1:])], 0.005, BOT2W, piv)
            elif name == "cargo":
                ring(f"{pre}_cuff{s}", r0 + 0.002, 0.009, (x, 0, end + 0.005), BOTTOM, piv, n=14)
                rbox(f"{pre}_pocket{s}", (0.02, 0.066, 0.072), (x + side * 0.062, 0, 0.19), BOTTOM, piv, b=0.3)
                rbox(f"{pre}_flap{s}", (0.024, 0.07, 0.018), (x + side * 0.066, 0, 0.228), BOTTOM, piv, b=0.35)
                ellip(f"{pre}_snap{s}", (0.004, 0.007, 0.007), (x + side * 0.079, 0, 0.222), METAL, piv, seg=8, rings=4)
            elif name == "shorts":
                ring(f"{pre}_cuff{s}", r0 + 0.002, 0.009, (x, 0, end + 0.005), BOTTOM, piv, n=14)
            elif name == "bootcut":
                ring(f"{pre}_cuff{s}", r0 + 0.001, 0.006, (x, 0, end + 0.004), BOTTOM, piv, n=16)
                tube(f"{pre}_seam{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs)], 0.003, stitch, piv)
            elif name == "baggy":
                ring(f"{pre}_cuff{s}", r0 + 0.002, 0.008, (x, 0, end + 0.004), BOTTOM, piv, n=16)
            elif name == "capri":
                ring(f"{pre}_cuff{s}", r0 + 0.003, 0.012, (x, 0, end + 0.01), BOTTOM, piv, n=14)
                ring(f"{pre}_cuff2{s}", r0 + 0.004, 0.004, (x, 0, end + 0.026), stitch, piv, n=14)
            elif name == "flares":
                ring(f"{pre}_cuff{s}", r0 + 0.001, 0.007, (x, 0, end + 0.004), BOTTOM, piv, n=18)
                tube(f"{pre}_seam{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs)], 0.003, stitch, piv)
            elif name == "harem":
                ring(f"{pre}_cuff{s}", r0 + 0.002, 0.014, (x, 0, end + 0.008), BOTTOM, piv, n=14)
                ring(f"{pre}_band{s}", legs[1][1] + 0.002, 0.005, (x, 0, 0.19), stitch, piv, n=16)
            elif name == "chinos":
                ring(f"{pre}_cuff{s}", r0 + 0.003, 0.009, (x, 0, end + 0.008), BOTTOM, piv, n=14)
                tube(f"{pre}_crease{s}", [(x, -(r + 0.001), z) for z, r in reversed(legs)], 0.0028, stitch, piv)
            elif name == "bikeshorts":
                tube(f"{pre}_stripe{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs)], 0.006, BOT2W, piv)
                ring(f"{pre}_cuff{s}", r0 + 0.001, 0.006, (x, 0, end + 0.004), BOT2W, piv, n=14)
            elif name == "boardshorts":
                ring(f"{pre}_cuff{s}", r0 + 0.002, 0.009, (x, 0, end + 0.005), BOTTOM, piv, n=16)
                tube(f"{pre}_stripe{s}", [(x + side * (r + 0.002), 0, z) for z, r in reversed(legs)], 0.009, BOT2W, piv)
                rbox(f"{pre}_pocket{s}", (0.016, 0.05, 0.05), (x + side * 0.08, 0, 0.2), BOTTOM, piv, b=0.3)
            elif name == "cutoffs":
                for k in range(8):
                    a = 2 * math.pi * k / 8
                    rbox(f"{pre}_fray{s}{k}", (0.005, 0.005, 0.016), (x + (r0 + 0.003) * math.cos(a), (r0 + 0.003) * math.sin(a), end - 0.004), BOTTOM, piv, b=0.4, seg=1, rot=(0.15 * math.sin(a), -0.15 * math.cos(a), 0))
                tube(f"{pre}_seam{s}", [(x + side * (r + 0.001), 0, z) for z, r in reversed(legs)], 0.003, stitch, piv)
            elif name == "palazzo":
                ring(f"{pre}_cuff{s}", r0 + 0.001, 0.006, (x, 0, end + 0.004), BOTTOM, piv, n=20)
                tube(f"{pre}_pleat{s}", [(x, -(r + 0.001), z) for z, r in reversed(legs)], 0.003, stitch, piv)

    # --- shoes (on leg pivots): rounded lofted soles and uppers; `shoe` main colour, `shoe2` sole/laces/accent
    def foot(W, L, n=20):
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n
            c, s_ = math.cos(a), math.sin(a)
            pts.append((W / 2 * sgnpow(c, 0.75) * (0.84 if s_ > 0 else 1.0), L / 2 * sgnpow(s_, 0.85)))
        return pts

    FY = -0.02  # foot centre (front = -Y)

    def sole(name, x, W, L, h, material, piv):
        loft(name, foot(W, L), [(0, 0.9), (0.005, 1.0), (h - 0.004, 1.0), (h, 0.95)], material, piv, M=T((x, FY, 0)))

    def upper(name, x, W, L, z0, hgt, material, piv, back=0.028, puff=1.0):
        loft(name, foot(W, L), [(z0, 1.0), (z0 + hgt * 0.4, 0.98 * puff), (z0 + hgt * 0.75, 0.84 * puff, 0, 0.012), (z0 + hgt, 0.5, 0, back)], material, piv, M=T((x, FY, 0)), caps=(False, True))

    def heel(name, x, W, L, z0, hgt, material, piv):
        """Heel counter: closes the back of the upper so no foot or ankle shows through behind the heel."""
        ellip(name, (W * 0.4, 0.034, hgt * 0.8), (x, FY + L * 0.34, z0 + hgt * 0.62), material, piv, seg=12, rings=8)

    def laces(name, x, z0, hgt, n, material, piv):
        for k in range(n):
            y = -0.05 + k * 0.014
            z = z0 + hgt * (0.5 + 0.12 * k)
            tube(f"{name}{k}", [(x - 0.016, y, z - 0.004), (x, y - 0.004, z + 0.002), (x + 0.016, y, z - 0.004)], 0.0035, material, piv, res=2)

    shoes = ["sneakers", "boots", "sandals", "hightops", "loafers", "clogs", "slippers"]
    for name in shoes:
        manifest["shoes"].append(name)
        pre = f"shoes_{name}"
        grp = empty(pre, (0, 0, 0), root)
        for side, piv in ((-1, hipL), (1, hipR)):
            s = "L" if side < 0 else "R"
            x = side * LEG_X
            if name == "sandals":
                sole(f"{pre}_sole{s}", x, 0.074, 0.15, 0.018, SHOE, piv)
                ellip(f"{pre}_foot{s}", (0.03, 0.06, 0.022), (x, FY - 0.005, 0.03), SKIN, piv, seg=14, rings=8)
                tube(f"{pre}_strap{s}", [(x - 0.032, -0.05, 0.02), (x, -0.058, 0.052), (x + 0.032, -0.05, 0.02)], 0.008, SHOE2, piv)
                tube(f"{pre}_strapb{s}", [(x - 0.032, 0.012, 0.02), (x, 0.004, 0.06), (x + 0.032, 0.012, 0.02)], 0.008, SHOE2, piv)
                continue
            if name == "sneakers":
                sole(f"{pre}_sole{s}", x, 0.08, 0.155, 0.022, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.072, 0.145, 0.02, 0.052, SHOE, piv)
                laces(f"{pre}_lace{s}", x, 0.02, 0.052, 3, SHOE2, piv)
                heel(f"{pre}_heel{s}", x, 0.072, 0.145, 0.02, 0.052, SHOE, piv)
                tube(f"{pre}_stripe{s}", [(x + side * 0.037, 0.03, 0.034), (x + side * 0.039, -0.02, 0.03), (x + side * 0.035, -0.055, 0.044)], 0.0045, SHOE2, piv, radii=[0.4, 1, 0.5])
                ring(f"{pre}_collar{s}", 0.038, 0.007, (x, 0.006, 0.07), SHOE, piv, n=12, minor=5)
            elif name == "hightops":
                sole(f"{pre}_sole{s}", x, 0.08, 0.155, 0.024, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.072, 0.145, 0.022, 0.05, SHOE, piv)
                lathe(f"{pre}_shaft{s}", [(0.05, 0.039), (0.085, 0.039), (0.112, 0.039)], SHOE, piv, seg=14, M=T((x, 0.002, 0)), caps=(False, False))
                ring(f"{pre}_collar{s}", 0.039, 0.0035, (x, 0.002, 0.112), SHOE2, piv, n=14)
                ellip(f"{pre}_cap{s}", (0.033, 0.03, 0.02), (x, -0.08, 0.03), SHOE2, piv, seg=12, rings=8, keep=lambda c: c.z > -0.3)
                laces(f"{pre}_lace{s}", x, 0.022, 0.05, 3, SHOE2, piv)
                heel(f"{pre}_heel{s}", x, 0.072, 0.145, 0.022, 0.05, SHOE, piv)
            elif name == "boots":
                sole(f"{pre}_sole{s}", x, 0.084, 0.16, 0.032, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.076, 0.15, 0.03, 0.05, SHOE, piv)
                lathe(f"{pre}_shaft{s}", [(0.055, 0.039), (0.08, 0.039), (0.105, 0.039)], SHOE, piv, seg=14, M=T((x, 0.002, 0)), caps=(False, False))
                ring(f"{pre}_fold{s}", 0.039, 0.0035, (x, 0.002, 0.105), SHOE2, piv, n=14)
                laces(f"{pre}_lace{s}", x, 0.03, 0.05, 3, SHOE2, piv)
                heel(f"{pre}_heel{s}", x, 0.076, 0.15, 0.03, 0.05, SHOE, piv)
            elif name == "loafers":
                sole(f"{pre}_sole{s}", x, 0.076, 0.152, 0.014, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.07, 0.144, 0.012, 0.038, SHOE, piv, back=0.022)
                tube(f"{pre}_strap{s}", [(x - 0.03, -0.045, 0.034), (x, -0.052, 0.046), (x + 0.03, -0.045, 0.034)], 0.005, SHOE2, piv)
                ring(f"{pre}_collar{s}", 0.037, 0.006, (x, 0.008, 0.048), SHOE, piv, n=12, minor=5)
                heel(f"{pre}_heel{s}", x, 0.07, 0.144, 0.012, 0.038, SHOE, piv)
            elif name == "clogs":
                sole(f"{pre}_sole{s}", x, 0.088, 0.16, 0.03, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.084, 0.152, 0.028, 0.058, SHOE, piv, puff=1.03)
                heel(f"{pre}_heel{s}", x, 0.084, 0.152, 0.028, 0.058, SHOE, piv)
                for k, (dx, dy) in enumerate(((-0.018, -0.06), (0.0, -0.066), (0.018, -0.06), (-0.01, -0.045), (0.01, -0.045))):
                    ellip(f"{pre}_hole{s}{k}", (0.006, 0.006, 0.003), (x + dx, dy, 0.069 + 0.06 * (dy + 0.06)), INK, piv, seg=8, rings=4, rot=(-0.4, 0, 0))
                tube(f"{pre}_strap{s}", [(x - 0.042, 0.0, 0.05), (x - 0.03, 0.05, 0.04), (x + 0.03, 0.05, 0.04), (x + 0.042, 0.0, 0.05)], 0.006, SHOE2, piv)
            elif name == "slippers":
                sole(f"{pre}_sole{s}", x, 0.09, 0.16, 0.014, SHOE2, piv)
                upper(f"{pre}_upper{s}", x, 0.088, 0.156, 0.012, 0.062, SHOE, piv, puff=1.04)
                for e in (-1, 1):
                    ellip(f"{pre}_ear{s}{e}", (0.012, 0.008, 0.036), (x + e * 0.018, -0.045, 0.1), SHOE, piv, seg=10, rings=6, rot=(0.35, e * 0.25, 0))
                    ellip(f"{pre}_eye{s}{e}", (0.006, 0.004, 0.006), (x + e * 0.014, -0.083, 0.055), INK, piv, seg=8, rings=4)
                ellip(f"{pre}_nose{s}", (0.007, 0.005, 0.006), (x, -0.092, 0.045), TONGUE, piv, seg=8, rings=4)
                ring(f"{pre}_collar{s}", 0.038, 0.009, (x, 0.006, 0.072), SHOE2, piv, n=12, minor=5)

    # --- hats (`hat` colour; fixed trims)
    hz = HEAD_C.z

    def disc(name, r0, r1, z, material, grp, lift=lambda a, r: 0.0, seg=24, rings=3, thick=0.01, cy=0.01):
        """Annular brim; r1 may be a function of angle; lift(a, r) bends it (cowboy curl, tricorn)."""
        bm = bmesh.new()
        rows = []
        for j in range(rings + 1):
            row = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                rr = r0 + ((r1(a) if callable(r1) else r1) - r0) * j / rings
                row.append(bm.verts.new((rr * math.cos(a), cy + rr * math.sin(a), z + lift(a, rr))))
            rows.append(row)
        for j in range(rings):
            for i in range(seg):
                k = (i + 1) % seg
                bm.faces.new((rows[j][i], rows[j][k], rows[j + 1][k], rows[j + 1][i]))
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thick)
        return from_bm(name, bm, material, grp)

    def cap(pre, grp, back=False):
        sy = -1 if back else 1
        ellip(f"{pre}_dome", (0.252, 0.242, 0.205), (0, 0.012, hz + 0.065), HAT, grp, seg=28, rings=16, keep=lambda c: c.z > -0.1)
        for k in range(6):
            a = k * math.pi / 3
            tube(f"{pre}_seam{k}", [(math.cos(a) * 0.251, 0.012 + math.sin(a) * 0.241, hz + 0.065 - 0.018), (math.cos(a) * 0.196, 0.012 + math.sin(a) * 0.186, hz + 0.21), (0, 0.012, hz + 0.27)], 0.0035, HAT, grp)
        ellip(f"{pre}_button", (0.018, 0.018, 0.01), (0, 0.012, hz + 0.27), HAT, grp, seg=10, rings=6)
        brim = bmesh.new()
        bmesh.ops.create_uvsphere(brim, u_segments=24, v_segments=8, radius=1.0)
        for v in brim.verts:
            v.co = Vector((v.co.x * 0.21, -0.22 + v.co.y * 0.16 - 0.02 * v.co.x ** 2, hz + 0.05 + v.co.z * 0.01 - 0.03 * v.co.x ** 2 - 0.02 * (-v.co.y)))
        bmesh.ops.delete(brim, geom=[v for v in brim.verts if v.co.y > -0.13], context="VERTS")
        if back:
            for v in brim.verts:
                v.co.y = 0.024 - v.co.y
                v.co.z += 0.02
            bmesh.ops.reverse_faces(brim, faces=brim.faces[:])
            ring(f"{pre}_strap", 0.03, 0.006, (0, 0.235, hz + 0.08), HAT, grp, rot=(math.pi / 2, 0, 0), n=12, minor=4)
        from_bm(f"{pre}_brim", brim, HAT, grp)

    hats = ["none", "cap", "beanie", "bucket", "tuque", "crown", "backCap", "cowboy", "topHat", "party", "chef", "viking",
            "pirate", "hardHat", "propeller", "catEars", "sombrero", "wizard", "beret", "headband"]
    for name in hats:
        manifest["hat"].append(name)
        pre = f"hat_{name}"
        grp = empty(pre, (0, 0, 0), head)
        if name == "cap":
            cap(pre, grp)
        elif name == "backCap":
            cap(pre, grp, back=True)
        elif name == "beanie":
            ellip(f"{pre}_dome", (0.245, 0.235, 0.22), (0, 0.01, hz + 0.045), HAT, grp, seg=28, rings=16, keep=lambda c: c.z > -0.15, deform=lambda c: c * (1 + 0.012 * math.cos(24 * math.atan2(c.y, c.x))))
            lathe(f"{pre}_fold", [(hz - 0.0, 0.25, 0.24), (hz + 0.06, 0.252, 0.242)], HAT, grp, seg=24, M=T((0, 0.01, 0)), wave=lambda a, z: 1 + 0.02 * math.cos(24 * a), caps=(False, False))
            ellip(f"{pre}_pompom", (0.05, 0.05, 0.045), (0, 0.01, hz + 0.27), HAT2W, grp, seg=14, rings=10, deform=lambda c: c * (1 + 0.1 * math.sin(7 * math.atan2(c.y, c.x)) * math.sin(6 * c.z)))
        elif name == "bucket":
            lathe(f"{pre}_crown", [(hz + 0.04, 0.222), (hz + 0.15, 0.21), (hz + 0.215, 0.19), (hz + 0.24, 0.15), (hz + 0.248, 0.0)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            lathe(f"{pre}_brim", [(hz - 0.02, 0.32), (hz + 0.02, 0.27), (hz + 0.045, 0.215)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            ring(f"{pre}_band", 0.214, 0.012, (0, 0.01, hz + 0.065), HAT2I, grp, n=24)
        elif name == "tuque":
            pts = [(-0.02, 0.232), (0.07, 0.215), (0.16, 0.16), (0.25, 0.085), (0.31, 0.0)]
            tilt = T((0, 0.015, hz + 0.07)) @ R((-0.3, 0, 0))
            lathe(f"{pre}_cone", pts, HAT, grp, seg=28, M=tilt, wave=lambda a, z: 1 + 0.015 * math.cos(20 * a), caps=(False, False))
            lathe(f"{pre}_rim", [(hz + 0.03, 0.238), (hz + 0.05, 0.25), (hz + 0.09, 0.246), (hz + 0.11, 0.232)], HAT2W, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            tip = tilt @ Vector((0, 0, 0.32))
            ellip(f"{pre}_pompom", (0.055, 0.055, 0.05), tip, HAT2W, grp, seg=14, rings=10, deform=lambda c: c * (1 + 0.1 * math.sin(7 * math.atan2(c.y, c.x)) * math.sin(6 * c.z)))
        elif name == "crown":
            lathe(f"{pre}_band", [(hz + 0.15, 0.15), (hz + 0.2, 0.155)], GOLD, grp, seg=28, caps=(False, False))
            for j in range(5):
                a = j / 5 * 2 * math.pi
                c = Vector((math.sin(a) * 0.152, math.cos(a) * 0.152, hz + 0.2))
                lathe(f"{pre}_spike{j}", [(0, 0.03), (0.05, 0.012), (0.07, 0.0)], GOLD, grp, seg=8, M=T(c), caps=(False, False))
                ellip(f"{pre}_tip{j}", (0.012,) * 3, c + Vector((0, 0, 0.074)), GOLD, grp, seg=8, rings=6)
                ellip(f"{pre}_gem{j}", (0.016, 0.008, 0.016), (math.sin(a + 0.63) * 0.157, math.cos(a + 0.63) * 0.157, hz + 0.175), HAT, grp, seg=8, rings=6, rot=(0, 0, -(a + 0.63)))
        elif name == "cowboy":
            lathe(f"{pre}_crown", [(hz + 0.04, 0.222, 0.212), (hz + 0.15, 0.205, 0.195), (hz + 0.22, 0.19, 0.18), (hz + 0.245, 0.15, 0.14), (hz + 0.25, 0.0)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False),
                  wave=lambda a, z: 1 - 0.12 * max(0.0, math.cos(a - math.pi / 2)) ** 6 * max(0.0, (z - hz - 0.15) / 0.1))
            disc(f"{pre}_brim", 0.215, 0.38, hz + 0.05, HAT, grp, lift=lambda a, r: 0.6 * (r - 0.215) ** 2 * (1 + 5 * math.cos(a) ** 2) - 0.02 * max(0.0, -math.sin(a)) * (r - 0.215) / 0.16, seg=28, rings=3)
            ring(f"{pre}_band", 1.0, 0.012, (0, 0.01, hz + 0.065), HAT2I, grp, n=24, scale=(0.222, 0.212))
        elif name == "topHat":
            disc(f"{pre}_brim", 0.205, 0.3, hz + 0.08, HAT, grp, lift=lambda a, r: 0.5 * (r - 0.205) ** 2 * (1 + 3 * math.cos(a) ** 2), seg=24, rings=2)
            lathe(f"{pre}_tube", [(hz + 0.05, 0.2), (hz + 0.2, 0.185), (hz + 0.36, 0.2), (hz + 0.37, 0.0)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            lathe(f"{pre}_band", [(hz + 0.09, 0.2), (hz + 0.14, 0.192)], HAT2A, grp, seg=24, M=T((0, 0.01, 0)), wave=lambda a, z: 1.03, caps=(False, False))
        elif name == "party":
            tilt = T((0.03, 0.0, hz + 0.16)) @ R((0, 0.2, 0))
            lathe(f"{pre}_cone", [(0, 0.11), (0.24, 0.0)], HAT, grp, seg=24, M=tilt, caps=(True, False))
            for k in range(7):
                h = 0.04 + 0.025 * (k % 3) + 0.03 * (k // 3)
                a = k * 2.3
                rr = 0.11 * (1 - h / 0.24) + 0.002
                ellip(f"{pre}_dot{k}", (0.012, 0.012, 0.012), tilt @ Vector((rr * math.cos(a), rr * math.sin(a), h)), HAT2W, grp, seg=8, rings=4)
            ellip(f"{pre}_pompom", (0.032,) * 3, tilt @ Vector((0, 0, 0.245)), HAT2A, grp, seg=12, rings=8, deform=lambda c: c * (1 + 0.12 * math.sin(7 * math.atan2(c.y, c.x)) * math.sin(6 * c.z)))
            tube(f"{pre}_elastic", [(-0.08, 0.0, hz + 0.16), (-0.2, -0.04, hz - 0.03), (-0.1, -0.13, hz - 0.18), (0.0, -0.15, hz - 0.2), (0.1, -0.13, hz - 0.18), (0.2, -0.04, hz - 0.03), (0.13, 0.0, hz + 0.15)], 0.0025, HAT2I, grp, res=2)
        elif name == "chef":
            lathe(f"{pre}_band", [(hz + 0.03, 0.226, 0.216), (hz + 0.13, 0.232, 0.222)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False), wave=lambda a, z: 1 + 0.01 * math.cos(16 * a))
            ellip(f"{pre}_puff", (0.27, 0.26, 0.15), (0, 0.01, hz + 0.24), HAT, grp, seg=28, rings=14, deform=lambda c: c * (1 + 0.07 * max(0.0, c.z + 0.3) * math.sin(6 * math.atan2(c.y, c.x))))
        elif name == "viking":
            ellip(f"{pre}_dome", (0.238, 0.23, 0.215), (0, 0.01, hz + 0.04), HAT, grp, seg=28, rings=14, keep=lambda c: c.z > -0.05)
            ring(f"{pre}_band", 1.0, 0.016, (0, 0.01, hz + 0.035), GOLD, grp, n=24, scale=(0.238, 0.23))
            tube(f"{pre}_ridge", [(0, -0.22, hz + 0.06), (0, -0.16, hz + 0.19), (0, 0.01, hz + 0.26), (0, 0.18, hz + 0.18), (0, 0.24, hz + 0.05)], 0.012, GOLD, grp)
            for side in (-1, 1):
                tube(f"{pre}_horn{side}", [(side * 0.2, 0.0, hz + 0.1), (side * 0.29, -0.01, hz + 0.15), (side * 0.33, -0.03, hz + 0.26), (side * 0.3, -0.05, hz + 0.34)], 0.038, HAT2H, grp, radii=[1.0, 0.8, 0.45, 0.06], res=4, bev=2)
        elif name == "pirate":
            lathe(f"{pre}_crown", [(hz + 0.04, 0.226, 0.216), (hz + 0.16, 0.21, 0.2), (hz + 0.225, 0.18, 0.17), (hz + 0.25, 0.0)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            disc(f"{pre}_brim", 0.215, 0.33, hz + 0.06, HAT, grp, lift=lambda a, r: ((r - 0.215) / 0.115) ** 1.2 * 0.09 * (1 - 0.85 * max(0.0, math.cos(3 * (a + math.pi / 2)))), seg=28, rings=3)
            ellip(f"{pre}_skull", (0.03, 0.01, 0.028), (0, -0.215, hz + 0.13), HAT2W, grp, seg=12, rings=8, rot=(0.3, 0, 0))
            for side in (-1, 1):
                tube(f"{pre}_bone{side}", [(-side * 0.04, -0.21, hz + 0.09), (side * 0.04, -0.215, hz + 0.16)], 0.006, HAT2W, grp, res=2)
        elif name == "hardHat":
            lathe(f"{pre}_dome", [(hz + 0.03, 0.24, 0.23), (hz + 0.12, 0.232, 0.222), (hz + 0.2, 0.185, 0.175), (hz + 0.25, 0.1, 0.095), (hz + 0.265, 0.0)], HAT, grp, seg=28, M=T((0, 0.01, 0)), caps=(False, False))
            tube(f"{pre}_ridge", [(0, -0.21, hz + 0.1), (0, -0.14, hz + 0.23), (0, 0.01, hz + 0.28), (0, 0.16, hz + 0.23), (0, 0.23, hz + 0.1)], 0.018, HAT, grp)
            disc(f"{pre}_brim", 0.235, lambda a: 0.27 + 0.06 * max(0.0, -math.sin(a)) ** 2, hz + 0.03, HAT, grp, lift=lambda a, r: -0.15 * (r - 0.235), seg=24, rings=2)
        elif name == "propeller":
            lathe(f"{pre}_dome", [(hz + 0.04, 0.238, 0.228), (hz + 0.15, 0.205, 0.195), (hz + 0.22, 0.125, 0.12), (hz + 0.25, 0.0)], HAT, grp, seg=28, M=T((0, 0.01, 0)), caps=(False, False))
            for k in range(4):
                a = k * math.pi / 2 + math.pi / 4
                tube(f"{pre}_seam{k}", [(math.cos(a) * 0.236, 0.01 + math.sin(a) * 0.226, hz + 0.045), (math.cos(a) * 0.2, 0.01 + math.sin(a) * 0.19, hz + 0.155), (0, 0.01, hz + 0.25)], 0.005, HAT2A, grp, res=2)
            tube(f"{pre}_stalk", [(0, 0.01, hz + 0.24), (0, 0.01, hz + 0.3)], 0.008, METAL, grp, res=2)
            ellip(f"{pre}_hub", (0.016, 0.016, 0.012), (0, 0.01, hz + 0.305), HAT2A, grp, seg=10, rings=6)
            for k, m_ in enumerate((HAT2A, HAT2W)):
                rbox(f"{pre}_blade{k}", (0.32, 0.045, 0.008), (0, 0.01, hz + 0.305), m_, grp, b=0.45, rot=(0.15 * (-1) ** k, 0, 0.5 + k * math.pi / 2))
        elif name == "catEars":
            tube(f"{pre}_band", [(-0.205, 0.0, hz - 0.01), (-0.17, -0.01, hz + 0.15), (0, -0.01, hz + 0.235), (0.17, -0.01, hz + 0.15), (0.205, 0.0, hz - 0.01)], 0.01, HAT, grp)
            ear = [(-0.055, 0.0), (0.055, 0.0), (0.03, 0.05), (0.008, 0.085), (-0.008, 0.085), (-0.03, 0.05)]
            for side in (-1, 1):
                M = T((side * 0.12, -0.01, hz + 0.175)) @ R((0, side * 0.45, 0)) @ R((math.pi / 2, 0, 0))
                loft(f"{pre}_ear{side}", ear, [(-0.012, 1.0), (0.012, 1.0)], HAT, grp, M=M)
                loft(f"{pre}_inner{side}", ear, [(0.012, 0.62, 0, 0.012), (0.016, 0.55, 0, 0.014)], TONGUE, grp, M=M)
        elif name == "sombrero":
            lathe(f"{pre}_crown", [(hz + 0.05, 0.21), (hz + 0.2, 0.18), (hz + 0.3, 0.13), (hz + 0.335, 0.07), (hz + 0.345, 0.0)], HAT, grp, seg=24, M=T((0, 0.01, 0)), caps=(False, False))
            disc(f"{pre}_brim", 0.205, 0.47, hz + 0.06, HAT, grp, lift=lambda a, r: 0.9 * max(0.0, r - 0.3) ** 2 - 0.15 * (r - 0.205) * (1 - min(1.0, (r - 0.205) / 0.1)), seg=24, rings=3)
            ring(f"{pre}_rim", 0.47, 0.018, (0, 0.01, hz + 0.06 + 0.9 * 0.17 ** 2 + 0.01), HAT, grp, n=24, minor=5)
            lathe(f"{pre}_band", [(hz + 0.1, 0.205), (hz + 0.16, 0.19)], HAT2A, grp, seg=24, M=T((0, 0.01, 0)), wave=lambda a, z: 1.025, caps=(False, False))
            ring(f"{pre}_trim", 0.34, 0.01, (0, 0.01, hz + 0.06 + 0.9 * 0.04 ** 2 + 0.012), HAT2A, grp, n=24, minor=4)
        elif name == "wizard":
            disc(f"{pre}_brim", 0.17, 0.36, hz + 0.06, HAT, grp, lift=lambda a, r: -0.25 * max(0.0, r - 0.205) ** 1.5, seg=24, rings=3)
            tube(f"{pre}_cone", [(0, 0.01, hz + 0.05), (0, 0.02, hz + 0.27), (0.03, 0.07, hz + 0.45), (0.12, 0.15, hz + 0.53)], 0.218, HAT, grp, radii=[1.0, 0.72, 0.28, 0.02], res=5, bev=4)
            ring(f"{pre}_band", 0.2, 0.012, (0, 0.012, hz + 0.08), HAT2A, grp, n=28, minor=5)
            for k, (az, h) in enumerate(((0.3, 0.17), (-0.7, 0.26), (1.4, 0.32), (-0.2, 0.36))):
                rr = 0.205 * (1 - (h - 0.05) / 0.3) * 0.95 + 0.012
                star = [((0.022 if j % 2 == 0 else 0.009) * math.cos(math.pi / 2 + j * math.pi / 5), (0.022 if j % 2 == 0 else 0.009) * math.sin(math.pi / 2 + j * math.pi / 5)) for j in range(10)]
                ang = -math.pi / 2 + az
                loft(f"{pre}_star{k}", star, [(-0.003, 1.0), (0.003, 1.0)], GOLD, grp, M=T((rr * math.cos(ang), 0.015 + rr * math.sin(ang), hz + h)) @ R((0, 0, az)) @ R((math.pi / 2, 0, 0)))
        elif name == "beret":
            ellip(f"{pre}_body", (0.25, 0.245, 0.075), (0.035, 0.02, hz + 0.16), HAT, grp, seg=28, rings=12, rot=(0, 0.28, 0))
            lathe(f"{pre}_band", [(hz + 0.1, 0.218, 0.206), (hz + 0.13, 0.215, 0.203)], HAT, grp, seg=28, M=T((0, 0.01, 0)), caps=(False, False))
            tube(f"{pre}_nub", [(0.06, 0.02, hz + 0.23), (0.07, 0.02, hz + 0.26)], 0.008, HAT, grp, res=2)
        elif name == "headband":
            lathe(f"{pre}_band", [(hz + 0.035, 0.228, 0.214), (hz + 0.06, 0.232, 0.218), (hz + 0.085, 0.228, 0.214)], HAT, grp, seg=28, M=T((0, 0.012, 0)), caps=(False, False))
            ring(f"{pre}_stripe", 1.0, 0.006, (0, 0.012, hz + 0.06), HAT2W, grp, n=36, minor=4, scale=(0.233, 0.219))

    # --- glasses (`frame` colour; `lens_*` lenses follow the optional lens colour): lens shape always matches its rim, except the boxed joke pair
    gz = EYE_Z
    GO = 0.022  # how far in front of the face the frame sits

    def gM(side, dx=0.0, dz=0.0, out=GO):
        """Frame space at one eye: u along x (outer side positive after mirroring), v up, w out of the face."""
        p, r = surf(side * EYE_X + dx, gz + dz, out)
        return T(p) @ R((0, 0, r[2])) @ R((math.pi / 2, 0, 0))

    def mirror(pts, side):
        out = [(u * side, v) for u, v in pts]
        return out if side > 0 else out[::-1]

    def rim(name, pts, M, r, material, grp):
        tube(name, [M @ Vector((u, v, 0)) for u, v in pts], r, material, grp, cyclic=True, res=1)

    def lens(name, pts, M, material, grp, k=0.97, thick=0.004):
        loft(name, [(u * k, v * k) for u, v in pts], [(-thick / 2, 1.0), (thick / 2, 1.0)], material, grp, M=M)

    def temples(pre, grp, side, M, edge, r=0.005, material=FRAME):
        tube(f"{pre}_arm{side}", [M @ Vector((side * edge, 0, 0)), Vector((side * 0.2, -0.06, HEAD_C.z + gz + 0.005)), Vector((side * 0.205, 0.04, HEAD_C.z + gz - 0.01))], r, material, grp, res=2)

    def bridge(pre, grp, r=0.005, material=FRAME, lift=0.016, half=0.026):
        tube(f"{pre}_bridge", [face_pt(-half, gz + lift * 0.5, GO), face_pt(0, gz + lift, GO + 0.004), face_pt(half, gz + lift * 0.5, GO)], r, material, grp, res=2)

    def heart(s, n=24):
        pts = [(16 * math.sin(t) ** 3, 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)) for t in [2 * math.pi * k / n for k in range(n)]]
        return [(x * s / 16, (y + 2) * s / 16) for x, y in pts][::-1]

    def star5(ro, ri):
        return [((ro if j % 2 == 0 else ri) * math.cos(math.pi / 2 + j * math.pi / 5), (ro if j % 2 == 0 else ri) * math.sin(math.pi / 2 + j * math.pi / 5)) for j in range(10)]

    def aviator(w, h):
        return [(u + 0.22 * w * max(0.0, -v / h) * (1 if u > 0 else 0.4), v * (1.3 if v < 0 else 1.0)) for u, v in superellipse(w, h, 2.3, 22)]

    def cat_eye(w, h):
        return [(u, v + 0.55 * h * max(0.0, u / w) ** 2 * (1 if v > 0 else 0.3)) for u, v in superellipse(w, h, 2.6, 22)]

    glasses = ["none", "round", "square", "shades", "visor", "boxed", "wire", "aviator", "slim", "cyber", "heart", "star",
               "paper3d", "monocle", "nerd", "goggles", "pixel", "steampunk", "catEye"]
    for name in glasses:
        manifest["glasses"].append(name)
        pre = f"glasses_{name}"
        grp = empty(pre, (0, 0, 0), head)
        if name == "none":
            continue
        if name == "visor":
            lathe(f"{pre}_band", [(gz - 0.03, 0.222, 0.21), (gz + 0.035, 0.222, 0.21)], LENS, grp, seg=24, M=T(HEAD_C), caps=(False, False))
            continue
        if name in ("cyber", "goggles"):
            lo, hi, rx, ry, m_ = (-0.024, 0.024, 0.226, 0.214, NEON) if name == "cyber" else (-0.052, 0.05, 0.236, 0.224, MIRROR)
            # cyber: a visor band around the front; goggles: a curved shield over the eyes only, with a frame and a nose bridge
            front = (lambda c: c.y > -0.1) if name == "cyber" else (lambda c: not (c.y < -0.08 and abs(c.x) < 0.152))
            lathe(f"{pre}_lens", [(gz + lo, rx, ry), (gz + (lo + hi) / 2, rx + 0.006, ry + 0.006), (gz + hi, rx, ry)], m_, grp, seg=28, M=T(HEAD_C), caps=(False, False), drop=front)
            for z in (lo, hi):
                lathe(f"{pre}_edge{int(z * 1000)}", [(gz + z - 0.005, rx + 0.004, ry + 0.004), (gz + z + 0.005, rx + 0.004, ry + 0.004)], FRAME, grp, seg=28, M=T(HEAD_C), caps=(False, False), drop=front)
            lathe(f"{pre}_strap", [(gz - 0.012, 0.218, 0.206), (gz + 0.012, 0.218, 0.206)], FRAME if name == "cyber" else INK, grp, seg=24, M=T(HEAD_C), caps=(False, False))
            if name == "goggles":
                for sx in (-1, 1):
                    rbox(f"{pre}_end{sx}", (0.012, 0.03, hi - lo + 0.012), HEAD_C + Vector((sx * 0.152, -0.172, gz + (lo + hi) / 2)), FRAME, grp, b=0.4, rot=(0, 0, sx * 0.62))
                rbox(f"{pre}_bridge", (0.016, 0.014, hi - lo + 0.01), HEAD_C + Vector((0, -0.239, gz + (lo + hi) / 2)), FRAME, grp, b=0.4)
            continue
        if name == "pixel":
            # blocky 8-bit shades: one bar and a staircase of square pixels per eye, all in one mesh
            bm = bmesh.new()
            px = 0.026
            cells = [(c + 0.5, 0) for c in range(-6, 6)]
            for side in (-1, 1):
                for row, cols in ((1, range(0, 4)), (2, range(0, 4)), (3, range(1, 3))):
                    cells += [(side * (1.5 + c), -row) for c in cols]
            for cx, cz in cells:
                g = bmesh.ops.create_cube(bm, size=px)
                bmesh.ops.transform(bm, matrix=T(face_pt(cx * px, gz + 0.03 + cz * px, GO + 0.006)), verts=g["verts"])
            from_bm(f"{pre}_pixels", bm, FRAME, grp, smooth=False)
            glint = bmesh.new()
            for side in (-1, 1):
                for cx, cz in ((side * 3.5, -1), (side * 2.5, -2)):
                    g = bmesh.ops.create_cube(glint, size=px * 0.62)
                    bmesh.ops.transform(glint, matrix=T(face_pt(cx * px, gz + 0.03 + cz * px, GO + 0.006 + px * 0.5)), verts=g["verts"])
            from_bm(f"{pre}_glint", glint, WHITE, grp, smooth=False)
            for side in (-1, 1):
                temples(pre, grp, side, gM(side, dz=0.022), 0.06, r=0.004)
            continue
        for side in (-1, 1):
            M = gM(side)
            if name == "monocle":
                if side < 0:
                    continue
                pts = superellipse(0.043, 0.043, 2.0, 20)
                rim(f"{pre}_rim", pts, M, 0.0055, GOLD, grp)
                lens(f"{pre}_lens", pts, M, CLEAR, grp)
                tube(f"{pre}_chain", [M @ Vector((0, -0.043, 0)), face_pt(0.1, -0.11, 0.03), face_pt(0.13, -0.17, 0.03), face_pt(0.17, -0.2, 0.0)], 0.0025, GOLD, grp, res=2)
                continue
            if name == "round":
                pts, r_, lm, edge = superellipse(0.045, 0.045, 2.0, 20), 0.0055, CLEAR, 0.045
            elif name == "wire":
                pts, r_, lm, edge = superellipse(0.04, 0.04, 2.0, 20), 0.0032, CLEAR, 0.04
            elif name == "square":
                pts, r_, lm, edge = superellipse(0.05, 0.038, 5.0, 20), 0.0055, CLEAR, 0.05
            elif name == "shades":
                pts, r_, lm, edge = superellipse(0.054, 0.04, 5.0, 24), 0.0065, LENS, 0.054
            elif name == "boxed":
                # the original shades, kept as a joke: square frame, round lens
                c = face_pt(side * EYE_X, gz, GO)
                w, h = 0.054, 0.04
                pts = [c + Vector((w * sgnpow(math.cos(t), 0.4), 0, h * sgnpow(math.sin(t), 0.4))) for t in [k * math.pi / 8 for k in range(16)]]
                tube(f"{pre}_rim{side}", pts, 0.0065, FRAME, grp, cyclic=True, res=2)
                ellip(f"{pre}_lens{side}", (w * 0.98, 0.006, h * 0.98), c, LENS, grp, seg=12, rings=6)
                temples(pre, grp, side, T(c), 0.045)
                continue
            elif name == "aviator":
                pts, r_, lm, edge = mirror(aviator(0.046, 0.036), side), 0.0035, TINT, 0.046
            elif name == "slim":
                M = gM(side, dz=0.004) @ R((0, 0, 0))
                pts, r_, lm, edge = mirror([(u, v - 0.12 * u) for u, v in superellipse(0.047, 0.017, 3.0, 20)], side), 0.003, LENS, 0.047
            elif name == "heart":
                pts, r_, lm, edge = heart(0.05), 0.005, PINK, 0.05
            elif name == "star":
                pts, r_, lm, edge = star5(0.056, 0.026), 0.0045, AMBER, 0.05
            elif name == "paper3d":
                pts, r_, lm, edge = superellipse(0.05, 0.034, 8.0, 20), 0.0065, RED3D if side < 0 else BLUE3D, 0.05
            elif name == "nerd":
                pts, r_, lm, edge = superellipse(0.052, 0.042, 4.0, 20), 0.009, CLEAR, 0.052
            elif name == "steampunk":
                Mg = gM(side, out=0.006)
                lathe(f"{pre}_tube{side}", [(0.0, 0.041), (0.026, 0.041), (0.026, 0.033)], METAL, grp, seg=18, M=Mg, caps=(False, False))
                ring(f"{pre}_bezel{side}", 0.041, 0.006, (0, 0, 0), GOLD, grp, n=18, minor=5)
                bpy.data.objects[f"{pre}_bezel{side}"].data.transform(Mg @ T((0, 0, 0.026)))
                lathe(f"{pre}_glass{side}", [(0.022, 0.034), (0.022, 0.0)], AMBER, grp, seg=18, M=Mg, caps=(False, False))
                continue
            else:  # catEye
                pts, r_, lm, edge = mirror(cat_eye(0.052, 0.036), side), 0.0075, CLEAR, 0.052
            material = WHITE if name == "paper3d" else FRAME
            rim(f"{pre}_rim{side}", pts, M, r_, material, grp)
            if lm is not None:
                lens(f"{pre}_lens{side}", pts, M, lm, grp)
            temples(pre, grp, side, M, edge, r=0.0035 if name in ("wire", "aviator", "slim") else 0.005, material=material)
        if name == "monocle":
            continue
        if name == "steampunk":
            lathe(f"{pre}_strap", [(gz - 0.014, 0.218, 0.206), (gz + 0.014, 0.218, 0.206)], INK, grp, seg=24, M=T(HEAD_C), caps=(False, False))
            bridge(pre, grp, r=0.005, material=GOLD, lift=0.01, half=0.034)
            continue
        if name == "aviator":
            bridge(pre, grp, r=0.003, lift=0.012)
            tube(f"{pre}_brow", [face_pt(-0.03, gz + 0.034, GO), face_pt(0, gz + 0.036, GO + 0.004), face_pt(0.03, gz + 0.034, GO)], 0.003, FRAME, grp, res=2)
        elif name == "slim":
            bridge(pre, grp, r=0.003, lift=0.01)
        else:
            bridge(pre, grp, r=0.007 if name == "nerd" else 0.005, material=WHITE if name == "paper3d" else FRAME)
        if name == "nerd":
            p, r = surf(0, gz + 0.008, GO + 0.003)
            ellip(f"{pre}_tape", (0.011, 0.01, 0.013), p, WHITE, grp, seg=10, rings=6, rot=r)

    # --- extras (accessory slot; `extra` colour). Face/head ones hang off the head pivot, body ones are fitted per
    # body where they sit on clothes
    accessories = ["none", "backpack", "scarf", "headphones", "chain", "cape", "earrings", "bandana", "mask", "facePaint",
                   "freckles", "beard", "goatee", "moustache", "handlebar", "scar", "bowTie", "tie", "pearls", "wings",
                   "halo", "antennae", "tail", "eyePatch", "blush", "horns"]
    back = max(b[1] for b in BODIES.values()) + 0.02

    def beard_top(c):
        """Upper edge of the beard in unit head space: under the lip in front, up to the sideburns at the sides, gone
        behind the ears."""
        lv = -0.6 + 0.62 * smooth(0.3, 0.7, abs(c.x))
        return lv - 2.0 * max(0.0, c.y - 0.05)

    def beard_shape(c):
        lv = max(-0.98, beard_top(c))
        if c.z > lv:  # clamp onto the edge (as the hair caps do): a smooth hairline, not a face-cut stair
            h = Vector((c.x, c.y, 0))
            h = h.normalized() if h.length > 1e-6 else Vector((0, -1, 0))
            c = Vector((h.x * math.sqrt(1 - lv * lv), h.y * math.sqrt(1 - lv * lv), lv))
        depth = min(1.0, max(0.0, (lv - c.z) / 0.25))  # thin at the edge, full below
        v = jaw(c.copy()) * (1.015 + 0.06 * depth + 0.05 * max(0.0, -c.z - 0.6))
        if c.y < 0.2:
            v.z -= 0.05 * max(0.0, -c.z - 0.6) / 0.4
        return v

    for name in accessories:
        manifest["accessory"].append(name)
        pre = f"acc_{name}"
        grp = empty(pre, (0, 0, 0), root)
        hg = empty(f"{pre}_head", (0, 0, 0), head) if name not in ("none", "backpack", "scarf", "chain", "cape", "bandana", "bowTie", "tie", "pearls", "wings", "tail") else None
        if name == "backpack":
            rbox(f"{pre}_bag", (0.2, 0.09, 0.22), (0, back + 0.05, 0.43), EXTRA, grp, b=0.35, taper=(0.9, 0.85))
            rbox(f"{pre}_pocket", (0.15, 0.03, 0.09), (0, back + 0.1, 0.38), EXTRA, grp, b=0.4)
            tube(f"{pre}_zip", [(-0.065, back + 0.115, 0.425), (0, back + 0.118, 0.428), (0.065, back + 0.115, 0.425)], 0.004, METAL, grp)
            for side in (-1, 1):
                tube(f"{pre}_strap{side}", [(side * 0.07, back + 0.01, 0.53), (side * 0.08, 0.0, 0.575), (side * 0.085, -back + 0.005, 0.52), (side * 0.09, -back + 0.01, 0.4)], 0.009, EXT2I, grp)
        elif name == "scarf":
            lathe(f"{pre}_wrap", [(0.54, 0.105, 0.1), (0.57, 0.11, 0.105), (0.6, 0.085, 0.08)], EXTRA, grp, seg=24, wave=lambda a, z: 1 + 0.04 * math.sin(3 * a + 40 * z), caps=(False, False))
            tube(f"{pre}_tail", [(0.05, -0.095, 0.56), (0.06, -0.12, 0.5), (0.055, -0.115, 0.42)], 0.024, EXTRA, grp, radii=[1, 1, 0.9])
            for k in range(3):
                tube(f"{pre}_fringe{k}", [(0.04 + k * 0.012, -0.115, 0.405), (0.04 + k * 0.012, -0.115, 0.38)], 0.004, EXTRA, grp)
        elif name == "headphones":
            tube(f"{pre}_band", [(-0.215, 0.005, hz + 0.02), (-0.18, 0.0, hz + 0.16), (0, 0.0, hz + 0.24), (0.18, 0.0, hz + 0.16), (0.215, 0.005, hz + 0.02)], 0.013, EXT2I, hg)
            for side in (-1, 1):
                lathe(f"{pre}_cup{side}", [(0, 0.06), (0.025, 0.062), (0.04, 0.045), (0.045, 0.0)], EXTRA, hg, seg=20, M=T((side * 0.19, 0.005, hz)) @ R((0, side * math.pi / 2, 0)), caps=(True, False))
                lathe(f"{pre}_pad{side}", [(0, 0.05), (0.012, 0.055), (0.02, 0.04)], EXT2I, hg, seg=20, M=T((side * 0.185, 0.005, hz)) @ R((0, -side * math.pi / 2, 0)), caps=(False, True))
        elif name == "chain":
            pts = [(math.cos(t) * 0.08, -0.04 + math.sin(t) * 0.07 - (0.05 if math.sin(t) < 0 else 0) * abs(math.sin(t)) ** 2, 0.57 - 0.07 * max(0.0, -math.sin(t))) for t in [k * math.pi / 8 for k in range(16)]]
            tube(f"{pre}_loop", pts, 0.006, EXT2G, grp, cyclic=True, res=3)
            ellip(f"{pre}_pendant", (0.02, 0.008, 0.024), (0, -0.165, 0.49), EXT2G, grp, seg=12, rings=8, rot=(0.2, 0, 0))
        elif name == "cape":
            bm = bmesh.new()
            nx, nz = 12, 10
            vs = []
            for j in range(nz + 1):
                row = []
                for i in range(nx + 1):
                    u, v = i / nx, j / nz
                    w = 0.1 + 0.12 * v
                    a = (u - 0.5) * 2.4
                    row.append(bm.verts.new((math.sin(a) * w * 1.15, back - 0.02 + (1 - math.cos(a)) * -0.08 + v * 0.07 + 0.012 * math.sin(u * 12) * v, 0.58 - v * 0.42)))
                vs.append(row)
            for j in range(nz):
                for i in range(nx):
                    bm.faces.new((vs[j][i], vs[j + 1][i], vs[j + 1][i + 1], vs[j][i + 1]))
            from_bm(f"{pre}_cloth", bm, EXTRA, grp)
            ring(f"{pre}_clasp", 0.02, 0.006, (0, -0.07, 0.575), EXT2G, grp, rot=(math.pi / 2, 0, 0), n=10)
        elif name == "earrings":
            for side in (-1, 1):
                ring(f"{pre}_hoop{side}", 0.017, 0.0035, (side * 0.205, 0.008, hz - 0.082), EXTRA, hg, rot=(0, math.pi / 2, 0), n=16, minor=5)
                ellip(f"{pre}_stud{side}", (0.007,) * 3, (side * 0.204, 0.006, hz - 0.064), EXTRA, hg, seg=8, rings=6)
        elif name == "mask":
            ellip(f"{pre}_cloth", HR, HEAD_C, EXTRA, hg, seg=28, rings=18, keep=lambda c: c.y < -0.18 and -0.82 < c.z < -0.1, deform=lambda c: jaw(c) * 1.085)
            for side in (-1, 1):
                tube(f"{pre}_loop{side}", [face_pt(side * 0.15, -0.05, 0.008), Vector((side * 0.2, -0.04, hz - 0.035)), Vector((side * 0.215, 0.01, hz - 0.02))], 0.003, EXTRA, hg, res=2)
        elif name == "facePaint":
            for side in (-1, 1):
                for k in range(2):
                    z = -0.035 - 0.022 * k
                    tube(f"{pre}_stripe{side}{k}", [face_pt(side * 0.058, z + 0.004, 0.001), face_pt(side * 0.085, z, 0.001), face_pt(side * 0.112, z - 0.006, 0.0)], 0.0065, EXTRA, hg, radii=[0.6, 1.0, 0.5], res=2)
        elif name == "freckles":
            for k, (x, z) in enumerate(((0.06, -0.035), (0.082, -0.045), (0.07, -0.058), (0.097, -0.032), (0.05, -0.052), (0.092, -0.06))):
                for side in (-1, 1):
                    p, r = surf(side * x, z, 0.0)
                    ellip(f"{pre}_dot{side}{k}", (0.005, 0.002, 0.005), p, EXTRA, hg, seg=6, rings=4, rot=r)
            for k, x in enumerate((-0.012, 0.012)):
                p, r = surf(x, -0.03, 0.006)
                ellip(f"{pre}_nose{k}", (0.004, 0.002, 0.004), p, EXTRA, hg, seg=6, rings=4, rot=r)
        elif name == "beard":
            # chin + sideburns follow the jaw; the mouth stays clear, a moustache closes it over
            ellip(f"{pre}_beard", HR, HEAD_C, EXTRA, hg, seg=28, rings=18, keep=lambda c: c.z < beard_top(c) + 0.25, deform=beard_shape)
            tube(f"{pre}_stache", [face_pt(x, z, -0.002) for x, z in ((-0.05, -0.085), (-0.028, -0.068), (0.0, -0.07), (0.028, -0.068), (0.05, -0.085))], 0.01, EXTRA, hg, radii=[0.5, 1, 0.9, 1, 0.5], res=3)
        elif name == "goatee":
            p, r = surf(0, -0.135, -0.003)
            ellip(f"{pre}_chin", (0.022, 0.012, 0.03), p, EXTRA, hg, seg=12, rings=8, rot=r)
            tube(f"{pre}_stache", [face_pt(x, z, -0.002) for x, z in ((-0.036, -0.082), (-0.02, -0.07), (0.0, -0.071), (0.02, -0.07), (0.036, -0.082))], 0.007, EXTRA, hg, radii=[0.4, 1, 0.9, 1, 0.4], res=3)
        elif name == "moustache":
            tube(f"{pre}_stache", [face_pt(x, z, -0.002) for x, z in ((-0.052, -0.082), (-0.03, -0.067), (0.0, -0.07), (0.03, -0.067), (0.052, -0.082))], 0.011, EXTRA, hg, radii=[0.4, 1, 0.9, 1, 0.4], res=3)
        elif name == "handlebar":
            tube(f"{pre}_stache", [face_pt(x, z, -0.002) for x, z in ((-0.074, -0.05), (-0.07, -0.068), (-0.045, -0.073), (-0.02, -0.067), (0.0, -0.07), (0.02, -0.067), (0.045, -0.073), (0.07, -0.068), (0.074, -0.05))], 0.009, EXTRA, hg, radii=[0.2, 0.5, 0.9, 1, 0.9, 1, 0.9, 0.5, 0.2], res=3)
        elif name == "scar":
            tube(f"{pre}_slash", [face_pt(-0.115, 0.06, 0.004), face_pt(-0.09, 0.005, 0.004), face_pt(-0.07, -0.05, 0.003)], 0.0042, EXTRA, hg, res=2)
            for k, (x, z) in enumerate(((-0.106, 0.04), (-0.091, 0.005), (-0.079, -0.028))):
                tube(f"{pre}_stitch{k}", [face_pt(x - 0.012, z - 0.004, 0.004), face_pt(x + 0.012, z + 0.004, 0.004)], 0.0026, EXTRA, hg, res=2)
        elif name == "eyePatch":
            p, r = surf(EYE_X, EYE_Z, 0.008)
            ellip(f"{pre}_patch", (0.047, 0.008, 0.043), p, EXTRA, hg, seg=14, rings=8, rot=r)
            tube(f"{pre}_strap", [face_pt(0.03, 0.035, 0.008), face_pt(-0.05, 0.11, 0.006), Vector((-0.17, -0.02, hz + 0.12)), Vector((-0.2, 0.08, hz + 0.08))], 0.0045, EXT2I, hg, res=2)
            tube(f"{pre}_strap2", [face_pt(0.115, 0.0, 0.006), Vector((0.205, 0.0, hz - 0.01)), Vector((0.19, 0.1, hz + 0.02))], 0.0045, EXT2I, hg, res=2)
        elif name == "blush":
            for side in (-1, 1):
                p, r = surf(side * 0.098, -0.05, 0.0)
                ellip(f"{pre}_cheek{side}", (0.025, 0.004, 0.015), p, EXTRA, hg, seg=12, rings=6, rot=r)
        elif name == "halo":
            ring(f"{pre}_ring", 0.13, 0.013, (0, 0.02, hz + 0.33), EXTRA, hg, rot=(0.12, 0, 0), n=28, minor=6)
        elif name == "antennae":
            for side in (-1, 1):
                tube(f"{pre}_stalk{side}", [(side * 0.06, -0.02, hz + 0.18), (side * 0.08, -0.04, hz + 0.28), (side * 0.12, -0.06, hz + 0.34)], 0.007, EXTRA, hg, res=3)
                ellip(f"{pre}_ball{side}", (0.026,) * 3, (side * 0.125, -0.062, hz + 0.355), EXTRA, hg, seg=12, rings=8)
        elif name == "horns":
            for side in (-1, 1):
                p, dvec = on(side * math.radians(28), math.radians(48), 1.0)
                lathe(f"{pre}_horn{side}", [(0, 0.028), (0.05, 0.016), (0.085, 0.0)], EXTRA, hg, seg=12, M=T(p) @ align(dvec + Vector((side * 0.3, 0, 0.6))), caps=(False, False))
        elif name == "tail":
            tube(f"{pre}_tail", [(0, 0.08, 0.27), (0, 0.18, 0.23), (0.04, 0.27, 0.3), (0.06, 0.27, 0.42)], 0.02, EXTRA, grp, radii=[1, 1, 0.9, 0.7])
            ellip(f"{pre}_tuft", (0.032, 0.032, 0.045), (0.065, 0.27, 0.45), EXTRA, grp, seg=12, rings=8, deform=lambda c: c * (1 + 0.12 * math.sin(7 * math.atan2(c.y, c.x)) * math.sin(5 * c.z)))
        elif name == "wings":
            wing = [(0.0, 0.05), (0.08, 0.11), (0.18, 0.15), (0.27, 0.13), (0.26, 0.06), (0.21, 0.01), (0.17, -0.04), (0.13, -0.01), (0.09, -0.07), (0.05, -0.03), (0.0, -0.06)]
            for side in (-1, 1):
                M = T((side * 0.03, back + 0.02, 0.45)) @ R((0, 0, side * 0.45)) @ R((math.pi / 2, 0, 0))
                loft(f"{pre}_wing{side}", mirror(wing, side), [(-0.006, 1.0), (0.006, 1.0)], EXTRA, grp, M=M)
        else:
            # pieces that sit on clothes: fitted per body
            for bn, (sw, d, ww, hw, swa) in FITS.items():
                tg = f"{pre}_B{bn}"
                nx, ny = sw * 0.68 + 0.028, d * 0.74 + 0.028  # just outside every top's collar
                if name == "bandana":
                    lathe(f"{tg}_wrap", [(0.545, nx, ny), (0.565, nx + 0.004, ny + 0.004), (0.585, nx - 0.012, ny - 0.012)], EXTRA, grp, seg=24, wave=lambda a, z: 1 + 0.04 * math.sin(3 * a + 40 * z), caps=(False, False))
                    M = T((0, -ny - 0.004, 0.555)) @ R((-0.2, 0, 0)) @ R((math.pi / 2, 0, 0))
                    loft(f"{tg}_flap", [(-0.07, 0.0), (0.07, 0.0), (0.0, -0.095)], [(-0.003, 1.0), (0.003, 1.0)], EXTRA, grp, M=M)
                elif name == "bowTie":
                    c = Vector((0, -ny - 0.004, 0.555))
                    for side in (-1, 1):
                        ellip(f"{tg}_lobe{side}", (0.03, 0.011, 0.022), c + Vector((side * 0.028, 0, 0)), EXTRA, grp, seg=12, rings=8, deform=lambda v, s=side: Vector((v.x, v.y, v.z * (0.45 + 0.55 * max(0.0, s * v.x) ** 0.7))))
                    ellip(f"{tg}_knot", (0.011, 0.012, 0.012), c + Vector((0, -0.004, 0)), EXTRA, grp, seg=10, rings=6)
                elif name == "tie":
                    ellip(f"{tg}_knot", (0.016, 0.01, 0.016), (0, -(d * 0.8 + 0.03), 0.552), EXTRA, grp, seg=10, rings=6)
                    M = T((0, -(d * 0.85 + 0.032), 0.545)) @ R((-0.1, 0, 0)) @ R((math.pi / 2, 0, 0))
                    loft(f"{tg}_blade", [(-0.014, 0.0), (0.014, 0.0), (0.024, -0.16), (0.0, -0.19), (-0.024, -0.16)], [(-0.003, 1.0), (0.003, 1.0)], EXTRA, grp, M=M)
                elif name == "pearls":
                    for k in range(13):
                        a = -math.pi / 2 + (k - 6) * 0.37
                        dip = 0.025 * max(0.0, -math.sin(a)) ** 2
                        ellip(f"{tg}_pearl{k}", (0.012,) * 3, (math.cos(a) * nx, math.sin(a) * ny - dip * 0.6, 0.565 - dip), EXTRA, grp, seg=6, rings=4)

    # triangle budget: shared parts + the heaviest variant of every slot (a per-body fit counts once: one body shows)
    prefixes = {"body": "body", "face": "face", "hair": "hair", "top": "top", "bottom": "bottom", "shoes": "shoes", "hat": "hat", "glasses": "glasses", "accessory": "acc"}

    def variant_of(name):
        for key, pre in prefixes.items():
            for v in manifest[key]:
                if name == f"{pre}_{v}" or name.startswith(f"{pre}_{v}_"):
                    return f"{pre}_{v}"
        return ""

    consolidate(variant_of)
    per_variant, base = {}, 0
    for o in bpy.data.objects:
        n = tris(o)
        for key, pre in prefixes.items():
            hit = next((v for v in manifest[key] if o.name == f"{pre}_{v}" or o.name.startswith(f"{pre}_{v}_")), None)
            if hit:
                tag = VARIANT_TAG.search(o.name)
                k = (key, hit, tag.group(1) if tag else "")
                per_variant[k] = per_variant.get(k, 0) + n
                break
        else:
            base += n

    def variant_tris(k, v):
        own = per_variant.get((k, v, ""), 0)
        fits = [n for (k2, v2, t), n in per_variant.items() if k2 == k and v2 == v and t.startswith("B")]
        return own + max(fits or [0]) + max(per_variant.get((k, v, "H"), 0), per_variant.get((k, v, "W"), 0))

    heaviest = {k: max((variant_tris(k, v), v) for v in manifest[k]) for k in manifest}
    print("CREWMAP_AVATAR_SLOTS", json.dumps({"base": base, **{k: list(h) for k, h in heaviest.items()}}))
    worst = base + sum(h[0] for h in heaviest.values())
    export(os.path.join(OUT, "avatar.glb"))
    return manifest, {"worstCaseTris": worst}


# ----------------------------------------------------------------------------------------------------------------
# cars — profile-extruded bevelled bodies, glass cabins, rimmed wheels; length along -Y (front), ~4 units long
#
# Every vehicle registers a ride: its map scale, the rider's hip position in vehicle-local Blender units, the rider's
# scale and a pose. Written to manifest.json; the app (apps/mobile/src/avatar3d/kit.ts) and preview.py both read it,
# so the preview shows exactly what the sprite bake composes.
# Pose angles are three.js pivot rotations (radians): [x, z] per limb. x < 0 swings a limb forward (-1.57 =
# horizontal, -2.9 = overhead); z spreads it outward (mirrored per side here). lean pitches the rider forward about
# the hip, yaw turns the rider on the vehicle (skateboard stance).

RIDES = {}


def pose(legs=(0.0, 0.0), arms=(0.0, 0.0), lean=0.0, yaw=0.0, armR=None, legR=None):
    lr, ar = legR or legs, armR or arms
    return {"legL": [legs[0], -legs[1]], "legR": [lr[0], lr[1]], "armL": [arms[0], -arms[1]], "armR": [ar[0], ar[1]], "lean": lean, "yaw": yaw}


SEAT = pose(legs=(-1.45, 0.08), arms=(-1.1, -0.2))
# closed cars: standing up through the sunroof, one forearm on the roof, the other waving
ROOF = pose(legs=(-0.5, 0.06), arms=(-0.2, 1.3), armR=(-2.8, 0.3))
WAVE = pose(legs=(-1.45, 0.08), arms=(-1.1, -0.2), armR=(-2.8, 0.3))
MOTO = pose(legs=(-1.2, 0.35), arms=(-1.3, -0.12), lean=0.4)
ASTRIDE = pose(legs=(-0.95, 0.6), arms=(-1.45, -0.18), lean=0.45)
SKATE = pose(legs=(0.0, 0.24), arms=(0.1, 1.15), yaw=math.pi / 2)
SCOOT = pose(legs=(0.0, 0.05), legR=(0.3, 0.05), arms=(-1.15, -0.12), lean=0.18)
CART = pose(legs=(-1.35, 0.25), arms=(-2.85, 0.35))
TUB = pose(legs=(-1.4, 0.15), arms=(-0.25, 1.15), lean=-0.22)
CARPET = pose(legs=(-1.5, 0.55), arms=(-0.35, 0.5), armR=(-2.7, 0.3))


def ride(model, scale, seat, rider, p):
    RIDES[model] = {"scale": round(scale, 4), "seat": [round(c, 4) for c in seat], "rider": round(rider, 4), "pose": {k: ([round(a, 4) for a in v] if isinstance(v, list) else round(v, 4)) for k, v in p.items()}}


# Rider forward kinematics, mirrored by packages/shared/test/avatar-assets.test.ts: a limb pivot rotates by three.js
# Euler XYZ (x, z) = Blender Rx(x) @ Ry(-z); the rider is posed about the hip: seat + Rz(yaw) @ Rx(lean) @ k(p - hip).
ARM_PIVOT = {-1: Vector((-0.13, 0, SHOULDER_Z)), 1: Vector((0.13, 0, SHOULDER_Z))}
HAND_OFF = (0.026, -0.217)  # regular body: hand centre relative to its shoulder pivot (x outward, z)
CHIN = HEAD_C.z - 0.22 - HIP_Z  # lowest point of the head (skull + hair volume) above the hip, avatar units


def limb_rot(rx, rz):
    return Matrix.Rotation(rx, 3, "X") @ Matrix.Rotation(-rz, 3, "Y")


def rider_point(scale, seat, rider, p, local):
    k = rider / scale
    return Vector(seat) + (Matrix.Rotation(p["yaw"], 3, "Z") @ Matrix.Rotation(p["lean"], 3, "X")) @ (k * (Vector(local) - Vector((0, 0, HIP_Z))))


def hand(scale, seat, rider, p, side):
    rx, rz = p["armL" if side < 0 else "armR"]
    return rider_point(scale, seat, rider, p, ARM_PIVOT[side] + limb_rot(rx, rz) @ Vector((side * HAND_OFF[0], 0, HAND_OFF[1])))


# per-ride part boxes (vehicle units) for the manifest sanity tests: head clearance, wheels attached, hands on grips
GEOM = {}


def build_cars():
    reset()
    RIDES.clear()
    GEOM.clear()
    PAINT = mat("paint", (0.12, 0.53, 0.9), rough=0.32, metal=0.35, coat=1.0)
    GLASS = mat("glass", (0.06, 0.09, 0.13), rough=0.05, metal=0.3, coat=1.0)
    TRIM = mat("trim", (0.07, 0.07, 0.08), rough=0.55)
    TYRE = mat("tyre", (0.05, 0.05, 0.05), rough=0.85)
    RIM = mat("rim", (0.82, 0.83, 0.86), rough=0.2, metal=1.0)
    CHROME = mat("chrome", (0.9, 0.9, 0.92), rough=0.1, metal=1.0)
    LIGHT = mat("light", (1.0, 0.96, 0.82), emit=3.0)
    TAIL = mat("taillight", (0.95, 0.08, 0.1), rough=0.2, emit=2.0)
    BUN = mat("bun", (0.9, 0.62, 0.3), rough=0.75, sheen=0.4)
    SAUSAGE = mat("sausage", (0.68, 0.2, 0.14), rough=0.35, coat=0.6)
    MUSTARD = mat("mustard", (1.0, 0.8, 0.08), rough=0.4)
    KETCHUP = mat("ketchup", (0.85, 0.08, 0.06), rough=0.3)
    URETHANE = mat("accent_urethane", (1.0, 0.86, 0.42), rough=0.5)
    FLAME = mat("flame", (1.0, 0.45, 0.08), emit=4.0)
    WHITE = mat("white", (0.95, 0.95, 0.94), rough=0.4)
    GOLD_C = mat("gold", (1.0, 0.77, 0.3), rough=0.25, metal=1.0)
    ACCENT = mat("accent", (0.96, 0.96, 0.95), rough=0.35, coat=0.6)  # optional stripes/trim, recoloured apart from paint

    def own(prefix, m):
        """Copy of a fixed material that a ride colour may repaint: `accent_<name>` takes the optional accent (unset,
        it keeps the built-in look); `paint_<name>` is a natural material (bun, wood, rug) softly tinted by the paint
        only when the rider asked for a tint."""
        name = f"{prefix}_{m.name}"
        if name not in MATS:
            k = m.copy()
            k.name = name
            MATS[name] = k
        return MATS[name]

    ACC_RIM, ACC_TRIM, ACC_CHROME, ACC_GOLD = own("accent", RIM), own("accent", TRIM), own("accent", CHROME), own("accent", GOLD_C)
    NAT_BUN = own("paint", BUN)
    NAT_WOOD = mat("paint_wood", (0.78, 0.56, 0.32), rough=0.6)
    NAT_RUG = mat("paint_rug", (0.58, 0.1, 0.13), rough=0.8, sheen=0.4)

    def wheel(pre, x, y, r, parent, w=0.26, side=1):
        M = T((x, y, r)) @ R((0, math.pi / 2 * side, 0))
        lathe(f"{pre}_tyre", [(-w / 2, r * 0.62), (-w / 2, r * 0.9), (-w / 2 + 0.03, r), (w / 2 - 0.03, r), (w / 2, r * 0.9), (w / 2, r * 0.62)], TYRE, parent, seg=16, M=M, caps=(False, False))
        lathe(f"{pre}_rim", [(-w / 2 + 0.01, r * 0.64), (w / 2 - 0.035, r * 0.64), (w / 2 - 0.02, r * 0.6), (w / 2 - 0.03, r * 0.2), (w / 2 - 0.005, r * 0.16), (w / 2 + 0.005, 0.0)], ACC_RIM, parent, seg=16, M=M, caps=(True, False))
        for k in range(5):
            a = k * 2 * math.pi / 5 + 0.3
            c = M @ Vector((math.cos(a) * r * 0.4, math.sin(a) * r * 0.4, w / 2 - 0.022))
            d = (M.to_3x3() @ Vector((math.cos(a), math.sin(a), 0))).normalized()
            rbox(f"{pre}_spoke{k}", (0.03, r * 0.12, r * 0.44), c, ACC_RIM, parent, seg=0, rot=(math.atan2(-d.y, d.z), 0, 0))

    def lights(pre, root, hw, fy, ry, z, h=0.12, w=0.34):
        for side in (-1, 1):
            rbox(f"{pre}_hl{side}", (w, 0.06, h), (side * (hw - w / 2 - 0.08), fy, z), LIGHT, root, b=0.4, seg=1)
            rbox(f"{pre}_tl{side}", (w * 0.9, 0.06, h * 0.8), (side * (hw - w / 2 - 0.08), ry, z + 0.04), TAIL, root, b=0.4, seg=1)

    def smallwheel(pre, x, y, z, r, w, parent, tyre=None, rim=None):
        M = T((x, y, z)) @ R((0, math.pi / 2, 0))
        lathe(f"{pre}_tyre", [(-w / 2, r * 0.6), (-w / 2, r * 0.88), (-w / 2 + w * 0.2, r), (w / 2 - w * 0.2, r), (w / 2, r * 0.88), (w / 2, r * 0.6)], tyre or TYRE, parent, seg=14, M=M, caps=(False, False))
        lathe(f"{pre}_hub", [(-w / 2 + 0.002, r * 0.62), (w / 2 - 0.002, r * 0.62), (w / 2 + 0.002, 0.0)], rim or ACC_RIM, parent, seg=12, M=M, caps=(True, False))

    def car(name, L, W, wr, hood, belt, roof, nose, deck, ws, rf, rr, rb, cabin_w=0.86, tumble=0.82, wheel_y=0.32, glass=True, rider=0.65):
        """Side-profile car: hood/belt/roof heights, windscreen base ws, roof front rf / rear rr, rear base rb (y).
        Registers the driver seat: left seat, under the front of the roof, rider sized to fit under it."""
        pre = f"car_{name}"
        root = empty(pre)
        h, t = L / 2, wr * 0.55
        body = [(-h, t), (-h, nose), (-h + 0.12, hood - 0.02), (-h + 0.5, hood), (ws, belt), (rb, belt), (h - 0.25, deck), (h, deck - 0.08), (h, t)]
        extrude_profile(f"{pre}_body", body, W, PAINT, root, top_taper=0.97, z_split=hood - 0.05, bevel=0.17, seg=3)
        seat_y = rf + min(0.55, (rr - rf) * 0.4)
        if glass:
            g = [(ws - 0.02, belt - 0.03), (rf, roof), (rr, roof), (rb + 0.02, belt - 0.03)]
            cab = extrude_profile(f"{pre}_cabin", g, W * cabin_w, GLASS, root, top_taper=tumble, z_split=belt + 0.02, bevel=0.07, seg=2)
            # open top: the glass keeps its sides, a painted roof with a sunroof opening goes on top and the rider
            # stands up through it, head fully above the roof (never inside the body), shoulders at the opening
            bm = bmesh.new()
            bm.from_mesh(cab.data)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z > 0.6 and f.calc_center_median().z > roof - 0.06], context="FACES")
            bm.to_mesh(cab.data)
            bm.free()
            rw = W * cabin_w * tumble + 0.04
            hole_w, hole_l = min(0.86, rw - 0.2), 0.76
            y0, y1 = seat_y - hole_l / 2, seat_y + hole_l / 2
            for a, b_ in ((rf + 0.02, y0), (y1, rr - 0.02)):
                if b_ - a > 0.04:
                    rbox(f"{pre}_roof{a:.2f}", (rw, b_ - a, 0.07), (0, (a + b_) / 2, roof), PAINT, root, b=0.35, seg=2)
            for side in (-1, 1):
                rbox(f"{pre}_rail{side}", ((rw - hole_w) / 2, hole_l + 0.02, 0.07), (side * (rw + hole_w) / 4, seat_y, roof), PAINT, root, b=0.35, seg=1)
            # B pillars
            mid = (rf + rr) / 2
            for side in (-1, 1):
                rbox(f"{pre}_pillar{side}", (0.05, 0.1, roof - belt), (side * (W * cabin_w * (1 + tumble) / 4 + 0.005), mid, (roof + belt) / 2), PAINT, root, b=0.3, rot=(0, -side * math.atan((1 - tumble) * W * cabin_w / 2 / (roof - belt)), 0))
                rbox(f"{pre}_mirror{side}", (0.16, 0.08, 0.09), (side * (W / 2 + 0.05), ws + 0.12, belt + 0.035), PAINT, root, b=0.4)
                rbox(f"{pre}_mglass{side}", (0.1, 0.012, 0.06), (side * (W / 2 + 0.06), ws + 0.165, belt + 0.035), CHROME, root, seg=0)
                # window frames: A and C pillars along the glass edges, a sill along the belt
                xb, xr = side * (W * cabin_w / 2 - 0.01), side * (W * cabin_w * tumble / 2 - 0.01)
                tube(f"{pre}_apillar{side}", [(xb, ws, belt), (xr, rf, roof)], 0.032, PAINT, root)
                tube(f"{pre}_cpillar{side}", [(xr, rr, roof), (xb, rb, belt)], 0.04, PAINT, root)
                rbox(f"{pre}_sill{side}", (0.05, rb - ws, 0.04), (xb, (rb + ws) / 2, belt), TRIM, root, seg=0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                wheel(f"{pre}_w{'L' if sx < 0 else 'R'}{'F' if sy < 0 else 'B'}", sx * (W / 2 - 0.1), sy * L * wheel_y, wr, root, side=sx)
            rbox(f"{pre}_skirt{sx}", (0.04, L * 0.36, 0.07), (sx * (W / 2 + 0.005), 0, t + 0.05), TRIM, root, b=0.4, seg=1)
            tube(f"{pre}_handle{sx}", [(sx * (W / 2 + 0.005), ws + 0.55, belt - 0.12), (sx * (W / 2 + 0.01), ws + 0.65, belt - 0.12)], 0.02, CHROME, root)
        rbox(f"{pre}_bumperF", (W * 0.96, 0.14, 0.16), (0, -h - 0.02, t + 0.08), TRIM, root, b=0.4)
        rbox(f"{pre}_bumperR", (W * 0.96, 0.14, 0.16), (0, h + 0.02, t + 0.08), TRIM, root, b=0.4)
        rbox(f"{pre}_grille", (W * 0.4, 0.05, (nose - t) * 0.45), (0, -h - 0.005, (nose + t) / 2 + 0.06), TRIM, root, b=0.35, seg=1)
        lights(pre, root, W / 2, -h + 0.01, h - 0.01, (nose + t) / 2 + 0.12)
        for sy in (-1, 1):
            rbox(f"{pre}_plate{sy}", (0.42, 0.03, 0.12), (0, sy * (h + 0.1), t + 0.1), WHITE, root, b=0.3, seg=1)
        for sx in (-1, 1):  # accent pinstripe along the flank, door shut lines
            rbox(f"{pre}_stripe{sx}", (0.02, L * 0.62, 0.05), (sx * (W / 2 + 0.004), 0.05, min(belt, hood) - 0.13), ACCENT, root, b=0.3, seg=1)
            if glass:
                for dy in (ws + 0.08, seat_y + 0.35):
                    rbox(f"{pre}_door{sx}{dy:.2f}", (0.012, 0.018, belt - t - 0.12), (sx * (W / 2 + 0.002), dy, (belt + t) / 2), TRIM, root, seg=0)
        for k in range(3):  # grille slats
            rbox(f"{pre}_slat{k}", (W * 0.38, 0.02, 0.018), (0, -h - 0.035, (nose + t) / 2 + 0.06 + (k - 1) * (nose - t) * 0.13), CHROME, root, seg=0)
        if glass:
            # rider at 0.65 reads at map size; the chin clears the roof top
            # (roof + 0.035) by 0.03, so no part of the head is ever inside the car whatever the heading
            hip = roof + 0.065 - CHIN * rider / 0.3
            ride(name, 0.3, (0, seat_y, hip), rider, ROOF)
        return root

    car("compact", 3.4, 1.62, 0.3, 0.78, 0.82, 1.42, 0.66, 0.86, -0.75, -0.25, 0.75, 1.3)
    hb = car("hatchback", 3.9, 1.72, 0.32, 0.82, 0.88, 1.48, 0.68, 0.98, -0.8, -0.25, 1.4, 1.75)
    rbox("car_hatchback_lip", (1.2, 0.22, 0.04), (0, 1.36, 1.49), PAINT, hb, b=0.4, seg=1, rot=(0.12, 0, 0))  # roof spoiler
    sv = car("suv", 4.5, 1.92, 0.42, 1.12, 1.18, 1.9, 0.95, 1.2, -1.0, -0.45, 1.75, 2.05)
    M = T((0, 2.33, 0.95)) @ R((math.pi / 2, 0, 0))  # tailgate spare wheel
    lathe("car_suv_spare_tyre", [(-0.1, 0.18), (-0.1, 0.3), (0.1, 0.3), (0.1, 0.18)], TYRE, sv, seg=14, M=M, caps=(False, False))
    lathe("car_suv_spare_cover", [(0.09, 0.2), (0.11, 0.1), (0.115, 0.0)], ACCENT, sv, seg=14, M=M, caps=(True, False))
    rbox("car_suv_guard", (1.3, 0.08, 0.18), (0, -2.33, 0.5), CHROME, sv, b=0.35, seg=1)
    sp = car("sports", 4.3, 1.88, 0.33, 0.66, 0.74, 1.18, 0.5, 0.78, -0.55, 0.0, 0.7, 1.4, cabin_w=0.8, tumble=0.78)
    rbox("car_sports_wing", (1.7, 0.26, 0.04), (0, 1.9, 0.96), ACCENT, sp, b=0.4, seg=1, rot=(-0.12, 0, 0))
    for side in (-1, 1):
        rbox(f"car_sports_strut{side}", (0.04, 0.08, 0.22), (side * 0.6, 1.9, 0.84), TRIM, sp, seg=0)
        rbox(f"car_sports_intake{side}", (0.03, 0.4, 0.12), (side * 0.945, 0.9, 0.5), TRIM, sp, b=0.3, seg=1)
    vn = car("van", 5.0, 1.98, 0.37, 1.05, 1.32, 2.15, 0.9, 1.4, -1.65, -1.2, 2.3, 2.45, cabin_w=0.92, tumble=0.92, wheel_y=0.34)
    for side in (-1, 1):  # sliding-door track and seam
        rbox(f"car_van_track{side}", (0.02, 1.6, 0.03), (side * 1.0, 0.6, 1.2), TRIM, vn, seg=0)
        rbox(f"car_van_seam{side}", (0.012, 0.018, 0.75), (side * 0.995, 1.4, 0.88), TRIM, vn, seg=0)
    pk = car("pickup", 5.2, 1.95, 0.42, 1.12, 1.18, 1.86, 0.98, 1.18, -1.05, -0.6, 0.3, 0.45)
    rbox("car_pickup_bed", (1.95 * 0.86, 1.95, 0.08), (0, 1.55, 1.15), ACC_TRIM, pk, b=0.3, seg=1)
    for side in (-1, 1):
        rbox(f"car_pickup_bedrail{side}", (0.06, 2.0, 0.06), (side * 0.9, 1.55, 1.21), CHROME, pk, b=0.4, seg=1)
    rbox("car_pickup_tailgate", (1.86, 0.06, 0.12), (0, 2.55, 1.22), PAINT, pk, b=0.4, seg=1)
    rbox("car_pickup_gatehandle", (0.24, 0.02, 0.05), (0, 2.6, 1.02), CHROME, pk, seg=0)

    # convertible: open top, low doors, tilted windscreen, two seats and roll hoops; the rider's head and shoulders
    # clear the doors and the free arm waves
    cv = car("convertible", 4.2, 1.82, 0.33, 0.72, 0.8, 0.0, 0.55, 0.84, -0.6, 0.0, 0.0, 1.0, glass=False)
    rbox("car_convertible_screen", (1.82 * 0.82, 0.04, 0.34), (0, -0.62, 0.98), GLASS, cv, b=0.3, rot=(-0.55, 0, 0))
    tube("car_convertible_frame", [(-0.75, -0.6, 0.8), (-0.74, -0.73, 1.12), (0.74, -0.73, 1.12), (0.75, -0.6, 0.8)], 0.025, CHROME, cv)
    for x in (-0.36, 0.36):
        rbox(f"car_convertible_seat{x}", (0.46, 0.4, 0.14), (x, 0.05, 0.62), ACC_TRIM, cv, b=0.35)
        rbox(f"car_convertible_back{x}", (0.44, 0.12, 0.34), (x, 0.32, 0.8), ACC_TRIM, cv, b=0.4, rot=(0.2, 0, 0))
        tube(f"car_convertible_hoop{x}", [(x - 0.18, 0.55, 0.82), (x - 0.15, 0.58, 1.12), (x + 0.15, 0.58, 1.12), (x + 0.18, 0.55, 0.82)], 0.03, CHROME, cv)
    ride("convertible", 0.3, (-0.36, 0.08, 0.74), 0.5, WAVE)

    # motorcycle: seat pulled forward and bars pulled back so the short chibi arms reach them while leaning in
    mc = empty("car_motorcycle")
    for y, n in ((-0.78, "F"), (0.78, "B")):
        M = T((0, y, 0.34)) @ R((0, math.pi / 2, 0))
        lathe(f"car_motorcycle_tyre{n}", [(-0.07, 0.24), (-0.075, 0.3), (-0.04, 0.34), (0.04, 0.34), (0.075, 0.3), (0.07, 0.24)], TYRE, mc, seg=20, M=M, caps=(False, False))
        lathe(f"car_motorcycle_rim{n}", [(-0.05, 0.25), (0.05, 0.25), (0.04, 0.1), (0.06, 0.06), (0.065, 0.0)], ACC_RIM, mc, seg=20, M=M, caps=(False, False))
    tube("car_motorcycle_frame", [(0, 0.78, 0.36), (0, 0.3, 0.55), (0, -0.25, 0.7), (0, -0.5, 0.85)], 0.05, CHROME, mc)
    for fx in (-0.06, 0.06):  # twin fork legs, stanchion caps
        tube(f"car_motorcycle_fork{fx}", [(fx, -0.78, 0.34), (fx, -0.62, 0.7), (fx * 0.6, -0.52, 1.0)], 0.03, CHROME, mc)
    for side in (-1, 1):
        rbox(f"car_motorcycle_peg{side}", (0.12, 0.04, 0.03), (side * 0.18, 0.15, 0.4), TRIM, mc, seg=0)
    lathe("car_motorcycle_disc", [(0.075, 0.17), (0.085, 0.17), (0.085, 0.0)], RIM, mc, seg=16, M=T((0, -0.78, 0.34)) @ R((0, math.pi / 2, 0)), caps=(False, False))
    rbox("car_motorcycle_stripe", (0.05, 0.5, 0.02), (0, -0.27, 0.99), ACCENT, mc, seg=0)
    mh = [hand(0.5, (0, 0.12, 0.9), 0.55, MOTO, s) for s in (-1, 1)]
    tube("car_motorcycle_bars", [(mh[0].x, mh[0].y, mh[0].z), (-0.12, -0.5, 1.0), (0.12, -0.5, 1.0), (mh[1].x, mh[1].y, mh[1].z)], 0.025, TRIM, mc)
    for side, hp in zip((-1, 1), mh):
        tube(f"car_motorcycle_grip{side}", [(hp.x - side * 0.05, hp.y - 0.02, hp.z), (hp.x + side * 0.05, hp.y + 0.02, hp.z)], 0.035, TYRE, mc)
    GEOM["motorcycle"] = {"grips": [[round(c, 4) for c in hp] for hp in mh]}
    ellip("car_motorcycle_tank", (0.2, 0.3, 0.15), (0, -0.26, 0.84), PAINT, mc, seg=20, rings=12, deform=lambda c: Vector((c.x * (1 - 0.3 * max(0.0, c.y)), c.y, c.z)))
    rbox("car_motorcycle_seat", (0.26, 0.55, 0.09), (0, 0.18, 0.8), ACC_TRIM, mc, b=0.45, rot=(0.08, 0, 0))
    ellip("car_motorcycle_fender", (0.12, 0.3, 0.2), (0, 0.78, 0.42), PAINT, mc, seg=16, rings=10, keep=lambda c: c.z > 0.3)
    ellip("car_motorcycle_ffender", (0.11, 0.24, 0.16), (0, -0.8, 0.46), PAINT, mc, seg=16, rings=10, keep=lambda c: c.z > 0.3)
    rbox("car_motorcycle_engine", (0.3, 0.4, 0.28), (0, 0.0, 0.5), RIM, mc, b=0.3)
    tube("car_motorcycle_exhaust", [(0.18, -0.05, 0.4), (0.2, 0.4, 0.38), (0.2, 0.85, 0.48)], 0.045, CHROME, mc)
    lathe("car_motorcycle_hl", [(0, 0.1), (0.04, 0.11), (0.06, 0.0)], LIGHT, mc, seg=16, M=T((0, -0.6, 0.92)) @ R((math.pi / 2, 0, 0)), caps=(True, False))
    rbox("car_motorcycle_tl", (0.14, 0.04, 0.06), (0, 0.9, 0.6), TAIL, mc, b=0.4)
    ride("motorcycle", 0.5, (0, 0.12, 0.9), 0.55, MOTO)

    # the hot dog: open cockpit in the sausage (the rider pops out of the bun), mustard and ketchup squiggles, a little
    # windscreen and chunky wheels
    hd = empty("car_hotdog")
    for side in (-1, 1):
        ellip(f"car_hotdog_bun{side}", (0.55, 2.25, 0.36), (side * 0.36, 0, 0.75), NAT_BUN, hd, seg=18, rings=10, deform=lambda c: Vector((c.x, c.y, c.z * (1 + 0.15 * max(0.0, c.z)))))
    lathe("car_hotdog_sausage", [(-2.55, 0.0), (-2.5, 0.2), (-2.35, 0.32), (2.35, 0.32), (2.5, 0.2), (2.55, 0.0)], SAUSAGE, hd, seg=16, M=T((0, 0, 1.02)) @ R((math.pi / 2, 0, 0)), caps=(False, False))
    tube("car_hotdog_mustard", [(math.sin(i * 1.6) * 0.18, 0.4 + i * 0.2, 1.34) for i in range(9)], 0.05, MUSTARD, hd)
    tube("car_hotdog_ketchup", [(math.sin(i * 1.6 + 1.6) * 0.16, -2.1 + i * 0.16, 1.33) for i in range(7)], 0.045, KETCHUP, hd)
    rbox("car_hotdog_screen", (0.62, 0.03, 0.22), (0, -0.95, 1.44), GLASS, hd, b=0.3, rot=(-0.5, 0, 0))
    rbox("car_hotdog_chassis", (1.6, 4.3, 0.14), (0, 0, 0.44), PAINT, hd, b=0.4, seg=1)
    for side in (-1, 1):
        lathe(f"car_hotdog_hl{side}", [(0, 0.09), (0.03, 0.1), (0.05, 0.0)], LIGHT, hd, seg=14, M=T((side * 0.5, -2.17, 0.5)) @ R((math.pi / 2, 0, 0)), caps=(True, False))
        rbox(f"car_hotdog_tl{side}", (0.2, 0.05, 0.1), (side * 0.5, 2.16, 0.5), TAIL, hd, b=0.4)
    for sx in (-1, 1):
        for sy in (-1, 1):
            wheel(f"car_hotdog_w{'L' if sx < 0 else 'R'}{'F' if sy < 0 else 'B'}", sx * 0.82, sy * 1.4, 0.34, hd, w=0.34, side=sx)
    ride("hotdog", 0.3, (0, -0.4, 1.22), 0.52, WAVE)

    # --- fun rides, modelled at map scale (1 unit = 1 avatar height)

    # skateboard: deck with kicktails, grip tape, trucks, urethane wheels; rider stands sideways, arms out
    sk = empty("car_skateboard")
    rbox("car_skateboard_deck", (0.2, 0.56, 0.024), (0, 0, 0.085), NAT_WOOD, sk, b=0.45)
    for s in (-1, 1):
        rbox(f"car_skateboard_tail{s}", (0.2, 0.14, 0.024), (0, s * 0.33, 0.1), NAT_WOOD, sk, b=0.45, rot=(s * 0.32, 0, 0))
        rbox(f"car_skateboard_truck{s}", (0.17, 0.03, 0.03), (0, s * 0.2, 0.055), RIM, sk, b=0.3)
        for x in (-1, 1):
            smallwheel(f"car_skateboard_w{s}{x}", x * 0.085, s * 0.2, 0.036, 0.036, 0.034, sk, tyre=URETHANE, rim=URETHANE)
    rbox("car_skateboard_grip", (0.19, 0.5, 0.006), (0, 0, 0.098), TRIM, sk, b=0.3, seg=1)
    rbox("car_skateboard_graphic", (0.17, 0.42, 0.004), (0, 0, 0.072), ACCENT, sk, seg=0)  # underside graphic
    ride("skateboard", 1.0, (0, 0, 0.1 + 0.3 * 0.8), 0.8, SKATE)

    # kick scooter
    sc = empty("car_scooter")
    rbox("car_scooter_deck", (0.12, 0.48, 0.03), (0, 0.02, 0.08), PAINT, sc, b=0.4)
    rbox("car_scooter_grip", (0.11, 0.38, 0.006), (0, 0.04, 0.097), TRIM, sc, b=0.3, seg=1)
    for y, n in ((-0.27, "F"), (0.29, "B")):
        smallwheel(f"car_scooter_w{n}", 0, y, 0.065, 0.065, 0.032, sc)
    ellip("car_scooter_fender", (0.035, 0.08, 0.05), (0, 0.29, 0.1), PAINT, sc, seg=12, rings=8, keep=lambda c: c.z > 0.0)
    # the bars are built where the posed hands are (FK below), so the grips sit in the fists at every heading
    sc_seat = (0, 0.0, 0.1 + 0.3 * 0.75)
    hands = [hand(1.0, sc_seat, 0.75, SCOOT, s) for s in (-1, 1)]
    by, bz = (hands[0].y + hands[1].y) / 2, (hands[0].z + hands[1].z) / 2
    tube("car_scooter_stem", [(0, -0.27, 0.07), (0, (by - 0.27) / 2 - 0.01, (bz + 0.07) / 2), (0, by, bz)], 0.018, PAINT, sc)
    tube("car_scooter_bars", [(hands[0].x - 0.02, by, bz), (hands[1].x + 0.02, by, bz)], 0.014, ACC_CHROME, sc)
    for side, hp in zip((-1, 1), hands):
        tube(f"car_scooter_grip{side}", [(hp.x - 0.03, hp.y, hp.z), (hp.x + 0.03, hp.y, hp.z)], 0.02, PAINT, sc)
    rbox("car_scooter_clamp", (0.05, 0.05, 0.04), (0, by, bz - 0.015), TRIM, sc, b=0.4, seg=1)
    rbox("car_scooter_brake", (0.06, 0.1, 0.02), (0, 0.27, 0.15), TRIM, sc, b=0.4, seg=1)
    lathe("car_scooter_hl", [(0, 0.03), (0.015, 0.032), (0.025, 0.0)], LIGHT, sc, seg=12, M=T((0, -0.255, 0.42)) @ R((math.pi / 2, 0, 0)), caps=(True, False))
    ride("scooter", 1.0, sc_seat, 0.75, SCOOT)
    GEOM["scooter"] = {"grips": [[round(c, 4) for c in hp] for hp in hands]}

    # rocket: hull along -Y, white nose band, porthole, four fins clear of the rider's legs, glowing exhaust
    rk = empty("car_rocket")
    axis = T((0, 0, 0.34)) @ R((math.pi / 2, 0, 0))  # local +Z -> -Y (forward)
    lathe("car_rocket_hull", [(-0.46, 0.085), (-0.42, 0.11), (-0.15, 0.125), (0.15, 0.12), (0.3, 0.095), (0.42, 0.045), (0.47, 0.0)], PAINT, rk, seg=24, M=axis, caps=(True, False))
    lathe("car_rocket_band", [(0.18, 0.121), (0.24, 0.112)], ACCENT, rk, seg=24, M=axis, caps=(False, False))
    lathe("car_rocket_nozzle", [(-0.56, 0.08), (-0.5, 0.065), (-0.46, 0.075)], RIM, rk, seg=20, M=axis, caps=(False, False))
    lathe("car_rocket_flame", [(-0.82, 0.0), (-0.7, 0.045), (-0.58, 0.07), (-0.55, 0.0)], FLAME, rk, seg=16, M=axis, caps=(False, False))
    lathe("car_rocket_core", [(-0.7, 0.0), (-0.62, 0.035), (-0.56, 0.045), (-0.55, 0.0)], LIGHT, rk, seg=12, M=axis, caps=(False, False))
    for side in (-1, 1):
        ring(f"car_rocket_port{side}", 0.035, 0.01, (side * 0.118, -0.16, 0.36), CHROME, rk, rot=(0, math.pi / 2, 0), n=14)
        ellip(f"car_rocket_glass{side}", (0.01, 0.033, 0.033), (side * 0.116, -0.16, 0.36), GLASS, rk, seg=12, rings=6)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        c = Vector((math.cos(a) * 0.14, 0.34, 0.34 + math.sin(a) * 0.14))
        rbox(f"car_rocket_fin{k}", (0.02, 0.2, 0.13), c, PAINT if k % 2 else ACCENT, rk, b=0.4, rot=(0, -a + math.pi / 2, 0), taper=(1.0, 0.5))
    ride("rocket", 1.0, (0, 0.06, 0.34 + 0.125 + 0.03), 0.62, ASTRIDE)

    # shopping cart: wire basket (light metal panels with ribs), coloured handle and bumper, swivel casters;
    # the rider sits in the basket, hands up
    ct = empty("car_cart")
    rbox("car_cart_floor", (0.34, 0.46, 0.012), (0, 0, 0.3), PAINT, ct, b=0.3, seg=1)
    for s in (-1, 1):
        rbox(f"car_cart_side{s}", (0.012, 0.5, 0.24), (s * 0.18, 0, 0.42), PAINT, ct, b=0.3, seg=1, rot=(0, s * 0.08, 0))
        for k in range(4):
            tube(f"car_cart_rib{s}{k}", [(s * 0.188, -0.18 + k * 0.12, 0.3), (s * 0.2, -0.18 + k * 0.12, 0.545)], 0.006, ACC_CHROME, ct)
    rbox("car_cart_front", (0.36, 0.012, 0.24), (0, -0.25, 0.42), PAINT, ct, b=0.3, seg=1)
    rbox("car_cart_back", (0.36, 0.012, 0.24), (0, 0.25, 0.42), PAINT, ct, b=0.3, seg=1)
    ring("car_cart_rim", 1.0, 0.01, (0, 0, 0.545), ACC_CHROME, ct, n=24, scale=(0.2, 0.26))
    tube("car_cart_handle", [(-0.2, 0.34, 0.62), (0.2, 0.34, 0.62)], 0.022, ACCENT, ct)
    for s in (-1, 1):
        tube(f"car_cart_post{s}", [(s * 0.19, 0.25, 0.3), (s * 0.19, 0.3, 0.48), (s * 0.19, 0.34, 0.62)], 0.012, ACC_CHROME, ct)
        # chassis: bottom rail joining both casters, rear upright to the basket, front strut; each caster hangs from
        # a fork + swivel plate on the rail, so no wheel floats
        tube(f"car_cart_leg{s}", [(s * 0.17, -0.22, 0.09), (s * 0.18, 0.0, 0.18), (s * 0.18, 0.2, 0.3)], 0.012, ACC_CHROME, ct)
        tube(f"car_cart_rail{s}", [(s * 0.17, -0.25, 0.09), (s * 0.17, 0.25, 0.09)], 0.012, ACC_CHROME, ct)
        tube(f"car_cart_rear{s}", [(s * 0.17, 0.24, 0.09), (s * 0.18, 0.25, 0.3)], 0.012, ACC_CHROME, ct)
        for y in (-0.22, 0.22):
            rbox(f"car_cart_plate{s}{y}", (0.04, 0.04, 0.012), (s * 0.17, y, 0.08), ACC_CHROME, ct, b=0.3, seg=1)
            for f in (-1, 1):
                rbox(f"car_cart_fork{s}{y}{f}", (0.005, 0.016, 0.05), (s * 0.17 + f * 0.016, y, 0.055), ACC_CHROME, ct, b=0.2, seg=1)
            smallwheel(f"car_cart_w{s}{y}", s * 0.17, y, 0.035, 0.035, 0.025, ct)
    tube("car_cart_axle", [(-0.17, 0.25, 0.09), (0.17, 0.25, 0.09)], 0.01, ACC_CHROME, ct)
    tube("car_cart_crossF", [(-0.17, -0.25, 0.09), (0.17, -0.25, 0.09)], 0.01, ACC_CHROME, ct)
    rbox("car_cart_bumper", (0.38, 0.03, 0.05), (0, -0.27, 0.32), ACCENT, ct, b=0.4)
    ride("cart", 1.0, (0, 0.06, 0.42), 0.7, CART)

    # clawfoot bathtub: painted shell, porcelain inside, water with foam, gold feet, a rubber duck on the rim
    bt = empty("car_bathtub")
    PORC = mat("porcelain", (0.95, 0.96, 0.97), rough=0.25, double=True)
    WATER = mat("water", (0.45, 0.76, 0.96), rough=0.1)
    DUCK = mat("duck", (1.0, 0.82, 0.12), rough=0.45)
    BEAK = mat("beak", (1.0, 0.45, 0.1), rough=0.45)
    lathe("car_bathtub_shell", [(0.1, 0.15, 0.3), (0.16, 0.21, 0.4), (0.3, 0.24, 0.45), (0.42, 0.25, 0.46)], PAINT, bt, seg=28, caps=(True, False))
    lathe("car_bathtub_inner", [(0.2, 0.19, 0.38), (0.33, 0.225, 0.425), (0.42, 0.232, 0.442)], PORC, bt, seg=28, caps=(True, False))
    ring("car_bathtub_rim", 1.0, 0.018, (0, 0, 0.42), own("accent", PORC), bt, n=32, scale=(0.243, 0.452))
    lathe("car_bathtub_water", [(0.34, 0.226, 0.428), (0.345, 0.0)], WATER, bt, seg=28, caps=(False, False))
    for k, (x, y, r) in enumerate(((0.12, -0.2, 0.045), (0.15, -0.12, 0.035), (-0.13, 0.18, 0.04), (-0.08, 0.27, 0.03), (0.1, 0.3, 0.035), (-0.15, -0.25, 0.03))):
        ellip(f"car_bathtub_foam{k}", (r, r, r * 0.7), (x, y, 0.35), PORC, bt, seg=10, rings=6)
    for sx in (-1, 1):
        for sy in (-1, 1):
            ellip(f"car_bathtub_foot{sx}{sy}", (0.035, 0.035, 0.06), (sx * 0.15, sy * 0.3, 0.06), ACC_GOLD, bt, seg=10, rings=6)
    ellip("car_bathtub_duck", (0.04, 0.05, 0.035), (0.13, -0.38, 0.45), DUCK, bt, seg=12, rings=8)
    ellip("car_bathtub_duckhead", (0.026, 0.026, 0.026), (0.13, -0.41, 0.49), DUCK, bt, seg=10, rings=6)
    ellip("car_bathtub_beak", (0.012, 0.016, 0.007), (0.13, -0.435, 0.488), BEAK, bt, seg=8, rings=4)
    tube("car_bathtub_tap", [(0, 0.46, 0.4), (0, 0.47, 0.5), (0, 0.42, 0.53)], 0.014, CHROME, bt)
    ride("bathtub", 1.0, (0, 0.06, 0.305), 0.66, TUB)

    # magic carpet: thick wavy rug, gold border and medallion, tassels; the rider sits cross-legged and waves
    cp = empty("car_carpet")
    PATTERN = mat("pattern", (1.0, 0.77, 0.3), rough=0.6, sheen=0.4)

    def rug(name, L, W, z, material, thick):
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=8, y_segments=12, size=0.5)
        for v in bm.verts:
            x, y = v.co.x * W, v.co.y * L
            v.co = Vector((x, y, z + 0.025 * math.sin(y * 9 + 0.6) + 0.02 * (abs(x) / (W / 2)) ** 2))
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thick)
        return from_bm(name, bm, material, cp)

    rug("car_carpet_rug", 0.95, 0.6, 0.24, NAT_RUG, 0.018)
    rug("car_carpet_medallion", 0.6, 0.3, 0.262, ACCENT, 0.004)
    for sx in (-1, 1):
        tube(f"car_carpet_edge{sx}", [(sx * 0.3, -0.475 + i * 0.095, 0.25 + 0.025 * math.sin((-0.475 + i * 0.095) * 9 + 0.6) + 0.02) for i in range(11)], 0.012, ACC_GOLD, cp)
        for sy in (-1, 1):
            for k in range(3):
                x = sx * (0.12 + k * 0.08)
                tube(f"car_carpet_tassel{sx}{sy}{k}", [(x, sy * 0.47, 0.25 + 0.025 * math.sin(sy * 0.47 * 9 + 0.6)), (x, sy * 0.53, 0.235)], 0.008, ACC_GOLD, cp)
    ride("carpet", 1.0, (0, 0.06, 0.3), 0.7, CARPET)

    counts = {}
    for o in bpy.data.objects:
        if o.parent is None and o.name.startswith("car_"):
            counts[o.name[4:]] = sum(tris(c) for c in o.children_recursive)
            parts = []
            for c in o.children_recursive:
                if c.type != "MESH" or not c.data.vertices:
                    continue
                ws = [c.matrix_world @ v.co for v in c.data.vertices]
                lo = [min(w[i] for w in ws) for i in range(3)]
                hi = [max(w[i] for w in ws) for i in range(3)]
                parts.append({"n": c.name[len(o.name) + 1:], "min": [round(a, 4) for a in lo], "max": [round(a, 4) for a in hi]})
            GEOM.setdefault(o.name[4:], {})["parts"] = parts
    # not bundled by the app: read by packages/shared/test/avatar-assets.test.ts
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rides-geometry.json"), "w") as f:
        json.dump(GEOM, f, separators=(",", ":"))
    consolidate(lambda _n: "")
    export(os.path.join(OUT, "cars.glb"))
    return counts


# optional second arg: "avatar" or "cars" rebuilds one kit and keeps the other's manifest entries
ONLY = argv[1] if len(argv) > 1 else None
MPATH = os.path.join(OUT, "manifest.json")
out = json.load(open(MPATH)) if ONLY and os.path.exists(MPATH) else {}
if ONLY != "cars":
    out["avatar"], out["avatarTris"] = build_avatar()
if ONLY != "avatar":
    out["cars"] = build_cars()
    out["rides"] = RIDES
with open(MPATH, "w") as f:
    json.dump(out, f, indent=2)
print("CREWMAP_ASSETS_OK", json.dumps({"avatarTris": out.get("avatarTris"), "cars": out.get("cars")}))
