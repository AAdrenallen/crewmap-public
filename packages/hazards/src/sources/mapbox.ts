import { slicePolyline } from '@crewmap/shared/geo';
import type { NavRoute, RouteIncident } from '@crewmap/shared/navigation';
import { DEFAULT_TTL_MS, type Hazard, type HazardType } from '../types';

export const MAPBOX_ATTRIBUTION = '© Mapbox';
/** Route incidents are re-derived from the route on every publish; this caps how long a shared copy lives. */
export const MAPBOX_INCIDENT_TTL_MS = 2 * 3600_000;

/** Mapbox Directions `driving-traffic` incident (`legs[].incidents[]`) → hazard type. */
export function mapboxIncidentType(i: RouteIncident): HazardType {
  if (i.closed) return 'closure';
  switch (i.type) {
    case 'accident':
      return 'accident';
    case 'construction':
      return 'construction';
    case 'road_closure':
      return 'closure';
    case 'congestion':
      return 'jam';
    default:
      // lane_restriction, disabled_vehicle, road_hazard, weather, planned_event, mass_transit, miscellaneous …
      return 'hazard';
  }
}

export function hazardsFromRoute(route: NavRoute, now: number): Hazard[] {
  return route.incidents.map((i) => {
    const type = mapboxIncidentType(i);
    const line =
      i.endAlongM > i.startAlongM && route.geometry.length >= 2
        ? slicePolyline(route.geometry, route.cum, i.startAlongM, i.endAlongM).map((p) => [p.lng, p.lat] as [number, number])
        : undefined;
    return {
      id: `mapbox:${i.id}`,
      source: 'mapbox' as const,
      type,
      subtype: i.type,
      lat: i.location.lat,
      lng: i.location.lng,
      heading: null,
      street: null,
      reportedAt: now,
      expiresAt: now + Math.min(DEFAULT_TTL_MS[type], MAPBOX_INCIDENT_TTL_MS),
      reliability: 8,
      confirmations: 0,
      ...(line && line.length >= 2 ? { line } : {}),
      ...(i.description ? { description: i.description } : {}),
    };
  });
}

/** Incidents of several candidate routes (route picker), the same incident once. */
export function hazardsFromRoutes(routes: NavRoute[], now: number): Hazard[] {
  const seen = new Map<string, Hazard>();
  for (const r of routes) for (const h of hazardsFromRoute(r, now)) if (!seen.has(h.id)) seen.set(h.id, h);
  return [...seen.values()];
}
