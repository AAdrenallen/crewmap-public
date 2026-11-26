/**
 * Free colours and special finishes on top of the avatar/ride palettes (re-exported by `./avatar`).
 *
 * Wire compatibility: older builds validate palette slots (`skin`, `hairColor`, ...) strictly and reset the whole
 * avatar on an unknown value. So a palette slot always holds the nearest palette entry, and the exact colour goes in
 * `hex` (a slot → `#RRGGBB` map) that older builds carry along and ignore. Finishes are optional `<slot>Finish` ids;
 * unknown ids read as none. Nothing here runs at module load (avatar.ts re-exports this file).
 */
import { AVATAR_PARTS, CAR_COLORS, type AvatarConfig, type AvatarPartKey, type CarConfig } from './avatar';

/** Append only; ids are on the wire. `none` is never stored. */
export const FINISHES = ['none', 'rainbow', 'psychedelic', 'holo', 'gold', 'chrome', 'galaxy', 'lava', 'ice', 'glitch', 'neon', 'camo', 'zebra', 'leopard', 'checker', 'stripes', 'tiedye', 'carbon', 'pixel'] as const;
export type FinishId = (typeof FINISHES)[number];
/** Finishes that move in the live preview (baked sprites show one still frame). */
export const ANIMATED_FINISHES: readonly FinishId[] = ['rainbow', 'psychedelic', 'holo', 'galaxy', 'lava', 'glitch', 'neon'];

/** Items that take a finish (`<item>Finish` on the avatar; `finish` on the ride paint). */
export const FINISH_ITEMS = ['hair', 'top', 'bottom', 'shoes', 'hat', 'accessory'] as const;
export type FinishItem = (typeof FINISH_ITEMS)[number];
export type FinishKey = `${FinishItem}Finish`;

export interface AvatarStyle {
  /** Exact colours for palette slots (only where they differ from the slot's stored palette value). */
  hex?: Partial<Record<string, string>>;
  hairFinish?: FinishId;
  topFinish?: FinishId;
  bottomFinish?: FinishId;
  shoesFinish?: FinishId;
  hatFinish?: FinishId;
  accessoryFinish?: FinishId;
}

export interface CarStyle {
  /** Exact paint (the `color` field keeps the nearest palette entry for older builds). */
  hex?: string;
  /** Accent/trim colour. */
  accent?: string;
  finish?: FinishId;
}

export const finishKey = (item: FinishItem): FinishKey => `${item}Finish`;

/** `#RRGGBB` (upper case) from `#RGB`/`#RRGGBB`/`RRGGBB` in any case; anything else is null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toUpperCase()}` : null;
}

export function normalizeFinish(v: unknown): FinishId {
  return (FINISHES as readonly unknown[]).includes(v) ? (v as FinishId) : 'none';
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Closest palette entry (weighted RGB distance). */
export function nearestColor<T extends string>(hex: string, palette: readonly T[]): T {
  const [r, g, b] = rgb(hex);
  let best = palette[0]!;
  let bestD = Infinity;
  for (const p of palette) {
    const [pr, pg, pb] = rgb(p);
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Config keys whose options are colours (`skin`, `hairColor`, ... including slots added later). */
export function colorSlots(): AvatarPartKey[] {
  return (Object.keys(AVATAR_PARTS) as AvatarPartKey[]).filter((k) => String(AVATAR_PARTS[k][0]).startsWith('#'));
}

/** The colour a slot is painted with. */
export function colorOf(cfg: AvatarConfig, slot: AvatarPartKey): string {
  return cfg.hex?.[slot] ?? String(cfg[slot]);
}

/** Config with a slot painted any colour; invalid input leaves it as is. */
export function withColor(cfg: AvatarConfig, slot: AvatarPartKey, color: string): AvatarConfig {
  const hex = normalizeHex(color);
  const palette = AVATAR_PARTS[slot] as readonly string[];
  if (!hex || !String(palette[0]).startsWith('#') || colorOf(cfg, slot) === hex) return cfg;
  const near = nearestColor(hex, palette);
  const map = { ...cfg.hex };
  if (near === hex) delete map[slot];
  else map[slot] = hex;
  const next = { ...cfg, [slot]: near } as AvatarConfig;
  if (Object.keys(map).length) next.hex = map;
  else delete next.hex;
  return next;
}

export function finishOf(cfg: AvatarConfig, item: FinishItem): FinishId {
  return cfg[finishKey(item)] ?? 'none';
}

export function withFinish(cfg: AvatarConfig, item: FinishItem, finish: FinishId): AvatarConfig {
  const next = { ...cfg };
  if (finish === 'none') delete next[finishKey(item)];
  else next[finishKey(item)] = finish;
  return next;
}

/**
 * Canonical style fields of a stored avatar (fixed key order, `none` and redundant hexes dropped), so equal looks
 * hash to one sprite sheet. `cfg` is the already-normalised palette part.
 */
export function normalizeStyle(raw: Record<string, unknown>, cfg: AvatarConfig): AvatarStyle {
  const out: AvatarStyle = {};
  const src = raw.hex && typeof raw.hex === 'object' ? (raw.hex as Record<string, unknown>) : {};
  const hex: Record<string, string> = {};
  for (const slot of colorSlots()) {
    const h = normalizeHex(src[slot]);
    if (h && h !== cfg[slot]) hex[slot] = h;
  }
  if (Object.keys(hex).length) out.hex = hex;
  for (const item of FINISH_ITEMS) {
    const f = normalizeFinish(raw[finishKey(item)]);
    if (f !== 'none') out[finishKey(item)] = f;
  }
  return out;
}

export function carColorOf(car: CarConfig): string {
  return car.hex ?? car.color;
}

export function withCarColor(car: CarConfig, color: string): CarConfig {
  const hex = normalizeHex(color);
  if (!hex || carColorOf(car) === hex) return car;
  const near = nearestColor(hex, CAR_COLORS);
  const next: CarConfig = { ...car, color: near };
  if (near === hex) delete next.hex;
  else next.hex = hex;
  return next;
}

/** Rides whose kit node has an `accent` material (plates, pinstripes, fins, ...); checked against cars.glb in tests. */
export const RIDES_WITH_ACCENT: readonly string[] = ['compact', 'hatchback', 'pickup', 'suv', 'sports', 'van', 'convertible', 'motorcycle', 'skateboard', 'rocket', 'carpet'];

export function withCarAccent(car: CarConfig, color: string | null): CarConfig {
  const next = { ...car };
  const hex = normalizeHex(color);
  if (hex) next.accent = hex;
  else delete next.accent;
  return next;
}

export function withCarFinish(car: CarConfig, finish: FinishId): CarConfig {
  const next = { ...car };
  if (finish === 'none') delete next.finish;
  else next.finish = finish;
  return next;
}

/** Canonical style fields of a stored ride (fixed key order). */
export function normalizeCarStyle(raw: Record<string, unknown>, color: CarConfig['color']): CarStyle {
  const out: CarStyle = {};
  const hex = normalizeHex(raw.hex);
  if (hex && hex !== color) out.hex = hex;
  const accent = normalizeHex(raw.accent);
  if (accent) out.accent = accent;
  const finish = normalizeFinish(raw.finish);
  if (finish !== 'none') out.finish = finish;
  return out;
}

/** Most-recent-first list of picked colours, de-duplicated and capped. */
export const RECENT_COLORS_MAX = 8;
export function pushRecentColor(list: readonly string[], color: string, max = RECENT_COLORS_MAX): string[] {
  const hex = normalizeHex(color);
  if (!hex) return [...list];
  return [hex, ...list.filter((c) => c !== hex)].slice(0, max);
}
