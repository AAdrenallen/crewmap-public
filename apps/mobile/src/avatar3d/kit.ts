import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { carColorOf, colorOf, DEFAULT_CAR, finishOf, type AvatarConfig, type CarConfig, type FinishId, type FinishItem } from '@crewmap/shared/avatar';
import manifest from '../../assets/models/manifest.json';
import { applyFinish, stillClock, type FinishClock } from './finishes';

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
function toonify(root: THREE.Object3D, colours: Record<string, string>, finishes: Record<string, FinishId> = {}, clock: FinishClock = stillClock()): void {
  const made = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (m: THREE.Material): THREE.MeshToonMaterial => {
    let t = made.get(m);
    if (t) return t;
    const src = m as THREE.MeshStandardMaterial;
    const hex = colours[m.name];
    const color = hex ? new THREE.Color(hex) : src.color.clone();
    if (!hex && src.metalness > 0.5) color.multiplyScalar(METAL_TINT);
    const glass = m.name === 'glass';
    t = new THREE.MeshToonMaterial({
      name: m.name,
      color,
      gradientMap: toonRamp(),
      emissive: src.emissive,
      emissiveIntensity: src.emissiveIntensity,
      side: src.side,
      // see-through cabins: the rider shows in every car
      transparent: glass,
      opacity: glass ? 0.38 : 1,
      depthWrite: !glass,
    });
    const finish = finishes[m.name];
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

/** A configured avatar instance (own materials, only the chosen variants visible). */
/** Material names painted by each finish item. */
const FINISH_MATERIALS: Record<FinishItem, readonly string[]> = {
  hair: ['hair'],
  top: ['top'],
  bottom: ['bottom'],
  shoes: ['shoes', 'shoe', 'shoe2'],
  hat: ['hat'],
  accessory: ['extra', 'cape'],
};

function avatarFinishes(cfg: AvatarConfig): Record<string, FinishId> {
  const out: Record<string, FinishId> = {};
  for (const item of Object.keys(FINISH_MATERIALS) as FinishItem[]) {
    const f = finishOf(cfg, item);
    if (f !== 'none') for (const name of FINISH_MATERIALS[item]) out[name] = f;
  }
  return out;
}

/** `clock` drives animated finishes (the live stage advances it; bakes keep the still frame). */
export async function buildAvatar(cfg: AvatarConfig, clock?: FinishClock): Promise<AvatarRig> {
  const kit = await loadGlb(AVATAR_GLB);
  ensureNormals(kit);
  const root = pickVariants(kit, cfg) ?? new THREE.Group();
  const accent = cfg.topColor === '#FF6B6B' ? '#5B6CFF' : '#FF6B6B';
  toonify(root, { skin: colorOf(cfg, 'skin'), hair: colorOf(cfg, 'hairColor'), top: colorOf(cfg, 'topColor'), bottom: colorOf(cfg, 'bottomColor'), shoe: colorOf(cfg, 'shoeColor'), shoe2: colorOf(cfg, 'shoeColor2'), hat: colorOf(cfg, 'hatColor'), frame: colorOf(cfg, 'glassesColor'), extra: colorOf(cfg, 'extraColor'), accent }, avatarFinishes(cfg), clock);
  const find = (n: string) => root.getObjectByName(n) ?? null;
  return { root, legL: find('legL'), legR: find('legR'), armL: find('armL'), armR: find('armR') };
}

/** Walk-cycle pose: phase 0 = idle, ±1 = stride. */
export function pose(rig: AvatarRig, phase: number): void {
  const a = 0.45 * phase;
  if (rig.legL) rig.legL.rotation.set(a, 0, 0);
  if (rig.legR) rig.legR.rotation.set(-a, 0, 0);
  if (rig.armL) rig.armL.rotation.set(-a * 0.8, 0, 0);
  if (rig.armR) rig.armR.rotation.set(a * 0.8, 0, 0);
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
  toonify(car, { paint: carColorOf(cfg), ...(cfg.accent ? { accent: cfg.accent } : {}) }, cfg.finish ? { paint: cfg.finish } : {}, clock);
  car.scale.setScalar(scale);
  return car;
}

/**
 * The avatar riding their vehicle: vehicle at its ride scale, the rider's hip on the seat, posed (seated with hands
 * on the wheel, astride and leaning on the motorcycle/rocket, standing sideways on the skateboard, ...).
 */
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
