import { haversineM, type LatLng } from '../geo';


/** Legacy glyph field, still written for peers on older versions; derived from `type`. */
export type PlaceIcon = 'home' | 'work' | 'school' | 'gym' | 'heart' | 'star' | 'food' | 'shop' | 'car' | 'tree';
export type Visibility = 'shared' | 'private';

export const PLACE_TYPES = ['home', 'work', 'home2', 'school', 'gym', 'family', 'friend', 'shop', 'restaurant', 'other'] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

export interface Place {
  id: string;
  owner: string;
  /** Free text, 1–PLACE_NAME_MAX chars. */
  name: string;
  /** Sets the icon and the default colour only. */
  type: PlaceType;
  color: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** Own places: crews this place is shared with (∩ each crew's places policy). Never leaves the device. */
  sharedWith: string[];
  /** Derived from `type` (legacy glyph, still written for peers on older versions). */
  icon: PlaceIcon;
  /** Derived: own places 'shared' iff sharedWith is non-empty; friends' places (from a doc) are always 'shared'. */
  visibility: Visibility;
  createdAt: number;
}

export const PLACE_NAME_MAX = 40;

export const PLACE_TYPE_COLOR: Record<PlaceType, string> = {
  home: '#5B6CFF',
  work: '#1F2937',
  home2: '#30A46C',
  school: '#FB8C00',
  gym: '#E5484D',
  family: '#D6409F',
  friend: '#8E44AD',
  shop: '#2EC4B6',
  restaurant: '#F5A524',
  other: '#607089',
};

const TYPE_ICON: Record<PlaceType, PlaceIcon> = {
  home: 'home',
  work: 'work',
  home2: 'tree',
  school: 'school',
  gym: 'gym',
  family: 'heart',
  friend: 'star',
  shop: 'shop',
  restaurant: 'food',
  other: 'car',
};

const LEGACY_TYPE: Record<PlaceIcon, PlaceType> = {
  home: 'home',
  work: 'work',
  school: 'school',
  gym: 'gym',
  heart: 'family',
  star: 'other',
  food: 'restaurant',
  shop: 'shop',
  car: 'other',
  tree: 'home2',
};

const isType = (v: unknown): v is PlaceType => typeof v === 'string' && (PLACE_TYPES as readonly string[]).includes(v);

export type RawPlace = Partial<Place> & Pick<Place, 'id' | 'owner' | 'lat' | 'lng'>;

/**
 * Upgrade a stored or received place to the current shape without losing data. Older own places had
 * `visibility: 'shared'` (= every crew whose policy shares places) → `sharedWith = legacyShared`; private → [].
 * Names are kept as they were (the length limit is enforced in the editor).
 */
export function normalizePlace(raw: RawPlace, legacyShared: readonly string[] = []): Place {
  const type: PlaceType = isType(raw.type) ? raw.type : raw.icon && raw.icon in LEGACY_TYPE ? LEGACY_TYPE[raw.icon] : 'other';
  const sharedWith = Array.isArray(raw.sharedWith) ? raw.sharedWith.filter((x) => typeof x === 'string') : raw.visibility === 'shared' ? [...legacyShared] : [];
  return {
    id: raw.id,
    owner: raw.owner,
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    color: typeof raw.color === 'string' ? raw.color : PLACE_TYPE_COLOR[type],
    lat: raw.lat,
    lng: raw.lng,
    radiusM: typeof raw.radiusM === 'number' ? raw.radiusM : PLACE_DEFAULT_RADIUS_M,
    sharedWith,
    icon: TYPE_ICON[type],
    visibility: sharedWith.length > 0 ? 'shared' : 'private',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  };
}

/** True when the stored form differs from the normalized one (migration needed). */
export function needsMigration(raw: RawPlace): boolean {
  return !isType(raw.type) || !Array.isArray(raw.sharedWith);
}

/** A place read from a crew doc (a friend's, possibly written by an older version). */
export function placeFromWire(raw: RawPlace): Place {
  return { ...normalizePlace({ ...raw, sharedWith: [] }), visibility: 'shared' };
}

/** What goes into a crew doc: everything but `sharedWith` (it would reveal our other crews). */
export type WirePlace = Omit<Place, 'sharedWith'>;
export function placeForWire(p: Place): WirePlace {
  const { sharedWith: _sharedWith, ...rest } = p;
  return { ...rest, icon: TYPE_ICON[p.type], visibility: 'shared' };
}

export function validPlaceName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= PLACE_NAME_MAX;
}

export const PLACE_DEFAULT_RADIUS_M = 150;
export const PLACE_MIN_RADIUS_M = 75;
export const PLACE_MAX_RADIUS_M = 1000;

export const ARRIVAL_THRESHOLDS = {
  /** Must be inside the radius this long to count as arrived (filters drive-bys). */
  enterDwellS: 60,
  /** Must be beyond radius + margin this long to count as left. */
  exitMarginM: 50,
  exitDwellS: 90,
  /** Ignore fixes worse than this. */
  maxAccuracyM: 100,
  /** Treat a fix as inside if its accuracy circle mostly overlaps the radius. */
  accuracyFactor: 0.5,
} as const;

export type ArrivalEvent = { placeId: string; kind: 'arrive' | 'leave'; t: number };

type PlaceState = { inside: boolean; candidateSince: number | null };

/**
 * Arrival/leave with hysteresis (F6): evaluated on the arriving friend's own phone, from OS geofence hints and
 * location fixes. Enter needs `enterDwellS` inside; leave needs `exitDwellS` beyond radius + margin. GPS jitter at
 * the edge can't flap.
 */
export class ArrivalDetector {
  private readonly state = new Map<string, PlaceState>();

  constructor(
    private places: Place[],
    private readonly th = ARRIVAL_THRESHOLDS,
  ) {}

  setPlaces(places: Place[]): void {
    this.places = places;
    for (const id of [...this.state.keys()]) if (!places.some((p) => p.id === id)) this.state.delete(id);
  }

  /** Current inside-state (for "is Alex at Work?" and seeding after restart). */
  isInside(placeId: string): boolean {
    return this.state.get(placeId)?.inside ?? false;
  }

  seed(placeId: string, inside: boolean): void {
    this.state.set(placeId, { inside, candidateSince: null });
  }

  onFix(fix: LatLng & { t: number; accuracy: number }): ArrivalEvent[] {
    if (fix.accuracy > this.th.maxAccuracyM) return [];
    const out: ArrivalEvent[] = [];
    for (const p of this.places) {
      const s = this.state.get(p.id) ?? { inside: false, candidateSince: null };
      const d = haversineM(fix, p);
      const slack = fix.accuracy * this.th.accuracyFactor;
      if (!s.inside) {
        if (d <= p.radiusM + slack) {
          s.candidateSince ??= fix.t;
          if ((fix.t - s.candidateSince) / 1000 >= this.th.enterDwellS) {
            s.inside = true;
            s.candidateSince = null;
            out.push({ placeId: p.id, kind: 'arrive', t: fix.t });
          }
        } else s.candidateSince = null;
      } else if (d > p.radiusM + this.th.exitMarginM + slack) {
        s.candidateSince ??= fix.t;
        if ((fix.t - s.candidateSince) / 1000 >= this.th.exitDwellS) {
          s.inside = false;
          s.candidateSince = null;
          out.push({ placeId: p.id, kind: 'leave', t: fix.t });
        }
      } else s.candidateSince = null;
      this.state.set(p.id, s);
    }
    return out;
  }
}

/** Subscription stored in the circle doc: "Notify me when <target> arrives at / leaves <place>". */
export interface ArrivalSubscription {
  id: string;
  subscriber: string;
  target: string;
  placeId: string;
  arrive: boolean;
  leave: boolean;
  /** "Notify when <target> starts driving home". */
  drivingHome?: boolean;
  /** One-shot: removed by the subscriber after it fires (see companions `consumeOnce`). */
  once?: boolean;
}

export function subscribersFor(subs: ArrivalSubscription[], target: string, e: ArrivalEvent): string[] {
  return subs
    .filter((s) => s.target === target && s.placeId === e.placeId && (e.kind === 'arrive' ? s.arrive : s.leave))
    .map((s) => s.subscriber);
}

// --- Proximity moments (F4b) ---------------------------------------------------------------------------------------

export const PROXIMITY = {
  /** Passing a friend's shared place within this distance while driving. */
  passPlaceM: 200,
  /** Don't re-announce the same place within this time. */
  passPlaceDebounceMs: 60 * 60_000,
  /** Default "friends nearby" distance (user-configurable). */
  friendsNearM: 500,
  friendsNearDebounceMs: 2 * 3600_000,
  /** Must have been apart by more than 2× the distance before re-triggering. */
  rearmFactor: 2,
} as const;

export type ProximityMoment =
  | { kind: 'passPlace'; placeId: string; owner: string; t: number }
  | { kind: 'friendsNear'; a: string; b: string; distanceM: number; t: number };

export class ProximityMoments {
  private readonly lastPlace = new Map<string, number>();
  private readonly pair = new Map<string, { at: number; armed: boolean }>();

  constructor(private readonly opts: { friendsNearM: number } = { friendsNearM: PROXIMITY.friendsNearM }) {}

  /** While I'm driving: passing friends' shared places (never my own). */
  passPlaces(me: string, fix: LatLng & { t: number }, places: Place[]): ProximityMoment[] {
    const out: ProximityMoment[] = [];
    for (const p of places) {
      if (p.owner === me || p.visibility !== 'shared') continue;
      if (haversineM(fix, p) > Math.max(PROXIMITY.passPlaceM, p.radiusM)) continue;
      const last = this.lastPlace.get(p.id);
      if (last !== undefined && fix.t - last < PROXIMITY.passPlaceDebounceMs) continue;
      this.lastPlace.set(p.id, fix.t);
      out.push({ kind: 'passPlace', placeId: p.id, owner: p.owner, t: fix.t });
    }
    return out;
  }

  /** Any two people (including me) within the configured distance; debounced per pair, re-armed after separating. */
  friendsNear(positions: { id: string; lat: number; lng: number }[], t: number): ProximityMoment[] {
    const out: ProximityMoment[] = [];
    const near = this.opts.friendsNearM;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const d = haversineM(a, b);
        const st = this.pair.get(key) ?? { at: -Infinity, armed: true };
        if (d > near * PROXIMITY.rearmFactor) st.armed = true;
        if (d <= near && st.armed && t - st.at >= PROXIMITY.friendsNearDebounceMs) {
          st.at = t;
          st.armed = false;
          const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
          out.push({ kind: 'friendsNear', a: x, b: y, distanceM: Math.round(d), t });
        }
        this.pair.set(key, st);
      }
    }
    return out;
  }
}
