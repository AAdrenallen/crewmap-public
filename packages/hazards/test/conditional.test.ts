import { describe, expect, it } from 'vitest';
import { qcLayerIntervalMs, QuebecSource, withConditionalGet, type HttpGet } from '../src';

const NOW = Date.UTC(2026, 10, 24, 15, 0);
const FC = { type: 'FeatureCollection', features: [] };
const hdrs = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe('conditional GET (D44)', () => {
  it('sends If-None-Match / If-Modified-Since and serves a 304 from the cached body', async () => {
    const seen: Record<string, string>[] = [];
    const base: HttpGet = async (_u, h) => {
      seen.push(h ?? {});
      if (h?.['If-None-Match'] === '"v1"') return { status: 304, json: async () => null, text: async () => '' };
      return { status: 200, headers: hdrs({ etag: '"v1"', 'last-modified': 'Tue, 24 Nov 2026 15:00:00 GMT' }), json: async () => FC, text: async () => JSON.stringify(FC) };
    };
    const http = withConditionalGet(base);
    expect(await (await http('u')).json()).toEqual(FC);
    const r = await http('u');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(FC);
    expect(seen[1]).toMatchObject({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Tue, 24 Nov 2026 15:00:00 GMT' });
  });
});

describe('MTMD per-layer polling', () => {
  it('events every 5 min while driving, works/conditions every 20 min, radars every 6 h', async () => {
    expect(qcLayerIntervalMs('ms:evenements', true)).toBe(5 * 60_000);
    expect(qcLayerIntervalMs('ms:evenements', false)).toBe(15 * 60_000);
    const calls: string[] = [];
    const http: HttpGet = async (u) => {
      calls.push(u);
      return { status: 200, json: async () => FC, text: async () => '' };
    };
    const q = new QuebecSource(http);
    const bbox = { south: 45.5, west: -74.2, north: 45.7, east: -73.9 };
    await q.fetch({ bbox, now: NOW, reason: 'driving' });
    expect(calls).toHaveLength(5);
    await q.fetch({ bbox, now: NOW + 5 * 60_000, reason: 'driving' });
    expect(calls.slice(5).map((u) => /typename=([^&]+)/.exec(u)![1]).sort()).toEqual(['ms:evenements', 'ms:evenements_inondation']);
    await q.fetch({ bbox, now: NOW + 20 * 60_000, reason: 'driving' });
    expect(calls.slice(7).some((u) => u.includes('conditions_routieres'))).toBe(true);
    expect(calls.slice(7).some((u) => u.includes('radars_photos'))).toBe(false);
  });
});
