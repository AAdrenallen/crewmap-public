import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { destination } from '../src/geo';
import {
  classifyParking,
  cleanNote,
  NO_PARKING,
  PARKING,
  parkCandidate,
  parkingQuery,
  parkingStep,
  parseParkingContext,
  parseWalk,
  readParkingState,
  spotExpired,
  straightWalk,
  walkingUrl,
  type ParkingState,
  type ParkTrip,
} from '../src/parking';

const fixture = (n: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `parking-${n}.json`), 'utf8')) as { spot: { lat: number; lng: number }; osm: unknown };

const T = Date.UTC(2026, 10, 20, 15, 0, 0);

/** A drive arriving at `spot` from the south, heading north, stopping there. */
function tripTo(spot: { lat: number; lng: number }, id = 't1'): ParkTrip {
  const points = Array.from({ length: 30 }, (_, i) => {
    const p = destination(spot, 180, (29 - i) * 12);
    return { t: T + i * 1000, ...p, speed: i === 29 ? 0 : 12, heading: i === 29 ? null : 0 };
  });
  return { id, endedAt: T + 29_000, passenger: false, points };
}

const home = (p: { lat: number; lng: number }) => ({ type: 'home' as const, lat: p.lat, lng: p.lng, radiusM: 80 });

describe('parking tunables', () => {
  it('are sane', () => {
    expect(PARKING.streetMaxM).toBeGreaterThan(PARKING.drivewayMaxM);
    expect(PARKING.lookupRadiusM).toBeGreaterThanOrEqual(PARKING.houseNearM);
    expect(PARKING.walkAwayM).toBeGreaterThan(PARKING.arrivedM);
    expect(PARKING.forgetAfterOptionsH).toContain(PARKING.defaultForgetAfterH);
    expect(PARKING.skipPlaceTypes).toContain('home');
  });
});

describe('parkCandidate', () => {
  it('takes the last point and the last moving heading', () => {
    const f = fixture('street');
    const c = parkCandidate(tripTo(f.spot))!;
    expect(c.lat).toBeCloseTo(f.spot.lat, 6);
    expect(c.lng).toBeCloseTo(f.spot.lng, 6);
    expect(c.heading).toBe(0);
    expect(c.at).toBe(T + 29_000);
  });
  it('falls back to the bearing of the final metres when fixes carry no heading', () => {
    const tr = tripTo(fixture('street').spot);
    const c = parkCandidate({ ...tr, points: tr.points.map((p) => ({ ...p, heading: null })) })!;
    expect(Math.min(c.heading!, 360 - c.heading!)).toBeLessThan(1);
  });
  it('never for a passenger trip', () => {
    expect(parkCandidate({ ...tripTo(fixture('street').spot), passenger: true })).toBeNull();
  });
});

describe('classifyParking (fixtures)', () => {
  it('street park is saved with the street name', () => {
    const f = fixture('street');
    const ctx = parseParkingContext(f.osm, f.spot);
    expect(ctx.roads[0]!.distM).toBeLessThan(6);
    expect(classifyParking(f.spot, [], ctx)).toEqual({ save: true, kind: 'street', street: 'Rue Saint-Denis' });
  });
  it('home driveway is skipped: by the saved Home place, and by OSM alone', () => {
    const f = fixture('driveway');
    const ctx = parseParkingContext(f.osm, f.spot);
    expect(classifyParking(f.spot, [home(destination(f.spot, 45, 30))], ctx)).toEqual({ save: false, reason: 'home' });
    expect(classifyParking(f.spot, [home(destination(f.spot, 45, 30))], null)).toEqual({ save: false, reason: 'home' });
    expect(classifyParking(f.spot, [], ctx)).toEqual({ save: false, reason: 'driveway' });
  });
  it('a house with no street right there is a private spot', () => {
    const f = fixture('driveway');
    const ctx = parseParkingContext(f.osm, f.spot);
    const noDriveway = { ...ctx, roads: ctx.roads.filter((r) => r.service !== 'driveway') };
    expect(classifyParking(f.spot, [], noDriveway)).toEqual({ save: false, reason: 'private' });
  });
  it('parking lot is saved with the lot name', () => {
    const f = fixture('lot');
    const ctx = parseParkingContext(f.osm, f.spot);
    expect(ctx.lots[0]!.inside).toBe(true);
    expect(classifyParking(f.spot, [], ctx)).toEqual({ save: true, kind: 'lot', street: 'Stationnement du Stade' });
  });
  it('a private lot by a house is skipped; other saved place types do not block', () => {
    const f = fixture('lot');
    const ctx = parseParkingContext(f.osm, f.spot);
    const priv = { ...ctx, lots: ctx.lots.map((l) => ({ ...l, access: 'private' })), buildings: [{ building: 'house', distM: 10, inside: false }] };
    expect(classifyParking(f.spot, [], priv)).toEqual({ save: false, reason: 'private' });
    expect(classifyParking(f.spot, [{ type: 'work', lat: f.spot.lat, lng: f.spot.lng, radiusM: 100 }], ctx).save).toBe(true);
  });
  it('no OSM data (offline): saved as unknown', () => {
    expect(classifyParking(fixture('street').spot, [], null)).toEqual({ save: true, kind: 'unknown', street: null });
  });
  it('parser ignores malformed input', () => {
    const p = fixture('street').spot;
    expect(parseParkingContext(null, p)).toEqual({ roads: [], lots: [], buildings: [] });
    expect(parseParkingContext({ elements: [{ type: 'way', tags: { highway: 'residential' }, geometry: 'x' }, 5] }, p).roads).toEqual([]);
  });
  it('query asks for roads, parking and buildings around the spot', () => {
    const q = parkingQuery({ lat: 45.5, lng: -73.6 });
    expect(q).toContain('around:40,45.500000,-73.600000');
    expect(q).toContain('[amenity=parking]');
    expect(q).toContain('out tags geom');
  });
});

describe('parking session', () => {
  const run = (st: ParkingState, ...inputs: Parameters<typeof parkingStep>[1][]) => {
    const effects: string[] = [];
    for (const i of inputs) {
      const r = parkingStep(st, i);
      st = r.state;
      effects.push(...r.effects.map((e) => (e.type === 'cleared' ? `cleared:${e.why}` : e.type === 'skipped' ? `skipped:${e.reason}` : e.type)));
    }
    return { st, effects };
  };
  const f = fixture('street');
  const c = parkCandidate(tripTo(f.spot))!;
  const parked = { type: 'parked' as const, candidate: c, decision: classifyParking(f.spot, [], parseParkingContext(f.osm, f.spot)) };

  it('saves, notices the walk away once, keeps a note', () => {
    const away = destination(f.spot, 90, 60);
    const r = run(NO_PARKING, parked, { type: 'fix', t: c.at + 30_000, ...destination(f.spot, 90, 10) }, { type: 'fix', t: c.at + 60_000, ...away }, { type: 'fix', t: c.at + 90_000, ...away }, { type: 'note', text: '  Level  P2,\nspot 14 ' });
    expect(r.effects).toEqual(['saved', 'walkedAway']);
    expect(r.st.spot!.street).toBe('Rue Saint-Denis');
    expect(r.st.spot!.note).toBe('Level P2, spot 14');
  });
  it('driving away clears the spot; a drive starting elsewhere does not', () => {
    const saved = run(NO_PARKING, parked).st;
    expect(run(saved, { type: 'tripStarted', t: c.at + 3600_000, ...destination(f.spot, 0, 2000) }).st.spot).not.toBeNull();
    const r = run(saved, { type: 'tripStarted', t: c.at + 3600_000, ...destination(f.spot, 0, 30) });
    expect(r.effects).toEqual(['cleared:droveAway']);
    expect(r.st.spot).toBeNull();
  });
  it('a skipped stop keeps nothing; forget and expiry clear', () => {
    const d = fixture('driveway');
    const skip = { type: 'parked' as const, candidate: parkCandidate(tripTo(d.spot))!, decision: classifyParking(d.spot, [], parseParkingContext(d.osm, d.spot)) };
    expect(run(NO_PARKING, skip)).toEqual({ st: NO_PARKING, effects: ['skipped:driveway'] });
    const saved = run(NO_PARKING, parked).st;
    expect(run(saved, { type: 'forget' }).effects).toEqual(['cleared:forgot']);
    expect(run(saved, { type: 'tick', now: c.at + 23 * 3600_000, forgetAfterH: 24 }).st.spot).not.toBeNull();
    expect(run(saved, { type: 'tick', now: c.at + 24 * 3600_000, forgetAfterH: 24 }).effects).toEqual(['cleared:expired']);
    expect(spotExpired(saved.spot!, c.at + 1e10, 0)).toBe(false);
  });
  it('persisted state round-trips; garbage reads as nothing', () => {
    const saved = run(NO_PARKING, parked).st;
    expect(readParkingState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(readParkingState({ spot: { lat: 'x' } })).toEqual(NO_PARKING);
    expect(readParkingState(null)).toEqual(NO_PARKING);
    expect(cleanNote('x'.repeat(200))).toHaveLength(PARKING.noteMax);
  });
});

describe('walk route', () => {
  it('builds a walking Directions URL and parses its route', () => {
    const a = { lat: 45.5, lng: -73.6 };
    const b = destination(a, 90, 300);
    expect(walkingUrl(a, b, 'pk.x', 'fr')).toMatch(/^https:\/\/api\.mapbox\.com\/directions\/v5\/mapbox\/walking\/-73\.600000,45\.500000;/);
    expect(parseWalk({ code: 'NoRoute', routes: [] })).toBeNull();
    expect(parseWalk({ code: 'Ok', routes: [{ geometry: '_ibE_ibE_seK_seK', distance: 10, duration: 8 }] })?.line).toHaveLength(2);
    const s = straightWalk(a, b);
    expect(s.distanceM).toBeCloseTo(300, 0);
    expect(s.durationS).toBeGreaterThan(200);
  });
});
