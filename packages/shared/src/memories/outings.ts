import { haversineM } from '../geo';
import { MEMORY } from './config';
import type { NotableReason, Outing, OutingMember, OutingStop, TrackPt, TripLite } from './types';

/** My interpolated position at `t` over a time-sorted track (clamped to its ends; null when empty). */
export function positionAt(track: readonly TrackPt[], t: number): TrackPt | null {
  if (track.length === 0) return null;
  if (t <= track[0]!.t) return track[0]!;
  const last = track[track.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { t, lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, spd: a.spd ?? null };
}

/** Consecutive drives with stops of at most `chainGapMs` between them. Input in any order. */
export function chainTrips(trips: readonly TripLite[], gapMs: number = MEMORY.chainGapMs): TripLite[][] {
  const sorted = [...trips].sort((a, b) => a.startedAt - b.startedAt);
  const out: TripLite[][] = [];
  for (const tr of sorted) {
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && tr.startedAt - prev.endedAt <= gapMs) cur.push(tr);
    else out.push([tr]);
  }
  return out;
}

/** My whole track over a chain: drives plus the stops between them (standing still at the arrival point). */
export function chainTrack(chain: readonly TripLite[]): TrackPt[] {
  const out: TrackPt[] = [];
  for (const tr of chain) for (const p of tr.line) if (!out.length || p.t > out[out.length - 1]!.t) out.push(p);
  return out;
}

/** Stops between drives (and none after the last: that is the way home or the end of the day). */
export function chainStops(chain: readonly TripLite[], minMs: number = MEMORY.minStopMs): OutingStop[] {
  const out: OutingStop[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const end = a.line[a.line.length - 1];
    if (!end || b.startedAt - a.endedAt < minMs) continue;
    out.push({ lat: end.lat, lng: end.lng, start: a.endedAt, end: b.startedAt });
  }
  return out;
}

/**
 * Who was with me: a crewmate's fixes compared with my interpolated position at the same time. Together-time adds
 * up between consecutive close fixes no more than `maxFixGapMs` apart.
 */
export function companionsOf(
  myTrack: readonly TrackPt[],
  friendTracks: Readonly<Record<string, readonly TrackPt[]>>,
  window: [number, number],
  sessions: readonly { who: string; from: number; to: number }[] = [],
): OutingMember[] {
  const [s, e] = window;
  const span = Math.max(1, e - s);
  const out: OutingMember[] = [];
  const ids = new Set([...Object.keys(friendTracks), ...sessions.map((x) => x.who)]);
  for (const id of ids) {
    const pts = (friendTracks[id] ?? []).filter((p) => p.t >= s - MEMORY.windowSlackMs && p.t <= e + MEMORY.windowSlackMs);
    let together = 0;
    let first = Infinity;
    let last = -Infinity;
    let prevClose: TrackPt | null = null;
    for (const p of pts) {
      // Slack only widens which fixes are read; time before I left or after I arrived is not time spent together.
      if (p.t < s || p.t > e) {
        prevClose = null;
        continue;
      }
      const me = positionAt(myTrack, p.t);
      const close = !!me && haversineM(me, p) <= MEMORY.togetherM;
      if (close) {
        first = Math.min(first, p.t);
        last = Math.max(last, p.t);
        if (prevClose && p.t - prevClose.t <= MEMORY.maxFixGapMs) together += p.t - prevClose.t;
        prevClose = p;
      } else prevClose = null;
    }
    const ses = sessions.filter((x) => x.who === id && x.to >= s && x.from <= e);
    for (const x of ses) {
      first = Math.min(first, Math.max(s, x.from));
      last = Math.max(last, Math.min(e, x.to));
    }
    const byDistance = together >= MEMORY.minTogetherMs || together / span >= MEMORY.minTogetherShare;
    if (!byDistance && ses.length === 0) continue;
    out.push({
      id,
      joinedAt: first,
      leftAt: last,
      togetherMs: Math.max(together, ses.reduce((n, x) => n + Math.max(0, Math.min(e, x.to) - Math.max(s, x.from)), 0)),
      ...(ses.length ? { session: true } : {}),
    });
  }
  return out.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
}

export interface NotableContext {
  /** Distances (m) of my earlier outings, with their end time (for the "longest in 30 days" record). */
  history: readonly { end: number; distanceM: number }[];
  /** Cities of my stops before this outing. */
  knownCities: ReadonlySet<string>;
  /** City of each stop of this outing (same order as stops), null when unknown. */
  stopCities?: readonly (string | null)[];
}

export function notableReasons(o: Pick<Outing, 'start' | 'distanceM' | 'drivingS'>, ctx: NotableContext): NotableReason[] {
  const n = MEMORY.notable;
  const out: NotableReason[] = [];
  if (o.distanceM >= n.longDayM) out.push('longDay');
  if (o.drivingS >= n.roadTripS) out.push('roadTrip');
  const since = o.start - n.recordDays * 86_400_000;
  const earlier = ctx.history.filter((h) => h.end < o.start && h.end >= since);
  if (o.distanceM >= n.recordMinM && earlier.length >= 3 && earlier.every((h) => h.distanceM < o.distanceM)) out.push('record');
  if (o.distanceM >= n.newCityMinM && (ctx.stopCities ?? []).some((c) => !!c && !ctx.knownCities.has(c))) out.push('newCity');
  return out;
}

export interface BuildInput {
  trips: readonly TripLite[];
  /** Crewmate tracks recorded on this phone (what they already shared with me), by device id. */
  friendTracks: Readonly<Record<string, readonly TrackPt[]>>;
  /** Drive-along / group drive sessions with a crewmate. */
  sessions?: readonly { who: string; from: number; to: number }[];
  /** Earlier outings (for records) and known cities; computed by the caller. */
  notable?: (o: Omit<Outing, 'kind' | 'notable'>) => NotableReason[];
}

/**
 * Groups drives into outings: consecutive drives with short stops, plus the crewmates who were along. An outing with
 * crewmates is a group outing; a solo one is kept only when notable. Passenger drives count (riding along is the
 * point); the drive list decides their scoring, not this.
 */
export function buildOutings(input: BuildInput): Outing[] {
  const out: Outing[] = [];
  for (const chain of chainTrips(input.trips)) {
    const first = chain[0]!;
    const lastTrip = chain[chain.length - 1]!;
    const window: [number, number] = [first.startedAt, lastTrip.endedAt];
    const track = chainTrack(chain);
    const base: Omit<Outing, 'kind' | 'notable'> = {
      id: `o-${first.id}`,
      start: window[0],
      end: window[1],
      tripIds: chain.map((c) => c.id),
      distanceM: chain.reduce((n, c) => n + c.distanceM, 0),
      drivingS: chain.reduce((n, c) => n + c.durationS, 0),
      topSpeedKph: Math.max(0, ...chain.map((c) => c.topSpeedKph)),
      members: companionsOf(track, input.friendTracks, window, input.sessions),
      stops: chainStops(chain),
    };
    const notable = input.notable?.(base) ?? [];
    if (base.members.length > 0) out.push({ ...base, kind: 'group', notable });
    else if (notable.length > 0) out.push({ ...base, kind: 'notable', notable });
  }
  return out;
}

/** Overlap share of two windows relative to the shorter one (0..1). */
export function overlapShare(a: [number, number], b: [number, number]): number {
  const inter = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  const shorter = Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
  return inter <= 0 ? 0 : Math.min(1, inter / shorter);
}

/**
 * Which local memory a crewmate's message belongs to: a known alias first, else the best time overlap (windows
 * widened by the slack, so a crewmate who joined late still matches). null = a memory of their own to create.
 */
export function matchMemory(
  memories: readonly { id: string; start: number; end: number; aliases?: readonly string[] }[],
  mid: string,
  window: [number, number],
): string | null {
  const byAlias = memories.find((m) => m.id === mid || m.aliases?.includes(mid));
  if (byAlias) return byAlias.id;
  const slack = MEMORY.windowSlackMs;
  let best: { id: string; share: number } | null = null;
  for (const m of memories) {
    const share = overlapShare([m.start - slack, m.end + slack], [window[0], window[1]]);
    if (share >= MEMORY.matchOverlap && (!best || share > best.share)) best = { id: m.id, share };
  }
  return best?.id ?? null;
}

/** Thin a track to at most `n` points, keeping both ends (evenly by index: shapes stay, sizes stay bounded). */
export function thinTrack<T extends TrackPt>(track: readonly T[], n: number): T[] {
  if (track.length <= n) return [...track];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(track[Math.round((i * (track.length - 1)) / (n - 1))]!);
  return out;
}
