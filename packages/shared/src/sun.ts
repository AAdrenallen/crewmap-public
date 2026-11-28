/**
 * Sunrise/sunset (NOAA algorithm, ±1–2 min) for day/night map themes that follow local sunset (F2).
 */
const RAD = Math.PI / 180;

function julian(t: number): number {
  return t / 86_400_000 + 2440587.5;
}

/** Returns sunrise and sunset (epoch ms) for the local solar day containing `t` at (lat, lng). Null in polar day/night. */
export function sunTimes(t: number, lat: number, lng: number): { sunrise: number; sunset: number } | null {
  const day = Math.round(julian(t) - 2451545.0 + 0.0008 + lng / 360);
  const meanSolarNoon = day - lng / 360;
  const M = (357.5291 + 0.98560028 * meanSolarNoon) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + meanSolarNoon + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / RAD;
  const toMs = (j: number) => (j - 2440587.5) * 86_400_000;
  return { sunrise: toMs(transit - H / 360), sunset: toMs(transit + H / 360) };
}

export type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

/** Mapbox Standard `lightPreset` for now, with 30-min dawn/dusk windows around sunrise/sunset. */
export function lightPreset(t: number, lat: number, lng: number): LightPreset {
  const s = sunTimes(t, lat, lng);
  if (!s) return Math.abs(lat) > 66 && new Date(t).getUTCMonth() % 11 < 3 ? 'night' : 'day';
  const w = 30 * 60_000;
  if (Math.abs(t - s.sunrise) <= w) return 'dawn';
  if (Math.abs(t - s.sunset) <= w) return 'dusk';
  return t > s.sunrise && t < s.sunset ? 'day' : 'night';
}
