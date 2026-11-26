import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NavRoute } from '@crewmap/shared/navigation';
import { cumulativeDistances } from '@crewmap/shared/geo';
import {
  credits,
  easternClock,
  easternToUtc,
  HazardService,
  hazardsFromRoute,
  hazardsFromRoutes,
  incidentsAlong,
  MemoryLedger,
  mergeHazards,
  MontrealSource,
  MTL_BBOX,
  MTL_REFRESH_MS,
  mtlImpactType,
  normaliseQc,
  OFFICIAL_FEED_TTL_MS,
  parseQcDate,
  qcEventType,
  QuebecSource,
  WazePaidSource,
  type Hazard,
  type HttpGet,
} from '../src';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
/** 2026-11-24 15:00 UTC = 10:00 Tuesday in Montréal (EST). Recording day of the live fixtures. */
const LIVE = Date.UTC(2026, 10, 24, 15, 0);
const VAL_CLAIR = { south: 45.45, west: -74.55, north: 45.8, east: -73.8 };

function http(routes: Record<string, { status: number; body: unknown }>): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const v = routes[key]!;
    return { status: v.status, json: async () => v.body, text: async () => JSON.stringify(v.body) };
  }) as HttpGet & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

describe('Eastern time (DST-exact)', () => {
  it('converts Québec wall-clock to UTC across DST edges', () => {
    expect(easternToUtc(2026, 3, 15, 12, 0)).toBe(Date.UTC(2026, 2, 15, 16, 0)); // after 2nd Sunday of March → EDT
    expect(easternToUtc(2026, 3, 7, 12, 0)).toBe(Date.UTC(2026, 2, 7, 17, 0)); // before → EST
    expect(easternToUtc(2026, 10, 31, 12, 0)).toBe(Date.UTC(2026, 9, 31, 16, 0));
    expect(easternToUtc(2026, 11, 1, 3, 0)).toBe(Date.UTC(2026, 10, 1, 8, 0)); // after 1st Sunday of November → EST
    expect(parseQcDate('2026/11/27 06:00:00')).toBe(Date.UTC(2026, 10, 27, 11, 0));
    expect(easternClock(LIVE)).toEqual({ weekday: 2, minutes: 600 });
  });
});

describe('MTMD feeds (live recording 2026-11-24, Val-Clair / A-50 / R-148 / A-640)', () => {
  it('parses current chantiers near Val-Clair with end date, attribution-ready source and TTL', async () => {
    const h = http({ chantiers_mtmdet: { status: 200, body: fx('qc-chantiers-north.json') }, evenements_inondation: { status: 200, body: EMPTY_FC }, conditions_routieres: { status: 200, body: EMPTY_FC }, evenements: { status: 200, body: EMPTY_FC }, radars_photos: { status: 200, body: EMPTY_FC } });
    const q = new QuebecSource(h);
    const hs = await q.fetch({ bbox: VAL_CLAIR, now: LIVE, reason: 'chore' });
    expect(q.health().status).toBe('ok');
    expect(hs).toHaveLength(3);
    const r148 = hs.find((x) => x.id === 'quebec:works:167790')!;
    expect(r148.street).toContain('Pont-Ouest');
    expect(r148.type).toBe('construction');
    expect(r148.endsAt).toBe(Date.UTC(2026, 10, 27, 11, 0));
    expect(r148.expiresAt).toBe(LIVE + OFFICIAL_FEED_TTL_MS);
    expect(r148.reportedAt).toBe(parseQcDate('2026/11/20 16:36:00'));
    expect(r148.line!.length).toBeGreaterThanOrEqual(2);
    expect(credits(mergeHazards([r148], LIVE)[0]!)).toEqual(['Gouvernement du Québec (MTMD), CC-BY 4.0']);
  });

  it('drops ended works and works whose window has not started; never outlives the published end', () => {
    const f = (fx('qc-chantiers-north.json') as { features: unknown[] }).features[0]!;
    const ends = parseQcDate((f as { properties: { fin: string } }).properties.fin)!;
    expect(normaliseQc('ms:chantiers_mtmdet', f, ends + 1)).toBeNull();
    expect(normaliseQc('ms:chantiers_mtmdet', f, ends - 60_000)!.expiresAt).toBe(ends);
    const start = parseQcDate((f as { properties: { debut: string } }).properties.debut)!;
    expect(normaliseQc('ms:chantiers_mtmdet', f, start - 3600_000)).toBeNull();
  });

  it('types events: lane closures are not road closures', async () => {
    expect(qcEventType('Fermeture de 1 voie sur 2', 'Mesures préventives')).toBe('hazard');
    expect(qcEventType('Fermeture', 'Bris de la structure')).toBe('closure');
    expect(qcEventType('Circulation en alternance', 'Travaux')).toBe('construction');
    expect(qcEventType('Fermeture', 'Accident')).toBe('accident');
    const h = http({ chantiers_mtmdet: { status: 200, body: EMPTY_FC }, evenements_inondation: { status: 200, body: EMPTY_FC }, conditions_routieres: { status: 200, body: EMPTY_FC }, evenements: { status: 200, body: fx('qc-evenements-live.json') }, radars_photos: { status: 200, body: EMPTY_FC } });
    const hs = await new QuebecSource(h).fetch({ bbox: VAL_CLAIR, now: LIVE, reason: 'chore' });
    expect(hs.map((x) => x.type).sort()).toEqual(['closure', 'hazard', 'hazard']);
    expect(hs.every((x) => x.expiresAt === LIVE + OFFICIAL_FEED_TTL_MS)).toBe(true);
  });
});

describe('Ville de Montréal entraves (live recording 2026-11-24)', () => {
  const routes = () =>
    http({ 'a2bc8014-488c-495d-941b-e7ae1999d1bd': { status: 200, body: fx('mtl-impacts.json') }, 'cc41b532-f12d-40fb-9f55-eb58c9a2b12b': { status: 200, body: fx('mtl-permits.json') } });

  it('maps impacts; parking-only permits are dropped', () => {
    expect(mtlImpactType('Rue barrée')).toBe('closure');
    expect(mtlImpactType('Voie de circulation obstruée')).toBe('construction');
    expect(mtlImpactType('Voie de stationnement et voie de circulation obstruées')).toBe('construction');
    expect(mtlImpactType('Voie de stationnement obstruée')).toBeNull();
    expect(mtlImpactType('Aucun impact / non applicable')).toBeNull();
  });

  it('keeps active traffic-affecting permits, honours the weekly schedule and end dates', async () => {
    const h = routes();
    const src = new MontrealSource(h);
    const hs = await src.fetch({ bbox: MTL_BBOX, now: LIVE, reason: 'chore' });
    expect(src.health().status).toBe('ok');
    expect(hs.map((x) => x.id).sort()).toEqual(
      ['montreal:67aa3ef05408a50019f0945a', 'montreal:67aa441d5408a50019f0954e', 'montreal:6ad611f4d4f58c1f3662f079', 'montreal:6ad670832889b2709fbdf259', 'montreal:6ad758ac2889b2709fc2e557'].sort(),
    );
    expect(hs.filter((x) => x.type === 'closure')).toHaveLength(3);
    const day = hs.find((x) => x.id === 'montreal:6ad758ac2889b2709fc2e557')!; // Tue 07:00–16:00, ends 13:59 local
    expect(day.endsAt).toBe(Date.parse('2026-11-24T18:59:59Z'));
    expect(day.expiresAt).toBe(LIVE + OFFICIAL_FEED_TTL_MS);
    // 06:30 local: before the daily window → not shown (re-evaluated from cache, no new download).
    const early = await src.fetch({ bbox: MTL_BBOX, now: Date.UTC(2026, 10, 24, 11, 30), reason: 'chore' });
    expect(early.some((x) => x.id === day.id)).toBe(false);
    // After its end date → gone.
    const late = await src.fetch({ bbox: MTL_BBOX, now: Date.parse('2026-11-24T19:00:00Z'), reason: 'chore' });
    expect(late.some((x) => x.id === day.id)).toBe(false);
    expect(h.calls).toHaveLength(2);
    await src.fetch({ bbox: MTL_BBOX, now: LIVE + MTL_REFRESH_MS, reason: 'chore' });
    expect(h.calls).toHaveLength(4);
  });

  it('skips the download when the area is off-island; flags shape changes', async () => {
    const h = routes();
    expect(await new MontrealSource(h).fetch({ bbox: { ...VAL_CLAIR, east: -74.1 }, now: LIVE, reason: 'chore' })).toEqual([]);
    expect(h.calls).toHaveLength(0);
    const bad = new MontrealSource(http({ datastore_search: { status: 200, body: { success: false } } }));
    await bad.fetch({ bbox: MTL_BBOX, now: LIVE, reason: 'chore' });
    expect(bad.health().status).toBe('shapeChanged');
  });

  it('is merged with the MTMD feed in the official fetch', async () => {
    const h = http({
      'a2bc8014-488c-495d-941b-e7ae1999d1bd': { status: 200, body: fx('mtl-impacts.json') },
      'cc41b532-f12d-40fb-9f55-eb58c9a2b12b': { status: 200, body: fx('mtl-permits.json') },
      chantiers_mtmdet: { status: 200, body: fx('qc-chantiers-north.json') },
      'typename=ms:evenements&': { status: 200, body: EMPTY_FC },
      evenements_inondation: { status: 200, body: EMPTY_FC },
      conditions_routieres: { status: 200, body: EMPTY_FC },
      radars_photos: { status: 200, body: EMPTY_FC },
    });
    const svc = new HazardService({ paid: new WazePaidSource(h, '', 0, new MemoryLedger()), quebec: new QuebecSource(h), montreal: new MontrealSource(h) });
    const got = await svc.fetchOfficial({ south: 45.4, west: -74.55, north: 45.8, east: -73.5 }, LIVE);
    expect(new Set(got.map((x) => x.source))).toEqual(new Set(['quebec', 'montreal']));
    expect(svc.health().map((x) => x.source)).toContain('montreal');
    expect(svc.merged([], LIVE + OFFICIAL_FEED_TTL_MS + 1)).toHaveLength(0); // nothing outlives its TTL
  });
});

describe('Mapbox route incidents + incidentsAlong', () => {
  // Straight route north along lng −74.0 from lat 45.60 to 45.62 (~2.2 km).
  const geometry = Array.from({ length: 21 }, (_, i) => ({ lat: 45.6 + i * 0.001, lng: -74.0 }));
  const cum = cumulativeDistances(geometry);
  const route = {
    id: 'r0',
    geometry,
    cum,
    incidents: [
      { id: 'a1', type: 'accident', description: 'Collision', closed: false, startAlongM: cum[5]!, endAlongM: cum[6]!, location: geometry[5]! },
      { id: 'c1', type: 'construction', description: '', closed: true, startAlongM: cum[10]!, endAlongM: cum[13]!, location: geometry[10]! },
      { id: 'j1', type: 'congestion', description: '', closed: false, startAlongM: cum[15]!, endAlongM: cum[18]!, location: geometry[15]!, congestion: 80 },
    ],
  } as unknown as NavRoute;
  const base = (over: Partial<Hazard>): Hazard => ({ id: 'x', source: 'quebec', type: 'construction', subtype: null, lat: 0, lng: 0, heading: null, street: null, reportedAt: LIVE, expiresAt: LIVE + 3600_000, reliability: 10, confirmations: 0, ...over });

  it('turns incidents into typed hazards with their along-route extent', () => {
    const hs = hazardsFromRoute(route, LIVE);
    expect(hs.map((h) => [h.id, h.type])).toEqual([['mapbox:a1', 'accident'], ['mapbox:c1', 'closure'], ['mapbox:j1', 'jam']]);
    expect(hs[1]!.line!.length).toBeGreaterThanOrEqual(2);
    expect(hazardsFromRoutes([route, route], LIVE)).toHaveLength(3);
  });

  it('counts hazards per route within the buffer; crossing roads do not count', () => {
    const hs: Hazard[] = [
      ...hazardsFromRoute(route, LIVE),
      base({ id: 'on', lat: 45.6035, lng: -74.0002 }), // ~16 m off
      base({ id: 'off', lat: 45.6035, lng: -74.002 }), // ~156 m off
      // Works whose representative point is off-route but whose line follows it for 300 m.
      base({ id: 'parallel', type: 'closure', lat: 45.6075, lng: -74.003, line: [[-74.0001, 45.607], [-74.0001, 45.608], [-74.0001, 45.609], [-74.0001, 45.61]] }),
      // A road crossing the route: one vertex in the corridor.
      base({ id: 'cross', lat: 45.611, lng: -74.005, line: [[-74.01, 45.611], [-74.0, 45.611], [-73.99, 45.611]] }),
    ];
    const r = incidentsAlong(geometry, hs, 40);
    expect(r.items.map((i) => i.hazard.id)).toEqual(['on', 'mapbox:a1', 'parallel', 'mapbox:c1', 'mapbox:j1']);
    expect(r.counts).toEqual({ construction: 1, accident: 1, closure: 2, jam: 1 });
    expect(r.total).toBe(5);
    expect(r.items[0]!.alongM).toBeGreaterThan(350);
    expect(incidentsAlong([], hs).total).toBe(0);
  });
});
