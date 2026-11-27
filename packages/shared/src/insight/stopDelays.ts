import { coarsen, type LatLng } from '../geo';
import type { LocationSample } from '../driving/types';
import { INSIGHT } from './thresholds';

const S = INSIGHT.stops;

export interface StopObs extends LatLng {
  /** Epoch ms the stop began. */
  t: number;
  waitS: number;
}

/** Stops of 5–180 s inside a drive (red lights, stop signs, queues). A stop the trace ends in is not counted. */
export function detectStops(samples: LocationSample[]): StopObs[] {
  const out: StopObs[] = [];
  let start: LocationSample | null = null;
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const stopped = s.speed !== null && s.speed < S.stopSpeedMps;
    if (stopped) {
      if (!start) start = s;
      continue;
    }
    if (start) {
      const waitS = (s.t - start.t) / 1000;
      if (waitS >= S.minStopS && waitS <= S.maxStopS) out.push({ lat: start.lat, lng: start.lng, t: start.t, waitS });
      start = null;
    }
  }
  return out;
}

export interface StopDelayModel {
  /** "cellKey|band" → sorted waits, s. */
  cells: Record<string, number[]>;
}

const localHour = (t: number) => new Date(t).getHours();

function keyOf(p: LatLng, t: number, hourOf: (t: number) => number): string {
  const c = coarsen(p, S.cellM);
  return `${c.lat.toFixed(5)},${c.lng.toFixed(5)}|${Math.floor(hourOf(t) / S.hourBand)}`;
}

/** Pools stops from any number of drives and drivers. `hourOf` defaults to the phone's local hour. */
export function learnStopDelays(stops: StopObs[], hourOf: (t: number) => number = localHour): StopDelayModel {
  const cells: Record<string, number[]> = {};
  for (const s of stops) (cells[keyOf(s, s.t, hourOf)] ??= []).push(s.waitS);
  for (const k in cells) cells[k]!.sort((a, b) => a - b);
  return { cells };
}

/** Median measured wait at this spot for this time of day, or null with too few observations. */
export function expectedStopS(model: StopDelayModel, p: LatLng, t: number, hourOf: (t: number) => number = localHour): number | null {
  const w = model.cells[keyOf(p, t, hourOf)];
  if (!w || w.length < S.minObs) return null;
  const m = w.length >> 1;
  return w.length % 2 ? w[m]! : (w[m - 1]! + w[m]!) / 2;
}
