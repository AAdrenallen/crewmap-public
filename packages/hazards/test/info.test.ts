import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '@crewmap/shared/geo';
import { BORDER, bordersOnRoute, CbsaBorderSource, parseCbsaCsv, parseCbsaTime, parseWait, parseWiki, WikiPlaceInfo, wikiUrl, type HttpGet } from '../src';

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const route = (pts: LatLng[]) => ({ geometry: pts, cum: cumulativeDistances(pts) });
const line = (a: LatLng, b: LatLng, n = 200) => route(Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n })));
/** Recording time of cbsa-bwt.csv. */
const NOW = Date.UTC(2026, 10, 27, 4, 40);

describe('CBSA border waits', () => {
  it('parses times with their zone and waits in minutes', () => {
    expect(parseCbsaTime('2026-11-26 23:15 EST')).toBe(Date.UTC(2026, 10, 27, 4, 15));
    expect(parseCbsaTime('2026-11-26 22:04 AST')).toBe(Date.UTC(2026, 10, 27, 2, 4));
    expect(parseCbsaTime('soon')).toBeNull();
    expect(parseWait('No Delay')).toBe(0);
    expect(parseWait('25 minutes')).toBe(25);
    expect(parseWait('1 minute')).toBe(1);
    expect(parseWait('1 hour 5 minutes')).toBe(65);
    expect(parseWait('Not Applicable')).toBeNull();
    expect(parseWait('--')).toBeNull();
  });

  it('keeps Québec / Ontario ports only and rejects a changed header', () => {
    const w = parseCbsaCsv(raw('cbsa-bwt.csv'))!;
    expect(w.map((x) => x.office)).toContain('St-Bernard-de-Lacolle');
    expect(w.some((x) => x.office.startsWith('St. Stephen'))).toBe(false);
    expect(w.find((x) => x.office === 'St-Bernard-de-Lacolle')).toMatchObject({ toCanadaMin: 25, toUsMin: null });
    expect(parseCbsaCsv('a;;b\n1;;2')).toBeNull();
  });

  it('finds the port on the route and picks the direction travelled', () => {
    const w = parseCbsaCsv(raw('cbsa-bwt.csv'))!;
    const south = line({ lat: 45.3, lng: -73.45 }, { lat: 44.8, lng: -73.45 }); // A-15 → I-87 through Lacolle
    const on = bordersOnRoute(south, w, NOW);
    expect(on.map((b) => b.wait.office)).toEqual(['St-Bernard-de-Lacolle']);
    expect(on[0]!.minutes).toBeNull(); // CBSA publishes Canada-bound waits only here
    const north = line({ lat: 44.8, lng: -73.45 }, { lat: 45.3, lng: -73.45 });
    expect(bordersOnRoute(north, w, NOW)[0]!.minutes).toBe(25);
    expect(bordersOnRoute(south, w, NOW + BORDER.maxAgeMs + 3600_000)).toEqual([]);
  });

  it('refreshes at most every refreshMs and tracks health', async () => {
    let n = 0;
    const http: HttpGet = async () => {
      n++;
      return { status: 200, json: async () => ({}), text: async () => raw('cbsa-bwt.csv') };
    };
    const s = new CbsaBorderSource(http);
    expect(await s.refresh(NOW)).toBe(true);
    expect(await s.refresh(NOW + 60_000)).toBe(false);
    expect(n).toBe(1);
    expect(s.health().status).toBe('ok');
    const bad = new CbsaBorderSource(async () => ({ status: 200, json: async () => ({}), text: async () => 'x;;y' }));
    await bad.refresh(NOW);
    expect(bad.health().status).toBe('shapeChanged');
  });
});

describe('Wikipedia nearby', () => {
  const chalet = { lat: 45.5039, lng: -73.5876 };
  it('picks the closest article with an extract and a link', () => {
    const s = parseWiki(JSON.parse(raw('wiki-geosearch-mount-royal.json')), chalet, 'en')!;
    expect(s.title).toBe('Mount Royal Chalet');
    expect(s.url).toBe('https://en.wikipedia.org/wiki/Mount_Royal_Chalet');
    expect(s.extract.length).toBeGreaterThan(20);
    expect(parseWiki({ batchcomplete: true }, chalet, 'en')).toBeNull();
    expect(parseWiki('nope', chalet, 'en')).toBeUndefined();
  });

  it('queries the wiki of the app language and sends an identifying header', async () => {
    expect(wikiUrl(chalet, 'fr')).toMatch(/^https:\/\/fr\.wikipedia\.org\/w\/api\.php\?.*generator=geosearch/);
    let h: Record<string, string> | undefined;
    const w = new WikiPlaceInfo(async (_u, headers) => {
      h = headers;
      return { status: 200, json: async () => JSON.parse(raw('wiki-geosearch-mount-royal.json')), text: async () => '' };
    });
    expect((await w.lookup(chalet, 'en', 0))?.title).toBe('Mount Royal Chalet');
    expect(h?.['Api-User-Agent']).toContain('CrewMap');
  });
});
