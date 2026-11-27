import {
  BORDER,
  BORDER_PORTS,
  bordersOnRoute,
  CBSA_CREDIT,
  CbsaBorderSource,
  ECCC_CREDIT,
  EcccAlertSource,
  RoadWeatherAnnouncer,
  roadWeatherOnRoute,
  SOURCE_CREDIT,
  type BorderOnRoute,
  type CbsaSnapshot,
  type EcccSnapshot,
  type HttpGet,
  type MergedHazard,
  type RoadWeatherAnnouncement,
  type RoadWeatherZone,
  type SourceHealth,
} from '@crewmap/hazards';
import { bboxContains, bboxOf } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import { countRequest } from './apiBudget';
import { kvGet, kvSet } from './db';

const KV = 'roadWeather.eccc';
const KV_BORDER = 'roadWeather.cbsa';

/** What the drive banner shows (spoken text is built by the navigator in the voice language). */
export type RouteNotice =
  | { kind: 'weather'; zone: RoadWeatherZone; distanceM: number; credit: string }
  | { kind: 'border'; office: string; minutes: number; distanceM: number; credit: string };

const http: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers: headers ?? {} });
  return { status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text() };
};

/**
 * Route-level road-weather warning (D70): ECCC alert polygons (fetched by the navigating phone for its route) and the
 * MTMD winter road conditions the chore peer already shares as `quebec:cond:*` hazards, intersected with the active
 * route. Spoken + shown once per zone; nothing is fetched unless a route is being navigated.
 */
class RoadWeather {
  private readonly eccc = new EcccAlertSource(http, () => countRequest('eccc'));
  private announcer = new RoadWeatherAnnouncer();
  private zones: RoadWeatherZone[] = [];
  private key: { route: NavRoute | null; hazards: MergedHazard[] | null; at: number } = { route: null, hazards: null, at: -1 };
  private readonly cbsa = new CbsaBorderSource(http, () => countRequest('cbsa'));
  private borderSaid = new Set<string>();
  private borderKey: { route: NavRoute | null; at: number; list: BorderOnRoute[] } = { route: null, at: -1, list: [] };
  readonly listeners = new Set<(n: RouteNotice) => void>();

  async start(): Promise<void> {
    const [e, b] = await Promise.all([kvGet<EcccSnapshot | null>(KV, null), kvGet<CbsaSnapshot | null>(KV_BORDER, null)]);
    this.eccc.restore(e, Date.now());
    this.cbsa.restore(b);
  }

  health(): SourceHealth[] {
    return [this.eccc.health(), this.cbsa.health()];
  }

  /** New navigation session: forget what was said (reroutes keep it). */
  reset(): void {
    this.announcer = new RoadWeatherAnnouncer();
    this.borderSaid = new Set();
    this.key = { route: null, hazards: null, at: -1 };
  }

  /** Navigating phone, online: alerts covering the route and, when it crosses the border, CBSA waits (≤ 1 request each / 15 min). */
  async refresh(route: NavRoute, now: number): Promise<void> {
    const box = bboxOf(route.geometry, 5000);
    if (await this.eccc.refresh(box, now)) {
      void kvSet(KV, this.eccc.snapshot());
      this.key.at = -1;
    }
    if (Object.values(BORDER_PORTS).some((p) => bboxContains(box, p)) && (await this.cbsa.refresh(now))) void kvSet(KV_BORDER, this.cbsa.snapshot());
  }

  private zonesFor(route: NavRoute, hazards: MergedHazard[], now: number): RoadWeatherZone[] {
    const k = this.key;
    if (k.route !== route || k.hazards !== hazards || k.at < 0 || now - k.at > 60_000) {
      this.zones = roadWeatherOnRoute(route, this.eccc.alerts(now), hazards, now);
      this.key = { route, hazards, at: now };
    }
    return this.zones;
  }

  /** Per fix while navigating; returns the road-weather warning to speak (the banner listeners are notified too). */
  update(route: NavRoute, hazards: MergedHazard[], alongM: number, now: number): RoadWeatherAnnouncement | null {
    const a = this.announcer.update(this.zonesFor(route, hazards, now), alongM);
    if (a) this.emit({ kind: 'weather', zone: a.zone, distanceM: a.distanceM, credit: a.zone.source === 'eccc' ? ECCC_CREDIT : SOURCE_CREDIT.quebec });
    return a;
  }

  /** Per fix while navigating: the wait at a border crossing coming up, once per port. */
  border(route: NavRoute, alongM: number, now: number): { office: string; minutes: number; distanceM: number } | null {
    const at = this.cbsa.snapshot().at;
    if (this.borderKey.route !== route || this.borderKey.at !== at) this.borderKey = { route, at, list: bordersOnRoute(route, this.cbsa.waits(), now) };
    for (const b of this.borderKey.list) {
      const ahead = b.alongM - alongM;
      if (ahead < 0 || ahead > BORDER.announceAheadM || b.minutes === null || this.borderSaid.has(b.wait.office)) continue;
      this.borderSaid.add(b.wait.office);
      const n = { office: b.wait.office, minutes: b.minutes, distanceM: ahead };
      this.emit({ kind: 'border', ...n, credit: CBSA_CREDIT });
      return n;
    }
    return null;
  }

  private emit(n: RouteNotice): void {
    for (const l of this.listeners) l(n);
  }
}

export const roadWeather = new RoadWeather();
