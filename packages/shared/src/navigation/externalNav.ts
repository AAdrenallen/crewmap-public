import { pointAlong, polylineChunks, projectNearPolyline, type LatLng } from '../geo';
import type { NavRoute } from './route';

/** External turn-by-turn apps CrewMap can hand a destination to (docs/DECISIONS.md: no Google/Waze data on our map). */
export type ExternalNavApp = 'waze' | 'gmaps';

export const EXTERNAL_NAV = {
  /** Google Maps accepts more, but its navigate intent only honours a few shaping points reliably. */
  maxWaypoints: 3,
  /** A route sample farther than this from every other candidate counts as "diverged". */
  divergeM: 60,
  /** Divergent stretches shorter than this are noise (parallel carriageways, ramps). */
  minStretchM: 300,
  /** Sampling step along the chosen route. */
  sampleM: 100,
} as const;

const coord = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Waze deep link. Waze has no waypoint support: it computes its own route. */
export function wazeUrl(dest: LatLng): string {
  return `https://waze.com/ul?ll=${coord(dest)}&navigate=yes`;
}

/**
 * Google Maps link. With vias the universal Directions URL keeps the chosen route; without, the
 * `google.navigation:` intent starts guidance immediately.
 */
export function googleMapsUrl(dest: LatLng, via: LatLng[] = []): string {
  const v = via.slice(0, EXTERNAL_NAV.maxWaypoints);
  if (v.length === 0) return `google.navigation:q=${coord(dest)}&mode=d`;
  const wp = encodeURIComponent(v.map(coord).join('|'));
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coord(dest))}&waypoints=${wp}&travelmode=driving&dir_action=navigate`;
}

export function externalNavUrl(app: ExternalNavApp, dest: LatLng, via: LatLng[] = []): string {
  return app === 'waze' ? wazeUrl(dest) : googleMapsUrl(dest, via);
}

/**
 * ≤ 3 points that pin Google's routing to `route`: the middle of each stretch where `route` is far from every
 * other candidate, longest stretches first, returned in driving order. No other candidates → no vias.
 */
export function shapingWaypoints(route: NavRoute, others: NavRoute[], cfg = EXTERNAL_NAV): LatLng[] {
  const alts = others.filter((o) => o.id !== route.id && o.geometry.length > 1).map((o) => ({ o, idx: polylineChunks(o.geometry, cfg.divergeM) }));
  if (alts.length === 0 || route.geometry.length < 2) return [];
  const total = route.cum[route.cum.length - 1] ?? 0;
  const stretches: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (let s = 0; s <= total; s += cfg.sampleM) {
    const p = pointAlong(route.geometry, route.cum, s);
    const far = alts.every(({ o, idx }) => projectNearPolyline(p, o.geometry, o.cum, idx) === null);
    if (far && open === null) open = s;
    if (!far && open !== null) {
      stretches.push({ start: open, end: s });
      open = null;
    }
  }
  if (open !== null) stretches.push({ start: open, end: total });
  return stretches
    .filter((x) => x.end - x.start >= cfg.minStretchM)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, cfg.maxWaypoints)
    .sort((a, b) => a.start - b.start)
    .map((x) => pointAlong(route.geometry, route.cum, (x.start + x.end) / 2));
}
