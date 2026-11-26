import { comboPlan, EMOTE_COMBO } from './emoteCombo';
import { intersects, type Rect } from './emotes';

/**
 * Life360-style edge pop-ins: emoji pop in from the side edges (and top/bottom) in a staggered cascade that grows
 * with the count. Pure planner: positions never overlap the occupied layout rects (route banner, next turn, speed,
 * chat bubbles…). Driving: a couple of small, soft pops.
 */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export const EDGE_BURST = {
  sizeDp: 34,
  drivingSizeDp: 28,
  margin: 8,
  /** Pops per emote; bursts * pops stay under EMOTE_COMBO.maxParticles. */
  idleBase: 6,
  idlePerExtra: 4,
  drivingPops: 2,
  /** Stagger between pops, shrinking as the cascade builds. */
  firstGapMs: 140,
  minGapMs: 35,
  lifeMs: 1700,
  drivingLifeMs: 1400,
  /** How far each pop slides in from its edge. */
  travelDp: 56,
} as const;

export interface EdgePop {
  edge: Edge;
  /** Resting top-left of the emoji. */
  x: number;
  y: number;
  delayMs: number;
  scale: number;
  /** Small wobble, degrees. */
  tilt: number;
}

export interface EdgePlan {
  pops: EdgePop[];
  durationMs: number;
  /** Where the sender chip sits (top-left), clear of occupied rects; null = none fits. */
  chip: { x: number; y: number } | null;
}

/** Tiny deterministic PRNG so a plan is reproducible from the emote id. */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Candidate resting slots along the edges that clear every occupied rect (padded by the margin). */
export function edgeSlots(screen: { w: number; h: number }, size: number, occupied: readonly Rect[], edges: readonly Edge[], margin: number = EDGE_BURST.margin): { edge: Edge; x: number; y: number }[] {
  const step = Math.round(size * 0.8);
  const out: { edge: Edge; x: number; y: number }[] = [];
  const free = (x: number, y: number) => {
    const r = { x: x - margin, y: y - margin, w: size + 2 * margin, h: size + 2 * margin };
    return x >= 0 && y >= 0 && x + size <= screen.w && y + size <= screen.h && !occupied.some((o) => intersects(r, o));
  };
  for (const edge of edges) {
    if (edge === 'left' || edge === 'right') {
      const x = edge === 'left' ? margin : screen.w - margin - size;
      for (let y = margin; y + size <= screen.h - margin; y += step) if (free(x, y)) out.push({ edge, x, y });
    } else {
      const y = edge === 'top' ? margin : screen.h - margin - size;
      for (let x = margin * 2 + size; x + size <= screen.w - margin * 2 - size; x += step) if (free(x, y)) out.push({ edge, x, y });
    }
  }
  return out;
}

export function edgePopCount(count: number, driving: boolean): number {
  if (driving) return EDGE_BURST.drivingPops;
  const n = Math.max(1, Math.floor(count));
  return Math.min(EMOTE_COMBO.maxParticles, EDGE_BURST.idleBase + (n - 1) * EDGE_BURST.idlePerExtra);
}

export function planEdgeBurst(o: {
  screen: { w: number; h: number };
  count: number;
  driving: boolean;
  occupied: readonly Rect[];
  seed: number;
  chipSize?: { w: number; h: number };
}): EdgePlan {
  const rand = rng(o.seed);
  const size = o.driving ? EDGE_BURST.drivingSizeDp : EDGE_BURST.sizeDp;
  const edges: Edge[] = ['left', 'right', 'top', 'bottom'];
  const slots = edgeSlots(o.screen, size, o.occupied, edges);
  const want = edgePopCount(o.count, o.driving);
  const intensity = comboPlan(o.count).intensity;
  const pops: EdgePop[] = [];
  // Shuffle once, then cycle: no slot reused until all are, so the cascade spreads around the screen.
  const order = slots.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map((e) => e.s);
  let t = 0;
  for (let i = 0; i < want && order.length; i++) {
    const s = order[i % order.length]!;
    pops.push({
      edge: s.edge,
      x: s.x,
      y: s.y,
      delayMs: Math.round(t),
      scale: o.driving ? 0.9 : (0.8 + rand() * 0.35) * (1 + intensity * 0.4),
      tilt: o.driving ? 0 : (rand() - 0.5) * 30,
    });
    t += Math.max(EDGE_BURST.minGapMs, EDGE_BURST.firstGapMs * Math.pow(0.9, i));
  }
  const life = o.driving ? EDGE_BURST.drivingLifeMs : EDGE_BURST.lifeMs;
  return { pops, durationMs: (pops.at(-1)?.delayMs ?? 0) + life, chip: o.chipSize ? placeChip(o.screen, o.chipSize, o.occupied, pops[0]) : null };
}

/** Sender chip: next to the first pop when it fits, else the first free spot down the side edges. */
function placeChip(screen: { w: number; h: number }, size: { w: number; h: number }, occupied: readonly Rect[], near: EdgePop | undefined): { x: number; y: number } | null {
  const m = EDGE_BURST.margin;
  const fits = (x: number, y: number) => {
    const r = { x: x - m, y: y - m, w: size.w + 2 * m, h: size.h + 2 * m };
    return x >= 0 && y >= 0 && x + size.w <= screen.w && y + size.h <= screen.h && !occupied.some((o) => intersects(r, o));
  };
  const tries: { x: number; y: number }[] = [];
  if (near) {
    const right = near.edge === 'right';
    const x = right ? screen.w - m - size.w : m;
    tries.push({ x, y: near.y + EDGE_BURST.sizeDp + 4 }, { x, y: near.y - size.h - 4 });
  }
  for (let y = m; y + size.h <= screen.h - m; y += 16) tries.push({ x: m, y }, { x: screen.w - m - size.w, y });
  return tries.find((p) => fits(p.x, p.y)) ?? null;
}

/** Escalating audio layers for a cascade: which pops ring a sting, at what volume and rate (pitch), capped. */
export interface AudioLayer {
  delayMs: number;
  volume: number;
  /** Playback rate without pitch correction: > 1 = higher, so the build-up climbs. */
  rate: number;
}

export const EDGE_AUDIO = { maxLayers: 6, baseVolume: 0.45, volumeStep: 0.08, maxVolume: 0.9, rateStep: 0.04, maxRate: 1.25 } as const;

export function audioLayers(plan: EdgePlan, count: number): AudioLayer[] {
  const n = Math.min(EDGE_AUDIO.maxLayers, Math.max(0, Math.floor(count) - 1), plan.pops.length);
  if (n <= 0) return [];
  const stride = Math.max(1, Math.floor(plan.pops.length / n));
  return Array.from({ length: n }, (_, i) => ({
    delayMs: plan.pops[Math.min(plan.pops.length - 1, i * stride)]!.delayMs,
    volume: Math.min(EDGE_AUDIO.maxVolume, EDGE_AUDIO.baseVolume + i * EDGE_AUDIO.volumeStep),
    rate: Math.min(EDGE_AUDIO.maxRate, 1 + i * EDGE_AUDIO.rateStep),
  }));
}
