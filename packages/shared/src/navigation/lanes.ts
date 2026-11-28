import type { Lane, ManeuverModifier } from './route';

/** Lane-guidance tunables. */
export const LANE_LIMITS = {
  /** Strips wider than this are treated as bad data and hidden. */
  maxLanes: 10,
  /** A single lane carries no choice — nothing to show. */
  minLanes: 2,
} as const;

/** Canonical lane indication (Mapbox `directions` / `indications`, OSM `turn:lanes` spellings). */
export type LaneIndication = 'uturn' | 'sharp left' | 'left' | 'slight left' | 'straight' | 'slight right' | 'right' | 'sharp right' | 'merge-left' | 'merge-right' | 'none';

const ALIASES: Record<string, LaneIndication> = {
  uturn: 'uturn',
  'u-turn': 'uturn',
  reverse: 'uturn',
  'sharp left': 'sharp left',
  sharp_left: 'sharp left',
  left: 'left',
  'slight left': 'slight left',
  slight_left: 'slight left',
  merge_to_left: 'merge-left',
  straight: 'straight',
  through: 'straight',
  'slight right': 'slight right',
  slight_right: 'slight right',
  merge_to_right: 'merge-right',
  right: 'right',
  'sharp right': 'sharp right',
  sharp_right: 'sharp right',
  none: 'none',
  '': 'none',
};

/** Left-to-right sort order of indications inside one lane glyph. */
export const INDICATION_ORDER: readonly LaneIndication[] = ['uturn', 'sharp left', 'left', 'merge-left', 'slight left', 'straight', 'none', 'slight right', 'merge-right', 'right', 'sharp right'];

export function normalizeIndication(s: string | undefined): LaneIndication | null {
  if (s === undefined) return null;
  return ALIASES[s.trim().toLowerCase()] ?? null;
}

/** Raw lane shape from Mapbox banner `sub` components (`directions`, `active`, `active_direction`) or intersections (`indications`, `valid`, `valid_indication`). */
export interface RawLane {
  type?: string;
  directions?: string[];
  indications?: string[];
  active?: boolean;
  valid?: boolean;
  active_direction?: string;
  valid_indication?: string;
}

/** One physical lane per raw entry, indications de-duplicated and ordered left→right. Unknown spellings become 'none'. */
export function parseLanes(raw: readonly RawLane[] | undefined): Lane[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((c) => {
    const ind = new Set<LaneIndication>();
    for (const d of c.indications ?? c.directions ?? []) ind.add(normalizeIndication(d) ?? 'none');
    if (ind.size === 0) ind.add('none');
    if (ind.size > 1) ind.delete('none');
    const directions = INDICATION_ORDER.filter((i) => ind.has(i));
    const valid = c.valid ?? c.active ?? false;
    const lane: Lane = { directions, valid, active: c.active ?? valid };
    const dir = normalizeIndication(c.active_direction ?? c.valid_indication);
    if (valid && dir && directions.includes(dir)) lane.activeDirection = dir;
    return lane;
  });
}

const SIDE: Record<LaneIndication, number> = { uturn: -3, 'sharp left': -3, left: -2, 'slight left': -1, 'merge-left': -1, straight: 0, none: 0, 'slight right': 1, 'merge-right': 1, right: 2, 'sharp right': 3 };

/** Indication of `lane` that matches the route maneuver, if any. */
export function matchingIndication(lane: Lane, modifier: ManeuverModifier | undefined): LaneIndication | null {
  const dirs = lane.directions as LaneIndication[];
  if (lane.activeDirection) return lane.activeDirection as LaneIndication;
  if (!lane.valid) return null;
  const m = normalizeIndication(modifier ?? 'straight') ?? 'straight';
  if (dirs.includes(m)) return m;
  // Same side (e.g. 'left' lane for a 'slight left' maneuver).
  const side = Math.sign(SIDE[m]);
  return dirs.find((d) => Math.sign(SIDE[d]) === side && d !== 'none') ?? (dirs.length === 1 ? dirs[0]! : null);
}

/**
 * Lanes worth showing for a maneuver, or null to hide the strip: too few/many lanes, no valid lane, every lane
 * valid (no choice to make), or a valid lane whose arrows contradict the maneuver side.
 */
export function laneStrip(
  bannerLanes: readonly Lane[] | null | undefined,
  modifier: ManeuverModifier | undefined,
  intersectionLanes?: readonly Lane[] | null,
): Lane[] | null {
  const lanes = reconcileLanes(bannerLanes, intersectionLanes);
  if (!lanes || lanes.length < LANE_LIMITS.minLanes || lanes.length > LANE_LIMITS.maxLanes) return null;
  const valid = lanes.filter((l) => l.valid);
  if (valid.length === 0 || valid.length === lanes.length) return null;
  if (lanes.every((l) => l.directions.length === 1 && l.directions[0] === 'none')) return null;
  const m = normalizeIndication(modifier ?? 'straight') ?? 'straight';
  const side = Math.sign(SIDE[m]);
  for (const l of valid) {
    const sides = (l.directions as LaneIndication[]).filter((d) => d !== 'none').map((d) => Math.sign(SIDE[d]));
    if (sides.length > 0 && m !== 'uturn' && !sides.includes(side)) return null;
  }
  return lanes.map((l) => ({ ...l }));
}

function merge(a: Lane, b: Lane): Lane {
  const set = new Set([...a.directions, ...b.directions]);
  if (set.size > 1) set.delete('none');
  const lane: Lane = { directions: INDICATION_ORDER.filter((i) => set.has(i)), valid: a.valid || b.valid, active: a.active || b.active };
  const dir = a.activeDirection ?? b.activeDirection;
  if (dir) lane.activeDirection = dir;
  return lane;
}

const isBay = (l: Lane, edge: 'left' | 'right'): boolean => {
  if (l.valid || l.directions.length !== 1) return false;
  const d = l.directions[0] as LaneIndication;
  return edge === 'left' ? d === 'left' || d === 'sharp left' || d === 'uturn' : d === 'right' || d === 'sharp right';
};

/**
 * Folds a turn bay at the edge of the strip (a lone `[left]` on the far left / `[right]` on the far right) into its
 * neighbour when neither is used by our maneuver. Short pockets (OSM `width:lanes:start=0`) are often mapped as a
 * full lane; for a driver who is not turning there, one composite "straight+left" lane is what they see on the road.
 * Lanes we drive in, or bays our maneuver uses, are never merged.
 */
export function foldUnusedBays(lanes: readonly Lane[]): Lane[] {
  const out = lanes.map((l) => ({ ...l, directions: [...l.directions] }));
  if (out.length > LANE_LIMITS.minLanes && isBay(out[0]!, 'left') && !out[1]!.valid && out[1]!.directions.includes('straight')) {
    out.splice(0, 2, merge(out[0]!, out[1]!));
  }
  const n = out.length;
  if (n > LANE_LIMITS.minLanes && isBay(out[n - 1]!, 'right') && !out[n - 2]!.valid && out[n - 2]!.directions.includes('straight')) {
    out.splice(n - 2, 2, merge(out[n - 2]!, out[n - 1]!));
  }
  return out;
}

/** Merges adjacent lanes that share a movement until there are `count` lanes; null when that is ambiguous. */
function mergeToCount(lanes: readonly Lane[], count: number): Lane[] | null {
  let cur = foldUnusedBays(lanes);
  while (cur.length > count) {
    const pairs: number[] = [];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i]!;
      const b = cur[i + 1]!;
      if (a.valid === b.valid && a.directions.some((d) => b.directions.includes(d) || (d !== 'straight' && b.directions.includes('straight')) || (b.directions.length === 1 && a.directions.includes('straight')))) pairs.push(i);
    }
    if (pairs.length !== 1) return null;
    const i = pairs[0]!;
    cur = [...cur.slice(0, i), merge(cur[i]!, cur[i + 1]!), ...cur.slice(i + 2)];
  }
  return cur.length === count ? cur : null;
}

/**
 * Banner `sub` lanes and the lanes on the maneuver intersection describe the same approach. When they disagree in
 * count, the longer list is merged down to the shorter one; if that is ambiguous, the strip is hidden.
 * Unused edge bays are folded in every case (see `foldUnusedBays`).
 */
export function reconcileLanes(banner: readonly Lane[] | null | undefined, intersection: readonly Lane[] | null | undefined): Lane[] | null {
  const a = banner && banner.length > 0 ? banner : null;
  const b = intersection && intersection.length > 0 ? intersection : null;
  if (!a && !b) return null;
  if (!a || !b) return foldUnusedBays((a ?? b)!);
  if (a.length === b.length) return foldUnusedBays(a);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  const merged = mergeToCount(long, foldUnusedBays(short).length);
  // Fall back to Mapbox's banner lanes rather than blanking lane guidance on ambiguous intersection count mismatches.
  return merged ?? foldUnusedBays(a);
}
