import { bboxContains, bboxOf, cumulativeDistances, polylineChunks, projectNearPolyline, type LatLng } from '@crewmap/shared/geo';
import type { Hazard, HazardType } from './types';

/** Lateral corridor (m) for "this hazard is on that route" in the route picker. */
export const ROUTE_INCIDENT_BUFFER_M = 40;
/** A line hazard (works, closures) only counts if this many of its vertices lie in the corridor — a road that
 * merely crosses the route (overpass, intersection) touches it at one point. */
export const LINE_MIN_VERTICES_IN_BUFFER = 2;

export interface IncidentAlong<H extends Hazard = Hazard> {
  hazard: H;
  /** Along-route position (m) of the closest point. */
  alongM: number;
  /** Lateral distance (m) from the route. */
  distanceM: number;
}

export interface IncidentsAlong<H extends Hazard = Hazard> {
  /** Sorted by along-route distance. */
  items: IncidentAlong<H>[];
  counts: Partial<Record<HazardType, number>>;
  total: number;
}

/**
 * Pure: hazards lying along a route geometry within `bufferM`, with per-type counts for the route picker.
 * Point hazards count when within the buffer; line hazards when ≥ LINE_MIN_VERTICES_IN_BUFFER vertices are
 * (or their representative point is). Expired hazards are the caller's concern (merge drops them).
 */
export function incidentsAlong<H extends Hazard>(geometry: LatLng[], hazards: H[], bufferM = ROUTE_INCIDENT_BUFFER_M): IncidentsAlong<H> {
  const items: IncidentAlong<H>[] = [];
  const counts: Partial<Record<HazardType, number>> = {};
  if (geometry.length === 0) return { items, counts, total: 0 };
  const cum = cumulativeDistances(geometry);
  const box = bboxOf(geometry, bufferM + 50);
  const idx = polylineChunks(geometry, bufferM);
  for (const h of hazards) {
    let best: { alongM: number; distanceM: number } | null = null;
    if (bboxContains(box, h)) {
      const p = projectNearPolyline(h, geometry, cum, idx);
      if (p) best = { alongM: p.alongM, distanceM: p.distanceM };
    }
    if (!best && h.line && h.line.length >= 2) {
      let inside = 0;
      let cand: { alongM: number; distanceM: number } | null = null;
      for (const [lng, lat] of h.line) {
        const v = { lat, lng };
        if (!bboxContains(box, v)) continue;
        const p = projectNearPolyline(v, geometry, cum, idx);
        if (!p) continue;
        inside++;
        if (!cand || p.alongM < cand.alongM) cand = { alongM: p.alongM, distanceM: p.distanceM };
      }
      if (inside >= LINE_MIN_VERTICES_IN_BUFFER) best = cand;
    }
    if (!best) continue;
    items.push({ hazard: h, ...best });
    counts[h.type] = (counts[h.type] ?? 0) + 1;
  }
  items.sort((a, b) => a.alongM - b.alongM);
  return { items, counts, total: items.length };
}
