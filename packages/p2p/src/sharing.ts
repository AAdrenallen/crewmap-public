import { coarsen } from '@crewmap/shared/geo';
import { DEFAULT_VISIBILITY, restrictShared, type SharedStats, type StatsVisibility } from '@crewmap/shared/stats';
import type { Presence } from './presence';

/**
 * Per-crew sharing policy: what THIS device reveals to ONE crew. Enforced on the sending side only — data a policy
 * forbids is stripped before it is sealed, so no member of that crew can ever decrypt it.
 */
export type LocationShare = 'exact' | 'approx' | 'city' | 'hidden';

export interface SharingPolicy {
  location: LocationShare;
  /** Live speed, heading, activity (driving status) and navigation ETA. */
  speed: boolean;
  battery: boolean;
  /** Driving stats, scores and leaderboard entries. */
  stats: boolean;
  /** Trip history: trip counts / longest trip inside the stats summary. */
  trips: boolean;
  /** Shared places in the crew doc, arrival/departure/driving-home notifications. */
  places: boolean;
  emotes: boolean;
  /** Text chat (only when emotes are allowed too, see chatAllowed). */
  chat: boolean;
  /** Which stats fields this crew sees (when `stats` is on). Its `trips` field is folded into `trips` above (D52). */
  statsVis: StatsVisibility;
  /** Drive-along with this phone. Only set by a per-friend override; absent = allowed when location is exact. */
  driveAlong?: boolean;
  /** Safety check-in (D66): this crew is told where I stopped if I don't answer. Opt-in: absent = off. */
  checkIn?: boolean;
}

export const DEFAULT_SHARING: SharingPolicy = {
  location: 'exact',
  speed: true,
  battery: true,
  stats: true,
  trips: true,
  places: true,
  emotes: true,
  chat: true,
  statsVis: { ...DEFAULT_VISIBILITY },
};

export const chatAllowed = (pol: SharingPolicy): boolean => pol.emotes && pol.chat;

/** Grid sizes for the coarse precisions (m). */
export const SHARE_CELL_M = { approx: 2000, city: 20_000 } as const;

export function normalizePolicy(p: Partial<SharingPolicy> | null | undefined): SharingPolicy {
  return { ...DEFAULT_SHARING, ...(p ?? {}), statsVis: { ...DEFAULT_SHARING.statsVis, ...(p?.statsVis ?? {}) } };
}

/**
 * Per-friend override (D52): what ONE friend sees beyond (or below) the crew policy. Keyed by deviceId and applied
 * in every crew that carries that friend, so a restriction cannot leak through another crew. Absent field = crew
 * default. Places are not here: they live in the crew-wide Yjs doc, where a per-member restriction cannot be enforced.
 * Stats are (D56): the stats aggregate is sealed per recipient, gated by statsAllowed().
 */
export interface UserOverride {
  location?: LocationShare;
  /** Speed, heading, activity and ETA (same grouping as the crew policy). */
  speed?: boolean;
  /** Battery level and charging. */
  battery?: boolean;
  driveAlong?: boolean;
  /** Stats at all, trip history, and per-field visibility (D56). */
  stats?: boolean;
  trips?: boolean;
  statsVis?: Partial<StatsVisibility>;
  /** Safety check-in alerts to this friend (D66). */
  checkIn?: boolean;
}

export const OVERRIDE_KEYS = ['location', 'speed', 'battery', 'driveAlong', 'stats', 'trips', 'statsVis', 'checkIn'] as const satisfies readonly (keyof UserOverride)[];

/** Override ?? crew policy. */
export function resolveShare(pol: SharingPolicy, ov: UserOverride | null | undefined): SharingPolicy {
  if (!ov) return pol;
  const out: SharingPolicy = { ...pol };
  if (ov.location !== undefined) out.location = ov.location;
  if (ov.speed !== undefined) out.speed = ov.speed;
  if (ov.battery !== undefined) out.battery = ov.battery;
  if (ov.driveAlong !== undefined) out.driveAlong = ov.driveAlong;
  if (ov.stats !== undefined) out.stats = ov.stats;
  if (ov.trips !== undefined) out.trips = ov.trips;
  if (ov.statsVis) out.statsVis = { ...pol.statsVis, ...ov.statsVis };
  if (ov.checkIn !== undefined) out.checkIn = ov.checkIn;
  return out;
}

/**
 * May a safety check-in alert (with the exact stop position) go to this friend (D66)? Only when the resolved policy
 * opts in. A friend hidden by their own override is left out unless that override opts them in explicitly.
 */
export function checkInAllowed(resolved: SharingPolicy, ov?: UserOverride | null): boolean {
  if (resolved.checkIn !== true) return false;
  return ov?.location !== 'hidden' || ov.checkIn === true;
}

/** Remove unset fields; null when nothing is overridden (the friend follows the crew). */
export function cleanOverride(ov: UserOverride): UserOverride | null {
  const out: Record<string, unknown> = {};
  for (const k of OVERRIDE_KEYS) if (ov[k] !== undefined && !(k === 'statsVis' && !Object.keys(ov.statsVis ?? {}).length)) out[k] = ov[k];
  return Object.keys(out).length ? (out as UserOverride) : null;
}

/** Drive-along kinds: explicit override, else only with exact location. */
export const driveAlongAllowed = (pol: SharingPolicy): boolean => pol.driveAlong ?? pol.location === 'exact';

const LOC_RANK: Record<LocationShare, number> = { exact: 3, approx: 2, city: 1, hidden: 0 };
const LOC_BY_RANK: LocationShare[] = ['hidden', 'city', 'approx', 'exact'];

/** The presence-relevant part of a policy. */
export interface PresenceView {
  location: LocationShare;
  speed: boolean;
  battery: boolean;
}

const viewOf = (p: SharingPolicy): PresenceView => ({ location: p.location, speed: p.speed, battery: p.battery });
export const viewKey = (v: PresenceView): string => `${v.location}|${+v.speed}|${+v.battery}`;

export interface PresenceTier {
  key: string;
  view: PresenceView;
  members: string[];
}

export interface PresencePlan {
  /** What the crew-wide broadcast carries: the least any member may see. */
  base: PresenceView;
  /** Members who may see more than `base`, grouped by what they see. Empty with no overrides. */
  tiers: PresenceTier[];
}

/**
 * Per-recipient presence planning (D52). With no overrides this is exactly the crew policy and no tiers, so the
 * common case stays one broadcast. A restricting override lowers the broadcast to that friend's view and moves the
 * others up into a tier; a granting override adds a tier. `canTier(id) === false` (older build) keeps that friend on
 * the broadcast: it still counts towards the floor but is never offered more than the crew policy.
 */
export function planPresence(
  members: readonly string[],
  pol: SharingPolicy,
  overrides: Readonly<Record<string, UserOverride>>,
  canTier: (id: string) => boolean = () => true,
): PresencePlan {
  const crew = viewOf(pol);
  const views = members.map((m) => [m, viewOf(resolveShare(pol, overrides[m]))] as const);
  if (views.every(([, v]) => viewKey(v) === viewKey(crew))) return { base: crew, tiers: [] };
  const capped = views.map(([m, v]) => [m, canTier(m) ? v : floorOf([v, crew])] as const);
  const base = floorOf(capped.map(([, v]) => v));
  const byKey = new Map<string, PresenceTier>();
  for (const [m, v] of capped) {
    const k = viewKey(v);
    if (k === viewKey(base) || !canTier(m)) continue;
    let t = byKey.get(k);
    if (!t) byKey.set(k, (t = { key: k, view: v, members: [] }));
    t.members.push(m);
  }
  const tiers = [...byKey.values()].map((t) => ({ ...t, members: [...t.members].sort() })).sort((a, b) => a.key.localeCompare(b.key));
  return { base, tiers };
}

function floorOf(vs: PresenceView[]): PresenceView {
  return {
    location: LOC_BY_RANK[Math.min(...vs.map((v) => LOC_RANK[v.location]))]!,
    speed: vs.every((v) => v.speed),
    battery: vs.every((v) => v.battery),
  };
}

/** Presence as one view may see it; null = location hidden (nothing to send). */
export function presenceForView(p: Presence, v: PresenceView): Presence | null {
  if (v.location === 'hidden') return null;
  const pol: SharingPolicy = { ...DEFAULT_SHARING, ...v };
  const stripped = stripPresence(p, pol);
  return coarsenForPolicy(stripped, pol) ?? { ...stripped, prec: 'p' };
}

/** Drop the optional fields a policy forbids (location precision is handled by `coarsenForPolicy`). */
export function stripPresence(p: Presence, pol: SharingPolicy): Presence {
  const out: Presence = { ...p };
  if (!pol.speed) {
    out.spd = null;
    out.hdg = null;
    out.act = 'unknown';
    delete out.eta;
    delete out.etaSrc;
  }
  if (!pol.battery) {
    out.bat = null;
    out.chg = false;
  }
  return out;
}

/** Snap to the policy's grid; never carries the offline trail. `null` for exact / hidden. */
export function coarsenForPolicy(p: Presence, pol: SharingPolicy): Presence | null {
  if (pol.location !== 'approx' && pol.location !== 'city') return null;
  const cell = SHARE_CELL_M[pol.location];
  const c = coarsen(p, cell);
  const { trail: _trail, ...rest } = p;
  return { ...rest, lat: c.lat, lng: c.lng, acc: Math.max(p.acc, cell / 2), hdg: null, prec: pol.location === 'city' ? 'c' : 'a' };
}

const PERIOD_TRIP_FIELDS = ['trips', 'longestTrip'] as const;

/** The profile this crew may see: stats removed when off, trip fields removed when trips are off. */
export function profileForPolicy<T extends { stats?: Record<string, SharedStats | undefined> }>(profile: T, pol: SharingPolicy): T {
  if (!profile.stats) return profile;
  if (!pol.stats) {
    const { stats: _s, ...rest } = profile;
    return rest as T;
  }
  const vis: StatsVisibility = { ...DEFAULT_SHARING.statsVis, ...pol.statsVis, trips: true };
  const stats: Record<string, SharedStats | undefined> = {};
  for (const [k, v] of Object.entries(profile.stats)) {
    if (!v) continue;
    const copy: Record<string, unknown> = { ...restrictShared(v, vis) };
    if (!pol.trips) for (const f of PERIOD_TRIP_FIELDS) delete copy[f];
    stats[k] = copy as SharedStats;
  }
  return { ...profile, stats };
}

const RANK: Record<Presence['prec'], number> = { p: 3, a: 2, c: 1 };

/** A friend seen through several crews: the most precise position wins, then the newest; extra fields are unioned. */
export function mergePresence<P extends Presence>(a: P | null, b: P | null): P | null {
  if (!a) return b;
  if (!b) return a;
  const [best, other] = RANK[a.prec] !== RANK[b.prec] ? (RANK[a.prec] > RANK[b.prec] ? [a, b] : [b, a]) : a.t >= b.t ? [a, b] : [b, a];
  // Battery is a reading of its own: the newest one wins, never an older one riding on the better position.
  const [newer, older] = a.t >= b.t ? [a, b] : [b, a];
  const batSrc = newer.bat !== null ? newer : older;
  return {
    ...best,
    // The precise channel carries no protocol stamp: keep the other crew's, or capability checks fail for good.
    ...(best.cp === undefined && other.cp !== undefined ? { cp: other.cp, ...(other.pv !== undefined ? { pv: other.pv } : {}) } : {}),
    spd: best.spd ?? other.spd,
    hdg: best.hdg ?? other.hdg,
    act: best.act !== 'unknown' ? best.act : other.act,
    bat: batSrc.bat,
    chg: batSrc.chg,
    eta: best.eta ?? other.eta,
  };
}

export interface StoredInviteV1 {
  inviteId: string;
  secret: string;
  expiresAt: number;
  used: boolean;
}

/** Storage keys before multiple crews existed. */
export interface CrewStorageV1 {
  circleId?: string | null;
  invites?: StoredInviteV1[];
}

export interface CrewStorageV2 {
  circles: string[];
  invites: Record<string, StoredInviteV1[]>;
  sharing: Record<string, SharingPolicy>;
  /** Per-friend overrides (D52), by deviceId. */
  overrides?: Record<string, UserOverride>;
  /** 3 = global "friends can see" and per-friend precision folded into crews / overrides (D52). */
  ver?: number;
}

/** The pre-D52 global settings that sharing used to read. */
export interface LegacySharingSettings {
  statsVisibility?: StatsVisibility;
  precision?: Record<string, 'precise' | 'approx'>;
}

export const SHARING_STORAGE_VER = 3;

/**
 * One-time (version-flagged) migration of the global sharing settings: the old global stats visibility becomes the
 * value of every crew that has no explicit per-crew one (its `trips` folds into the crew's trips switch), and the old
 * per-friend "precise location" switch becomes a location + speed override (what 'approx' stripped). Idempotent.
 */
export function migrateSharingGlobals(st: CrewStorageV2, legacy: LegacySharingSettings | null | undefined): CrewStorageV2 {
  if ((st.ver ?? 0) >= SHARING_STORAGE_VER) return st;
  const vis = legacy?.statsVisibility;
  const sharing: Record<string, SharingPolicy> = {};
  for (const [id, raw] of Object.entries(st.sharing)) {
    const explicit = (raw as Partial<SharingPolicy>).statsVis !== undefined;
    const pol = normalizePolicy(explicit || !vis ? raw : { ...raw, statsVis: { ...vis, trips: true } });
    if (!explicit && vis && !vis.trips) pol.trips = false;
    sharing[id] = pol;
  }
  const overrides: Record<string, UserOverride> = { ...(st.overrides ?? {}) };
  for (const [id, p] of Object.entries(legacy?.precision ?? {})) {
    if (p === 'approx' && overrides[id]?.location === undefined) overrides[id] = { ...overrides[id], location: 'approx', speed: false };
  }
  return { ...st, sharing, overrides, ver: SHARING_STORAGE_VER };
}

/** Split the legacy sharing keys off persisted settings (dropped once `migrateSharingGlobals` ran). */
export function splitLegacySharing<T extends object>(raw: T & LegacySharingSettings): { settings: Omit<T, keyof LegacySharingSettings>; legacy: LegacySharingSettings | null } {
  const { statsVisibility, precision, ...settings } = raw;
  const legacy = statsVisibility || precision ? { ...(statsVisibility ? { statsVisibility } : {}), ...(precision ? { precision } : {}) } : null;
  return { settings, legacy };
}

/**
 * One-time migration from the single-circle layout. Circle logs and Yjs updates were always keyed by circle id, so
 * only the kv index moves: the one circle becomes the first crew, its invites move under it, and it gets the default
 * policy. Idempotent: an existing v2 layout is returned unchanged.
 */
export function migrateCrewStorage(v1: CrewStorageV1, v2: CrewStorageV2 | null): CrewStorageV2 {
  if (v2) return v2;
  const id = v1.circleId ?? null;
  if (!id) return { circles: [], invites: {}, sharing: {} };
  // No statsVis yet: migrateSharingGlobals fills it from the old global setting.
  const { statsVis: _v, ...pol } = DEFAULT_SHARING;
  return { circles: [id], invites: { [id]: v1.invites ?? [] }, sharing: { [id]: pol as SharingPolicy } };
}
