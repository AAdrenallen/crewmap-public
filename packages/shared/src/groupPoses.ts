/**
 * Group scenes: crewmates at the same spot drawn in fun, expressive freeze-frame poses!
 * Each slot combines:
 *  - a 3D action pose (`action`: 0..7 — victory cheer, high-five jump, big wave, mid-air star jump, superhero stance,
 *    dance groove, selfie/peace lean, hype kick) from `poseSheet`, with `frame` (0..2) fallback while baking;
 *  - a 16-way heading column (col 8 faces the camera);
 *  - a non-overlapping 2D choreography slot (`x`, `y`, `jump` vertical air-lift, `scale`, `rot` lean, `mirror`, `z`).
 * Generates 600+ distinct fun freeze-frame scenes for every group size 2..8, and `pickGroupPose(ids, seed)` picks a
 * fresh freeze-frame on every session/open when `seed` advances!
 */

export const POSE_HEADINGS = 16;
export const POSE_FRONT = 8;
export const POSE_FRAMES = 3;
export const POSE_ACTIONS = 8;
export const POSE_MIN = 2;
export const POSE_MAX = 8;

export type ActionPoseId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PoseSlot {
  /** Offset in a unit box: x -1 (left) .. 1 (right), y -1 (back/up) .. 1 (front/down). */
  x: number;
  y: number;
  /** Vertical mid-air jump lift (0 = grounded, up to 0.35 = airborne). */
  jump: number;
  scale: number;
  /** Lean in degrees (positive = clockwise). */
  rot: number;
  mirror: boolean;
  z: number;
  /** Fallback walk-sheet row: 0 idle, 1 stride A, 2 stride B. */
  frame: 0 | 1 | 2;
  /** Expressive 3D pose-sheet row: 0 cheer, 1 high-five, 2 wave, 3 star-jump, 4 power, 5 dance, 6 selfie, 7 kick. */
  action: ActionPoseId;
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
  jump?: number;
}

/** Ring starting at -π/2 (left-to-right!) so n=2 places crewmates side-by-side at (-r, +r) instead of stacking at x=0! */
const circle = (n: number, r: number, faceIn: boolean, tilt = 0): Base[] =>
  Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + tilt + (i / n) * 2 * Math.PI;
    const x = Math.sin(a) * r;
    const y = -Math.cos(a) * r * 0.52;
    const raw = Math.round(((faceIn ? a + Math.PI : a) / (2 * Math.PI)) * POSE_HEADINGS);
    const wrapped = ((raw % POSE_HEADINGS) + POSE_HEADINGS) % POSE_HEADINGS;
    return { x, y, face: wrapped > 8 ? wrapped - 16 : wrapped };
  });

const row = (n: number, spread: number, y: number, face: number): Base[] =>
  Array.from({ length: n }, (_, i) => ({ x: n === 1 ? 0 : -spread + (2 * spread * i) / (n - 1), y, face }));

/** 18 fun multi-character formations — every formation keeps n=2..8 clearly separated horizontally so nobody stacks! */
const FORMATIONS: Record<string, (n: number) => Base[]> = {
  'high-five-duo': (n) => row(n, 0.58, 0.05, 0).map((b, i) => ({ ...b, face: i % 2 === 0 ? 2 : -2, jump: i % 2 === 0 ? 0.22 : 0.14 })),
  'group-hug': (n) => row(n, 0.54, 0, 0).map((b, i) => ({ ...b, y: (i % 2 ? 0.12 : -0.08), face: i < n / 2 ? 2 : -2 })),
  'shoulder-squad': (n) => row(n, 0.82, 0.04, 0),
  'huddle': (n) => circle(n, 0.56, true, 0.18),
  'high-five-circle': (n) => circle(n, 0.74, true).map((b, i) => ({ ...b, jump: (i % 2) * 0.18 })),
  'back-to-back': (n) => circle(n, 0.55, false, 0.12).map((b, i) => ({ ...b, face: i % 2 === 0 ? -3 : 3 })),
  'cheer-pyramid': (n) => {
    if (n === 2) return [{ x: -0.54, y: -0.2, face: 1, jump: 0.24 }, { x: 0.54, y: 0.2, face: -1 }];
    const top = Math.floor(n / 2);
    const bot = n - top;
    return [
      ...row(top, Math.max(0.32, 0.34 * (top - 1)), -0.36, 0).map((b) => ({ ...b, jump: 0.22 })),
      ...row(bot, Math.max(0.55, 0.36 * (bot - 1)), 0.32, 0),
    ];
  },
  'selfie-huddle': (n) =>
    circle(n, 0.6, false, 0.25).map((b, i) => ({
      ...b,
      y: b.y * 0.55 + (i === n - 1 ? 0.32 : -0.08),
      face: Math.round(b.face / 3),
    })),
  'conga-party': (n) => row(n, 0.84, 0, 3).map((b, i) => ({ ...b, y: (i % 2 ? 0.18 : -0.14), jump: (i % 2) * 0.15 })),
  'dance-battle': (n) => row(n, 0.8, 0, 0).map((b, i) => ({ ...b, y: i % 2 ? 0.28 : -0.26, face: i % 2 ? -2 : 2, jump: (i % 3 === 0 ? 0.2 : 0) })),
  'peace-arc': (n) => row(n, 0.82, 0, 0).map((b) => ({ ...b, y: -0.42 + b.x * b.x * 0.68, face: -Math.round(b.x * 2) })),
  'staggered-band': (n) =>
    n === 2
      ? [{ x: -0.58, y: -0.22, face: 1 }, { x: 0.58, y: 0.24, face: -1 }]
      : [...row(Math.ceil(n / 2), 0.74, -0.34, 0), ...row(Math.floor(n / 2), 0.58, 0.34, 0).map((b) => ({ ...b, x: b.x + 0.12 }))],
  'boyband-v': (n) => row(n, 0.8, 0, 0).map((b) => ({ ...b, y: 0.42 - Math.abs(b.x) * 0.75, face: Math.round(b.x * 2) })),
  'star-jump-burst': (n) => circle(n, 0.72, false).map((b, i) => ({ ...b, jump: 0.2 + (i % 2) * 0.12 })),
  'charlies-angels': (n) => row(n, 0.68, 0.08, 0).map((b, i) => ({ ...b, y: -Math.abs(b.x) * 0.35 + 0.18, face: i === 0 ? -3 : i === n - 1 ? 3 : 0 })),
  'photobomb-peek': (n) =>
    row(n, 0.76, 0.16, 0).map((b, i) => (i === 0 ? { x: b.x * 0.85, y: -0.45, face: 2, jump: 0.28 } : b)),
  'diagonal-strut': (n) => row(n, 0.78, 0, 1).map((b) => ({ ...b, y: b.x * 0.42 })),
  'kick-line': (n) => row(n, 0.76, 0.06, 0).map((b, i) => ({ ...b, jump: i % 2 === 0 ? 0.16 : 0.06 })),
};

/** 9 expressive 3D action choreographies + matching walk-frame fallbacks. */
const ACTIONS: Record<string, (i: number, n: number) => { action: ActionPoseId; frame: 0 | 1 | 2 }> = {
  'victory-cheer': (i) => ({ action: (i % 2 === 0 ? 0 : 2) as ActionPoseId, frame: 1 }),
  'high-five': (i) => ({ action: (i % 2 === 0 ? 1 : 0) as ActionPoseId, frame: (i % 2 ? 2 : 1) as 1 | 2 }),
  'star-jump': (i) => ({ action: (i % 2 === 0 ? 3 : 7) as ActionPoseId, frame: 2 }),
  'dance-groove': (i) => ({ action: (i % 2 === 0 ? 5 : 7) as ActionPoseId, frame: (i % 2 ? 1 : 2) as 1 | 2 }),
  'superhero-cool': (i) => ({ action: (i % 2 === 0 ? 4 : 6) as ActionPoseId, frame: 0 }),
  'wave-squad': (i, n) => ({ action: (i === 0 || i === n - 1 ? 2 : 6) as ActionPoseId, frame: (i === 0 || i === n - 1 ? 1 : 0) as 0 | 1 }),
  'selfie-peace': (i, n) => ({ action: (i === n - 1 ? 6 : (i % 2 ? 0 : 2)) as ActionPoseId, frame: (i === n - 1 ? 0 : 2) as 0 | 2 }),
  'hype-kick': (i) => ({ action: (i % 3 === 0 ? 7 : i % 3 === 1 ? 3 : 1) as ActionPoseId, frame: 2 }),
  'party-mix': (i) => ({ action: ([0, 5, 3, 2, 7, 1, 6, 4][i % 8]!) as ActionPoseId, frame: ([1, 2, 0][i % 3]!) as 0 | 1 | 2 }),
};

/** Lean & hop styles. */
const LEANS: Record<string, (x: number, i: number) => { rot: number; extraJump: number }> = {
  upright: () => ({ rot: 0, extraJump: 0 }),
  inward: (x) => ({ rot: -x * 13, extraJump: 0.04 }),
  outward: (x) => ({ rot: x * 13, extraJump: 0.08 }),
  'sway-hop': (_x, i) => ({ rot: i % 2 ? 10 : -10, extraJump: i % 2 ? 0.14 : 0 }),
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Ensures no two slots in any group (2..8) ever stack on top of each other, even near stage edges. */
function separateSlots(slots: Base[]): Base[] {
  const out = slots.map((s) => ({ ...s }));
  const minDist = out.length <= 2 ? 0.62 : out.length <= 4 ? 0.46 : 0.32;
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < minDist) {
          if (d < 0.03) {
            const ang = ((i * 3 + j * 5) % 8) * (Math.PI / 4);
            dx = Math.cos(ang) * 0.1;
            dy = Math.sin(ang) * 0.1;
            d = Math.hypot(dx, dy);
          }
          const push = (minDist - d) * 0.55;
          const ux = dx / d;
          const uy = dy / d;
          a.x = clamp(a.x - ux * push, -0.94, 0.94);
          b.x = clamp(b.x + ux * push, -0.94, 0.94);
          a.y = clamp(a.y - uy * push, -0.88, 0.88);
          b.y = clamp(b.y + uy * push, -0.88, 0.88);
        }
      }
    }
  }
  return out;
}

function buildFromBase(base: Base[], actName: string, leanName: string, mirror: boolean, n: number): PoseSlot[] {
  const actFn = ACTIONS[actName]!;
  const leanFn = LEANS[leanName]!;
  return base.map((b, i) => {
    const x = clamp(mirror ? -b.x : b.x, -1, 1);
    const y = clamp(b.y, -1, 1);
    const face = mirror ? -b.face : b.face;
    const { action, frame } = actFn(i, n);
    const { rot, extraJump } = leanFn(x, i);
    const jump = r2(clamp((b.jump ?? 0) + extraJump, 0, 0.35));
    return {
      x: r2(x),
      y: r2(y),
      jump,
      // Further back (smaller y) draws slightly smaller: natural depth.
      scale: r2(0.92 + (y + 1) * 0.07),
      rot: r2(rot),
      mirror,
      z: Math.round((y + 1) * 100) + i,
      frame,
      action,
      heading: (((POSE_FRONT + face) % POSE_HEADINGS) + POSE_HEADINGS) % POSE_HEADINGS,
    };
  });
}

const signature = (slots: PoseSlot[]) =>
  slots.map((s) => `${s.x},${s.y},${s.jump},${s.rot},${s.mirror ? 1 : 0},${s.action},${s.heading}`).join('|');
const cache = new Map<number, GroupPose[]>();

/** Every distinct freeze-frame pose for n members (2..8), in a stable order (600+ per count). */
export function posesFor(n: number): GroupPose[] {
  const k = Math.max(POSE_MIN, Math.min(POSE_MAX, Math.round(n)));
  const hit = cache.get(k);
  if (hit) return hit;
  const seen = new Set<string>();
  const out: GroupPose[] = [];
  for (const f of Object.keys(FORMATIONS)) {
    const base = separateSlots(FORMATIONS[f]!(k));
    for (const a of Object.keys(ACTIONS))
      for (const l of Object.keys(LEANS))
        for (const m of [false, true]) {
          const slots = buildFromBase(base, a, l, m, k);
          const sig = signature(slots);
          if (seen.has(sig)) continue;
          seen.add(sig);
          out.push({ name: `${f}/${a}/${l}${m ? '/mirrored' : ''}`, slots });
        }
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

/**
 * Picks a fun freeze-frame pose for this group: order-independent, deterministic for a given `seed`,
 * and different each time you open to the map when `seed` advances!
 */
export function pickGroupPose(memberIds: string[], seed = 0): GroupScene {
  const ids = [...new Set(memberIds)].sort();
  const n = Math.max(POSE_MIN, Math.min(POSE_MAX, ids.length));
  const shown = ids.slice(0, n);
  const key = seed === 0 ? ids.join('|') : `${ids.join('|')}#${seed}`;
  const h = stableHash(key);
  const list = posesFor(n);
  const pose = list[h % list.length]!;
  const rot = (h >>> 8) % Math.max(1, shown.length);
  const members = shown.map((_, i) => shown[(i + rot) % shown.length]!);
  return { pose, members };
}
