import { z } from 'zod';
import { haversineM, type LatLng } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import type { HttpGet } from '../types';

/**
 * Nearby Wikipedia article for a place (MediaWiki Action API geosearch + intro extract; text CC BY-SA 4.0, credited
 * with a link to the article). Text only: page images carry their own licences and are not loaded. One request per
 * place, cached on the device for `WIKI.cacheMs`.
 */
export const WIKI = {
  /** Articles whose coordinates are within this distance of the place (m). */
  radiusM: 300,
  cacheMs: 30 * 86_400_000,
  /** Extract length shown on the sheet (sentences). */
  sentences: 2,
} as const;

export const WIKI_LICENCE = 'CC BY-SA 4.0';
export type WikiLang = 'en' | 'fr' | 'ru';

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  lang: WikiLang;
  distanceM: number;
}

export function wikiUrl(p: LatLng, lang: WikiLang): string {
  const q = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'geosearch',
    ggscoord: `${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`,
    ggsradius: String(WIKI.radiusM),
    ggslimit: '5',
    prop: 'extracts|coordinates|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exsentences: String(WIKI.sentences),
    exlimit: '5',
  });
  return `https://${lang}.wikipedia.org/w/api.php?${q.toString()}`;
}

const Page = z.object({
  title: z.string(),
  extract: z.string().nullish(),
  fullurl: z.string().nullish(),
  coordinates: z.array(z.object({ lat: z.number(), lon: z.number() })).nullish(),
});
const Resp = z.object({ query: z.object({ pages: z.array(z.unknown()) }).nullish(), batchcomplete: z.unknown().optional() });

/** Closest article with an extract, or null when none is near. Undefined when the payload is not the expected shape. */
export function parseWiki(raw: unknown, at: LatLng, lang: WikiLang): WikiSummary | null | undefined {
  const r = Resp.safeParse(raw);
  if (!r.success) return undefined;
  let best: WikiSummary | null = null;
  for (const x of r.data.query?.pages ?? []) {
    const p = Page.safeParse(x);
    if (!p.success) continue;
    const c = p.data.coordinates?.[0];
    const extract = p.data.extract?.trim();
    const url = p.data.fullurl;
    if (!c || !extract || !url || !url.startsWith(`https://${lang}.wikipedia.org/`)) continue;
    const d = haversineM(at, { lat: c.lat, lng: c.lon });
    if (d > WIKI.radiusM) continue;
    if (!best || d < best.distanceM) best = { title: p.data.title, extract, url, lang, distanceM: Math.round(d) };
  }
  return best;
}

/** Wikimedia asks automated clients to identify themselves; a generic name, no contact details. */
export const WIKI_HEADERS = { 'Api-User-Agent': 'CrewMap/1.0 (open-source personal app)' };

export class WikiPlaceInfo {
  readonly id = 'wiki' as const;
  readonly tracker = new HealthTracker('wiki');

  constructor(
    private readonly http: HttpGet,
    private readonly onRequest?: () => void,
  ) {}

  health() {
    return this.tracker.get();
  }

  async lookup(p: LatLng, lang: WikiLang, now: number): Promise<WikiSummary | null | undefined> {
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(wikiUrl(p, lang), WIKI_HEADERS);
      if (res.status !== 200) {
        this.tracker.fail(now, res.status === 403 || res.status === 429 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return undefined;
      }
      const s = parseWiki(await res.json(), p, lang);
      if (s === undefined) this.tracker.fail(now, 'shapeChanged', 'unexpected payload');
      else this.tracker.ok(now);
      return s;
    } catch (e) {
      this.tracker.fail(now, 'degraded', e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }
}
