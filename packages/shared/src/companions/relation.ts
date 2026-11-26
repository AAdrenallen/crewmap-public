import { cumulativeDistances, haversineM, projectOnPolyline, type LatLng } from '../geo';
import { DRIVE_ALONG } from './thresholds';

export interface Relation {
  /** Straight-line distance (m). */
  distM: number;
  /** Signed gap along my route (m): > 0 friend ahead of me, < 0 behind. Null when either of us is off the route. */
  alongGapM: number | null;
  /** Friend within `onRouteM` of my route. Null when I have no route. */
  onMyRoute: boolean | null;
}

export interface RouteRef {
  line: LatLng[];
  cum: number[];
}

export function routeRef(line: LatLng[]): RouteRef | null {
  return line.length >= 2 ? { line, cum: cumulativeDistances(line) } : null;
}

/** Where a companion is relative to me (and to my route, when I am navigating). */
export function relation(me: LatLng, friend: LatLng, route: RouteRef | null): Relation {
  const distM = haversineM(me, friend);
  if (!route) return { distM, alongGapM: null, onMyRoute: null };
  const f = projectOnPolyline(friend, route.line, route.cum);
  const m = projectOnPolyline(me, route.line, route.cum);
  const onMyRoute = f.distanceM <= DRIVE_ALONG.onRouteM;
  const meOn = m.distanceM <= DRIVE_ALONG.onRouteM;
  return { distM, alongGapM: onMyRoute && meOn ? f.alongM - m.alongM : null, onMyRoute };
}

export type RelationLabel = { kind: 'ahead' | 'behind' | 'away' | 'here'; m: number };

/** Short label: "2.1 km behind" / "ahead" / "away"; within 150 m "with you". */
export function relationLabel(r: Relation): RelationLabel {
  if (r.distM < 150) return { kind: 'here', m: r.distM };
  if (r.alongGapM !== null) return { kind: r.alongGapM >= 0 ? 'ahead' : 'behind', m: Math.abs(r.alongGapM) };
  return { kind: 'away', m: r.distM };
}

export type CompanionCue = { kind: 'gap'; label: RelationLabel } | { kind: 'offRoute' } | { kind: 'backOnRoute' };

/**
 * Spoken companion cues with hysteresis: a gap is announced when it crosses into a new bucket (1, 2, 5, 10, 20 km)
 * and not more than every `gapEveryMs`; "took a different route" once after `offRouteHoldMs` off my route, and
 * "back on your route" once after that. One instance per companion.
 */
export class CompanionCues {
  private bucket = -1;
  private lastGapAt = -Infinity;
  private offSince: number | null = null;
  private offAnnounced = false;

  update(r: Relation, now: number): CompanionCue | null {
    if (r.onMyRoute === false) {
      this.offSince ??= now;
      if (!this.offAnnounced && now - this.offSince >= DRIVE_ALONG.offRouteHoldMs) {
        this.offAnnounced = true;
        return { kind: 'offRoute' };
      }
    } else if (r.onMyRoute === true) {
      this.offSince = null;
      if (this.offAnnounced) {
        this.offAnnounced = false;
        return { kind: 'backOnRoute' };
      }
    }
    const label = relationLabel(r);
    if (label.kind === 'here') {
      this.bucket = -1;
      return null;
    }
    const b = DRIVE_ALONG.gapBucketsM.filter((x) => label.m >= x).length - 1;
    if (b < 0) this.bucket = -1;
    // A crossing during the cooldown is kept pending (bucket not committed), so it is announced once it ends.
    if (b < 0 || b === this.bucket || now - this.lastGapAt < DRIVE_ALONG.gapEveryMs) return null;
    this.bucket = b;
    this.lastGapAt = now;
    return { kind: 'gap', label: { kind: label.kind, m: DRIVE_ALONG.gapBucketsM[b]! } };
  }
}

export interface RegroupCandidate extends LatLng {
  id: string;
  name: string;
}

/**
 * Regroup suggestion: the first candidate place ahead of me on my route (≥ `regroupMinAheadM`) that is also within
 * `regroupNearM` of the companion's route. Null when the routes share no such place.
 */
export function regroupPoint<P extends RegroupCandidate>(me: LatLng, mine: RouteRef, theirs: RouteRef, places: readonly P[]): P | null {
  const myAlong = projectOnPolyline(me, mine.line, mine.cum).alongM;
  let best: { p: P; along: number } | null = null;
  for (const p of places) {
    const onMine = projectOnPolyline(p, mine.line, mine.cum);
    if (onMine.distanceM > DRIVE_ALONG.regroupNearM || onMine.alongM - myAlong < DRIVE_ALONG.regroupMinAheadM) continue;
    if (projectOnPolyline(p, theirs.line, theirs.cum).distanceM > DRIVE_ALONG.regroupNearM) continue;
    if (!best || onMine.alongM < best.along) best = { p, along: onMine.alongM };
  }
  return best?.p ?? null;
}

/** Downsample a route for the wire (keep ≤ `max` points, ends kept). */
export function thinRoute(line: LatLng[], max = 300): LatLng[] {
  if (line.length <= max) return line;
  const step = (line.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(line[Math.round(i * step)]!);
  return out;
}
