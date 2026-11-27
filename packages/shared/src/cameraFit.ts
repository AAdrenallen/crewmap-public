import type { Bounds } from './crewCluster';

/**
 * Camera fits (route preview, "show us both", any fit-to-points move): a fit never zooms in past `maxZoom` and always
 * shows at least `minSpanM` each way, so a destination next door (or a friend a few metres away) frames a readable
 * neighbourhood instead of a single building at zoom 22. The crew-cluster tap keeps its own max zoom 19 (D55).
 */
export const CAMERA_FIT = {
  /** Smallest span (m) a fit shows, width and height. */
  minSpanM: 300,
  /** Deepest zoom a fit may end at (Mapbox GL zoom, 512-dp tiles). */
  maxZoom: 17.5,
};

export type CameraFitConfig = typeof CAMERA_FIT;

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const M_PER_DEG = 111_195;

/** Ground metres per dp at `zoom` and `lat` (Web Mercator, 512-dp tiles). */
export function metresPerDp(zoom: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
}

export interface FitView {
  width: number;
  height: number;
  /** [top, right, bottom, left] in dp. */
  padding: readonly [number, number, number, number];
}

/**
 * `b` grown symmetrically around its centre to the minimum span: `minSpanM`, and, when the view is known, what the
 * visible area (view minus padding) shows at `maxZoom`. Bounds already larger are returned unchanged.
 */
export function fitBounds(b: Bounds, view?: FitView, cfg: CameraFitConfig = CAMERA_FIT): Bounds {
  const [e, n] = b.ne;
  const [w, s] = b.sw;
  if (![e, n, w, s].every(Number.isFinite)) return b;
  const lat = (n + s) / 2;
  const lng = (e + w) / 2;
  const k = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  let needX = cfg.minSpanM;
  let needY = cfg.minSpanM;
  if (view) {
    const [top, right, bottom, left] = view.padding;
    const mpd = metresPerDp(cfg.maxZoom, lat);
    needX = Math.max(needX, mpd * Math.max(32, view.width - left - right));
    needY = Math.max(needY, mpd * Math.max(32, view.height - top - bottom));
  }
  const halfLng = Math.max((e - w) / 2, needX / 2 / (M_PER_DEG * k));
  const halfLat = Math.max((n - s) / 2, needY / 2 / M_PER_DEG);
  return { ne: [lng + halfLng, lat + halfLat], sw: [lng - halfLng, lat - halfLat] };
}
