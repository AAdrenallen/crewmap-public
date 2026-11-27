/**
 * Group scenes: crewmates on one spot drawn as a frozen group pose built from their EXISTING baked sprites.
 * The rig bakes 3 frames (0 idle, 1 stride A, 2 stride B) x 16 headings (col 8 faces the camera), so a "pose" here is,
 * per slot, a frame + heading column plus a 2D transform (offset in a unit box, scale, lean, mirror, z-order).
 * The library is generated: formations x frame patterns x lean styles x mirroring, names built in code.
 */

/** Must match the sprite sheet (packages/shared avatar SPRITE_HEADINGS / baker AVATAR_FRAMES). */
export const POSE_HEADINGS = 16;
export const POSE_FRONT = 8;
export const POSE_FRAMES = 3;
export const POSE_MIN = 2;
export const POSE_MAX = 8;

export interface PoseSlot {
  /** Offset in a unit box: x -1 (left) .. 1 (right), y -1 (back/up) .. 1 (front/down). */
  x: number;
  y: number;
  scale: number;
  /** Lean in degrees (positive = clockwise). */
  rot: number;
  mirror: boolean;
  z: number;
  /** Sprite sheet row: 0 idle, 1 stride A, 2 stride B. */
  frame: 0 | 1 | 2;
  /** Sprite sheet column 0..15 (8 faces the camera). */
  heading: number;
}

export interface GroupPose {
  name: string;
  slots: PoseSlot[];
}

interface Base {
  x: number;
  y: number;
  /** Facing as an offset from the front column (-8..8). */
  face: number;
}

const circle = (n: number, r: number, faceIn: boolean): Base[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const x = Math.sin(a) * r;
    const y = -Math.cos(a) * r * 0.55;
    // Facing the centre (in) or away (out): heading offset follows the angle round the ring.
    const face = Math.round(((faceIn ? a + Math.PI : a) / (2 * Math.PI)) * POSE_HEADINGS) % POSE_HEADINGS;
    return { x, y, face: face > 8 ? face - 16 : face };
  });
const row = (n: number, spread: number, y: number, face: number): Base[] =>
  Array.from({ length: n }, (_, i) => ({ x: n === 1 ? 0 : -spread + (2 * spread * i) / (n - 1), y, face }));

/** Formations: name -> base slots for n members (left to right, back to front). */
const FORMATIONS: Record<string, (n: number) => Base[]> = {
  'group-hug': (n) => row(n, 0.45, 0, 0).map((b, i) => ({ ...b, face: i < n / 2 ? 2 : -2 })),
  'shoulder-line': (n) => row(n, 0.8, 0, 0),
  'huddle': (n) => circle(n, 0.35, true),
  'high-five-circle': (n) => circle(n, 0.7, true),
  'back-to-back': (n) => circle(n, 0.4, false),
  'pyramid': (n) => {
    const out: Base[] = [];
    let left = n;
    for (let r = 0; left > 0; r++) {
      const k = Math.min(left, r + 1);
      out.push(...row(k, 0.25 * (k - 1), -0.6 + r * 0.45, 0));
      left -= k;
    }
    return out;
  },
  'selfie': (n) => circle(n, 0.45, false).map((b) => ({ ...b, y: b.y * 0.5 + 0.2, face: Math.round(b.face / 3) })),
  'conga-line': (n) => row(n, 0.85, 0, 4).map((b, i) => ({ ...b, y: (i % 2) * 0.1 })),
  'dance-zigzag': (n) => row(n, 0.8, 0, 0).map((b, i) => ({ ...b, y: i % 2 ? 0.3 : -0.3, face: i % 2 ? 3 : -3 })),
  'arc': (n) => row(n, 0.8, 0, 0).map((b) => ({ ...b, y: -0.5 + b.x * b.x * 0.7, face: -Math.round(b.x * 3) })),
  'two-rows': (n) => [
    ...row(Math.ceil(n / 2), 0.7, -0.35, 0),
    ...row(Math.floor(n / 2), 0.5, 0.35, 0),
  ],
  'wedge': (n) => row(n, 0.75, 0, 0).map((b) => ({ ...b, y: 0.5 - Math.abs(b.x) * 0.8, face: Math.round(b.x * 2) })),
};

/** Frame patterns: slot index (and count) -> sprite frame. */
const FRAMES: Record<string, (i: number, n: number) => 0 | 1 | 2> = {
  still: () => 0,
  stride: () => 1,
  march: (i) => (i % 2 ? 2 : 1),
  'outer-move': (i, n) => (i === 0 || i === n - 1 ? 1 : 0),
  'centre-move': (i, n) => (i === 0 || i === n - 1 ? 0 : 2),
};

/** Lean styles: (x, i) -> rotation in degrees. */
const LEANS: Record<string, (x: number, i: number) => number> = {
  upright: () => 0,
  inward: (x) => -x * 12,
  outward: (x) => x * 12,
  sway: (_x, i) => (i % 2 ? 8 : -8),
};

const r2 = (v: number) => Math.round(v * 100) / 100;

function build(formation: string, frames: string, lean: string, mirror: boolean, n: number): PoseSlot[] {
  const base = FORMATIONS[formation]!(n);
  const fr = FRAMES[frames]!;
  const ln = LEANS[lean]!;
  return base.map((b, i) => {
    const x = mirror ? -b.x : b.x;
    const face = mirror ? -b.face : b.face;
    return {
      x: r2(x),
      y: r2(b.y),
      // Further back (smaller y) draws slightly smaller: cheap depth.
      scale: r2(0.9 + (b.y + 1) * 0.08),
      rot: r2(ln(x, i)),
      mirror,
      z: Math.round((b.y + 1) * 100) + i,
      frame: fr(i, n),
      heading: (((POSE_FRONT + face) % POSE_HEADINGS) + POSE_HEADINGS) % POSE_HEADINGS,
    };
  });
}

const signature = (slots: PoseSlot[]) => JSON.stringify(slots);
const cache = new Map<number, GroupPose[]>();

/** Every distinct pose for n members (2..8), in a stable order. */
export function posesFor(n: number): GroupPose[] {
  const k = Math.max(POSE_MIN, Math.min(POSE_MAX, Math.round(n)));
  const hit = cache.get(k);
  if (hit) return hit;
  const seen = new Set<string>();
  const out: GroupPose[] = [];
  for (const f of Object.keys(FORMATIONS))
    for (const fr of Object.keys(FRAMES))
      for (const l of Object.keys(LEANS))
        for (const m of [false, true]) {
          const slots = build(f, fr, l, m, k);
          const sig = signature(slots);
          if (seen.has(sig)) continue;
          seen.add(sig);
          out.push({ name: `${f}/${fr}/${l}${m ? '/mirrored' : ''}`, slots });
        }
  cache.set(k, out);
  return out;
}

/** FNV-1a 32-bit. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface GroupScene {
  pose: GroupPose;
  /** Member id per slot (same length as pose.slots). */
  members: string[];
}

/** The pose for this group: deterministic per member set (order-independent), slots filled in a stable order. */
export function pickGroupPose(memberIds: string[]): GroupScene {
  const ids = [...new Set(memberIds)].sort();
  const n = Math.max(POSE_MIN, Math.min(POSE_MAX, ids.length));
  const shown = ids.slice(0, n);
  const h = stableHash(ids.join('|'));
  const list = posesFor(n);
  const pose = list[h % list.length]!;
  const rot = (h >>> 8) % Math.max(1, shown.length);
  const members = shown.map((_, i) => shown[(i + rot) % shown.length]!);
  return { pose, members };
}
