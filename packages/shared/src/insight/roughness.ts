import { coarsen } from '../geo';
import type { ImuSample, LocationSample } from '../driving/types';
import { INSIGHT } from './thresholds';

const R = INSIGHT.roughness;

export interface RoughCell {
  /** Cell centre key "lat,lng" (5 decimals). */
  key: string;
  lat: number;
  lng: number;
  /** Speed-normalised RMS linear acceleration, m/s². */
  index: number;
  samples: number;
  /** Spikes at or above `spikeMps2` in this cell. */
  spikes: number;
}

function cellOf(lat: number, lng: number) {
  const c = coarsen({ lat, lng }, R.cellM);
  return { key: `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, lat: c.lat, lng: c.lng };
}

/**
 * Road roughness per 50 m cell from one drive: each IMU sample is placed at the latest good fix before it (at most
 * 2 s old) and scaled by sqrt(refSpeed / speed). Only cell values leave the phone, never the trace.
 */
export function roughnessCells(loc: LocationSample[], imu: ImuSample[]): RoughCell[] {
  const fixes = loc
    .filter((f) => f.accuracy <= R.maxAccuracyM && f.speed !== null && f.speed >= R.minSpeedMps)
    .sort((a, b) => a.t - b.t);
  const acc = new Map<string, { lat: number; lng: number; sq: number; n: number; spikes: number }>();
  let i = 0;
  for (const s of [...imu].sort((a, b) => a.t - b.t)) {
    while (i + 1 < fixes.length && fixes[i + 1]!.t <= s.t) i++;
    const f = fixes[i];
    if (!f || f.t > s.t || s.t - f.t > 2000) continue;
    const scaled = s.magnitude * Math.sqrt(R.refSpeedMps / (f.speed as number));
    const c = cellOf(f.lat, f.lng);
    const a = acc.get(c.key) ?? { lat: c.lat, lng: c.lng, sq: 0, n: 0, spikes: 0 };
    a.sq += scaled * scaled;
    a.n++;
    if (s.magnitude >= R.spikeMps2) a.spikes++;
    acc.set(c.key, a);
  }
  const out: RoughCell[] = [];
  for (const [key, a] of acc) {
    if (a.n < R.minSamples) continue;
    out.push({ key, lat: a.lat, lng: a.lng, index: Math.sqrt(a.sq / a.n), samples: a.n, spikes: a.spikes });
  }
  return out;
}

export interface CrewRoughCell {
  key: string;
  lat: number;
  lng: number;
  /** Sample-weighted mean index across drivers. */
  index: number;
  drivers: number;
  spikeDrivers: number;
  rough: boolean;
}

/** Pools cells from several drivers (driver id → that driver's cells, any number of drives). */
export function mergeRoughness(byDriver: Record<string, RoughCell[]>): CrewRoughCell[] {
  const m = new Map<string, { lat: number; lng: number; w: number; sum: number; drivers: Set<string>; spikers: Set<string> }>();
  for (const [driver, cells] of Object.entries(byDriver)) {
    for (const c of cells) {
      const a = m.get(c.key) ?? { lat: c.lat, lng: c.lng, w: 0, sum: 0, drivers: new Set<string>(), spikers: new Set<string>() };
      a.w += c.samples;
      a.sum += c.index * c.samples;
      a.drivers.add(driver);
      if (c.spikes > 0) a.spikers.add(driver);
      m.set(c.key, a);
    }
  }
  return [...m].map(([key, a]) => {
    const index = a.sum / a.w;
    return { key, lat: a.lat, lng: a.lng, index, drivers: a.drivers.size, spikeDrivers: a.spikers.size, rough: index >= R.roughIndex };
  });
}

/** Cells where enough different drivers hit a spike: a pothole or bump worth suggesting as a crew report. */
export function potholeCandidates(cells: CrewRoughCell[]): CrewRoughCell[] {
  return cells
    .filter((c) => c.spikeDrivers >= R.potholeDrivers)
    .sort((a, b) => b.spikeDrivers - a.spikeDrivers || b.index - a.index);
}
