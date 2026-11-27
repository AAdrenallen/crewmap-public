import { bearingDeg, haversineM } from '../geo';
import { MEMORY } from './config';
import { positionAt } from './outings';
import type { MemoryEvent, MemoryPhoto, MemoryReact, Outing, RemotePost, TrackPt } from './types';

export type HighlightKind = 'distance' | 'duration' | 'topSpeed' | 'farthest' | 'stops' | 'hype' | 'photos' | 'crew' | 'nightOwl' | 'earlyBird';

export interface Highlight {
  kind: HighlightKind;
  /** km, minutes, km/h, count: the UI formats by kind. */
  value: number;
  /** Who it belongs to (top speed, hype); absent = the outing / me. */
  who?: string;
  score: number;
}

export interface TimelineItem {
  t: number;
  kind: 'start' | 'join' | 'leave' | 'stop' | 'emote' | 'photo' | 'end';
  who?: string;
  /** Emote preset, stop name or photo hash. */
  ref?: string;
}

export interface PlaybackTrack {
  who: string;
  pts: TrackPt[];
}

export interface Recap {
  outing: Outing;
  /** Me first, then crewmates in join order. */
  tracks: PlaybackTrack[];
  timeline: TimelineItem[];
  highlights: Highlight[];
  photos: MemoryPhoto[];
  /** Reaction counts on the memory itself, plus whether I reacted with each. */
  reactions: { e: string; n: number; mine: boolean }[];
  emoteCount: number;
}

/** Reactions on one target: latest per person and emoji wins (`on` toggles), counted by emoji. */
export function reactionSummary(reacts: readonly (MemoryReact & { on?: boolean })[], target: string, me: string): { e: string; n: number; mine: boolean }[] {
  const latest = new Map<string, MemoryReact & { on?: boolean }>();
  for (const r of [...reacts].filter((x) => x.target === target).sort((a, b) => a.at - b.at)) latest.set(`${r.from}\u0000${r.e}`, r);
  const by = new Map<string, { n: number; mine: boolean }>();
  for (const r of latest.values()) {
    if (r.on === false) continue;
    const cur = by.get(r.e) ?? { n: 0, mine: false };
    cur.n++;
    if (r.from === me) cur.mine = true;
    by.set(r.e, cur);
  }
  return [...by].map(([e, v]) => ({ e, ...v })).sort((a, b) => b.n - a.n || a.e.localeCompare(b.e));
}

function farthestKm(track: readonly TrackPt[]): number {
  const o = track[0];
  if (!o) return 0;
  let m = 0;
  for (const p of track) m = Math.max(m, haversineM(o, p));
  return m / 1000;
}

const hourOf = (t: number, tzMin: number) => new Date(t + tzMin * 60_000).getUTCHours();

/**
 * Highlight candidates, scored for how interesting they are, then the best `MEMORY.maxHighlights`. Crewmates' numbers
 * only appear when they shared them (their post carries them).
 */
export function pickHighlights(input: {
  outing: Outing;
  myTrack: readonly TrackPt[];
  me: string;
  posts: readonly RemotePost[];
  events: readonly MemoryEvent[];
  photos: number;
  tzMin: number;
  max?: number;
}): Highlight[] {
  const { outing: o } = input;
  const c: Highlight[] = [];
  c.push({ kind: 'distance', value: o.distanceM / 1000, score: 50 + Math.min(40, o.distanceM / 5000) });
  c.push({ kind: 'duration', value: Math.round((o.end - o.start) / 60_000), score: 30 + Math.min(30, (o.end - o.start) / 600_000) });
  const speeds = [{ who: input.me, kph: o.topSpeedKph }, ...input.posts.filter((p) => typeof p.topKph === 'number').map((p) => ({ who: p.from, kph: p.topKph! }))];
  const top = speeds.reduce((a, b) => (b.kph > a.kph ? b : a), speeds[0]!);
  if (top.kph >= 20) c.push({ kind: 'topSpeed', value: Math.round(top.kph), ...(top.who !== input.me ? { who: top.who } : {}), score: 35 + (speeds.length > 1 ? 15 : 0) });
  const far = farthestKm(input.myTrack);
  if (far >= 5) c.push({ kind: 'farthest', value: Math.round(far * 10) / 10, score: 25 + Math.min(30, far / 4) });
  if (o.stops.length >= 1) c.push({ kind: 'stops', value: o.stops.length, score: 30 + o.stops.length * 8 });
  if (o.members.length >= 1) c.push({ kind: 'crew', value: o.members.length + 1, score: 45 + o.members.length * 6 });
  const bySender = new Map<string, number>();
  for (const e of input.events) bySender.set(e.from, (bySender.get(e.from) ?? 0) + 1);
  const hype = [...bySender].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (hype && hype[1] >= 3) c.push({ kind: 'hype', value: hype[1], ...(hype[0] !== input.me ? { who: hype[0] } : {}), score: 40 + Math.min(30, hype[1] * 3) });
  if (input.photos > 0) c.push({ kind: 'photos', value: input.photos, score: 38 + Math.min(20, input.photos * 4) });
  const endH = hourOf(o.end, input.tzMin);
  const startH = hourOf(o.start, input.tzMin);
  if (endH >= 23 || endH < 4) c.push({ kind: 'nightOwl', value: endH, score: 42 });
  else if (startH >= 4 && startH < 7) c.push({ kind: 'earlyBird', value: startH, score: 42 });
  return c.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind)).slice(0, input.max ?? MEMORY.maxHighlights);
}

/** Start, joins/leaves, stops, emotes, photos and end, in time order (ties: the listed order). */
export function buildTimeline(o: Outing, events: readonly MemoryEvent[], photos: readonly MemoryPhoto[]): TimelineItem[] {
  const order: Record<TimelineItem['kind'], number> = { start: 0, join: 1, stop: 2, emote: 3, photo: 4, leave: 5, end: 6 };
  const items: TimelineItem[] = [{ t: o.start, kind: 'start' }];
  for (const m of o.members) {
    items.push({ t: Math.max(o.start, m.joinedAt), kind: 'join', who: m.id });
    if (m.leftAt < o.end - MEMORY.windowSlackMs) items.push({ t: m.leftAt, kind: 'leave', who: m.id });
  }
  for (const s of o.stops) items.push({ t: s.start, kind: 'stop', ...(s.name ? { ref: s.name } : {}) });
  for (const e of events) if (e.t >= o.start - MEMORY.windowSlackMs && e.t <= o.end + MEMORY.windowSlackMs) items.push({ t: e.t, kind: 'emote', who: e.from, ref: e.preset });
  for (const p of photos) items.push({ t: p.at, kind: 'photo', who: p.from, ref: p.h });
  items.push({ t: o.end, kind: 'end' });
  return items.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
}

/**
 * Playback tracks: mine from my drives; a crewmate's from their own shared route when they sent one (it is what they
 * chose to share, and denser), else the fixes this phone received from them during the outing.
 */
export function playbackTracks(o: Outing, me: string, myTrack: readonly TrackPt[], friendTracks: Readonly<Record<string, readonly TrackPt[]>>, posts: readonly RemotePost[]): PlaybackTrack[] {
  const slack = MEMORY.windowSlackMs;
  const inWin = (p: TrackPt) => p.t >= o.start - slack && p.t <= o.end + slack;
  const out: PlaybackTrack[] = [{ who: me, pts: [...myTrack] }];
  for (const m of o.members) {
    const post = posts.find((p) => p.from === m.id && (p.route?.length ?? 0) >= 2);
    const pts = (post?.route ?? friendTracks[m.id] ?? []).filter(inWin).sort((a, b) => a.t - b.t);
    if (pts.length >= 2) out.push({ who: m.id, pts });
  }
  return out;
}

export function assembleRecap(input: {
  outing: Outing;
  me: string;
  myTrack: readonly TrackPt[];
  friendTracks: Readonly<Record<string, readonly TrackPt[]>>;
  posts: readonly RemotePost[];
  events: readonly MemoryEvent[];
  photos: readonly MemoryPhoto[];
  reacts: readonly (MemoryReact & { on?: boolean })[];
  tzMin: number;
}): Recap {
  const o = input.outing;
  const events = input.events.filter((e) => e.t >= o.start - MEMORY.windowSlackMs && e.t <= o.end + MEMORY.windowSlackMs);
  const photos = [...input.photos].sort((a, b) => a.at - b.at);
  return {
    outing: o,
    tracks: playbackTracks(o, input.me, input.myTrack, input.friendTracks, input.posts),
    timeline: buildTimeline(o, events, photos),
    highlights: pickHighlights({ outing: o, myTrack: input.myTrack, me: input.me, posts: input.posts, events, photos: photos.length, tzMin: input.tzMin }),
    photos,
    reactions: reactionSummary(input.reacts, 'memory', input.me),
    emoteCount: events.length,
  };
}

// --- playback clock --------------------------------------------------------------------------------------------------

/** A piece of real time and how long it plays. */
interface Span {
  from: number;
  to: number;
  playFrom: number;
  playMs: number;
}

export interface PlaybackClock {
  durationMs: number;
  /** Real time at a playback offset. */
  realAt(playMs: number): number;
  /** Playback offset of a real time. */
  playAt(realT: number): number;
}

/**
 * Compresses an outing into a short playback: moving time plays at one constant rate, every idle gap longer than
 * `idleGapMs` (nobody's track advances: a stop, a meal) collapses to `stopMs`. Monotonic both ways.
 */
export function playbackClock(tracks: readonly PlaybackTrack[], cfg: { targetMs: number; minMs: number; stopMs: number; idleGapMs: number } = MEMORY.playback): PlaybackClock {
  const times = [...new Set(tracks.flatMap((tr) => tr.pts.map((p) => p.t)))].sort((a, b) => a - b);
  if (times.length < 2) return { durationMs: 0, realAt: () => times[0] ?? 0, playAt: () => 0 };
  const moving: [number, number][] = [];
  const idle: [number, number][] = [];
  for (let i = 1; i < times.length; i++) (times[i]! - times[i - 1]! > cfg.idleGapMs ? idle : moving).push([times[i - 1]!, times[i]!]);
  const movingMs = moving.reduce((n, [a, b]) => n + (b - a), 0);
  const playMoving = Math.max(cfg.minMs, cfg.targetMs - idle.length * cfg.stopMs);
  const rate = movingMs > 0 ? playMoving / movingMs : 0;
  const spans: Span[] = [];
  let at = 0;
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!;
    const b = times[i]!;
    const ms = b - a > cfg.idleGapMs ? cfg.stopMs : (b - a) * rate;
    spans.push({ from: a, to: b, playFrom: at, playMs: ms });
    at += ms;
  }
  const durationMs = at;
  const find = <K extends 'playFrom' | 'from'>(key: K, v: number) => {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spans[mid]![key] <= v) lo = mid;
      else hi = mid - 1;
    }
    return spans[lo]!;
  };
  return {
    durationMs,
    realAt: (p) => {
      if (p <= 0) return times[0]!;
      if (p >= durationMs) return times[times.length - 1]!;
      const s = find('playFrom', p);
      return s.playMs === 0 ? s.from : s.from + ((p - s.playFrom) / s.playMs) * (s.to - s.from);
    },
    playAt: (t) => {
      if (t <= times[0]!) return 0;
      if (t >= times[times.length - 1]!) return durationMs;
      const s = find('from', t);
      return s.to === s.from ? s.playFrom : s.playFrom + ((t - s.from) / (s.to - s.from)) * s.playMs;
    },
  };
}

/** Where each member is at real time `t`, with a heading from the local direction of travel. */
export function posesAt(tracks: readonly PlaybackTrack[], t: number): { who: string; lat: number; lng: number; heading: number; moving: boolean }[] {
  const out: { who: string; lat: number; lng: number; heading: number; moving: boolean }[] = [];
  for (const tr of tracks) {
    const p = positionAt(tr.pts, t);
    if (!p) continue;
    const ahead = positionAt(tr.pts, t + 20_000)!;
    const behind = positionAt(tr.pts, t - 20_000)!;
    const moved = haversineM(behind, ahead);
    out.push({ who: tr.who, lat: p.lat, lng: p.lng, heading: moved > 5 ? bearingDeg(behind, ahead) : 0, moving: moved > 30 });
  }
  return out;
}
