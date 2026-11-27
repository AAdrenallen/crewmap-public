import type { LocationSample } from '@crewmap/shared/driving';
import {
  classifyParking,
  NO_PARKING,
  parkCandidate,
  parkingStep,
  type ParkingContext,
  type ParkingEffect,
  type ParkingState,
} from '@crewmap/shared/parking';
import type { Place } from '@crewmap/shared/places';
import { runDrive } from './runDrive';
import type { SynthDrive } from './synth';

export interface ParkingRun {
  state: ParkingState;
  effects: ParkingEffect[];
  trips: number;
}

/**
 * "Where did I park" through the real trip pipeline (D67): the synthetic drive goes through `runDrive`; each trip
 * start, trip end (classified with `contextAt`, standing in for the Overpass lookup) and every later fix is fed to
 * `parkingStep` in time order, the way `apps/mobile/src/core/parking.ts` does on the phone.
 */
export function runParking(
  d: SynthDrive,
  opts: { places?: Pick<Place, 'type' | 'lat' | 'lng' | 'radiusM'>[]; contextAt?: (p: { lat: number; lng: number }) => ParkingContext | null; state?: ParkingState; after?: LocationSample[] } = {},
): ParkingRun {
  const r = runDrive(d);
  type In = { t: number; k: 0 | 1 | 2; run: (st: ParkingState) => ReturnType<typeof parkingStep> };
  const items: In[] = [];
  for (const t of r.startedAt) {
    const at = d.locations.find((l) => l.t >= t) ?? d.locations[0]!;
    items.push({ t, k: 0, run: (st) => parkingStep(st, { type: 'tripStarted', t, lat: at.lat, lng: at.lng }) });
  }
  for (const trip of r.trips) {
    const c = parkCandidate(trip);
    if (!c) continue;
    const decision = classifyParking(c, opts.places ?? [], opts.contextAt?.(c) ?? null);
    items.push({ t: trip.endedAt, k: 1, run: (st) => parkingStep(st, { type: 'parked', candidate: c, decision }) });
  }
  const lastEnd = r.trips.reduce((m, tr) => Math.max(m, tr.endedAt), -Infinity);
  for (const f of [...d.locations.filter((l) => l.t > lastEnd), ...(opts.after ?? [])])
    items.push({ t: f.t, k: 2, run: (st) => parkingStep(st, { type: 'fix', t: f.t, lat: f.lat, lng: f.lng }) });
  items.sort((a, b) => a.t - b.t || a.k - b.k);
  let state = opts.state ?? NO_PARKING;
  const effects: ParkingEffect[] = [];
  for (const it of items) {
    const s = it.run(state);
    state = s.state;
    effects.push(...s.effects);
  }
  return { state, effects, trips: r.trips.length };
}
