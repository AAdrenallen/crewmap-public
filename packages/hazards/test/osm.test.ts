import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HazardService,
  MemoryLedger,
  mergeHazards,
  normaliseOsm,
  OSM_BACKOFF_MIN_MS,
  OSM_REFRESH_MS,
  OsmCameraSource,
  osmCells,
  osmHeading,
  osmQuery,
  QuebecSource,
  WazePaidSource,
  type Hazard,
  type HttpGet,
} from '../src';

/** Recorded 2026-11-27 from overpass-api.de for downtown Toronto (public data, ODbL). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/osm-cameras-toronto.json', import.meta.url), 'utf8')) as { elements: unknown[] };
const TORONTO = { south: 43.6, west: -79.5, north: 43.75, east: -79.3 };
const NOW = Date.UTC(2026, 10, 27, 12);

const ok = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status: number) => ({ status, json: async () => ({}), text: async () => '' });

describe('OSM cameras', () => {
  it('normalises the recorded Overpass response', () => {
    const hs = normaliseOsm(fixture.elements, TORONTO, NOW);
    expect(hs).toHaveLength(9);
    expect(hs.every((h) => h.type === 'camera' && h.source === 'osm')).toBe(true);
    expect(hs.find((h) => h.id === 'osm:3708696449')?.subtype).toBe('red_light');
    expect(hs.find((h) => h.id === 'osm:10174227463')?.heading).toBe(235);
    const named = hs.find((h) => h.id === 'osm:13042469402')!;
    expect(named.heading).toBe(67.5);
    expect(named.street).toContain('Lake Shore');
  });

  it('takes enforcement relation devices and their kind', () => {
    const els = [
      { type: 'node', id: 1, lat: 43.65, lon: -79.38, tags: { man_made: 'surveillance' } },
      { type: 'node', id: 2, lat: 43.65, lon: -79.39 },
      { type: 'relation', id: 9, tags: { type: 'enforcement', enforcement: 'traffic_signals' }, members: [{ type: 'node', ref: 1, role: 'device' }, { type: 'node', ref: 2, role: 'from' }] },
    ];
    const hs = normaliseOsm(els, TORONTO, NOW);
    expect(hs.map((h) => h.id)).toEqual(['osm:1']);
    expect(hs[0]!.subtype).toBe('red_light');
  });

  it('parses direction tags', () => {
    expect(osmHeading('NE')).toBe(45);
    expect(osmHeading('360')).toBe(0);
    expect(osmHeading('forward')).toBeNull();
    expect(osmHeading('90-270')).toBeNull();
    expect(osmHeading(undefined)).toBeNull();
  });

  it('cuts the area into cells and refuses huge areas', () => {
    expect(osmCells(TORONTO)).toHaveLength(1);
    expect(osmCells({ south: 40, west: -80, north: 50, east: -60 })).toBeNull();
    expect(osmQuery(TORONTO)).toContain('node["highway"="speed_camera"](43.6,-79.5,43.75,-79.3)');
  });

  it('fetches a cell once per refresh window and persists it', async () => {
    let calls = 0;
    const http: HttpGet = async () => {
      calls++;
      return ok(fixture);
    };
    const src = new OsmCameraSource(http);
    const a = await src.fetch({ bbox: TORONTO, now: NOW, reason: 'chore' });
    expect(a).toHaveLength(9);
    await src.fetch({ bbox: TORONTO, now: NOW + 3600_000, reason: 'chore' });
    expect(calls).toBe(1);
    const copy = new OsmCameraSource(async () => fail(500));
    copy.restore(JSON.parse(JSON.stringify(src.snapshot())), NOW + 3600_000);
    expect(await copy.fetch({ bbox: TORONTO, now: NOW + 3600_000, reason: 'chore' })).toHaveLength(9);
    await src.fetch({ bbox: TORONTO, now: NOW + OSM_REFRESH_MS, reason: 'chore' });
    expect(calls).toBe(2);
  });

  it('backs off after a busy server and switches instance', async () => {
    const urls: string[] = [];
    const http: HttpGet = async (url) => {
      urls.push(url);
      return urls.length === 1 ? fail(504) : ok(fixture);
    };
    const src = new OsmCameraSource(http, ['https://a.example/api/interpreter', 'https://b.example/api/interpreter']);
    expect(await src.fetch({ bbox: TORONTO, now: NOW, reason: 'chore' })).toEqual([]);
    expect(src.health().status).toBe('degraded');
    await src.fetch({ bbox: TORONTO, now: NOW + 60_000, reason: 'chore' });
    expect(urls).toHaveLength(1);
    const got = await src.fetch({ bbox: TORONTO, now: NOW + OSM_BACKOFF_MIN_MS, reason: 'chore' });
    expect(got).toHaveLength(9);
    expect(urls[1]).toContain('b.example');
    expect(src.health().status).toBe('ok');
  });

  it('flags a changed response shape', async () => {
    const src = new OsmCameraSource(async () => ok({ nope: true }));
    await src.fetch({ bbox: TORONTO, now: NOW, reason: 'chore' });
    expect(src.health().status).toBe('shapeChanged');
  });

  it('merges with an official radar at the same spot', () => {
    const osm = normaliseOsm(fixture.elements, TORONTO, NOW)[0]!;
    const official: Hazard = { ...osm, id: 'quebec:r1', source: 'quebec', lat: osm.lat + 0.0002, subtype: 'Radar photo fixe' };
    const m = mergeHazards([osm, official], NOW);
    expect(m).toHaveLength(1);
    expect(m[0]!.source).toBe('quebec');
    expect(m[0]!.sources.sort()).toEqual(['osm', 'quebec']);
  });

  it('runs inside the official-feed cycle', async () => {
    const svc = new HazardService({
      paid: new WazePaidSource(async () => fail(500), '', 0, new MemoryLedger()),
      quebec: new QuebecSource(async () => ok({ type: 'FeatureCollection', features: [] })),
      osm: new OsmCameraSource(async () => ok(fixture)),
    });
    const hs = await svc.fetchOfficial(TORONTO, NOW);
    expect(hs.filter((h) => h.source === 'osm')).toHaveLength(9);
    expect(svc.health().map((h) => h.source)).toContain('osm');
  });
});
