import Constants from 'expo-constants';
import {
  decodePois,
  encodePois,
  mergePois,
  needsFuelFetch,
  POI_TUNING,
  MtmdCameraSource,
  OcmSource,
  OsmPoiSource,
  RegieFuelSource,
  SharedPois,
  type CellRecord,
  type HttpGet,
  type MtmdCamSnapshot,
  type OcmSnapshot,
  type Poi,
  type RegieSnapshot,
  type SourceHealth,
} from '@crewmap/hazards';
import { fromUtf8, utf8 } from '@crewmap/p2p';
import { bboxOf, type BBox, type LatLng } from '@crewmap/shared/geo';
import { lang } from '@crewmap/shared/i18n';
import { countRequest } from './apiBudget';
import { kvGet, kvSet } from './db';
import type { Crews } from './crews';
import { useApp } from './store';

/** Re-share the crew's points at least this often even when nothing changed (late joiners). */
const RESHARE_MS = 30 * 60_000;
/** Fuel search on a phone that is not the chore peer fetches the Régie file itself when the prices are older than this. */
const ON_DEMAND_STALE_MS = 30 * 60_000;

/**
 * Map points (D64): Régie fuel prices, OSM fuel / chargers, MTMD traffic cameras, optional Open Charge Map. The chore
 * peer refreshes them (each source's own cadence), persists them, and shares a compact subset around the crew with
 * the circle (`pois` kind, encrypted like every envelope). Every phone reads its caches; nothing here runs while idle.
 */
export class Pois {
  readonly regie: RegieFuelSource;
  private readonly osm: OsmPoiSource;
  private readonly cams: MtmdCameraSource;
  private readonly ocm: OcmSource;
  private readonly shared = new SharedPois();
  private lastShare = 0;
  private sharedDirty = false;
  private offRouter: (() => void) | null = null;
  private ensuring: Promise<boolean> | null = null;

  constructor(
    http: HttpGet,
    private readonly net: Crews,
  ) {
    const extra = (Constants.expoConfig?.extra ?? {}) as { ocmKey?: string };
    this.regie = new RegieFuelSource(http, () => countRequest('regie'));
    this.osm = new OsmPoiSource(http, () => countRequest('overpass'));
    this.cams = new MtmdCameraSource(http, () => countRequest('mtmd'));
    this.ocm = new OcmSource(http, extra.ocmKey ?? '', () => countRequest('ocm'));
  }

  async start(): Promise<void> {
    const now = Date.now();
    const [r, o, c, k, s] = await Promise.all([
      kvGet<RegieSnapshot | null>('poi.regie', null),
      kvGet<Record<string, CellRecord<Poi>> | null>('poi.osm', null),
      kvGet<MtmdCamSnapshot | null>('poi.cams', null),
      kvGet<OcmSnapshot | null>('poi.ocm', null),
      kvGet<Poi[] | null>('poi.shared', null),
    ]);
    this.regie.restore(r, now);
    this.osm.restore(o, now);
    this.cams.restore(c, now);
    this.ocm.restore(k, now);
    this.shared.restore(s, now);
    const router = this.net.router;
    if (router) {
      this.offRouter?.();
      this.offRouter = router.on('pois', (m) => {
        if (this.shared.ingest(decodePois(fromUtf8(m.payload)), Date.now()) > 0) this.sharedDirty = true;
      });
    }
  }

  stop(): void {
    this.offRouter?.();
    this.offRouter = null;
  }

  health(): SourceHealth[] {
    return [this.regie.health(), this.osm.health(), this.cams.health(), this.ocm.health()];
  }

  /** Chore peer, while someone drives or has the map open. */
  async choreRefresh(area: BBox, centre: LatLng, now: number): Promise<void> {
    const camLang = lang() === 'en' ? 'en' : 'fr';
    const [r, o, c, k] = await Promise.all([this.regie.refresh(now), this.osm.refresh(area, now), this.cams.refresh(now, camLang), this.ocm.refresh(area, now)]);
    if (r) void kvSet('poi.regie', this.regie.snapshot());
    if (o) void kvSet('poi.osm', this.osm.snapshot());
    if (c) void kvSet('poi.cams', this.cams.snapshot());
    if (k) void kvSet('poi.ocm', this.ocm.snapshot());
    if (r || o || c || k || now - this.lastShare >= RESHARE_MS) {
      const list = this.local(area, now);
      if (list.length) {
        this.lastShare = now;
        void this.net.router?.broadcast('pois', utf8(encodePois(list, centre)));
      }
    }
  }

  /** Ensure local fuel prices (10 min ETag cache) and OSM station pins (30 day cell cache) are loaded for the visible map area on any phone. */
  async ensureViewport(area: BBox, now: number): Promise<boolean> {
    if (!useApp.getState().online) return false;
    if (this.ensuring) return this.ensuring;
    const run = async (): Promise<boolean> => {
      const camLang = lang() === 'en' ? 'en' : 'fr';
      const osmSpanOk = area.north - area.south <= 0.65 && area.east - area.west <= 0.85;
      const [r, o, c] = await Promise.all([
        this.regie.refresh(now),
        osmSpanOk ? this.osm.refresh(area, now) : Promise.resolve(false),
        this.cams.refresh(now, camLang),
      ]);
      if (r) void kvSet('poi.regie', this.regie.snapshot());
      if (o) void kvSet('poi.osm', this.osm.snapshot());
      if (c) void kvSet('poi.cams', this.cams.snapshot());
      return r || o || c;
    };
    this.ensuring = run().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  /** User asked for fuel prices near `at`: fetch the Régie file + local OSM stations directly when needed (any phone). */
  async ensureFuel(at: LatLng, now: number): Promise<void> {
    if (!useApp.getState().online) return;
    const box = bboxOf([at], POI_TUNING.searchRadiusM);
    const [r, o] = await Promise.all([
      needsFuelFetch(this.near(at, POI_TUNING.searchRadiusM, now), now) ? this.regie.refresh(now, ON_DEMAND_STALE_MS) : Promise.resolve(false),
      this.osm.refresh(box, now),
    ]);
    if (r) void kvSet('poi.regie', this.regie.snapshot());
    if (o) void kvSet('poi.osm', this.osm.snapshot());
  }

  private local(b: BBox, now: number): Poi[] {
    return [...this.regie.within(b, now), ...this.osm.within(b, now), ...this.cams.within(b, now), ...this.ocm.within(b, now)];
  }

  /** Merged points inside `b` from this phone's caches plus what the crew shared. */
  within(b: BBox, now: number): Poi[] {
    if (this.sharedDirty) {
      this.sharedDirty = false;
      void kvSet('poi.shared', this.shared.all());
    }
    return mergePois([...this.local(b, now), ...this.shared.within(b)]);
  }

  near(p: LatLng, radiusM: number, now: number): Poi[] {
    return this.within(bboxOf([p], radiusM), now);
  }
}
