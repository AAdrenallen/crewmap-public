import { haversineM, type LatLng } from '@crewmap/shared/geo';
import type { ImuSample, LocationSample, Trip } from '@crewmap/shared/driving';
import {
  detectStops,
  INSIGHT,
  learnStopDelays,
  leaveBy,
  roughnessCells,
  type LeaveByAdvice,
  type PastTrip,
  type RoughCell,
  type StopDelayModel,
  type StopObs,
} from '@crewmap/shared/insight';
import type { Place } from '@crewmap/shared/places';
import * as db from './db';

const STOP_OBS_KEY = 'insightStops.v1';
const ROUGH_CELLS_KEY = 'insightRough.v1';
const MAX_STOP_OBS = 500;
const MAX_ROUGH_CELLS = 400;
const ENDPOINT_MATCH_M = 250;

export interface DoorToDoorInsight {
  typicalS: number;
  trips: number;
  advice: LeaveByAdvice | null;
  arriveAt: number;
}

/** Next clean target arrival timestamp (rounded up to the next 30-min mark after typical drive + 10 min). */
function nextTargetArrival(now: number, typicalS: number): number {
  const earliest = now + (typicalS + 600) * 1000;
  const halfHour = 30 * 60_000;
  return Math.ceil(earliest / halfHour) * halfHour;
}

function matchPlaceId(pt: LatLng, places: Place[]): string | null {
  let best: { id: string; d: number } | null = null;
  for (const p of places) {
    const r = Math.max(ENDPOINT_MATCH_M, p.radiusM);
    const d = haversineM(pt, p);
    if (d <= r && (!best || d < best.d)) best = { id: p.id, d };
  }
  return best?.id ?? null;
}

/**
 * Computes door-to-door typical duration and `leaveBy` advice between `from` and `to` using lightweight
 * SQLite trip thumbnails (`db.tripList()` never loads full GPS point blobs).
 */
export async function computeTripInsight(
  from: LatLng,
  to: LatLng,
  places: Place[],
  now = Date.now(),
): Promise<DoorToDoorInsight | null> {
  if (haversineM(from, to) < 200) return null;
  const list = await db.tripList().catch(() => []);
  if (list.length < 2) return null;

  const fromPlace = matchPlaceId(from, places) ?? '__origin__';
  const toPlace = matchPlaceId(to, places) ?? '__dest__';
  if (fromPlace === toPlace) return null;

  const past: PastTrip[] = [];
  for (const tr of list) {
    if (tr.passenger || tr.durationS <= 60 || tr.thumb.length < 2) continue;
    const a = tr.thumb[0]!;
    const b = tr.thumb[tr.thumb.length - 1]!;
    const fp = fromPlace === '__origin__'
      ? (haversineM(a, from) <= ENDPOINT_MATCH_M ? '__origin__' : null)
      : matchPlaceId(a, places);
    const tp = toPlace === '__dest__'
      ? (haversineM(b, to) <= ENDPOINT_MATCH_M ? '__dest__' : null)
      : matchPlaceId(b, places);
    if (fp === fromPlace && tp === toPlace) {
      past.push({ fromPlace, toPlace, startT: tr.startedAt, durationS: tr.durationS });
    }
  }
  if (past.length < 2) return null;

  const sorted = past.map((p) => p.durationS).sort((x, y) => x - y);
  const typicalS = sorted[sorted.length >> 1]!;
  const arriveAt = nextTargetArrival(now, typicalS);
  const advice = leaveBy(past, fromPlace, toPlace, arriveAt);
  return { typicalS, trips: past.length, advice, arriveAt };
}

/** Merges a minute-window batch of IMU + fix samples into the running per-drive roughness cell map. */
export function mergeDriveRoughness(
  into: Map<string, RoughCell>,
  fixes: LocationSample[],
  imu: ImuSample[],
): void {
  if (fixes.length === 0 || imu.length === 0) return;
  for (const c of roughnessCells(fixes, imu)) {
    const prev = into.get(c.key);
    if (!prev) {
      into.set(c.key, c);
    } else {
      const total = prev.samples + c.samples;
      const rms = Math.sqrt((prev.index * prev.index * prev.samples + c.index * c.index * c.samples) / total);
      into.set(c.key, {
        key: c.key,
        lat: c.lat,
        lng: c.lng,
        index: rms,
        samples: total,
        spikes: prev.spikes + c.spikes,
      });
    }
  }
}

/**
 * Persists learned stop delays and road-roughness cells from a finished driver trip (D63), and returns the
 * strongest rough/pothole spot on the drive (if any and not already reported nearby) for a calm 1-tap prompt.
 */
export async function recordTripInsights(
  trip: Trip,
  driveRough: Map<string, RoughCell>,
  existingHazards: { type: string; lat: number; lng: number }[],
): Promise<{ lat: number; lng: number } | null> {
  if (trip.passenger || trip.points.length < 2) return null;

  const samples: LocationSample[] = trip.points.map((p) => ({
    t: p.t,
    lat: p.lat,
    lng: p.lng,
    speed: p.speed,
    heading: p.heading,
    accuracy: 10,
  }));
  const newStops = detectStops(samples);
  if (newStops.length > 0) {
    const prev = await db.kvGet<StopObs[]>(STOP_OBS_KEY, []).catch(() => []);
    const merged = [...prev, ...newStops].slice(-MAX_STOP_OBS);
    await db.kvSet(STOP_OBS_KEY, merged).catch(() => undefined);
  }

  const cells = [...driveRough.values()];
  if (cells.length === 0) return null;

  const prevCells = await db.kvGet<RoughCell[]>(ROUGH_CELLS_KEY, []).catch(() => []);
  const byKey = new Map<string, RoughCell>();
  for (const c of prevCells) byKey.set(c.key, c);
  for (const c of cells) {
    const old = byKey.get(c.key);
    byKey.set(c.key, old ? { ...c, spikes: old.spikes + c.spikes, samples: old.samples + c.samples } : c);
  }
  await db.kvSet(ROUGH_CELLS_KEY, [...byKey.values()].slice(-MAX_ROUGH_CELLS)).catch(() => undefined);

  const candidates = cells
    .filter((c) => c.spikes >= 2 || (c.spikes >= 1 && c.index >= INSIGHT.roughness.roughIndex))
    .sort((a, b) => b.spikes - a.spikes || b.index - a.index);
  const top = candidates[0];
  if (!top) return null;

  const alreadyKnown = existingHazards.some(
    (h) => (h.type === 'pothole' || h.type === 'hazard') && haversineM(h, top) < 150,
  );
  return alreadyKnown ? null : { lat: top.lat, lng: top.lng };
}

/** Loads the learned on-device stop-delay model (D63). */
export async function loadStopDelayModel(): Promise<StopDelayModel> {
  const obs = await db.kvGet<StopObs[]>(STOP_OBS_KEY, []).catch(() => []);
  return learnStopDelays(obs);
}
