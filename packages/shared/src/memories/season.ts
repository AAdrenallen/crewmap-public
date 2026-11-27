import { MEMORY } from './config';

export type SeasonKey = 'winter' | 'spring' | 'summer' | 'fall' | 'year';

/** Meteorological seasons (northern hemisphere); December belongs to the next year's winter. */
export function seasonOf(t: number, tzMin: number): { season: Exclude<SeasonKey, 'year'>; year: number } {
  const d = new Date(t + tzMin * 60_000);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  if (m === 11) return { season: 'winter', year: y + 1 };
  if (m <= 1) return { season: 'winter', year: y };
  if (m <= 4) return { season: 'spring', year: y };
  if (m <= 7) return { season: 'summer', year: y };
  return { season: 'fall', year: y };
}

/** [start, end) of a season (or the calendar year) in epoch ms, local time. */
export function seasonRange(season: SeasonKey, year: number, tzMin: number): [number, number] {
  const at = (y: number, m: number) => Date.UTC(y, m, 1) - tzMin * 60_000;
  switch (season) {
    case 'year':
      return [at(year, 0), at(year + 1, 0)];
    case 'winter':
      return [at(year - 1, 11), at(year, 2)];
    case 'spring':
      return [at(year, 2), at(year, 5)];
    case 'summer':
      return [at(year, 5), at(year, 8)];
    case 'fall':
      return [at(year, 8), at(year, 11)];
  }
}

/** What a season summary reads of each memory (no tracks). */
export interface MemoryDigest {
  id: string;
  start: number;
  end: number;
  kind: 'group' | 'notable';
  distanceM: number;
  members: string[];
  /** Named stops. */
  places: string[];
  photos: number;
  emotes: number;
}

export interface SeasonSummary {
  season: SeasonKey;
  year: number;
  range: [number, number];
  outings: number;
  groupOutings: number;
  km: number;
  hours: number;
  photos: number;
  emotes: number;
  /** Crewmates by outings shared, most first. */
  crew: { id: string; outings: number }[];
  /** Most visited named stops. */
  places: { name: string; n: number }[];
  longest: { id: string; km: number } | null;
  /** Month (0–11, local) with the most outings. */
  busiestMonth: number | null;
  /** Longest run of consecutive weeks with an outing. */
  weekStreak: number;
}

/**
 * The "year in review" style summary, computed on this phone from its own memories only. null when the period has
 * fewer than `MEMORY.seasonMinOutings` outings (nothing worth a card).
 */
export function seasonSummary(memories: readonly MemoryDigest[], season: SeasonKey, year: number, tzMin: number): SeasonSummary | null {
  const range = seasonRange(season, year, tzMin);
  const list = memories.filter((m) => m.start >= range[0] && m.start < range[1]);
  if (list.length < MEMORY.seasonMinOutings) return null;
  const crew = new Map<string, number>();
  const places = new Map<string, number>();
  const months = new Map<number, number>();
  const weeks = new Set<number>();
  for (const m of list) {
    for (const id of new Set(m.members)) crew.set(id, (crew.get(id) ?? 0) + 1);
    for (const p of new Set(m.places)) places.set(p, (places.get(p) ?? 0) + 1);
    const local = new Date(m.start + tzMin * 60_000);
    months.set(local.getUTCMonth(), (months.get(local.getUTCMonth()) ?? 0) + 1);
    // Monday-based week index since the epoch (1970-01-01 was a Thursday).
    weeks.add(Math.floor((Math.floor((m.start + tzMin * 60_000) / 86_400_000) + 3) / 7));
  }
  const sortedWeeks = [...weeks].sort((a, b) => a - b);
  let streak = 0;
  let run = 0;
  for (let i = 0; i < sortedWeeks.length; i++) {
    run = i > 0 && sortedWeeks[i]! === sortedWeeks[i - 1]! + 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }
  const longest = list.reduce<MemoryDigest | null>((a, b) => (!a || b.distanceM > a.distanceM ? b : a), null);
  const busiest = [...months].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return {
    season,
    year,
    range,
    outings: list.length,
    groupOutings: list.filter((m) => m.kind === 'group').length,
    km: Math.round(list.reduce((n, m) => n + m.distanceM, 0) / 100) / 10,
    hours: Math.round(list.reduce((n, m) => n + (m.end - m.start), 0) / 360_000) / 10,
    photos: list.reduce((n, m) => n + m.photos, 0),
    emotes: list.reduce((n, m) => n + m.emotes, 0),
    crew: [...crew].map(([id, outings]) => ({ id, outings })).sort((a, b) => b.outings - a.outings || a.id.localeCompare(b.id)),
    places: [...places].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 5),
    longest: longest ? { id: longest.id, km: Math.round(longest.distanceM / 100) / 10 } : null,
    busiestMonth: busiest ? busiest[0] : null,
    weekStreak: streak,
  };
}

/** The periods worth offering, newest first: the current and previous season, and this and last year. */
export function seasonChoices(memories: readonly MemoryDigest[], now: number, tzMin: number): { season: SeasonKey; year: number }[] {
  const cur = seasonOf(now, tzMin);
  const order: Exclude<SeasonKey, 'year'>[] = ['winter', 'spring', 'summer', 'fall'];
  const i = order.indexOf(cur.season);
  const prev = i === 0 ? { season: 'fall' as const, year: cur.year - 1 } : { season: order[i - 1]!, year: cur.year };
  const thisYear = new Date(now + tzMin * 60_000).getUTCFullYear();
  const cands: { season: SeasonKey; year: number }[] = [cur, prev, { season: 'year', year: thisYear }, { season: 'year', year: thisYear - 1 }];
  return cands.filter((c) => seasonSummary(memories, c.season, c.year, tzMin) !== null);
}
