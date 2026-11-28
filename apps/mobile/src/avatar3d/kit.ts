import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DEFAULT_CAR, type AvatarConfig, type CarConfig, type FinishId } from '@crewmap/shared/avatar';
import manifest from '../../assets/models/manifest.json';
import { applyFinish, stillClock, type FinishClock } from './finishes';
import { avatarFinishes, avatarLook, carFinish, carLook, type LookOf } from './looks';

/** GLB kits produced by tools/blender/build_assets.py (+ tools/blender/optimize.mjs: quantized, no decoder needed). */
const AVATAR_GLB = require('../../assets/models/avatar.glb');
const CARS_GLB = require('../../assets/models/cars.glb');

type Limb = 'legL' | 'legR' | 'armL' | 'armR';
/** Pivot rotations [x, z] (radians), forward lean and yaw of the rider; see build_assets.py `pose`. */
export type RiderPose = Record<Limb, [number, number]> & { lean: number; yaw: number };
export interface Ride {
  /** Vehicle scale in sprite world units. */
  scale: number;
  /** Rider hip position in vehicle-local Blender units (Z up, front = -Y). */
  seat: [number, number, number];
  /** Rider scale (the walking avatar is 1). */
  rider: number;
  pose: RiderPose;
}
const RIDES = (manifest as unknown as { rides: Record<string, Ride> }).rides;

/** Hip pivot height of the avatar kit (build_assets.py HIP_Z). */
const HIP = 0.3;

const cache = new Map<string, Promise<THREE.Group>>();

async function loadGlb(mod: number): Promise<THREE.Group> {
  const key = String(mod);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const asset = Asset.fromModule(mod);
      if (!asset.localUri) await asset.downloadAsync();
      const bytes = await new File(asset.localUri ?? asset.uri).bytes();
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
      return gltf.scene;
    })();
    // A failed load is not cached: the next bake may retry (the baker's breaker caps retries).
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Part-prefix → config key. Nodes whose name starts with `${prefix}_` are variants. */
const SLOTS: [prefix: string, key: keyof AvatarConfig][] = [
  ['body', 'body'],
  ['face', 'face'],
  ['hair', 'hair'],
  ['top', 'top'],
  ['bottom', 'bottom'],
  ['shoes', 'shoes'],
  ['hat', 'hat'],
  ['glasses', 'glasses'],
  ['acc', 'accessory'],
];

/**
 * Variant tags after the part id (build_assets.py consolidate): `_B<body>-<body>` clothes fitted for those bodies,
 * `_H` hair hidden under a hat, `_W` a flatter stand-in shown only under a hat.
 */
const VARIANT_TAG = /_(B[a-z-]+|H|W)(?=_|$)/;
/** Hats that leave the hair free (bands and rings); every other hat hides the `_H` hair pieces. */
const HAIR_FREE_HATS: ReadonlySet<string> = new Set(['none', 'catEars', 'headband', 'crown']);

export function variantVisible(name: string, cfg: AvatarConfig): boolean | null {
  for (const [prefix, key] of SLOTS) {
    if (name.startsWith(`${prefix}_`)) {
      const v = cfg[key];
      if (name !== `${prefix}_${v}` && !name.startsWith(`${prefix}_${v}_`)) return false;
      const tag = VARIANT_TAG.exec(name.slice(prefix.length + String(v).length + 1))?.[1];
      if (!tag) return true;
      if (tag === 'H') return HAIR_FREE_HATS.has(cfg.hat);
      if (tag === 'W') return !HAIR_FREE_HATS.has(cfg.hat);
      return tag.slice(1).split('-').includes(cfg.body);
    }
  }
  return null;
}

/** Copy of the kit holding only the chosen variants (a full clone was ~500 nodes; a look uses ~100). */
function pickVariants(src: THREE.Object3D, cfg: AvatarConfig): THREE.Object3D | null {
  if (variantVisible(src.name, cfg) === false) return null;
  const copy = src.clone(false);
  for (const child of src.children) {
    const c = pickVariants(child, cfg);
    if (c) copy.add(c);
  }
  return copy;
}

const normalsReady = new WeakSet<THREE.Object3D>();
/** optimize.mjs drops normals a smooth recompute reproduces (lighter GLB): rebuild them once per loaded kit. */
function ensureNormals(kit: THREE.Object3D): void {
  if (normalsReady.has(kit)) return;
  kit.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if ((o as THREE.Mesh).isMesh && g && !g.getAttribute('normal')) g.computeVertexNormals();
  });
  normalsReady.add(kit);
}

let gradient: THREE.DataTexture | null = null;
/** Soft 4-band toon ramp: cel-shaded read at map size, still some form in the editor. */
function toonRamp(): THREE.DataTexture {
  if (gradient) return gradient;
  const bands = [96, 168, 220, 255];
  const data = new Uint8Array(bands.length * 4);
  bands.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradient = new THREE.DataTexture(data, bands.length, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

/** Metals have no environment to reflect in a toon look: lift them so chrome still reads as bright. */
const METAL_TINT = 1.15;

/**
 * Swap the kit's PBR materials for toon materials (one per source material per instance, shared by every mesh that
 * used it) and apply the config colours. No clear-coat/sheen/environment map: the bake needs no PMREM pass, and the
 * composite outline + toon bands give the finished cartoon look.
 */
function toonify(root: THREE.Object3D, lookOf: LookOf, finishOf: (material: string) => FinishId | undefined = () => undefined, clock: FinishClock = stillClock()): void {
  const made = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (m: THREE.Material): THREE.MeshToonMaterial => {
    let t = made.get(m);
    if (t) return t;
    const src = m as THREE.MeshStandardMaterial;
    const look = lookOf(m.name);
    const color = src.color.clone();
    if (look?.color) color.lerp(new THREE.Color(look.color), look.tint ?? 1);
    else if (src.metalness > 0.5) color.multiplyScalar(METAL_TINT);
    // see-through cabins (the rider shows in every car) and clear lenses
    const opacity = m.name === 'glass' ? 0.38 : (look?.opacity ?? 1);
    const glows = src.emissiveIntensity > 0 && src.emissive.getHex() !== 0;
    const emissive = look?.glow === false ? new THREE.Color(0) : look?.color && glows ? color.clone() : src.emissive;
    t = new THREE.MeshToonMaterial({
      name: m.name,
      color,
      gradientMap: toonRamp(),
      emissive,
      emissiveIntensity: src.emissiveIntensity,
      side: src.side,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    });
    const finish = finishOf(m.name);
    if (finish) applyFinish(t, finish, clock);
    made.set(m, t);
    return t;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    if (mesh.material instanceof THREE.MeshToonMaterial && mesh.material.transparent) mesh.renderOrder = 1;
  });
}

export interface AvatarRig {
  root: THREE.Object3D;
  legL: THREE.Object3D | null;
  legR: THREE.Object3D | null;
  armL: THREE.Object3D | null;
  armR: THREE.Object3D | null;
}

/** `clock` drives animated finishes (the live stage advances it; bakes keep the still frame). */
export async function buildAvatar(cfg: AvatarConfig, clock?: FinishClock): Promise<AvatarRig> {
  const kit = await loadGlb(AVATAR_GLB);
  ensureNormals(kit);
  const root = pickVariants(kit, cfg) ?? new THREE.Group();
  const finishes = avatarFinishes(cfg);
  toonify(root, avatarLook(cfg), (name) => finishes[name], clock);
  const find = (n: string) => root.getObjectByName(n) ?? null;
  return { root, legL: find('legL'), legR: find('legR'), armL: find('armL'), armR: find('armR') };
}

/** Walk-cycle pose: phase 0 = idle, ±1 = stride. */
export function pose(rig: AvatarRig, phase: number): void {
  rig.root.position.set(0, 0, 0);
  rig.root.rotation.set(0, 0, 0);
  const a = 0.45 * phase;
  if (rig.legL) rig.legL.rotation.set(a, 0, 0);
  if (rig.legR) rig.legR.rotation.set(-a, 0, 0);
  if (rig.armL) rig.armL.rotation.set(-a * 0.8, 0, 0);
  if (rig.armR) rig.armR.rotation.set(a * 0.8, 0, 0);
}

/**
 * Expressive 3D freeze-frame action poses (0..7) for crew clusters:
 *  0: Victory Cheer (both arms raised overhead in a V)
 *  1: High-Five Jump (one arm high, excited mid-air stride)
 *  2: Big Wave (high waving arm + relaxed hip hand)
 *  3: Star Jump (airborne wide arms & split legs)
 *  4: Superhero / Power Stance (wide legs, proud arms out)
 *  5: Dance Boogie (funky asymmetric party arms & step)
 *  6: Selfie / Peace Reach (one arm forward + one arm up)
 *  7: Hype Kick (celebratory high kick + pumped arms)
 */
export function actionPose(rig: AvatarRig, action: number): void {
  const set = (
    armL: [number, number],
    armR: [number, number],
    legL: [number, number],
    legR: [number, number],
    liftY = 0,
    tiltZ = 0,
  ) => {
    rig.root.position.set(0, liftY, 0);
    rig.root.rotation.set(0, 0, tiltZ);
    rig.armL?.rotation.set(armL[0], 0, armL[1]);
    rig.armR?.rotation.set(armR[0], 0, armR[1]);
    rig.legL?.rotation.set(legL[0], 0, legL[1]);
    rig.legR?.rotation.set(legR[0], 0, legR[1]);
  };
  switch (action % 8) {
    case 0:
      set([-2.78, -0.38], [-2.78, 0.38], [-0.12, -0.22], [0.12, 0.22], 0.03, 0);
      break;
    case 1:
      set([0.52, -0.32], [-2.68, 0.28], [0.48, -0.12], [-0.62, 0.14], 0.05, -0.06);
      break;
    case 2:
      set([-2.62, -0.48], [-0.28, 0.52], [0.08, -0.18], [-0.08, 0.18], 0, 0.05);
      break;
    case 3:
      set([-2.38, -0.76], [-2.38, 0.76], [-0.18, -0.5], [-0.18, 0.5], 0.07, 0);
      break;
    case 4:
      set([0.12, -0.66], [0.12, 0.66], [0, -0.28], [0, 0.28], 0, 0);
      break;
    case 5:
      set([-2.15, -0.52], [-0.85, 0.68], [-0.55, -0.22], [0.38, 0.22], 0.02, -0.07);
      break;
    case 6:
      set([-2.42, -0.36], [-1.22, -0.14], [0.18, -0.2], [-0.22, 0.16], 0, 0.06);
      break;
    default:
      set([-2.48, -0.46], [-2.48, 0.46], [0.22, -0.14], [-1.08, 0.2], 0.04, -0.05);
      break;
  }
}

function riderPose(rig: AvatarRig, p: RiderPose): void {
  for (const limb of ['legL', 'legR', 'armL', 'armR'] as const) {
    const r = p[limb] as [number, number] | undefined;
    rig[limb]?.rotation.set(r?.[0] ?? 0, 0, r?.[1] ?? 0);
  }
}

/** The manifest entry for a ride; unknown ids (a newer peer) ride the default. */
export function rideOf(cfg: CarConfig): Ride {
  const r = RIDES[cfg.model] ?? RIDES[DEFAULT_CAR.model];
  if (!r) throw new Error(`no manifest ride for ${cfg.model}`);
  return r;
}

async function buildVehicle(cfg: CarConfig, scale: number, clock?: FinishClock): Promise<THREE.Object3D> {
  const kit = await loadGlb(CARS_GLB);
  const node = kit.getObjectByName(`car_${cfg.model}`) ?? kit.getObjectByName(`car_${DEFAULT_CAR.model}`);
  if (!node) throw new Error(`unknown ride ${cfg.model}`);
  const car = node.clone(true);
  car.position.set(0, 0, 0);
  toonify(car, carLook(cfg), (name) => carFinish(cfg, name), clock);
  car.scale.setScalar(scale);
  return car;
}

/**
 * The avatar riding their vehicle: vehicle at its ride scale, the rider's hip on the seat, posed (seated with hands
 * on the wheel, astride and leaning on the motorcycle/rocket, standing sideways on the skateboard, ...).
 */
/** The vehicle alone, same scale as in `buildRide` (the parked car marker, D67). */
export async function buildParked(car: CarConfig): Promise<THREE.Object3D> {
  const known = RIDES[car.model] ? car : { ...car, model: DEFAULT_CAR.model };
  return buildVehicle(known, rideOf(known).scale);
}

export async function buildRide(avatar: AvatarConfig, car: CarConfig, clock?: FinishClock): Promise<THREE.Object3D> {
  const known = RIDES[car.model] ? car : { ...car, model: DEFAULT_CAR.model };
  const ride = rideOf(known);
  const [vehicle, rig] = await Promise.all([buildVehicle(known, ride.scale, clock), buildAvatar(avatar, clock)]);
  riderPose(rig, ride.pose);
  const [x, y, z] = ride.seat;
  const seat = new THREE.Group();
  // Blender Z-up (x, y, z) -> three Y-up (x, z, -y)
  seat.position.set(x * ride.scale, z * ride.scale, -y * ride.scale);
  seat.rotation.order = 'YXZ';
  seat.rotation.set(ride.pose.lean, ride.pose.yaw, 0);
  seat.scale.setScalar(ride.rider);
  rig.root.position.set(0, -HIP, 0);
  seat.add(rig.root);
  const group = new THREE.Group();
  group.add(vehicle, seat);
  return group;
}
