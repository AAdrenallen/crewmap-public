/** Road-weather route warnings (D70): ECCC alert polygons + MTMD winter road conditions intersected with the route. */
export const ROAD_WEATHER = {
  /** The navigating phone re-fetches ECCC alerts for its route this often. */
  refreshMs: 15 * 60_000,
  /** Cached alerts are dropped after this (offline), on top of each alert's own expiry. */
  maxAgeMs: 3 * 3600_000,
  /** Route sampling step for point-in-polygon tests (m). */
  sampleM: 250,
  /** Warn once when the zone starts within this distance ahead (or immediately when we are already in it). */
  announceAheadM: 5000,
  /** MTMD condition segments count as on the route within this lateral distance (m). */
  corridorM: 60,
  /** MTMD segment conditions older than this are ignored (the layer is refreshed every few hours in winter). */
  conditionMaxAgeMs: 12 * 3600_000,
  /** Zones on the route closer together than this merge into one warning. */
  mergeGapM: 1500,
} as const;

export type RoadWeatherCategory = 'freezing' | 'snow' | 'fog' | 'slippery';

/** ECCC alert names (English) → category. Watches are skipped: they announce a possibility, not a road state. */
export const ECCC_NAME_RULES: { re: RegExp; category: RoadWeatherCategory }[] = [
  { re: /freezing (rain|drizzle)|flash freeze|ice/i, category: 'freezing' },
  { re: /snowfall|snow squall|winter storm|blizzard|blowing snow|winter weather/i, category: 'snow' },
  { re: /fog/i, category: 'fog' },
];

/** Special weather statements / generic advisories count only when their text says the roads are affected. */
export const ECCC_TEXT_SLIPPERY = /slippery|icy|black ice|freezing rain|glissant|verglas/i;

/** ECCC alert types we act on. */
export const ECCC_TYPES = new Set(['warning', 'advisory', 'statement']);
