import { describe, expect, it } from 'vitest';
import { DrivingEmoteLimiter, EMOTE_LIMITS, EMOTE_PRESETS, intersects, placeOverlay, validateEmote } from '../src/emotes';
import { computeStats, leaderboard, shareableStats, DEFAULT_VISIBILITY, WalkTracker, type TripSummary } from '../src/stats';
import { lightPreset, sunTimes } from '../src/sun';
import { formatDistance, formatMinutes } from '../src/units';
import { coarsen, decodePolyline, encodePolyline, haversineM } from '../src/geo';

const TZ = -300; // Montréal standard time (UTC−5) for deterministic tests
const NOW = Date.UTC(2026, 10, 20, 17, 0); // Fri 2026-11-20 12:00 local

describe('F3 emotes', () => {
  it('has all eight named presets and validates custom clips', () => {
    expect(EMOTE_PRESETS).toEqual(['getMeFood', 'areWeThereYet', 'whereAreYou', 'hurryUp', 'callMe', 'honkHonk', 'onMyWay', 'missYou']);
    expect(validateEmote({ preset: 'honkHonk' })).toBeNull();
    expect(validateEmote({ preset: 'custom', clip: 'A'.repeat(1000), clipMs: 4000 })).toBeNull();
    expect(validateEmote({ preset: 'custom', clip: 'A'.repeat(1000), clipMs: 6000 })).toBe('clip too long');
    expect(validateEmote({ preset: 'custom', clip: 'A'.repeat(100_000), clipMs: 4000 })).toBe('clip too large');
  });

  it('F3c rate-limits 1 emote per sender per 2 min while the recipient drives', () => {
    const l = new DrivingEmoteLimiter();
    expect(l.allow('alex', 0, true)).toBe(true);
    expect(l.allow('alex', 60_000, true)).toBe(false);
    expect(l.allow('sam', 60_000, true)).toBe(true);
    expect(l.allow('alex', 121_000, true)).toBe(true);
    expect(l.allow('alex', 122_000, false)).toBe(true);
  });

  it('F3c overlay lands in an empty area, never over the banners, speed, or route line', () => {
    const screen = { w: 412, h: 915 };
    const banner = { x: 0, y: 0, w: 412, h: 170 };
    const following = { x: 12, y: 170, w: 220, h: 56 };
    const speed = { x: 12, y: 760, w: 96, h: 96 };
    const bottomBar = { x: 0, y: 860, w: 412, h: 55 };
    const route = Array.from({ length: 40 }, (_, i) => ({ x: 206 + Math.sin(i / 6) * 30, y: 900 - i * 18 }));
    const size = { w: 150, h: 120 };
    const r = placeOverlay(screen, size, [banner, following, speed, bottomBar], route)!;
    expect(r).not.toBeNull();
    for (const o of [banner, following, speed, bottomBar]) expect(intersects(r, o)).toBe(false);
    for (const p of route) expect(p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h).toBe(false);
    expect(EMOTE_LIMITS.drivingDismissMs).toBeLessThanOrEqual(3000);
    // No room → null (falls back to the reserved chip slot).
    expect(placeOverlay({ w: 200, h: 200 }, size, [{ x: 0, y: 0, w: 200, h: 200 }])).toBeNull();
  });
});

const trip = (i: number, over: Partial<TripSummary> = {}): TripSummary => ({
  id: `t${i}`,
  startedAt: NOW - i * 86_400_000,
  endedAt: NOW - i * 86_400_000 + 1_800_000,
  distanceM: 20_000,
  durationS: 1800,
  topSpeedKph: 100 + i,
  avgSpeedKph: 40,
  score: 96,
  passenger: false,
  events: {},
  ...over,
});

describe('F5 / F1e stats', () => {
  it('totals, streaks, places/cities, badges; passengers excluded', () => {
    const trips = Array.from({ length: 8 }, (_, i) => trip(i));
    trips.push(trip(1, { id: 'p', passenger: true, distanceM: 99_000, topSpeedKph: 180 }));
    trips[2]!.events = { hardBrake: 1 };
    trips[2]!.score = 70;
    const walks = [{ startedAt: NOW - 3600_000, endedAt: NOW - 1800_000, distanceM: 2500, kind: 'walk' as const }];
    const visits = [
      { t: NOW - 1000, placeKey: 'a', city: 'Val-Clair' },
      { t: NOW - 2000, placeKey: 'b', city: 'Belle-Rive' },
      { t: NOW - 3000, placeKey: 'a', city: 'Val-Clair' },
    ];
    const s = computeStats({ trips, walks, visits }, 'all', NOW, TZ);
    expect(s.drivenKm).toBe(160);
    expect(s.walkedKm).toBe(2.5);
    expect(s.trips).toBe(8);
    expect(s.topSpeedKph).toBe(107);
    expect(s.longestTrip!.km).toBe(20);
    expect(s.places).toBe(2);
    expect(s.cities).toBe(2);
    expect(s.activeStreakDays).toBe(8);
    expect(s.cleanTripStreak).toBe(2);
    expect(s.events.hardBrake).toBe(1);
    expect(s.badges).toContain('smoothOperator');
    expect(s.badges).toContain('weekStreak');
    const week = computeStats({ trips, walks, visits }, 'week', NOW, TZ);
    expect(week.trips).toBe(5); // Mon–Fri
  });

  it('shares only the fields the owner allowed; leaderboards use only shared fields', () => {
    const s = computeStats({ trips: [trip(0), trip(1)], walks: [], visits: [] }, 'month', NOW, TZ);
    const shared = shareableStats(s, { ...DEFAULT_VISIBILITY, score: false, distance: true }, NOW);
    expect(shared.avgScore).toBeUndefined();
    expect(shared.scoreTrend).toBeUndefined();
    expect(shared.topSpeedKph).toBeUndefined();
    expect(shared.events).toBeUndefined();
    expect(shared.drivenKm).toBe(40);
    expect(JSON.stringify(shared)).not.toContain('"t0"');
    const lb = leaderboard(
      [
        { id: 'me', stats: shared },
        { id: 'alex', stats: { period: 'month', updatedAt: NOW, drivenKm: 55, avgScore: 80 } },
        { id: 'sam', stats: { period: 'month', updatedAt: NOW, drivenKm: 40 } },
      ],
      'drivenKm',
    );
    expect(lb.map((r) => [r.id, r.rank])).toEqual([['alex', 1], ['me', 2], ['sam', 2]]);
    expect(leaderboard([{ id: 'me', stats: shared }], 'avgScore')).toEqual([]);
  });

  it('detects a walk from fixes', () => {
    const w = new WalkTracker();
    let out = null;
    for (let i = 0; i <= 300; i++) out = w.onFix({ t: i * 1000, lat: 45.65 + i * 0.000012, lng: -74.33, speed: 1.4 }, true) ?? out;
    out = w.close() ?? out;
    expect(out?.kind).toBe('walk');
    expect(out!.distanceM).toBeGreaterThan(350);
  });
});

describe('geo / units / sun', () => {
  it('polyline round-trip, coarsening ~1 km, formatting', () => {
    const pts = [{ lat: 45.6519, lng: -74.3369 }, { lat: 45.66, lng: -74.3 }];
    expect(decodePolyline(encodePolyline(pts))[1]!.lat).toBeCloseTo(45.66, 5);
    const c = coarsen(pts[0]!, 1000);
    expect(haversineM(c, pts[0]!)).toBeLessThan(800);
    expect(coarsen({ lat: 45.6521, lng: -74.3371 }, 1000)).toEqual(c);
    expect(formatDistance(420)).toBe('420 m');
    expect(formatDistance(12_400, 'fr')).toBe('12 km');
    expect(formatDistance(3_450, 'fr')).toBe('3,5 km');
    expect(formatMinutes(3900)).toBe('1 h 05');
  });

  it('sunset in Val-Clair is ~16:20 local in late November; night theme after dusk', () => {
    const s = sunTimes(NOW, 45.65, -74.34)!;
    const sunsetLocal = new Date(s.sunset + TZ * 60_000);
    expect(sunsetLocal.getUTCHours()).toBe(16);
    expect(lightPreset(NOW, 45.65, -74.34)).toBe('day');
    expect(lightPreset(s.sunset + 2 * 3600_000, 45.65, -74.34)).toBe('night');
    expect(lightPreset(s.sunset, 45.65, -74.34)).toBe('dusk');
  });
});
