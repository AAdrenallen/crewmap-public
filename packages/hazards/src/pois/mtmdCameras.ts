import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { QC_WFS } from '../sources/quebec';
import type { HttpGet } from '../types';
import type { Poi } from './types';

/**
 * MTMD traffic cameras (`ms:infos_cameras`, Données Québec, CC-BY 4.0; D64). ~700 cameras province-wide, fetched
 * whole once a week on the chore peer. Each links to the official Québec 511 viewer page; the images themselves are
 * not downloaded or embedded (they are served by Québec 511, whose own terms we do not rely on).
 */
export const MTMD_CAM_URL = `${QC_WFS}?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&srsname=EPSG:4326&outputformat=geojson`;
export const MTMD_CAM_REFRESH_MS = 7 * 86_400_000;
export const MTMD_CAM_MAX_AGE_MS = 60 * 86_400_000;

const Feature = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  properties: z.record(z.string(), z.unknown()),
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }),
});
const FC = z.object({ type: z.literal('FeatureCollection'), features: z.array(z.unknown()) });

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The viewer link must stay on the official Québec 511 site. */
const officialUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https:\/\/(www\.)?quebec511\.info\//.test(s) ? s : null;
};

export function normaliseMtmdCameras(raw: unknown, now: number, lang: 'fr' | 'en' = 'fr'): Poi[] | null {
  const fc = FC.safeParse(raw);
  if (!fc.success) return null;
  const out: Poi[] = [];
  for (const f of fc.data.features) {
    const p = Feature.safeParse(f);
    if (!p.success) continue;
    const pr = p.data.properties;
    const id = str(pr.IDEcamera) ?? (p.data.id != null ? String(p.data.id) : null);
    if (!id) continue;
    const [lng, lat] = p.data.geometry.coordinates;
    const name = (lang === 'en' ? str(pr.DescriptionLocalisationEn) : null) ?? str(pr.DescriptionLocalisationFr);
    const url = officialUrl(pr.URL_FLUX_DONNEE);
    out.push({ id: `mtmd-cam:${id}`, kind: 'trafficCamera', source: 'mtmd-cam', lat, lng, name, ...(url ? { url } : {}), at: now });
  }
  return out;
}

export interface MtmdCamSnapshot {
  at: number;
  cameras: Poi[];
}

export class MtmdCameraSource {
  readonly id = 'mtmd-cam' as const;
  readonly tracker = new HealthTracker('mtmd-cam');
  private cameras: Poi[] = [];
  private at = 0;
  private triedAt = 0;

  constructor(
    private readonly http: HttpGet,
    private readonly onRequest?: () => void,
  ) {}

  health() {
    return this.tracker.get();
  }

  snapshot(): MtmdCamSnapshot {
    return { at: this.at, cameras: this.cameras };
  }

  restore(s: MtmdCamSnapshot | null, now: number): void {
    if (!s || !Array.isArray(s.cameras) || typeof s.at !== 'number' || now - s.at > MTMD_CAM_MAX_AGE_MS) return;
    this.cameras = s.cameras;
    this.at = s.at;
  }

  /** Re-download weekly; a failure waits an hour before the next try. */
  async refresh(now: number): Promise<boolean> {
    if (now - this.at < MTMD_CAM_REFRESH_MS || now - this.triedAt < 3600_000) return false;
    this.triedAt = now;
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(MTMD_CAM_URL);
      if (res.status !== 200) {
        this.tracker.fail(now, 'degraded', `HTTP ${res.status}`, res.status);
        return false;
      }
      const got = normaliseMtmdCameras(await res.json(), now);
      if (!got) {
        this.tracker.fail(now, 'shapeChanged', 'ms:infos_cameras: not a FeatureCollection');
        return false;
      }
      this.cameras = got;
      this.at = now;
      this.tracker.ok(now);
      return true;
    } catch (e) {
      this.tracker.fail(now, 'degraded', (e as Error).message);
      return false;
    }
  }

  within(b: BBox, now: number): Poi[] {
    if (now - this.at > MTMD_CAM_MAX_AGE_MS) return [];
    return this.cameras.filter((c) => c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east);
  }
}
