import type { Congestion, NavRoute } from '@crewmap/shared/navigation';

/**
 * Route preview colours (pure, no map imports so Vitest covers it). Each candidate keeps one colour for the whole
 * preview (map line + card chip), by its position in the candidate list; the selected one is drawn on top, wider,
 * with traffic colours on its moderate / heavy / severe stretches. No candidate hue is a traffic hue (green, amber,
 * red), so a coloured alternative never reads as congestion.
 */
export const ROUTE_COLORS = ['#5B6CFF', '#0EA5E9', '#A855F7', '#EC4899', '#8B5E3C'] as const;

export const CONGESTION_COLOR: Record<Congestion, string | null> = {
  unknown: null,
  low: null,
  moderate: '#FFB224',
  heavy: '#E5484D',
  severe: '#8E1B1E',
};

export function routeColor(index: number): string {
  const n = ROUTE_COLORS.length;
  return ROUTE_COLORS[((Math.trunc(Number.isFinite(index) ? index : 0) % n) + n) % n]!;
}

/** Colour of a route among the preview candidates (by id); the first colour when it is not a candidate. */
export function colorOfRoute(routeId: string, candidates: readonly { route: { id: string } }[] | null): string {
  const i = candidates?.findIndex((c) => c.route.id === routeId) ?? -1;
  return routeColor(Math.max(0, i));
}

export type LineFeature = GeoJSON.Feature<GeoJSON.LineString, { color: string }>;

/** The selected route as congestion runs: `base` where traffic is free / unknown, traffic colours elsewhere. */
export function routeFeatures(route: Pick<NavRoute, 'geometry' | 'congestion'>, base: string = ROUTE_COLORS[0]): { type: 'FeatureCollection'; features: LineFeature[] } {
  const feats: LineFeature[] = [];
  // Segment i joins geometry[i] and geometry[i + 1]; segments without congestion data take the base colour.
  const segs = route.geometry.length - 1;
  const colorAt = (i: number) => (i < route.congestion.length ? CONGESTION_COLOR[route.congestion[i]!] : null) ?? base;
  let start = 0;
  for (let i = 1; i <= segs; i++) {
    if (i === segs || colorAt(i) !== colorAt(start)) {
      const coords = route.geometry.slice(start, i + 1).map((p) => [p.lng, p.lat]);
      feats.push({ type: 'Feature', properties: { color: colorAt(start) }, geometry: { type: 'LineString', coordinates: coords } });
      start = i;
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Unselected candidates, each with its own colour (drawn under the selected route; tapping one selects it). */
export function alternativeFeatures(
  candidates: readonly { route: Pick<NavRoute, 'id' | 'geometry'> }[],
  selectedId: string,
): { type: 'FeatureCollection'; features: GeoJSON.Feature<GeoJSON.LineString, { id: string; color: string }>[] } {
  return {
    type: 'FeatureCollection',
    features: candidates.flatMap((c, i) =>
      c.route.id === selectedId || c.route.geometry.length < 2
        ? []
        : [{ type: 'Feature' as const, properties: { id: c.route.id, color: routeColor(i) }, geometry: { type: 'LineString' as const, coordinates: c.route.geometry.map((p) => [p.lng, p.lat]) } }],
    ),
  };
}
