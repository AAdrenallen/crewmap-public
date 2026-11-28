import { cumulativeDistances, haversineM, projectOnPolyline, projectOnSegment, slicePolyline, type LatLng } from '../geo';
import type { GroupSummary } from './group';
import type { DriveAlongSession } from './session';
import { CONVOY } from './thresholds';

/**
 * Convoy mode (D65): a group drive whose members follow one leader. Pure and clock-free. Gaps are measured along the
 * leader's shared route line (never straight line): every member is projected onto it, the order is the position along
 * it, and the time gap to the car ahead is "when did that car pass the point where I am now", from its position history.
 */

export interface ConvoyFix extends LatLng {
  /** Fix time (sender clock, ms). */
  t: number;
  /** m/s, null = unknown. */
  spd: number | null;
}

export interface ConvoyStanding {
  id: string;
  /** 1 = front of the convoy; null when off the convoy route or not heard yet. */
  order: number | null;
  alongM: number | null;
  onRoute: boolean;
  arrived: boolean;
  /** The car directly ahead in the order (null for the front car). */
  aheadId: string | null;
  /** Along-route distance to the car ahead (m). */
  gapM: number | null;
  /** Time gap to the car ahead (s): measured from its history when it covers my point, else distance / my speed. */
  gapS: number | null;
}

interface Track {
  alongM: number;
  t: number;
  spd: number | null;
  onRoute: boolean;
}

function indexAt(cum: number[], alongM: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= alongM) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function pointOn(a: LatLng, b: LatLng, k: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

/** Signals strictly after `fromM` and up to `toM` along the route (either order). */
export function lightsBetween(signalsAlongM: readonly number[] | undefined, fromM: number, toM: number): number | null {
  if (!signalsAlongM) return null;
  const lo = Math.min(fromM, toM);
  const hi = Math.max(fromM, toM);
  let n = 0;
  for (const s of signalsAlongM) if (s > lo && s <= hi) n++;
  return n;
}

/**
 * Per-convoy tracker on one phone: the reference line (the leader's shared route, or the leader's own nav route on the
 * leader's phone) plus each member's last projection and history. Projection is windowed around the last position so a
 * route that doubles back never makes a car jump to the wrong leg.
 */
export class ConvoyTracker {
  private line: LatLng[] = [];
  private cum: number[] = [];
  private key = '';
  private readonly tracks = new Map<string, Track>();
  private readonly hist = new Map<string, { alongM: number; t: number }[]>();

  /**
   * Set the reference line. When the leader (`leader`) rerouted, the new line starts near where the leader is now: the
   * old line is kept up to the leader's position and the new one appended, so everyone behind keeps their place and
   * history (their alongs do not change). Any other new line resets positions and history.
   */
  setLine(line: readonly LatLng[] | null, leader: string | null = null): void {
    const l = line && line.length >= 2 ? [...line] : [];
    const pt = (i: number) => `${l[i]!.lat.toFixed(5)},${l[i]!.lng.toFixed(5)}`;
    const key = l.length
      ? `${l.length}|${pt(0)}|${pt(Math.floor(l.length / 4))}|${pt(Math.floor(l.length / 2))}|${pt(Math.floor((l.length * 3) / 4))}|${pt(l.length - 1)}`
      : '';
    if (key === this.key) return;
    this.key = key;
    const lead = leader ? this.tracks.get(leader) : undefined;
    if (l.length && lead?.onRoute && this.hasLine) {
      const cut = lead.alongM;
      const prefix = slicePolyline(this.line, this.cum, 0, cut);
      if (haversineM(prefix[prefix.length - 1]!, l[0]!) <= CONVOY.rerouteJoinM) {
        this.line = [...prefix, ...l];
        this.cum = cumulativeDistances(this.line);
        for (const [id, tr] of [...this.tracks]) if (tr.alongM > cut + 1) this.forget(id);
        return;
      }
    }
    this.line = l;
    this.cum = l.length ? cumulativeDistances(l) : [];
    this.tracks.clear();
    this.hist.clear();
  }

  get hasLine(): boolean {
    return this.line.length >= 2;
  }

  get lengthM(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Feed one fix for a member; returns its along-route position or null when off the convoy route. */
  update(id: string, fix: ConvoyFix): number | null {
    if (!this.hasLine) return null;
    const prev = this.tracks.get(id);
    // Same or older fix (re-fed after a line change, or out of order): nothing new.
    if (prev && fix.t <= prev.t) return prev.onRoute ? prev.alongM : null;
    let pr: { distanceM: number; alongM: number } | null = null;
    if (prev?.onRoute) {
      const dtS = Math.max(0, (fix.t - prev.t) / 1000);
      const ahead = CONVOY.windowAheadM + Math.max(prev.spd ?? 0, fix.spd ?? 0, 30) * dtS * 1.5;
      pr = this.projectWindow(fix, prev.alongM - CONVOY.windowBackM, prev.alongM + ahead);
      if (pr && pr.distanceM > CONVOY.onRouteM) pr = null;
    }
    pr ??= projectOnPolyline(fix, this.line, this.cum);
    const onRoute = pr.distanceM <= CONVOY.onRouteM;
    this.tracks.set(id, { alongM: pr.alongM, t: fix.t, spd: fix.spd, onRoute });
    if (onRoute) {
      const h = this.hist.get(id) ?? [];
      h.push({ alongM: pr.alongM, t: fix.t });
      while (h.length > CONVOY.historyMax || (h.length > 1 && fix.t - h[0]!.t > CONVOY.historyMs)) h.shift();
      this.hist.set(id, h);
    }
    return onRoute ? pr.alongM : null;
  }

  /** Nearest point of the line whose along-route position lies in [minM, maxM]. */
  private projectWindow(p: LatLng, minM: number, maxM: number): { distanceM: number; alongM: number } | null {
    const i0 = indexAt(this.cum, Math.max(0, minM));
    const i1 = Math.min(this.line.length - 1, indexAt(this.cum, maxM) + 1);
    let best: { distanceM: number; alongM: number } | null = null;
    for (let i = i0; i < i1; i++) {
      const a = this.cum[i]!;
      const len = this.cum[i + 1]! - a;
      const pr = projectOnSegment(p, this.line[i]!, this.line[i + 1]!);
      const alongM = Math.min(Math.max(a + len * pr.t, minM), maxM);
      // Clamped to the window: a point behind it is measured at the window edge, never on an earlier leg.
      const d = alongM === a + len * pr.t ? pr.distanceM : haversineM(p, pointOn(this.line[i]!, this.line[i + 1]!, len > 0 ? (alongM - a) / len : 0));
      if (!best || d < best.distanceM) best = { distanceM: d, alongM };
    }
    return best;
  }

  forget(id: string): void {
    this.tracks.delete(id);
    this.hist.delete(id);
  }

  /** When `id` passed `alongM` (interpolated), or null when its history does not reach back that far. */
  passedAt(id: string, alongM: number): number | null {
    const h = this.hist.get(id);
    if (!h || h.length === 0 || h[0]!.alongM > alongM) return null;
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1]!;
      const b = h[i]!;
      if (b.alongM >= alongM && a.alongM <= alongM) {
        const k = b.alongM === a.alongM ? 0 : (alongM - a.alongM) / (b.alongM - a.alongM);
        return a.t + (b.t - a.t) * k;
      }
    }
    return null;
  }

  /** Along-route position of a member on the line (null when off it or not heard). */
  alongOf(id: string): number | null {
    const tr = this.tracks.get(id);
    return tr?.onRoute ? tr.alongM : null;
  }

  /**
   * Gap from `behind` (at `behindAlongM`) to the car ahead: distance along the line, and time = when the car ahead
   * passed that point (from its history), else distance over the follower's speed.
   */
  private gapTo(aheadId: string, aheadAlongM: number, behindId: string, behindAlongM: number): { gapM: number; gapS: number } {
    const gapM = Math.max(0, aheadAlongM - behindAlongM);
    const tr = this.tracks.get(behindId);
    const passed = this.passedAt(aheadId, behindAlongM);
    const gapS = passed !== null && tr ? Math.max(0, (tr.t - passed) / 1000) : gapM / Math.max(tr?.spd ?? 0, CONVOY.minSpeedMps);
    return { gapM, gapS };
  }

  /** Signed gap of `other` relative to `me` (> 0 ahead of me), or null when either is off the line. */
  relative(me: string, other: string): { m: number; s: number } | null {
    const a = this.alongOf(me);
    const b = this.alongOf(other);
    if (a === null || b === null) return null;
    if (b >= a) {
      const g = this.gapTo(other, b, me, a);
      return { m: g.gapM, s: g.gapS };
    }
    const g = this.gapTo(me, a, other, b);
    return { m: -g.gapM, s: -g.gapS };
  }

  /** The order, along-route gaps and time gaps of `ids`. Arrived members sit at the end of the line, front first. */
  standings(ids: readonly string[], arrived: ReadonlySet<string>): ConvoyStanding[] {
    const total = this.lengthM;
    const rows = ids.map((id) => {
      const isArrived = arrived.has(id);
      const alongM = isArrived && this.hasLine ? total : this.alongOf(id);
      return { id, arrived: isArrived, alongM };
    });
    const placed = rows.filter((r) => r.alongM !== null).sort((a, b) => b.alongM! - a.alongM! || a.id.localeCompare(b.id));
    const out: ConvoyStanding[] = placed.map((r, i) => {
      const ahead = i > 0 ? placed[i - 1]! : null;
      const g = ahead && !r.arrived ? this.gapTo(ahead.id, ahead.alongM!, r.id, r.alongM!) : null;
      return { id: r.id, order: i + 1, alongM: r.alongM, onRoute: true, arrived: r.arrived, aheadId: ahead?.id ?? null, gapM: g?.gapM ?? null, gapS: g?.gapS ?? null };
    });
    for (const r of rows) if (r.alongM === null) out.push({ id: r.id, order: null, alongM: null, onRoute: false, arrived: false, aheadId: null, gapM: null, gapS: null });
    return out;
  }
}

/** The order numbers to show on the map (only members with a place in the line). */
export function convoyOrderMap(rows: readonly ConvoyStanding[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const r of rows) if (r.order !== null) o[r.id] = r.order;
  return o;
}

export interface Neighbour {
  id: string;
  gapM: number;
  gapS: number | null;
}

/** The car directly ahead of me and the one directly behind (both with their gap to me). */
export function neighbours(rows: readonly ConvoyStanding[], me: string): { ahead: Neighbour | null; behind: Neighbour | null } {
  const mine = rows.find((r) => r.id === me);
  const ahead = mine?.aheadId && mine.gapM !== null ? { id: mine.aheadId, gapM: mine.gapM, gapS: mine.gapS } : null;
  const b = rows.find((r) => r.aheadId === me && r.gapM !== null);
  return { ahead, behind: b ? { id: b.id, gapM: b.gapM!, gapS: b.gapS } : null };
}

export type GapLabel = { dir: 'ahead' | 'behind'; kind: 'lights' | 'min' | 'm'; n: number };

/**
 * What a gap is called: "2 lights" when few signals separate the cars on a short gap, else minutes once a minute or
 * more, else metres (bucketed). Null when the cars are together or the gap is under the smallest bucket.
 */
export function gapLabel(dir: GapLabel['dir'], gapM: number, gapS: number | null, lights: number | null): GapLabel | null {
  if (gapM < CONVOY.togetherM) return null;
  if (lights !== null && lights >= 1 && lights <= CONVOY.lightsMax && gapM <= CONVOY.lightsMaxM) return { dir, kind: 'lights', n: lights };
  if (gapS !== null && gapS >= 60) {
    const min = gapS / 60;
    for (let i = CONVOY.minuteBuckets.length - 1; i >= 0; i--) {
      if (min >= CONVOY.minuteBuckets[i]!) return { dir, kind: 'min', n: CONVOY.minuteBuckets[i]! };
    }
  }
  for (let i = CONVOY.meterBuckets.length - 1; i >= 0; i--) {
    if (gapM >= CONVOY.meterBuckets[i]!) return { dir, kind: 'm', n: CONVOY.meterBuckets[i]! };
  }
  return null;
}

const labelKey = (l: GapLabel | null) => (l ? `${l.dir}|${l.kind}|${l.n}` : '');

/**
 * Spoken gap callouts for one neighbour: a new label must hold `calloutHoldMs`, and callouts are at least
 * `calloutEveryMs` apart (a change during the cooldown is spoken once it ends, if it still holds).
 */
export class ConvoyCallouts {
  private said = '';
  private cand = '';
  private candSince = 0;
  private lastAt = -Infinity;

  update(label: GapLabel | null, now: number): GapLabel | null {
    const k = labelKey(label);
    if (k !== this.cand) {
      this.cand = k;
      this.candSince = now;
    }
    if (!label) {
      // Back together: the next gap is news again.
      if (now - this.candSince >= CONVOY.calloutHoldMs) this.said = '';
      return null;
    }
    if (k === this.said || now - this.candSince < CONVOY.calloutHoldMs || now - this.lastAt < CONVOY.calloutEveryMs) return null;
    this.said = k;
    this.lastAt = now;
    return label;
  }
}

export interface RegroupLimits {
  m: number;
  s: number;
}

/**
 * Regroup alert for one member (its gap to the car ahead): fires once the gap stays over the distance OR time limit for
 * `regroupHoldMs`, then re-arms only once both fall under `regroupRearm` of the limits, and repeats at most every
 * `regroupEveryMs`. A member with no measurable gap (stale, off route, arrived) neither fires nor re-arms.
 */
export class RegroupWatch {
  private overSince: number | null = null;
  private armed = true;
  private lastAt = -Infinity;

  update(gapM: number | null, gapS: number | null, lim: RegroupLimits, now: number): boolean {
    if (gapM === null) {
      this.overSince = null;
      return false;
    }
    const over = gapM > lim.m || (gapS !== null && gapS > lim.s);
    const under = gapM < lim.m * CONVOY.regroupRearm && (gapS === null || gapS < lim.s * CONVOY.regroupRearm);
    if (under) this.armed = true;
    if (!over) {
      this.overSince = null;
      return false;
    }
    this.overSince ??= now;
    if (!this.armed || now - this.overSince < CONVOY.regroupHoldMs || now - this.lastAt < CONVOY.regroupEveryMs) return false;
    this.armed = false;
    this.lastAt = now;
    return true;
  }
}

/** Who hears a regroup alert about `straggler`: the leader and the car directly ahead of the gap (never the straggler). */
export function regroupAudience(rows: readonly ConvoyStanding[], leader: string | null, straggler: string): string[] {
  const r = rows.find((x) => x.id === straggler);
  const out = new Set<string>();
  if (leader && leader !== straggler) out.add(leader);
  if (r?.aheadId && r.aheadId !== straggler) out.add(r.aheadId);
  return [...out].sort();
}

/**
 * Follow the leader: the rest of the leader's line from where I join it, with my position first (for a via-constrained
 * Directions query). Null when the line is too short.
 */
export function followLine(leaderLine: readonly LatLng[], me: LatLng): LatLng[] | null {
  if (leaderLine.length < 2) return null;
  const line = [...leaderLine];
  const cum = cumulativeDistances(line);
  const pr = projectOnPolyline(me, line, cum);
  const total = cum[cum.length - 1]!;
  if (total - pr.alongM < 50) return null;
  const rest = slicePolyline(line, cum, pr.alongM, total);
  const head = haversineM(me, rest[0]!) > 5 ? [{ lat: me.lat, lng: me.lng }] : [];
  return [...head, ...rest];
}

/** The crew a convoy belongs to (for per-crew mute): the session's crew, else the first crew (by id) holding every joined member. */
export function convoyCrew(s: DriveAlongSession, crews: readonly { id: string; memberIds: readonly string[] }[]): string | null {
  if (s.crew) return s.crew;
  const joined = Object.entries(s.members).filter(([, m]) => m.state === 'joined').map(([id]) => id);
  const hit = [...crews].sort((a, b) => a.id.localeCompare(b.id)).find((c) => joined.every((id) => c.memberIds.includes(id)));
  return hit?.id ?? null;
}

/** Arrival summary rows with the delay after the first arrival (s). */
export function arrivalGaps(summary: GroupSummary): { id: string; name: string; at: number; afterS: number }[] {
  const first = summary.arrivals[0]?.at ?? 0;
  return summary.arrivals.map((a) => ({ ...a, afterS: Math.max(0, Math.round((a.at - first) / 1000)) }));
}
