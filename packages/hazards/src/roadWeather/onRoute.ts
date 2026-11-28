import { bboxContains, pointAlong, polylineChunks, projectNearPolyline, type LatLng } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import type { Hazard } from '../types';
import type { Rings, WeatherAlert } from './eccc';
import { ROAD_WEATHER, type RoadWeatherCategory } from './thresholds';

/** One stretch of the route under a weather alert or a winter road condition. */
export interface RoadWeatherZone {
  /** Announce-once key (alert key, or the MTMD segment id). */
  key: string;
  category: RoadWeatherCategory;
  source: 'eccc' | 'quebec';
  startM: number;
  endM: number;
  /** Source wording for the visual card (en / fr; ru falls back to the category label). */
  nameEn: string | null;
  nameFr: string | null;
}

/** Ray casting on [lng, lat] rings; holes subtract. */
export function inRings(p: LatLng, rings: Rings): boolean {
  let inOuter = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) c = !c;
    }
    if (r === 0) inOuter = c;
    else if (c) return false;
  }
  return inOuter;
}

/** Along-route intervals inside the alert's polygons, sampled every `sampleM`. */
export function alertIntervals(route: Pick<NavRoute, 'geometry' | 'cum' | 'distanceM'>, alert: Pick<WeatherAlert, 'polygons' | 'bbox'>, sampleM: number = ROAD_WEATHER.sampleM): [number, number][] {
  const out: [number, number][] = [];
  const total = route.cum[route.cum.length - 1] ?? route.distanceM;
  let start: number | null = null;
  for (let m = 0; m <= total + sampleM; m += sampleM) {
    const at = Math.min(m, total);
    const p = pointAlong(route.geometry, route.cum, at);
    const hit = bboxContains(alert.bbox, p) && alert.polygons.some((rs) => inRings(p, rs));
    if (hit && start === null) start = Math.max(0, at - sampleM / 2);
    if (!hit && start !== null) {
      out.push([start, at - sampleM / 2]);
      start = null;
    }
    if (at === total) break;
  }
  if (start !== null) out.push([start, total]);
  return out;
}

const isCondition = (h: Pick<Hazard, 'id'> & { memberIds?: string[] }) => h.id.startsWith('quebec:cond:') || !!h.memberIds?.some((id) => id.startsWith('quebec:cond:'));

/** MTMD winter-condition hazards (quebec:cond:*) are replaced on the route by the road-weather warning. */
export function isRoadConditionHazard(h: Pick<Hazard, 'id'> & { memberIds?: string[] }): boolean {
  return isCondition(h);
}

/** Visibility codes are one letter (B = good); surface codes are longer (PG, CND, …). */
const conditionCategory = (subtype: string | null): RoadWeatherCategory => (subtype && subtype.length === 1 ? 'fog' : 'slippery');

/**
 * Road-weather zones on the route, sorted by start, nearby zones of one category merged. Compute once per route or
 * data change (not per fix).
 */
export function roadWeatherOnRoute(route: Pick<NavRoute, 'geometry' | 'cum' | 'distanceM'>, alerts: WeatherAlert[], hazards: (Hazard & { memberIds?: string[] })[], now: number): RoadWeatherZone[] {
  const zones: RoadWeatherZone[] = [];
  if (route.geometry.length < 2) return zones;
  for (const a of alerts) {
    if (a.expiresAt <= now) continue;
    for (const [s, e] of alertIntervals(route, a)) zones.push({ key: a.key, category: a.category, source: 'eccc', startM: s, endM: e, nameEn: a.nameEn, nameFr: a.nameFr });
  }
  const idx = polylineChunks(route.geometry, ROAD_WEATHER.corridorM);
  for (const h of hazards) {
    if (!isCondition(h) || now - h.reportedAt > ROAD_WEATHER.conditionMaxAgeMs) continue;
    const pts: LatLng[] = h.line ? h.line.map(([lng, lat]) => ({ lat, lng })) : [h];
    const along = pts.map((p) => projectNearPolyline(p, route.geometry, route.cum, idx)?.alongM).filter((x): x is number => x !== undefined);
    if (!along.length) continue;
    const desc = h.description ?? null;
    zones.push({ key: h.id, category: conditionCategory(h.subtype), source: 'quebec', startM: Math.min(...along), endM: Math.max(...along), nameEn: null, nameFr: desc });
  }
  zones.sort((x, y) => x.startM - y.startM);
  const merged: RoadWeatherZone[] = [];
  for (const z of zones) {
    let prev: RoadWeatherZone | undefined;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i]!.category === z.category) {
        prev = merged[i];
        break;
      }
    }
    if (prev && z.startM - prev.endM <= ROAD_WEATHER.mergeGapM) {
      prev.endM = Math.max(prev.endM, z.endM);
      if (z.source === 'eccc' && prev.source === 'quebec') Object.assign(prev, { source: z.source, nameEn: z.nameEn, nameFr: z.nameFr });
      continue;
    }
    merged.push({ ...z });
  }
  return merged;
}

export interface RoadWeatherAnnouncement {
  zone: RoadWeatherZone;
  /** 0 when already inside the zone. */
  distanceM: number;
}

/** Warns once per zone key (kept across reroutes): when the zone starts within `announceAheadM`, or we are in it. */
export class RoadWeatherAnnouncer {
  private readonly said = new Set<string>();

  update(zones: RoadWeatherZone[], alongM: number): RoadWeatherAnnouncement | null {
    for (const z of zones) {
      if (z.endM < alongM || this.said.has(z.key)) continue;
      const ahead = z.startM - alongM;
      if (ahead > ROAD_WEATHER.announceAheadM) return null;
      this.said.add(z.key);
      return { zone: z, distanceM: Math.max(0, ahead) };
    }
    return null;
  }
}
