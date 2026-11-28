import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeBodyText,
  decodePois,
  encodePois,
  gunzipBytes,
  isFuelQuery,
  isGzip,
  mergePois,
  needsFuelFetch,
  MtmdCameraSource,
  normaliseMtmdCameras,
  normaliseOcm,
  normaliseOsmPois,
  normaliseRegie,
  OcmSource,
  OsmPoiSource,
  osmPoiQuery,
  parseCents,
  rankFuel,
  RegieFuelSource,
  REGIE_MAX_AGE_MS,
  SharedPois,
  type HttpGet,
  type Poi,
} from '../src';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as unknown;
const regie = load('regie-stations.json');
const cams = load('qc-cameras.json');
const osm = load('osm-pois-montreal.json') as { elements: unknown[] };
const GEN = Date.parse('2026-11-27T04:20:00.3810129Z');
const NOW = GEN + 5 * 60_000;
const ROUYN = { lat: 48.2385, lng: -79.0196 };
const QC = { south: 44, west: -80, north: 63, east: -57 };
const MTL = { south: 45.497, west: -73.575, north: 45.507, east: -73.56 };

const ok = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });
const status = (s: number) => ({ status: s, json: async () => ({}), text: async () => '' });

describe('Régie essence Québec', () => {
  it('parses prices to tenths of a cent', () => {
    expect(parseCents('166.4¢')).toBe(1664);
    expect(parseCents('204,9 ¢')).toBe(2049);
    expect(parseCents(164.9)).toBe(1649);
    expect(parseCents('$1.689')).toBe(1689);
    expect(parseCents(null)).toBeNull();
    expect(parseCents('9.9¢')).toBeNull();
  });

  it('decompresses raw gzipped stations.geojson.gz payloads cleanly', () => {
    const rawJson = JSON.stringify(regie);
    const gz = new Uint8Array(gzipSync(Buffer.from(rawJson, 'utf8')));
    expect(isGzip(gz)).toBe(true);
    expect(new TextDecoder().decode(gunzipBytes(gz))).toBe(rawJson);
    const decoded = JSON.parse(decodeBodyText(gz.buffer));
    expect(normaliseRegie(decoded, 0)?.stations).toHaveLength(4);
  });

  it('accepts French grade names, numeric prices, and 3D coordinates', () => {
    const custom = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-73.6, 45.5, 32] },
          properties: {
            StationId: 's-fr-1',
            Brand: 'Sonic',
            Fuels: [
              { FuelType: 'Ordinaire', Price: 162.9 },
              { FuelType: 'Suprême', Price: '189,9' },
            ],
          },
        },
      ],
    };
    const r = normaliseRegie(custom, NOW)!;
    expect(r.stations).toHaveLength(1);
    expect(r.stations[0]!.brand).toBe('Sonic');
    expect(r.stations[0]!.prices?.regular?.c10).toBe(1629);
    expect(r.stations[0]!.prices?.premium?.c10).toBe(1899);
  });

  it('normalises the recorded feed, dropping unavailable grades', () => {
    const r = normaliseRegie(regie, 0)!;
    expect(r.at).toBe(GEN);
    expect(r.stations).toHaveLength(4);
    const s = r.stations.find((x) => x.address?.startsWith('230 av. Murdoch'))!;
    expect(s.prices).toEqual({ regular: { c10: 1664, at: GEN, source: 'regie' }, premium: { c10: 2044, at: GEN, source: 'regie' }, diesel: { c10: 2799, at: GEN, source: 'regie' } });
    expect(s.brand).toBe('Shell');
    const b = r.stations.find((x) => x.address?.includes('Barraute'))!;
    expect(Object.keys(b.prices!)).toEqual(['regular']);
    expect(normaliseRegie({ nope: 1 }, 0)).toBeNull();
  });

  it('uses a conditional GET, persists, and expires old prices', async () => {
    const sent: (Record<string, string> | undefined)[] = [];
    let n = 0;
    const http: HttpGet = async (_u, h) => {
      sent.push(h);
      return n++ === 0 ? ok(regie, { etag: '"x1"' }) : status(304);
    };
    const src = new RegieFuelSource(http);
    expect(await src.refresh(NOW)).toBe(true);
    expect(await src.refresh(NOW + 60_000)).toBe(false); // not due
    expect(await src.refresh(NOW + 11 * 60_000)).toBe(false); // 304
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ 'If-None-Match': '"x1"' });
    expect(src.health().status).toBe('ok');
    const copy = new RegieFuelSource(async () => status(500));
    copy.restore(JSON.parse(JSON.stringify(src.snapshot())), NOW);
    expect(copy.within(QC, NOW)).toHaveLength(4);
    expect(copy.within(QC, GEN + REGIE_MAX_AGE_MS + 1)).toHaveLength(0);
  });

  it('flags a changed shape and HTTP errors', async () => {
    const a = new RegieFuelSource(async () => ok({ type: 'FeatureCollection', features: [] }));
    await a.refresh(NOW);
    expect(a.health().status).toBe('shapeChanged');
    const b = new RegieFuelSource(async () => status(403));
    await b.refresh(NOW);
    expect(b.health().status).toBe('blocked');
  });
});

describe('fuel search and merge', () => {
  const stations = normaliseRegie(regie, 0)!.stations;

  it('ranks cheapest first, then distance; missing prices last', () => {
    const hits = rankFuel(stations, ROUYN, 'premium', 'price', 200_000);
    expect(hits[0]!.price!.c10).toBe(1924);
    expect(hits.at(-1)!.price).toBeNull();
    const near = rankFuel(stations, ROUYN, 'premium', 'distance', 200_000);
    expect(near.map((h) => h.distanceM)).toEqual([...near.map((h) => h.distanceM)].sort((x, y) => x - y));
  });

  it('merges an OSM node into the Régie station; newest price per grade wins', () => {
    const s = stations[0]!;
    const osmNode: Poi = { id: 'osm-poi:n1', kind: 'fuel', source: 'osm-poi', lat: s.lat + 0.0002, lng: s.lng, name: 'Shell', grades: ['regular', 'diesel'], at: NOW };
    const crew: Poi = { id: 'crew:1', kind: 'fuel', source: 'crew', lat: s.lat, lng: s.lng, name: null, prices: { regular: { c10: 1599, at: NOW, source: 'crew' } }, at: NOW };
    const m = mergePois([osmNode, s, crew]);
    expect(m).toHaveLength(1);
    expect(m[0]!.id).toBe(s.id);
    expect(m[0]!.alsoFrom?.sort()).toEqual(['crew', 'osm-poi']);
    expect(m[0]!.prices!.regular!.c10).toBe(1599);
    expect(m[0]!.prices!.diesel!.c10).toBe(2799);
  });

  it('fetches on demand only when no fresh price is near', () => {
    const fresh = { ...stations[0]!, prices: { regular: { c10: 1600, at: NOW, source: 'regie' as const } } };
    expect(needsFuelFetch([], NOW)).toBe(true);
    expect(needsFuelFetch([fresh], NOW + 60_000)).toBe(false);
    expect(needsFuelFetch([fresh], NOW + 31 * 60_000)).toBe(true);
    expect(needsFuelFetch([{ ...fresh, prices: {} }], NOW)).toBe(true);
  });

  it('shares priced fuel before chargers', () => {
    const chargers: Poi[] = Array.from({ length: 300 }, (_, i) => ({ id: `osm-poi:n${i}`, kind: 'charging', source: 'osm-poi', lat: ROUYN.lat, lng: ROUYN.lng, name: 'Circuit électrique', maxKw: 7, at: NOW }));
    const back = decodePois(encodePois([...chargers, ...stations], ROUYN, 4000));
    expect(back.filter((p) => p.kind === 'fuel')).toHaveLength(4);
    expect(new TextEncoder().encode(encodePois([...chargers, ...stations], ROUYN)).length).toBeLessThanOrEqual(30_000);
  });

  it('merges same-brand stations a little further apart, other brands not', () => {
    const s = stations[0]!;
    const far: Poi = { id: 'osm-poi:n2', kind: 'fuel', source: 'osm-poi', lat: s.lat + 0.001, lng: s.lng, name: null, brand: 'shell', at: NOW };
    expect(mergePois([s, far])).toHaveLength(1);
    expect(mergePois([s, { ...far, brand: 'Esso' }])).toHaveLength(2);
  });

  it('detects fuel queries in en / fr / ru', () => {
    for (const q of ['gas', 'Gas station', 'essence', 'station-service', 'Diesel', 'заправка', 'АЗС']) expect(isFuelQuery(q)).toBe(true);
    for (const q of ['ga', 'Gaspé', 'Costco', 'restaurant']) expect(isFuelQuery(q)).toBe(false);
  });

  it('round-trips the shared wire format within the byte budget', () => {
    const wire = encodePois(stations, ROUYN);
    const back = decodePois(wire);
    expect(back).toHaveLength(4);
    const s = back.find((x) => x.id === stations[0]!.id)!;
    expect(s.prices!.premium!.c10).toBe(2044);
    expect(Math.abs(s.prices!.premium!.at - GEN)).toBeLessThan(1000);
    expect(decodePois(encodePois(stations, ROUYN, 400)).length).toBeLessThan(4);
    expect(decodePois('{"v":1,"p":[["x",9,0,0,0,0,"","","",[0,0,0],0,"",0,""]]}')).toEqual([]);
    expect(decodePois('garbage')).toEqual([]);
  });

  it('keeps the newest shared copy', () => {
    const sp = new SharedPois();
    const s = { ...stations[0]!, at: NOW };
    sp.ingest([s], NOW);
    sp.ingest([{ ...s, at: s.at - 1000, name: 'old' }], NOW);
    expect(sp.all()[0]!.name).toBe(s.name);
  });
});

describe('MTMD traffic cameras', () => {
  it('normalises the recorded layer with the official viewer link', () => {
    const c = normaliseMtmdCameras(cams, NOW)!;
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ id: 'mtmd-cam:3377', kind: 'trafficCamera', url: 'https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3377' });
    expect(normaliseMtmdCameras(cams, NOW, 'en')![0]!.name).toContain('westward');
  });

  it('drops non-official links and refreshes weekly', async () => {
    const bad = JSON.parse(JSON.stringify(cams)) as { features: { properties: Record<string, unknown> }[] };
    bad.features[0]!.properties.URL_FLUX_DONNEE = 'https://example.com/x';
    expect(normaliseMtmdCameras(bad, NOW)![0]!.url).toBeUndefined();
    let calls = 0;
    const src = new MtmdCameraSource(async () => {
      calls++;
      return ok(cams);
    });
    await src.refresh(NOW);
    await src.refresh(NOW + 86_400_000);
    expect(calls).toBe(1);
    expect(src.within({ south: 45, west: -74, north: 46, east: -73 }, NOW)).toHaveLength(3);
  });
});

describe('OSM fuel and chargers', () => {
  it('builds one combined query', () => {
    expect(osmPoiQuery(MTL)).toContain('nwr["amenity"~"^(fuel|charging_station)$"](45.497,-73.575,45.507,-73.56)');
  });

  it('normalises chargers and fuel stations, including convenience-store fuel brands', () => {
    const fuelWay = { type: 'way', id: 7, center: { lat: 45.5, lon: -73.57 }, tags: { amenity: 'fuel', brand: 'Esso', 'fuel:octane_87': 'yes', 'fuel:diesel': 'yes', 'addr:housenumber': '1', 'addr:street': 'Rue Sainte-Catherine' } };
    const sonicShop = { type: 'node', id: 9, lat: 45.502, lon: -73.568, tags: { shop: 'convenience', brand: 'Sonic', fuel: 'yes' } };
    const priv = { type: 'node', id: 8, lat: 45.5, lon: -73.57, tags: { amenity: 'fuel', access: 'private' } };
    const ps = normaliseOsmPois([...osm.elements, fuelWay, sonicShop, priv], MTL, NOW);
    expect(ps.filter((p) => p.kind === 'charging')).toHaveLength(3);
    const f = ps.find((p) => p.id === 'osm-poi:w7')!;
    expect(f).toMatchObject({ kind: 'fuel', brand: 'Esso', grades: ['regular', 'diesel'], address: '1 Rue Sainte-Catherine' });
    const sonic = ps.find((p) => p.id === 'osm-poi:n9')!;
    expect(sonic).toMatchObject({ kind: 'fuel', brand: 'Sonic' });
    expect(ps.find((p) => p.id === 'osm-poi:n8')).toBeUndefined();
  });

  it('caches cells (no second request within 30 days)', async () => {
    let calls = 0;
    const src = new OsmPoiSource(async () => {
      calls++;
      return ok(osm);
    });
    await src.refresh(MTL, NOW);
    const first = calls;
    await src.refresh(MTL, NOW + 7 * 86_400_000);
    expect(first).toBe(2); // the bbox straddles two 0.5° cells
    expect(calls).toBe(first);
    expect(src.within(MTL, NOW).length).toBe(3);
  });
});

describe('Open Charge Map', () => {
  const rec = (id: number, licence: string | null) => ({
    ID: id,
    NumberOfPoints: 2,
    AddressInfo: { Title: 'Place des Arts', AddressLine1: '175 Rue Sainte-Catherine O', Town: 'Montréal', Latitude: 45.5081, Longitude: -73.5664 },
    OperatorInfo: { Title: 'Circuit électrique' },
    DataProvider: { Title: 'Open Charge Map Contributors', License: licence },
    Connections: [{ PowerKW: 7.2 }, { PowerKW: 50 }],
    DateLastStatusUpdate: '2026-10-01T00:00:00Z',
  });

  it('keeps open-licence records only, with the provider credit', () => {
    const got = normaliseOcm([rec(1, 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)'), rec(2, 'Proprietary'), rec(3, null)], NOW)!;
    expect(got.map((p) => p.id)).toEqual(['ocm:1']);
    expect(got[0]).toMatchObject({ kind: 'charging', maxKw: 50, sockets: 2 });
    expect(got[0]!.credit).toContain('CC BY 4.0');
  });

  it('is disabled without a key', async () => {
    let calls = 0;
    const src = new OcmSource(async () => {
      calls++;
      return ok([]);
    }, '');
    expect(await src.refresh(MTL, NOW)).toBe(false);
    expect(calls).toBe(0);
    expect(src.health().status).toBe('disabled');
  });
});
