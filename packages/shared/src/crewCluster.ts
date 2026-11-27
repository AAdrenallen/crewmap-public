import { haversineM, type LatLng } from './geo';

/** Tunables for crew clusters on the home map (D55). Pixels are layout dp. */
export const CLUSTER = {
  /** Markers closer than this on screen merge into one cluster (a friend sprite is ~64 dp wide). */
  overlapPx: 52,
  /** While navigating/driving: markers carry a bigger touch target, but clusters stay small (declutter). */
  overlapPxDriving: 64,
  /** Everyone within this many metres of each other counts as one spot (same building): group scene. */
  sameSpotM: 25,
  /** Tapping a cluster never zooms in further than this. */
  maxZoom: 19,
  /** At or above (maxZoom - this), a tap opens the list instead of zooming. */
  maxZoomSlack: 0.25,
  /** Fit-bounds padding in dp (top, right, bottom, left) around the members. */
  fitPadding: [120, 64, 180, 64] as [number, number, number, number],
  /** Cluster recompute is throttled to at most once per this many ms. */
  recomputeMs: 400,
  /** Sprites shown in a group scene (more members only raise the count badge). */
  sceneMax: 6,
  sceneMaxDriving: 3,
} as const;

export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * Single-link clustering by screen distance: any two markers closer than `radiusPx` end up in one group. Groups
 * with one member are singles. Output order is deterministic (members sorted, groups by first member).
 */
export function clusterByPixels(points: ScreenPoint[], radiusPx: number): string[][] {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const r2 = radiusPx * radiusPx;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i]!.x - pts[j]!.x;
      const dy = pts[i]!.y - pts[j]!.y;
      if (dx * dx + dy * dy < r2) parent[find(i)] = find(j);
    }
  const groups = new Map<number, string[]>();
  pts.forEach((p, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), p.id]);
  });
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

export interface Bounds {
  ne: [number, number];
  sw: [number, number];
}

/** Bounds ([lng, lat]) around the points. Null for none. */
export function boundsOf(points: LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let n = -90,
    s = 90,
    e = -180,
    w = 180;
  for (const p of points) {
    n = Math.max(n, p.lat);
    s = Math.min(s, p.lat);
    e = Math.max(e, p.lng);
    w = Math.min(w, p.lng);
  }
  return { ne: [e, n], sw: [w, s] };
}

export function centroid(points: LatLng[]): LatLng {
  const k = Math.max(1, points.length);
  return {
    lat: points.reduce((a, p) => a + p.lat, 0) / k,
    lng: points.reduce((a, p) => a + p.lng, 0) / k,
  };
}

/** Largest pairwise distance in metres. */
export function spreadM(points: LatLng[]): number {
  let m = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) m = Math.max(m, haversineM(points[i]!, points[j]!));
  return m;
}

export function isSameSpot(points: LatLng[], thresholdM: number = CLUSTER.sameSpotM): boolean {
  return points.length >= 2 && spreadM(points) <= thresholdM;
}

/** Web-Mercator zoom (512-px tiles, Mapbox GL) that fits `b` inside a viewW x viewH dp view minus padding. */
export function fitZoom(b: Bounds, viewW: number, viewH: number, padding: readonly [number, number, number, number]): number {
  const [top, right, bottom, left] = padding;
  const w = Math.max(32, viewW - left - right);
  const h = Math.max(32, viewH - top - bottom);
  const mx = (lng: number) => (lng + 180) / 360;
  const my = (lat: number) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const dx = Math.abs(mx(b.ne[0]) - mx(b.sw[0]));
  const dy = Math.abs(my(b.sw[1]) - my(b.ne[1]));
  const zx = dx > 0 ? Math.log2(w / (512 * dx)) : Infinity;
  const zy = dy > 0 ? Math.log2(h / (512 * dy)) : Infinity;
  return Math.min(zx, zy);
}

export interface ClusterView {
  width: number;
  height: number;
  padding?: readonly [number, number, number, number];
}

export type ClusterTap = { kind: 'list' } | { kind: 'zoom'; center: LatLng; zoom: number };

/**
 * What tapping a cluster does: at max zoom, list everyone; otherwise frame all members on screen (with padding),
 * never closer than CLUSTER.maxZoom. Members on one spot go straight to max zoom.
 */
export function clusterTap(points: LatLng[], zoom: number, view: ClusterView): ClusterTap {
  if (points.length === 0 || zoom >= CLUSTER.maxZoom - CLUSTER.maxZoomSlack) return { kind: 'list' };
  const b = boundsOf(points)!;
  const center = { lat: (b.ne[1] + b.sw[1]) / 2, lng: (b.ne[0] + b.sw[0]) / 2 };
  const z = isSameSpot(points) ? CLUSTER.maxZoom : fitZoom(b, view.width, view.height, view.padding ?? CLUSTER.fitPadding);
  return { kind: 'zoom', center, zoom: Math.min(CLUSTER.maxZoom, z) };
}
