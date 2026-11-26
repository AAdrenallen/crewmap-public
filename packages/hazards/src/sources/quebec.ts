import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { easternToUtc } from '../time';
import { DEFAULT_TTL_MS, feedExpiry, type FetchContext, type Hazard, type HazardSource, type HazardType, type HttpGet } from '../types';

/**
 * Québec MTMD open data (Données Québec, CC-BY 4.0), WFS 2.0 GeoJSON:
 *  - ms:chantiers_mtmdet (road works), ms:evenements (road events/closures), ms:radars_photos (photo radar),
 *  - ms:evenements_inondation (flood closures / restrictions),
 *  - ms:conditions_routieres (winter surface + visibility per segment; only non-normal segments become hazards).
 * Refreshed by the circle's chore peer (charging + Wi-Fi) and shared with the circle.
 * Attribution: "Source : Gouvernement du Québec — Ministère des Transports et de la Mobilité durable".
 */
export const QC_WFS = 'https://ws.mapserver.transports.gouv.qc.ca/swtq';
export const QC_ATTRIBUTION = 'Gouvernement du Québec (MTMD), CC-BY 4.0';
export const QC_LAYERS = ['ms:chantiers_mtmdet', 'ms:evenements', 'ms:radars_photos', 'ms:evenements_inondation', 'ms:conditions_routieres'] as const;
/** Surface codes that are normal driving (bare and dry / bare and wet) and the "good" visibility code: not hazards. */
export const QC_NORMAL_SURFACE: ReadonlySet<string> = new Set(['Ds', 'Dm']);
export const QC_GOOD_VISIBILITY = 'B';
/** Works that start within this window are already shown (feed is refreshed every 15 min). */
export const QC_START_LEAD_MS = 30 * 60_000;
export type QcLayer =(typeof QC_LAYERS)[number];

/**
 * Poll interval per layer (D44): events every 5 min while someone drives (15 min otherwise); works and road
 * conditions every 20 min; photo radars every 6 h. Nothing is fetched while the crew is idle (caller's rule).
 */
export function qcLayerIntervalMs(layer: QcLayer, driving: boolean): number {
  switch (layer) {
    case 'ms:evenements':
    case 'ms:evenements_inondation':
      return driving ? 5 * 60_000 : 15 * 60_000;
    case 'ms:chantiers_mtmdet':
    case 'ms:conditions_routieres':
      return 20 * 60_000;
    case 'ms:radars_photos':
      return 6 * 3600_000;
  }
}

const Geometry = z.object({
  type: z.string(),
  coordinates: z.unknown(),
});
const Feature = z.object({
  type: z.literal('Feature'),
  id: z.union([z.string(), z.number()]).nullish(),
  properties: z.record(z.string(), z.unknown()),
  geometry: Geometry.nullable(),
});
const FC = z.object({ type: z.literal('FeatureCollection'), features: z.array(z.unknown()) });

export function qcUrl(layer: QcLayer, b: BBox): string {
  // WFS 2.0 + EPSG:4326 uses lat,lon axis order in BBOX.
  const bbox = `${b.south},${b.west},${b.north},${b.east},urn:ogc:def:crs:EPSG::4326`;
  return `${QC_WFS}?service=wfs&version=2.0.0&request=getfeature&typename=${layer}&srsname=EPSG:4326&outputformat=geojson&bbox=${encodeURIComponent(bbox)}`;
}

function firstPoint(geom: z.infer<typeof Geometry>): [number, number] | null {
  const c = geom.coordinates as unknown;
  if (geom.type === 'Point') return c as [number, number];
  if (geom.type === 'LineString') {
    const l = c as [number, number][];
    return l[Math.floor(l.length / 2)] ?? null;
  }
  if (geom.type === 'MultiLineString') {
    const l = (c as [number, number][][])[0] ?? [];
    return l[Math.floor(l.length / 2)] ?? null;
  }
  return null;
}

function lineOf(geom: z.infer<typeof Geometry>): [number, number][] | undefined {
  if (geom.type === 'LineString') return geom.coordinates as [number, number][];
  if (geom.type === 'MultiLineString') return (geom.coordinates as [number, number][][]).flat();
  return undefined;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** "2025/05/05 05:00:00" or "2025-07-30T11:17:00" (local Québec time) → epoch ms. */
export function parseQcDate(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return easternToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

/**
 * MTMD event → hazard type. Only a full closure ("Fermeture", "Route fermée") is a closure; "Fermeture de 1 voie
 * sur 2", alternating or contraflow traffic are lane restrictions (hazard).
 */
export function qcEventType(entraveRaw: string | null, causeRaw: string | null): HazardType {
  const entrave = (entraveRaw ?? '').toLowerCase();
  const cause = (causeRaw ?? '').toLowerCase();
  if (cause.includes('policier') || cause.includes('police')) return 'police';
  if (cause.includes('accident') || cause.includes('collision')) return 'accident';
  const laneOnly = /voie|accotement|alternance|contresens/.test(entrave);
  if (!laneOnly && /fermé|fermeture/.test(entrave)) return 'closure';
  if (cause.includes('travaux')) return 'construction';
  return 'hazard';
}

export function normaliseQc(layer: QcLayer, raw: unknown, now: number): Hazard | null {
  const f = Feature.safeParse(raw);
  if (!f.success || !f.data.geometry) return null;
  const p = f.data.properties;
  const pt = firstPoint(f.data.geometry);
  if (!pt) return null;
  const [lng, lat] = pt;
  switch (layer) {
    case 'ms:evenements_inondation': {
      const entrave = str(p.entrave);
      const line = lineOf(f.data.geometry);
      return {
        id: `quebec:flood:${String(p.identifiant ?? f.data.id)}`,
        source: 'quebec',
        type: qcEventType(entrave, null) === 'closure' ? 'closure' : 'hazard',
        subtype: entrave,
        lat,
        lng,
        heading: null,
        street: str(p.localisation),
        reportedAt: parseQcDate(p.enVigueurDepuis) ?? now,
        expiresAt: feedExpiry(now, null),
        reliability: 10,
        confirmations: 0,
        ...(line ? { line } : {}),
        description: str(p.cause) ?? 'Inondation',
      };
    }
    case 'ms:conditions_routieres': {
      const surface = str(p.CodeEtatChaussee);
      const vis = str(p.CodeVisibilite);
      const badSurface = surface !== null && !QC_NORMAL_SURFACE.has(surface);
      const badVis = vis !== null && vis !== QC_GOOD_VISIBILITY;
      if (!badSurface && !badVis) return null;
      const line = lineOf(f.data.geometry);
      const parts = [badSurface ? str(p.DescriptionEtatChausseeFR) : null, badVis ? str(p.DescriptionVisibiliteFR) : null].filter((x): x is string => x !== null);
      return {
        id: `quebec:cond:${String(p.NumeroSegment ?? f.data.id)}`,
        source: 'quebec',
        type: 'hazard',
        subtype: badSurface ? surface : vis,
        lat,
        lng,
        heading: null,
        street: str(p.NomRoute),
        reportedAt: parseQcDate(p.EnVigueurDepuis) ?? now,
        expiresAt: feedExpiry(now, null),
        reliability: 10,
        confirmations: 0,
        ...(line ? { line } : {}),
        ...(parts.length ? { description: parts.join(' · ') } : {}),
      };
    }
    case 'ms:radars_photos': {
      const end = parseQcDate(p.dateFinService);
      if (end !== null && end < now) return null;
      return {
        id: `quebec:radar:${lat.toFixed(5)},${lng.toFixed(5)}`,
        source: 'quebec',
        type: 'camera',
        subtype: str(p.typeAppareil),
        lat,
        lng,
        heading: null,
        street: str(p.description),
        reportedAt: parseQcDate(p.dateDebutService) ?? now,
        expiresAt: end !== null ? Math.min(end, now + DEFAULT_TTL_MS.camera) : now + DEFAULT_TTL_MS.camera,
        ...(end !== null ? { endsAt: end } : {}),
        reliability: 10,
        confirmations: 0,
      };
    }
    case 'ms:chantiers_mtmdet': {
      const start = parseQcDate(p.debut);
      const end = parseQcDate(p.fin);
      if (end !== null && end < now) return null;
      // Many entries are one-night windows ("20:00 → 05:00"): show only once active (small lead for the 15-min refresh).
      if (start !== null && start > now + QC_START_LEAD_MS) return null;
      const line = lineOf(f.data.geometry);
      return {
        id: `quebec:works:${String(p.identifiant ?? f.data.id)}`,
        source: 'quebec',
        type: 'construction',
        subtype: str(p.entraveType),
        lat,
        lng,
        heading: null,
        street: str(p.localisation),
        reportedAt: parseQcDate(p.miseAJour) ?? start ?? now,
        expiresAt: feedExpiry(now, end),
        ...(end !== null ? { endsAt: end } : {}),
        reliability: 10,
        confirmations: 0,
        ...(line ? { line } : {}),
        ...(str(p.entrave) ? { description: str(p.entrave)! } : {}),
      };
    }
    case 'ms:evenements': {
      const type = qcEventType(str(p.entrave), str(p.cause));
      const line = lineOf(f.data.geometry);
      return {
        id: `quebec:event:${String(p.identifiant ?? f.data.id)}`,
        source: 'quebec',
        type,
        subtype: str(p.entrave),
        lat,
        lng,
        heading: null,
        street: str(p.localisation),
        reportedAt: parseQcDate(p.enVigueurDepuis) ?? now,
        expiresAt: feedExpiry(now, null),
        reliability: 10,
        confirmations: 0,
        ...(line ? { line } : {}),
        ...(str(p.cause) ? { description: str(p.cause)! } : {}),
      };
    }
  }
}

export class QuebecSource implements HazardSource {
  readonly id = 'quebec' as const;
  readonly tracker = new HealthTracker('quebec');

  /** Per layer: last fetch time, bbox key and result (layers not yet due are served from here). */
  private readonly layerCache = new Map<QcLayer, { at: number; bbox: string; hazards: Hazard[] }>();

  constructor(private readonly http: HttpGet) {}

  health() {
    return this.tracker.get();
  }

  async fetch(ctx: FetchContext): Promise<Hazard[]> {
    this.tracker.attempt(ctx.now);
    const out: Hazard[] = [];
    let failures = 0;
    const driving = ctx.reason === 'driving';
    const bboxKey = qcUrl('ms:evenements', ctx.bbox);
    for (const layer of QC_LAYERS) {
      const cached = this.layerCache.get(layer);
      if (cached && cached.bbox === bboxKey && ctx.now - cached.at < qcLayerIntervalMs(layer, driving)) {
        out.push(...cached.hazards.filter((h) => h.expiresAt > ctx.now));
        continue;
      }
      try {
        const res = await this.http(qcUrl(layer, ctx.bbox));
        if (res.status !== 200) {
          failures++;
          continue;
        }
        const fc = FC.safeParse(await res.json());
        if (!fc.success) {
          this.tracker.fail(ctx.now, 'shapeChanged', `${layer}: not a FeatureCollection`);
          failures++;
          continue;
        }
        const got: Hazard[] = [];
        for (const f of fc.data.features) {
          const h = normaliseQc(layer, f, ctx.now);
          if (h) got.push(h);
        }
        this.layerCache.set(layer, { at: ctx.now, bbox: bboxKey, hazards: got });
        out.push(...got);
      } catch (e) {
        failures++;
        this.tracker.fail(ctx.now, 'degraded', `${layer}: ${(e as Error).message}`);
      }
    }
    if (failures === 0) this.tracker.ok(ctx.now);
    else if (failures === QC_LAYERS.length) this.tracker.fail(ctx.now, 'degraded', 'all layers failed');
    return out;
  }
}
