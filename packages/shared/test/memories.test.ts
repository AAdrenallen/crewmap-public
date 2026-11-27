import { describe, expect, it } from 'vitest';
import {
  CARD,
  MEMORY,
  MEMORY_REACTIONS,
  assembleRecap,
  buildOutings,
  buildTimeline,
  chainTrips,
  companionsOf,
  matchMemory,
  notableReasons,
  overlapShare,
  pickHighlights,
  playbackClock,
  posesAt,
  positionAt,
  projectLines,
  reactionSummary,
  seasonChoices,
  seasonOf,
  seasonRange,
  seasonSummary,
  thinTrack,
  type MemoryDigest,
  type TrackPt,
  type TripLite,
} from '../src/memories';

// Public landmarks only: Old Port of Montréal → Mont Royal chalet → Jean-Talon Market.
const OLD_PORT = { lat: 45.5075, lng: -73.5524 };
const CHALET = { lat: 45.5035, lng: -73.5871 };
const JEAN_TALON = { lat: 45.5363, lng: -73.6146 };
const T0 = Date.UTC(2026, 6, 4, 14, 0); // 10:00 in Montréal (UTC-4)
const MIN = 60_000;

function line(a: { lat: number; lng: number }, b: { lat: number; lng: number }, t0: number, mins: number, step = 1): TrackPt[] {
  const n = Math.max(1, Math.round(mins / step));
  return Array.from({ length: n + 1 }, (_, i) => ({ t: t0 + i * step * MIN, lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n, spd: 12 }));
}

function trip(id: string, a: typeof OLD_PORT, b: typeof OLD_PORT, t0: number, mins: number, km = 5): TripLite {
  return { id, startedAt: t0, endedAt: t0 + mins * MIN, distanceM: km * 1000, durationS: mins * 60, topSpeedKph: 70, passenger: false, line: line(a, b, t0, mins) };
}

const day = [trip('a', OLD_PORT, CHALET, T0, 20), trip('b', CHALET, JEAN_TALON, T0 + 80 * MIN, 25)];

describe('config', () => {
  it('keeps sane, ordered tunables', () => {
    expect(MEMORY.minTogetherMs).toBeLessThan(MEMORY.chainGapMs);
    expect(MEMORY.maxFixGapMs).toBeGreaterThan(MEMORY.track.minIntervalMs);
    expect(MEMORY.playback.minMs).toBeLessThan(MEMORY.playback.targetMs);
    expect(MEMORY.notable.newCityMinM).toBeLessThan(MEMORY.notable.longDayM);
    expect(MEMORY_REACTIONS.length).toBeGreaterThanOrEqual(4);
  });
});

describe('grouping', () => {
  it('chains drives with short stops and splits on long ones', () => {
    const late = trip('c', JEAN_TALON, OLD_PORT, T0 + 10 * 3600_000, 20);
    const chains = chainTrips([late, ...day]);
    expect(chains.map((c) => c.map((x) => x.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('interpolates and clamps positions', () => {
    const tr = line(OLD_PORT, CHALET, T0, 10);
    expect(positionAt(tr, T0 - MIN)).toEqual(tr[0]);
    const mid = positionAt(tr, T0 + 5 * MIN)!;
    expect(mid.lat).toBeCloseTo((OLD_PORT.lat + CHALET.lat) / 2, 4);
    expect(positionAt([], T0)).toBeNull();
  });

  it('finds the crewmate who rode along, with join and leave times', () => {
    const me = day.flatMap((d) => d.line);
    // Sam joins 5 minutes in and stays; Lee drives the other way the whole time.
    const sam = me.filter((p) => p.t >= T0 + 5 * MIN).map((p) => ({ ...p, lat: p.lat + 0.0005 }));
    const lee = line(JEAN_TALON, OLD_PORT, T0, 105);
    const ms = companionsOf(me, { sam, lee }, [T0, T0 + 105 * MIN]);
    expect(ms.map((m) => m.id)).toEqual(['sam']);
    expect(ms[0]!.joinedAt).toBe(T0 + 5 * MIN);
    expect(ms[0]!.togetherMs).toBeGreaterThanOrEqual(MEMORY.minTogetherMs);
  });

  it('a drive-along session counts even without many fixes', () => {
    const ms = companionsOf(day[0]!.line, {}, [T0, T0 + 20 * MIN], [{ who: 'kim', from: T0 + 2 * MIN, to: T0 + 30 * MIN }]);
    expect(ms).toMatchObject([{ id: 'kim', joinedAt: T0 + 2 * MIN, leftAt: T0 + 20 * MIN, session: true }]);
  });

  it('does not count stretches with no fixes as together', () => {
    const me = day[0]!.line;
    const sparse = [me[0]!, me[me.length - 1]!];
    expect(companionsOf(me, { sam: sparse }, [T0, T0 + 20 * MIN])).toEqual([]);
  });

  it('builds a group outing with its stop, and drops a plain solo drive', () => {
    const sam = day.flatMap((d) => d.line).map((p) => ({ ...p }));
    const solo = trip('s', OLD_PORT, CHALET, T0 + 2 * 86_400_000, 15);
    const outs = buildOutings({ trips: [...day, solo], friendTracks: { sam } });
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ id: 'o-a', kind: 'group', tripIds: ['a', 'b'], distanceM: 10_000 });
    expect(outs[0]!.stops).toHaveLength(1);
    expect(outs[0]!.stops[0]!.end - outs[0]!.stops[0]!.start).toBe(60 * MIN);
  });

  it('keeps a notable solo outing', () => {
    const long = trip('l', OLD_PORT, JEAN_TALON, T0, 200, 180);
    const outs = buildOutings({ trips: [long], friendTracks: {}, notable: (o) => notableReasons(o, { history: [], knownCities: new Set() }) });
    expect(outs[0]).toMatchObject({ kind: 'notable', notable: ['longDay', 'roadTrip'] });
  });

  it('records and new cities are notable', () => {
    const hist = [1, 2, 3].map((i) => ({ end: T0 - i * 86_400_000, distanceM: 20_000 }));
    const o = { start: T0, distanceM: 45_000, drivingS: 3000 };
    expect(notableReasons(o, { history: hist, knownCities: new Set(['Montréal']), stopCities: ['Montréal'] })).toEqual(['record']);
    expect(notableReasons(o, { history: [], knownCities: new Set(['Montréal']), stopCities: ['Laval'] })).toEqual(['newCity']);
    expect(notableReasons({ ...o, distanceM: 10_000 }, { history: [], knownCities: new Set(), stopCities: ['Laval'] })).toEqual([]);
  });
});

describe('matching remote memories', () => {
  const mems = [{ id: 'o-a', start: T0, end: T0 + 105 * MIN, aliases: ['o-x'] }];
  it('uses aliases first, then the time overlap', () => {
    expect(matchMemory(mems, 'o-x', [0, 1])).toBe('o-a');
    expect(matchMemory(mems, 'o-new', [T0 + 30 * MIN, T0 + 3 * 3600_000])).toBe('o-a');
    expect(matchMemory(mems, 'o-new', [T0 + 5 * 3600_000, T0 + 6 * 3600_000])).toBeNull();
  });
  it('overlap share is relative to the shorter window', () => {
    expect(overlapShare([0, 10], [5, 100])).toBe(0.5);
    expect(overlapShare([0, 10], [20, 30])).toBe(0);
  });
  it('thins tracks keeping both ends', () => {
    const tr = line(OLD_PORT, CHALET, T0, 300);
    const th = thinTrack(tr, 50);
    expect(th).toHaveLength(50);
    expect(th[0]).toEqual(tr[0]);
    expect(th[49]).toEqual(tr[tr.length - 1]);
  });
});

describe('recap', () => {
  const sam = day.flatMap((d) => d.line).map((p) => ({ ...p, lat: p.lat + 0.0003 }));
  const outing = buildOutings({ trips: day, friendTracks: { sam } })[0]!;
  outing.stops[0]!.name = 'Mont Royal';
  const events = [0, 1, 2, 3].map((i) => ({ t: T0 + (10 + i) * MIN, from: 'sam', to: 'me', preset: 'honkHonk' as const }));

  it('picks the most interesting highlights, with crewmates only when shared', () => {
    const hl = pickHighlights({ outing, myTrack: sam, me: 'me', posts: [{ from: 'sam', mid: 'o-z', window: [T0, T0 + MIN], topKph: 95, at: T0 }], events, photos: 2, tzMin: -240 });
    expect(hl).toHaveLength(MEMORY.maxHighlights);
    expect(hl[0]!.kind).toBe('distance');
    const kinds = hl.map((h) => h.kind);
    expect(kinds).toContain('crew');
    expect(kinds).toContain('hype');
    const all = pickHighlights({ outing, myTrack: sam, me: 'me', posts: [{ from: 'sam', mid: 'o-z', window: [T0, T0 + MIN], topKph: 95, at: T0 }], events, photos: 2, tzMin: -240, max: 20 });
    expect(all.find((h) => h.kind === 'topSpeed')).toMatchObject({ value: 95, who: 'sam' });
  });

  it('orders the timeline and keeps only the outing window', () => {
    const tl = buildTimeline(outing, [...events, { t: T0 + 9 * 3600_000, from: 'sam', to: 'me', preset: 'honkHonk' }], [{ h: 'ab', from: 'me', at: T0 + 30 * MIN, w: 1, hgt: 1 }]);
    expect(tl[0]!.kind).toBe('start');
    expect(tl[1]).toMatchObject({ kind: 'join', who: 'sam' });
    expect(tl.filter((x) => x.kind === 'emote')).toHaveLength(4);
    expect(tl.find((x) => x.kind === 'stop')!.ref).toBe('Mont Royal');
    expect(tl[tl.length - 1]!.kind).toBe('end');
  });

  it('assembles tracks: shared route wins over recorded fixes', () => {
    const route = line(OLD_PORT, JEAN_TALON, T0, 100, 5);
    const r = assembleRecap({ outing, me: 'me', myTrack: day.flatMap((d) => d.line), friendTracks: { sam }, posts: [{ from: 'sam', mid: 'o-z', window: [T0, T0 + 100 * MIN], route, at: T0 }], events, photos: [], reacts: [], tzMin: -240 });
    expect(r.tracks.map((t) => t.who)).toEqual(['me', 'sam']);
    expect(r.tracks[1]!.pts).toHaveLength(route.length);
    expect(r.emoteCount).toBe(4);
  });

  it('counts reactions, latest per person and emoji, toggles off', () => {
    const rs = reactionSummary(
      [
        { from: 'a', target: 'memory', e: '🔥', at: 1 },
        { from: 'b', target: 'memory', e: '🔥', at: 2 },
        { from: 'me', target: 'memory', e: '❤️', at: 3 },
        { from: 'b', target: 'memory', e: '🔥', at: 4, on: false },
        { from: 'a', target: 'photo', e: '😂', at: 5 },
      ],
      'memory',
      'me',
    );
    expect(rs).toEqual([
      { e: '❤️', n: 1, mine: true },
      { e: '🔥', n: 1, mine: false },
    ]);
  });
});

describe('playback', () => {
  const tracks = [{ who: 'me', pts: day.flatMap((d) => d.line) }];
  it('compresses moving time to the target and stops to a beat', () => {
    const c = playbackClock(tracks);
    expect(c.durationMs).toBeCloseTo(MEMORY.playback.targetMs, 0);
    // The hour-long stop plays in stopMs.
    const before = c.playAt(T0 + 20 * MIN);
    const after = c.playAt(T0 + 80 * MIN);
    expect(after - before).toBeCloseTo(MEMORY.playback.stopMs, 0);
  });
  it('is monotonic and round-trips', () => {
    const c = playbackClock(tracks);
    let prev = -1;
    for (let p = 0; p <= c.durationMs; p += 500) {
      const t = c.realAt(p);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    const t = T0 + 10 * MIN;
    expect(c.realAt(c.playAt(t))).toBeCloseTo(t, -2);
  });
  it('an empty track plays nothing', () => {
    expect(playbackClock([]).durationMs).toBe(0);
  });
  it('poses carry a heading while moving', () => {
    const p = posesAt(tracks, T0 + 10 * MIN)[0]!;
    expect(p.moving).toBe(true);
    expect(p.heading).toBeGreaterThan(180); // westward
    expect(posesAt(tracks, T0 + 50 * MIN)[0]!.moving).toBe(false);
  });
});

describe('season summary', () => {
  const tz = -240;
  const mk = (id: string, t: number, members: string[], places: string[], km = 20): MemoryDigest => ({ id, start: t, end: t + 2 * 3600_000, kind: members.length ? 'group' : 'notable', distanceM: km * 1000, members, places, photos: 1, emotes: 3 });
  const mems = [
    mk('1', Date.UTC(2026, 5, 6, 16), ['sam'], ['Mont Royal']),
    mk('2', Date.UTC(2026, 5, 13, 16), ['sam', 'kim'], ['Mont Royal', 'Jean-Talon Market'], 60),
    mk('3', Date.UTC(2026, 6, 20, 16), [], ['Old Port']),
  ];
  it('seasons follow meteorological months, December is next winter', () => {
    expect(seasonOf(Date.UTC(2026, 11, 15), tz)).toEqual({ season: 'winter', year: 2027 });
    expect(seasonOf(Date.UTC(2026, 6, 1), tz).season).toBe('summer');
    const [s, e] = seasonRange('summer', 2026, tz);
    expect(new Date(s).getUTCMonth()).toBe(5);
    expect(e - s).toBe(92 * 86_400_000);
  });
  it('summarises crew, places, longest and the week streak', () => {
    const s = seasonSummary(mems, 'summer', 2026, tz)!;
    expect(s).toMatchObject({ outings: 3, groupOutings: 2, km: 100, photos: 3, emotes: 9, busiestMonth: 5, weekStreak: 2 });
    expect(s.crew).toEqual([
      { id: 'sam', outings: 2 },
      { id: 'kim', outings: 1 },
    ]);
    expect(s.places[0]).toEqual({ name: 'Mont Royal', n: 2 });
    expect(s.longest).toEqual({ id: '2', km: 60 });
  });
  it('needs enough outings, and offers only periods with a summary', () => {
    expect(seasonSummary(mems, 'winter', 2026, tz)).toBeNull();
    const ch = seasonChoices(mems, Date.UTC(2026, 7, 30), tz);
    expect(ch).toEqual([{ season: 'summer', year: 2026 }, { season: 'year', year: 2026 }]);
  });
});

describe('share card', () => {
  it('projects routes inside the box, keeping aspect', () => {
    const paths = projectLines([[OLD_PORT, CHALET, JEAN_TALON]], { x: CARD.pad, y: CARD.mapTop, w: CARD.w - 2 * CARD.pad, h: CARD.mapH });
    expect(paths).toHaveLength(1);
    const nums = paths[0]!.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(CARD.pad - 0.1);
      expect(nums[i]).toBeLessThanOrEqual(CARD.w - CARD.pad + 0.1);
      expect(nums[i + 1]).toBeGreaterThanOrEqual(CARD.mapTop - 0.1);
      expect(nums[i + 1]).toBeLessThanOrEqual(CARD.mapTop + CARD.mapH + 0.1);
    }
    expect(projectLines([[OLD_PORT]], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe('together slack', () => {
  it('a crewmate waiting at my start before I leave is not together-time', () => {
    const me = day[0]!.line;
    const start = me[0]!;
    const waiting = Array.from({ length: 6 }, (_, i) => ({ ...start, t: T0 - 9 * MIN + i * 1.5 * MIN }));
    expect(companionsOf(me, { sam: waiting }, [T0, T0 + 20 * MIN])).toEqual([]);
  });
});
