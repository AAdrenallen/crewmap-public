import { polylineChunks, projectNearPolyline, type LatLng } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import { HealthTracker } from '../health';
import type { HttpGet } from '../types';

/**
 * CBSA "Current Border Wait Times" (open.canada.ca, Open Government Licence – Canada). One small CSV, updated about
 * hourly per office. Only travellers' waits are used. Coordinates are the public ports of entry (Québec / Ontario).
 */
export const CBSA_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
export const CBSA_CREDIT = 'Canada Border Services Agency, Open Government Licence – Canada';

export const BORDER = {
  /** Re-fetch at most this often (the source updates hourly). */
  refreshMs: 15 * 60_000,
  /** A wait older than this is not shown. */
  maxAgeMs: 3 * 3600_000,
  /** A port counts as on the route within this lateral distance (m). */
  corridorM: 400,
  /** Spoken / shown once when the crossing is this far ahead. */
  announceAheadM: 30_000,
} as const;

/** Ports of entry in Québec and Ontario, keyed by the CBSA office name. */
/** Side of the port Canada lies on, to tell the direction of travel. */
export type Side = 'N' | 'S' | 'E' | 'W';
export const BORDER_PORTS: Record<string, LatLng & { canada: Side }> = {
  Stanstead: { lat: 45.0055, lng: -72.0897, canada: 'N' },
  'St-Armand/Philipsburg': { lat: 45.0152, lng: -73.0857, canada: 'N' },
  'Lacolle: Route 221': { lat: 45.0094, lng: -73.3717, canada: 'N' },
  'St-Bernard-de-Lacolle': { lat: 45.0085, lng: -73.4517, canada: 'N' },
  Hemmingford: { lat: 45.0094, lng: -73.6006, canada: 'N' },
  'Cornwall Traffic Office': { lat: 45.0047, lng: -74.7346, canada: 'N' },
  Prescott: { lat: 44.7337, lng: -75.4583, canada: 'N' },
  'Thousand Islands Bridge': { lat: 44.3477, lng: -75.9846, canada: 'N' },
  'Sault Ste. Marie': { lat: 46.5088, lng: -84.3612, canada: 'N' },
  'Fort Frances Bridge': { lat: 48.6081, lng: -93.4027, canada: 'N' },
  'Queenston-Lewiston Bridge': { lat: 43.1531, lng: -79.0450, canada: 'W' },
  'Rainbow Bridge': { lat: 43.0906, lng: -79.0678, canada: 'W' },
  'Peace Bridge': { lat: 42.9068, lng: -78.9063, canada: 'W' },
  'Blue Water Bridge': { lat: 42.9989, lng: -82.4231, canada: 'E' },
  'Windsor and Detroit Tunnel': { lat: 42.3187, lng: -83.0393, canada: 'S' },
  'Ambassador Bridge': { lat: 42.3110, lng: -83.0740, canada: 'S' },
  'Gordie Howe International Bridge': { lat: 42.2895, lng: -83.1002, canada: 'S' },
};

export interface BorderWait {
  office: string;
  lat: number;
  lng: number;
  /** Minutes; 0 = no delay; null = not applicable / no data. */
  toCanadaMin: number | null;
  toUsMin: number | null;
  /** When the office last updated (epoch ms). */
  at: number;
}

const TZ: Record<string, number> = { NST: -3.5, NDT: -2.5, AST: -4, ADT: -3, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

/** "2026-11-26 23:15 EST" → epoch ms. */
export function parseCbsaTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([A-Z]{3})$/.exec(s.trim());
  if (!m) return null;
  const off = TZ[m[6]!];
  if (off === undefined) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) - off * 3600_000;
}

/** "No Delay" → 0, "25 minutes" → 25, "1 hour 5 minutes" → 65, "Not Applicable" / "--" → null. */
export function parseWait(s: string): number | null {
  const v = s.trim();
  if (/^no delay$/i.test(v)) return 0;
  const h = /(\d+)\s*hours?/i.exec(v);
  const mn = /(\d+)\s*min/i.exec(v);
  if (!h && !mn) return null;
  return (h ? +h[1]! * 60 : 0) + (mn ? +mn[1]! : 0);
}

/** Parses the `;;`-separated CSV; keeps only known Québec / Ontario ports. Null when the header changed. */
export function parseCbsaCsv(text: string): BorderWait[] | null {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = lines[0]?.split(';;').map((c) => c.trim());
  if (!head || head[0] !== 'Customs Office' || head[2] !== 'Last updated' || !/Travellers Flow - Canada bound/.test(head[5] ?? '')) return null;
  const out: BorderWait[] = [];
  for (const l of lines.slice(1)) {
    const c = l.split(';;').map((x) => x.trim());
    const office = c[0] ?? '';
    const port = BORDER_PORTS[office];
    const at = parseCbsaTime(c[2] ?? '');
    if (!port || at === null) continue;
    out.push({ office, lat: port.lat, lng: port.lng, toCanadaMin: parseWait(c[5] ?? ''), toUsMin: parseWait(c[6] ?? ''), at });
  }
  return out;
}

export interface BorderOnRoute {
  wait: BorderWait;
  alongM: number;
  /** Wait for the direction this route crosses in. */
  minutes: number | null;
}

/** Ports the route goes through, with the wait for the direction travelled (fresh data only). */
export function bordersOnRoute(route: Pick<NavRoute, 'geometry' | 'cum'>, waits: BorderWait[], now: number): BorderOnRoute[] {
  if (route.geometry.length < 2) return [];
  const idx = polylineChunks(route.geometry, BORDER.corridorM);
  const out: BorderOnRoute[] = [];
  for (const w of waits) {
    if (now - w.at > BORDER.maxAgeMs) continue;
    const p = projectNearPolyline(w, route.geometry, route.cum, idx);
    if (!p) continue;
    // The route 2 km past the port tells the direction of travel.
    const after = route.geometry.find((_, i) => (route.cum[i] ?? 0) >= p.alongM + 2000) ?? route.geometry[route.geometry.length - 1]!;
    const side = BORDER_PORTS[w.office]?.canada ?? 'N';
    const d = { N: after.lat - w.lat, S: w.lat - after.lat, E: after.lng - w.lng, W: w.lng - after.lng }[side];
    const intoCanada = d > 0;
    out.push({ wait: w, alongM: p.alongM, minutes: intoCanada ? w.toCanadaMin : w.toUsMin });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

export interface CbsaSnapshot {
  at: number;
  waits: BorderWait[];
}

export class CbsaBorderSource {
  readonly id = 'cbsa' as const;
  readonly tracker = new HealthTracker('cbsa');
  private snap: CbsaSnapshot = { at: 0, waits: [] };
  private triedAt = 0;

  constructor(
    private readonly http: HttpGet,
    private readonly onRequest?: () => void,
  ) {}

  health() {
    return this.tracker.get();
  }

  snapshot(): CbsaSnapshot {
    return this.snap;
  }

  restore(s: CbsaSnapshot | null): void {
    if (s && Array.isArray(s.waits) && typeof s.at === 'number') this.snap = s;
  }

  waits(): BorderWait[] {
    return this.snap.waits;
  }

  async refresh(now: number): Promise<boolean> {
    if (now - this.snap.at < BORDER.refreshMs || now - this.triedAt < 60_000) return false;
    this.triedAt = now;
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(CBSA_URL);
      if (res.status !== 200) {
        this.tracker.fail(now, res.status === 403 || res.status === 429 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return false;
      }
      const waits = parseCbsaCsv(await res.text());
      if (!waits) {
        this.tracker.fail(now, 'shapeChanged', 'unexpected CSV header');
        return false;
      }
      this.snap = { at: now, waits };
      this.tracker.ok(now);
      return true;
    } catch (e) {
      this.tracker.fail(now, 'degraded', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}
