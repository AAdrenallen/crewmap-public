import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applySignedConfig,
  attribution,
  canonicalConfig,
  hazardsFromReports,
  HazardService,
  MemoryLedger,
  mergeHazards,
  parseQcDate,
  parseWazeResponse,
  QuebecSource,
  WazeLiveMapSource,
  WazePaidSource,
  ageMinutes,
  type FriendReport,
  type Hazard,
  type HttpGet,
} from '../src';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const NOW = 1781547600000; // 2026-06-15 18:20 UTC
const BBOX = { south: 45.55, west: -73.85, north: 45.66, east: -73.72 };

function http(routes: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })>): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = routes[key]!;
    const v = typeof r === 'function' ? r() : r;
    return {
      status: v.status,
      json: async () => {
        if (typeof v.body === 'string') throw new SyntaxError('not json');
        return v.body;
      },
      text: async () => (typeof v.body === 'string' ? v.body : JSON.stringify(v.body)),
    };
  }) as HttpGet & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('F4c Waze contract (fixture)', () => {
  it('maps police/accident/hazard/closure/jams into our schema, skips unknown types and light jams', () => {
    const p = parseWazeResponse(fx('waze-a15-city.json'), NOW);
    const byType = (t: string) => p.hazards.filter((h) => h.type === t);
    expect(byType('police')).toHaveLength(1);
    const police = byType('police')[0]!;
    expect(police).toMatchObject({ source: 'waze', subtype: 'POLICE_HIDING', street: 'A-15 N', reliability: 8, confirmations: 4, heading: 318 });
    expect(police.lat).toBeCloseTo(45.5915);
    expect(byType('accident')).toHaveLength(1);
    expect(byType('hazard')).toHaveLength(1);
    expect(byType('construction')).toHaveLength(1); // ROAD_CLOSED_CONSTRUCTION
    expect(byType('jam')).toHaveLength(1); // level-1 jam skipped
    expect(p.hazards.every((h) => h.expiresAt > NOW)).toBe(true);
  });
});

describe('F4d Waze health check, kill switch, fallback', () => {
  it('never requests the Waze Live Map; uses the paid adapter when enabled and under cap (D40)', async () => {
    const h = http({ openwebninja: { status: 200, body: { status: 'OK', data: { alerts: [{ alert_id: 'p1', type: 'POLICE', subtype: 'POLICE_VISIBLE', latitude: 45.6, longitude: -73.77, publish_datetime_utc: '2026-06-15T18:10:00Z', num_thumbs_up: 2, alert_reliability: 7 }] } } } });
    const ledger = new MemoryLedger();
    const svc = new HazardService({ paid: new WazePaidSource(h, 'key', 5, ledger), quebec: new QuebecSource(h) });
    svc.setConfig({ wazeEnabled: true, paidEnabled: true, version: 1 }, NOW);
    const got = await svc.fetchWaze({ bbox: BBOX, now: NOW, reason: 'driving' });
    expect(got).toHaveLength(1);
    expect(got[0]!.source).toBe('waze-paid');
    expect(ledger.spent(NOW)).toBeCloseTo(0.005);
    expect(h.calls.some((u) => u.includes('waze.com'))).toBe(false);
  });

  it('detects a response shape change', async () => {
    const h = http({ 'waze.com': { status: 200, body: { alerts: [{ id: 1, kind: 'POLICE', lat: 1 }, { id: 2 }], jams: [] } } });
    const w = new WazeLiveMapSource(h);
    expect(await w.fetch({ bbox: BBOX, now: NOW, reason: 'driving' })).toEqual([]);
    expect(w.health().status).toBe('shapeChanged');
  });

  it('non-JSON 200 (challenge page) counts as blocked; paid cap is enforced', async () => {
    const h = http({ 'waze.com': { status: 200, body: '<html>' }, openwebninja: { status: 200, body: { status: 'OK', data: { alerts: [] } } } });
    const w = new WazeLiveMapSource(h);
    await w.fetch({ bbox: BBOX, now: NOW, reason: 'driving' });
    expect(w.health().status).toBe('blocked');
    const ledger = new MemoryLedger();
    ledger.add(NOW, 0.998);
    const paid = new WazePaidSource(h, 'key', 1, ledger);
    await paid.fetch({ bbox: BBOX, now: NOW, reason: 'driving' });
    expect(paid.health().status).toBe('capReached');
    expect(h.calls.some((u) => u.includes('openwebninja'))).toBe(false);
  });

  it('throttles to one request per 2 min per area and serves the cache', async () => {
    const h = http({ 'waze.com': { status: 200, body: fx('waze-a15-city.json') } });
    const w = new WazeLiveMapSource(h);
    const a = await w.fetch({ bbox: BBOX, now: NOW, reason: 'driving' });
    const b = await w.fetch({ bbox: BBOX, now: NOW + 60_000, reason: 'driving' });
    expect(h.calls).toHaveLength(1);
    expect(b.length).toBe(a.length);
    await w.fetch({ bbox: BBOX, now: NOW + 121_000, reason: 'driving' });
    expect(h.calls).toHaveLength(2);
  });

  it('kill switch: only an owner-signed, newer config disables Waze', async () => {
    const h = http({ 'waze.com': { status: 200, body: fx('waze-a15-city.json') } });
    const svc = new HazardService({ paid: new WazePaidSource(h, '', 0, new MemoryLedger()), quebec: new QuebecSource(h) });
    const verify = (msg: string, sig: string, by: string) => sig === `sig(${by}:${msg})`;
    const cfg = { wazeEnabled: false, paidEnabled: false, version: 5 };
    const cur = svc.getConfig();
    expect(applySignedConfig(cur, { config: cfg, by: 'member', sig: `sig(member:${canonicalConfig(cfg)})` }, 'owner', verify)).toEqual(cur);
    expect(applySignedConfig(cur, { config: cfg, by: 'owner', sig: 'forged' }, 'owner', verify)).toEqual(cur);
    const next = applySignedConfig(cur, { config: cfg, by: 'owner', sig: `sig(owner:${canonicalConfig(cfg)})` }, 'owner', verify);
    expect(next.wazeEnabled).toBe(false);
    svc.setConfig(next, NOW);
    expect(await svc.fetchWaze({ bbox: BBOX, now: NOW, reason: 'driving' })).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});

describe('F4e Québec feeds + Mapbox incidents + friend reports merged and de-duplicated', () => {
  it('parses recorded MTMD GeoJSON', async () => {
    const h = http({
      chantiers_mtmdet: { status: 200, body: fx('qc-chantiers.json') },
      evenements_inondation: { status: 200, body: EMPTY_FC },
      conditions_routieres: { status: 200, body: EMPTY_FC },
      evenements: { status: 200, body: fx('qc-evenements.json') },
      radars_photos: { status: 200, body: fx('qc-radars.json') },
    });
    const q = new QuebecSource(h);
    const hs = await q.fetch({ bbox: BBOX, now: Date.UTC(2026, 10, 23), reason: 'chore' });
    expect(q.health().status).toBe('ok');
    expect(hs.filter((x) => x.type === 'camera')).toHaveLength(2);
    expect(hs.some((x) => x.type === 'construction' && x.line && x.line.length >= 2)).toBe(true);
    expect(hs.filter((x) => x.source === 'quebec').length).toBe(hs.length);
    expect(h.calls[0]).toContain('bbox=45.55%2C-73.85');
    expect(parseQcDate('2025/05/05 05:00:00')).toBe(Date.UTC(2025, 4, 5, 9, 0, 0));
  });

  it('merges a Waze police alert with a friend report 120 m away; keeps distinct types apart', () => {
    const waze = parseWazeResponse(fx('waze-a15-city.json'), NOW).hazards;
    const report: FriendReport = { id: 'r1', by: 'alex', type: 'police', lat: 45.5920, lng: -73.7616, heading: 320, street: 'A-15 N', at: NOW - 60_000, votes: { sam: 1, kim: 1 } };
    const friends = hazardsFromReports([report], NOW);
    const mapbox: Hazard = { id: 'mapbox:inc1', source: 'mapbox', type: 'accident', subtype: 'accident', lat: 45.6219, lng: -73.7930, heading: null, street: null, reportedAt: NOW, expiresAt: NOW + 3600_000, reliability: 8, confirmations: 0 };
    const merged = mergeHazards([...waze, ...friends, mapbox], NOW);
    const police = merged.filter((m) => m.type === 'police');
    expect(police).toHaveLength(1);
    expect([...police[0]!.sources].sort()).toEqual(['friends', 'waze']);
    expect(police[0]!.confirmations).toBe(4 + 2);
    expect(attribution(police[0]!)).toBe('Waze · Friends');
    expect(ageMinutes(police[0]!, NOW)).toBe(1);
    const accidents = merged.filter((m) => m.type === 'accident');
    expect(accidents).toHaveLength(1);
    expect([...accidents[0]!.sources].sort()).toEqual(['mapbox', 'waze']);
    // Same Waze alert shared by two phones → counted once.
    expect(mergeHazards([...waze, ...waze], NOW).length).toBe(mergeHazards(waze, NOW).length);
  });

  it('friend reports expire and disappear when downvoted', () => {
    const r: FriendReport = { id: 'r2', by: 'a', type: 'police', lat: 45.6, lng: -73.7, heading: null, street: null, at: NOW, votes: {} };
    expect(hazardsFromReports([r], NOW + 59 * 60_000)).toHaveLength(1);
    expect(hazardsFromReports([r], NOW + 61 * 60_000)).toHaveLength(0);
    expect(hazardsFromReports([{ ...r, votes: { b: -1, c: -1 } }], NOW)).toHaveLength(0);
    expect(hazardsFromReports([{ ...r, votes: { b: 1 } }], NOW + 80 * 60_000)).toHaveLength(1);
  });
});
