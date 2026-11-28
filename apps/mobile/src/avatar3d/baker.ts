import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { Directory, File, Paths } from 'expo-file-system';
import * as THREE from 'three';
import { avatarKey, normalizeCar, rideKey, SPRITE_HEADINGS, type AvatarConfig, type CarConfig } from '@crewmap/shared/avatar';
import { BakeBreaker, sheetFits } from './bakeGuard';
import { actionPose, buildAvatar, buildParked, buildRide, pose } from './kit';

/**
 * On-device sprite baking (spike b decision): compose the avatar (or the avatar riding their vehicle) from the GLB
 * kit, render 16 headings (× 3 walk frames for avatars) into one sheet in an offscreen GL context, snapshot to PNG,
 * cache per config. The map then shows plain images; the live 3D model is only used in the editor. Composed configs
 * are too many to pre-bake on the PC (parts × colours × rides), so baking stays on device, kept cheap: toon materials
 * (no environment/PMREM pass), meshes joined per part and material in the Blender kit, and a 1-cell portrait for
 * lists instead of decoding the full sheet.
 *
 * Quality pipeline per cell: HDR (half-float when available) render at SUPERSAMPLE×, toon studio lighting
 * (key / fill / rim + hemispheric ambient), baked soft contact shadow;
 * then a composite pass box-downsamples to CELL, applies ACES filmic tone mapping + sRGB encoding, un-premultiplies
 * and draws a subtle dark outline around the silhouette.
 *
 * CELL stays 192: a 16-heading row is 3072 px wide (256 would hit the 4096 px texture limit of many GPUs and cost
 * ~12 MB decoded per avatar sheet), and the map draws sprites at 64 dp ≈ 176–192 px on typical densities.
 */
export const CELL = 192;
export const AVATAR_FRAMES = 3; // idle, stride A, stride B
export const POSE_SHEET_FRAMES = 8; // 8 expressive 3D group freeze-frame poses
const SUPERSAMPLE = 2;
// expo-gl has no renderbufferStorageMultisample; antialiasing comes from the SUPERSAMPLE downsample.
const MSAA = 0;
const EXPOSURE = 0.8;

const dir = new Directory(Paths.document, 'sprites');

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export const SPRITE_VERSION = 'v13';

export function avatarSheetFile(cfg: AvatarConfig): File {
  return new File(dir, `a-${SPRITE_VERSION}-${hash(avatarKey(cfg))}.png`);
}

export function portraitFile(cfg: AvatarConfig): File {
  return new File(dir, `p-${SPRITE_VERSION}-${hash(avatarKey(cfg))}.png`);
}

export function poseSheetFile(cfg: AvatarConfig): File {
  return new File(dir, `g-${SPRITE_VERSION}-${hash(avatarKey(cfg))}.png`);
}

export function rideSheetFile(avatar: AvatarConfig, car: CarConfig): File {
  return new File(dir, `r-${SPRITE_VERSION}-${hash(rideKey(avatar, car))}.png`);
}

/** Sheets from older sprite versions are never shown again; delete them once per launch. */
function pruneOldSheets(): void {
  try {
    if (!dir.exists) return;
    for (const f of dir.list()) if (f instanceof File && !f.name.includes(`-${SPRITE_VERSION}-`)) f.delete();
  } catch (e) {
    if (__DEV__) console.warn('sprite prune failed', e);
  }
}

let queue: Promise<unknown> = Promise.resolve();
let pruned = false;

/** Serialise bakes: one GL context at a time. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  if (!pruned) {
    pruned = true;
    pruneOldSheets();
  }
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** Radial falloff texture for the contact shadow (alpha only, soft edge). */
function shadowTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - d, 1.6) * (1 - d * 0.25);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Soft elliptical shadow on the ground plane, parented to the model so it turns with it. */
function contactShadow(model: THREE.Object3D, opacity: number): THREE.Mesh {
  model.updateMatrixWorld(true);
  // Only the chosen variants: hidden kit parts must not inflate the footprint.
  const box = new THREE.Box3();
  model.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = model.scale.x || 1;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity, depthWrite: false, toneMapped: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(centre.x / s, 0.002 / s, centre.z / s);
  mesh.scale.set((size.x * 1.25) / s, (size.z * 1.35) / s, 1);
  mesh.renderOrder = -1;
  model.add(mesh);
  return mesh;
}

const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D src;
uniform vec2 texel;      // one source texel
uniform float exposure;
uniform float outlineWidth; // in source texels
uniform vec4 outlineColor;  // straight alpha
varying vec2 vUv;

vec3 aces(vec3 c) {
  // Narkowicz ACES filmic fit
  c *= exposure;
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float solid(vec2 uv) {
  return smoothstep(0.45, 0.9, texture2D(src, uv).a);
}
void main() {
  // vUv sits on a 2×2 source texel corner, so one bilinear tap is an exact box downsample (premultiplied colour).
  vec4 c = texture2D(src, vUv);
  float a = c.a;
  vec3 col = a > 0.0 ? toSRGB(aces(c.rgb / a)) : vec3(0.0);
  float ring = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = float(i) * 0.5235988;
    ring = max(ring, solid(vUv + vec2(cos(t), sin(t)) * texel * outlineWidth));
  }
  float body = solid(vUv);
  float oa = clamp(ring - body, 0.0, 1.0) * outlineColor.a;
  float outA = a + oa * (1.0 - a);
  vec3 outC = outA > 0.0 ? (col * a + outlineColor.rgb * oa * (1.0 - a)) / outA : vec3(0.0);
  gl_FragColor = vec4(outC, outA);
}`;

interface BakeOpts {
  cols: number;
  rows: number;
  /** Half-height of the orthographic view (world units). */
  half: number;
  target: number;
  shadow: number;
  /** Heading index (of SPRITE_HEADINGS) per column; default one column per heading. */
  headings?: readonly number[];
}

/** Session breaker: after repeated GL/bake failures, stop creating GL contexts (callers show a flat badge). */
const breaker = new BakeBreaker();

async function bake(opts: BakeOpts, drawCell: (col: number, row: number) => void, build: () => Promise<THREE.Object3D>, out: File, portrait?: File): Promise<string> {
  if (breaker.open) throw new Error('sprite baking disabled after repeated failures');
  try {
    const uri = await bakeOnce(opts, drawCell, build, out, portrait);
    breaker.ok();
    return uri;
  } catch (e) {
    breaker.fail();
    throw e;
  }
}

async function bakeOnce(opts: BakeOpts, drawCell: (col: number, row: number) => void, build: () => Promise<THREE.Object3D>, out: File, portrait?: File): Promise<string> {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const t0 = Date.now();
  const { cols, rows } = opts;
  const w = cols * CELL;
  const h = rows * CELL;
  const big = CELL * SUPERSAMPLE;
  const gl = (await GLView.createContextAsync()) as ExpoWebGLRenderingContext;
  const disposables: { dispose(): void }[] = [];
  try {
    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const maxRb = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (!sheetFits(cols, rows, CELL, SUPERSAMPLE, maxTex, maxRb)) throw new Error(`sprite sheet ${w}x${h} exceeds GPU limits ${maxTex}/${maxRb}`);
    const renderer = new THREE.WebGLRenderer({
      context: gl as unknown as WebGLRenderingContext,
      canvas: { width: w, height: h, style: {}, addEventListener: () => undefined, removeEventListener: () => undefined, clientHeight: h } as unknown as HTMLCanvasElement,
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
    });
    disposables.push(renderer);
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0);
    // Render targets bypass three's output tone mapping / colour space; the composite pass does both explicitly.
    renderer.toneMapping = THREE.NoToneMapping;
    const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    const cellRT = new THREE.WebGLRenderTarget(big, big, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: MSAA,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const sheet = new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false });
    disposables.push(cellRT, sheet);

    // --- studio scene: fixed to the camera so every heading is lit the same way (sun from the upper left)
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe4ecff, 0x8f8578, 0.9));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.0);
    key.position.set(-2.2, 4, 3.2);
    const fill = new THREE.DirectionalLight(0xc9d8ff, 0.5);
    fill.position.set(3, 1.5, 2);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(0.8, 2.5, -4);
    scene.add(key, fill, rim);
    const model = await build();
    scene.add(model);
    const shadowMesh = contactShadow(model, opts.shadow);
    disposables.push(shadowMesh.geometry, shadowMesh.material as THREE.Material);
    const shadowTex = (shadowMesh.material as THREE.MeshBasicMaterial).map;
    if (shadowTex) disposables.push(shadowTex);
    // Dispose per-bake cloned/toonified materials after snapshotting (geometries belong to the shared GLB cache).
    const mats = new Set<THREE.Material>();
    model.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (o === shadowMesh || !m) return;
      if (Array.isArray(m)) for (const x of m) mats.add(x);
      else mats.add(m);
    });
    for (const m of mats) disposables.push(m);
    // Map-like 3/4 camera: pitched ~30°, orthographic so every heading is the same size.
    const half = opts.half;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);
    cam.position.set(0, 2.6, 3.7);
    cam.lookAt(0, opts.target, 0);

    // --- composite pass (downsample + tone map + outline) into the sheet
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: COMPOSITE_VERT,
        fragmentShader: COMPOSITE_FRAG,
        uniforms: {
          src: { value: cellRT.texture },
          texel: { value: new THREE.Vector2(1 / big, 1 / big) },
          exposure: { value: EXPOSURE },
          outlineWidth: { value: 1.25 * SUPERSAMPLE },
          outlineColor: { value: new THREE.Vector4(0.07, 0.08, 0.14, 0.5) },
        },
        depthTest: false,
        depthWrite: false,
        transparent: false,
        blending: THREE.NoBlending,
        toneMapped: false,
      }),
    );
    disposables.push(quad.geometry, quad.material as THREE.Material);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    renderer.autoClear = false;
    renderer.setRenderTarget(sheet);
    renderer.setScissorTest(false);
    renderer.clear();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        drawCell(c, r);
        const heading = opts.headings?.[c] ?? c;
        model.rotation.y = (-heading / SPRITE_HEADINGS) * Math.PI * 2 + Math.PI; // heading 0 = moving north = seen from behind
        renderer.setRenderTarget(cellRT);
        renderer.setScissorTest(false);
        renderer.clear();
        renderer.render(scene, cam);
        const x = c * CELL;
        const y = h - (r + 1) * CELL;
        // With a render target bound, three.js uses the target's own viewport/scissor.
        sheet.viewport.set(x, y, CELL, CELL);
        sheet.scissor.set(x, y, CELL, CELL);
        sheet.scissorTest = true;
        renderer.setRenderTarget(sheet);
        renderer.render(quadScene, quadCam);
      }
    }
    // expo-gl queues GL calls; getError() is a synchronous round-trip that forces every queued draw to execute
    // before we snapshot (gl.flush() alone is not enough).
    gl.flush();
    gl.getError();
    const framebuffer = (renderer.properties.get(sheet) as { __webglFramebuffer: WebGLFramebuffer }).__webglFramebuffer;
    const snap = await GLView.takeSnapshotAsync(gl, { framebuffer, rect: { x: 0, y: 0, width: w, height: h }, format: 'png', compress: 1, flip: false });
    const src = new File(typeof snap.uri === 'string' ? snap.uri : String(snap.uri));
    if (out.exists) out.delete();
    src.move(out);
    if (portrait) {
      // The list portrait is the sheet's idle front-facing cell: one more snapshot, no second bake.
      const p = await GLView.takeSnapshotAsync(gl, { framebuffer, rect: { x: PORTRAIT_HEADING * CELL, y: h - CELL, width: CELL, height: CELL }, format: 'png', compress: 1, flip: false });
      if (portrait.exists) portrait.delete();
      new File(typeof p.uri === 'string' ? p.uri : String(p.uri)).move(portrait);
    }
    if (__DEV__) console.log(`sprite bake ${out.name}: ${cols}×${rows} cells in ${Date.now() - t0} ms`);
    return out.uri;
  } finally {
    for (const d of disposables.reverse()) {
      try {
        d.dispose();
      } catch {
        // A failed dispose must not mask the bake result or leak the context below.
      }
    }
    try {
      await GLView.destroyContextAsync(gl);
    } catch {
      // Context already gone.
    }
  }
}

const AVATAR_VIEW = { half: 0.64, target: 0.48, shadow: 0.42 };
/** Slightly wider framing so raised hands & mid-air star-jump limbs never clip on group freeze-frames. */
export const POSE_HALF = 0.74;
const POSE_VIEW = { half: POSE_HALF, target: 0.52, shadow: 0.42 };

export async function avatarSheet(cfg: AvatarConfig): Promise<string> {
  const out = avatarSheetFile(cfg);
  if (out.exists) return out.uri;
  return enqueue(async () => {
    if (out.exists) return out.uri;
    let rig: Awaited<ReturnType<typeof buildAvatar>> | null = null;
    return bake(
      { cols: SPRITE_HEADINGS, rows: AVATAR_FRAMES, ...AVATAR_VIEW },
      (_c, row) => rig && pose(rig, row === 0 ? 0 : row === 1 ? 1 : -1),
      async () => {
        rig = await buildAvatar(cfg);
        return rig.root;
      },
      out,
      portraitFile(cfg),
    );
  });
}

/** Lazy 16×8 expressive pose sheet baked only when crewmates cluster into a freeze-frame scene. */
export async function poseSheet(cfg: AvatarConfig): Promise<string> {
  const out = poseSheetFile(cfg);
  if (out.exists) return out.uri;
  return enqueue(async () => {
    if (out.exists) return out.uri;
    let rig: Awaited<ReturnType<typeof buildAvatar>> | null = null;
    return bake(
      { cols: SPRITE_HEADINGS, rows: POSE_SHEET_FRAMES, ...POSE_VIEW },
      (_c, row) => rig && actionPose(rig, row),
      async () => {
        rig = await buildAvatar(cfg);
        return rig.root;
      },
      out,
    );
  });
}

/** Heading 180° (facing the camera), idle. */
export const PORTRAIT_HEADING = SPRITE_HEADINGS / 2;

/**
 * One front-facing cell for lists and sheets: ~150 KB decoded instead of the 7 MB walk sheet. Normally written by
 * the walk-sheet bake (the config is on the map anyway); a 1-cell bake only when that sheet already exists.
 */
export async function avatarPortrait(cfg: AvatarConfig): Promise<string> {
  const out = portraitFile(cfg);
  if (out.exists) return out.uri;
  if (!avatarSheetFile(cfg).exists) {
    await avatarSheet(cfg);
    if (out.exists) return out.uri;
  }
  return enqueue(async () =>
    out.exists ? out.uri : bake({ cols: 1, rows: 1, headings: [PORTRAIT_HEADING], ...AVATAR_VIEW }, () => undefined, async () => (await buildAvatar(cfg)).root, out),
  );
}

/** Half-height of the ride sheet view; Sprites scales ride cells by RIDE_HALF / AVATAR_VIEW.half to keep world scale. */
export const RIDE_HALF = 0.95;
export const AVATAR_HALF = AVATAR_VIEW.half;

export function parkedSheetFile(car: CarConfig): File {
  return new File(dir, `k-${SPRITE_VERSION}-${hash(JSON.stringify(normalizeCar(car)))}.png`);
}

/** The empty vehicle, 16 headings, framed like the ride sheet (the parked car marker, D67). */
export async function parkedSheet(car: CarConfig): Promise<string> {
  const out = parkedSheetFile(car);
  if (out.exists) return out.uri;
  return enqueue(async () =>
    out.exists ? out.uri : bake({ cols: SPRITE_HEADINGS, rows: 1, half: RIDE_HALF, target: 0.3, shadow: 0.5 }, () => undefined, () => buildParked(car), out),
  );
}

/** The avatar riding their vehicle, 16 headings (shown while driving). */
export async function rideSheet(avatar: AvatarConfig, car: CarConfig): Promise<string> {
  const out = rideSheetFile(avatar, car);
  if (out.exists) return out.uri;
  return enqueue(async () =>
    out.exists ? out.uri : bake({ cols: SPRITE_HEADINGS, rows: 1, half: RIDE_HALF, target: 0.3, shadow: 0.5 }, () => undefined, () => buildRide(avatar, car), out),
  );
}
