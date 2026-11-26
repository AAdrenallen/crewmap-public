import { destination, type LatLng } from '@crewmap/shared/geo';
import { smooth, synthesize, type SynthDrive } from './synth';

/** 2026-06-15 14:00 local (America/Toronto, UTC−4). */
export const T0 = Date.UTC(2026, 5, 15, 18, 0, 0);

/** Points along a heading from a start, every `stepM`. */
export function straight(from: LatLng, bearing: number, lengthM: number, stepM = 50): LatLng[] {
  const out: LatLng[] = [from];
  for (let d = stepM; d <= lengthM; d += stepM) out.push(destination(from, bearing, d));
  return out;
}

export const PLACES = {
  /** Val-Clair downtown (rue Centrale). */
  valClair: { lat: 45.6519, lng: -74.3369 },
  /** A-15 northbound at the Boul. Saint-Gabriel on-ramp, Ville-Centre. */
  a15OnRamp: { lat: 45.5703, lng: -73.7389 },
  /** A-15 / A-640 interchange (exit 19), Boisbriand. */
  a15A640Exit: { lat: 45.6383, lng: -73.8106 },
  /** Saved place "Work" in Mont-Rivière. */
  work: { lat: 45.7804, lng: -74.0036 },
  /** A friend's shared Home in Belle-Rive. */
  friendHome: { lat: 45.6745, lng: -74.0861 },
} as const;

/**
 * Highway drive near Montréal: on-ramp onto A-15 north at Saint-Gabriel, 100 km/h cruise, off-ramp to the A-640.
 * Ramp segments have 50–70 km/h limits; the highway 100 km/h.
 */
export function highwayDrive(): SynthDrive & { path: LatLng[] } {
  const path: LatLng[] = smooth([
    { lat: 45.5655, lng: -73.7315 }, // Boul. Saint-Gabriel
    PLACES.a15OnRamp,
    { lat: 45.5822, lng: -73.7502 },
    { lat: 45.6012, lng: -73.7701 },
    { lat: 45.6205, lng: -73.7908 },
    PLACES.a15A640Exit,
    { lat: 45.6421, lng: -73.8189 },
    { lat: 45.6438, lng: -73.8282 },
  ]);
  const d = synthesize({
    path,
    startAt: T0,
    phases: [
      { kind: 'stop', seconds: 30 },
      { kind: 'ramp', toKph: 50, mps2: 2 },
      { kind: 'cruise', seconds: 40, kph: 50 },
      { kind: 'ramp', toKph: 100, mps2: 1.5 },
      { kind: 'cruise', seconds: 330, kph: 100 },
      { kind: 'ramp', toKph: 60, mps2: 1.8 },
      { kind: 'cruise', seconds: 40, kph: 60 },
      { kind: 'ramp', toKph: 0, mps2: 2 },
      { kind: 'stop', seconds: 240 },
    ],
    limitAt: (s) => (s < 600 ? 50 : s < 10_000 ? 100 : 70),
    jitterM: 2,
  });
  return { ...d, path };
}

/** City drive with one hard brake (−5 m/s² from 60 km/h) in the middle. */
export function hardBrakeDrive(): SynthDrive {
  return synthesize({
    path: straight(PLACES.valClair, 90, 6000),
    startAt: T0,
    phases: [
      { kind: 'ramp', toKph: 60, mps2: 2 },
      { kind: 'cruise', seconds: 90, kph: 60 },
      { kind: 'ramp', toKph: 5, mps2: 5 },
      { kind: 'ramp', toKph: 50, mps2: 1.5 },
      { kind: 'cruise', seconds: 90, kph: 50 },
      { kind: 'ramp', toKph: 0, mps2: 2 },
      { kind: 'stop', seconds: 200 },
    ],
    limitAt: () => 70,
  });
}

/** Drive at 92 km/h in a 70 zone for 40 s, then 108 km/h in a 70 zone for 15 s. */
export function speedingDrive(): SynthDrive {
  return synthesize({
    path: straight(PLACES.valClair, 45, 12_000),
    startAt: T0,
    phases: [
      { kind: 'ramp', toKph: 70, mps2: 2 },
      { kind: 'cruise', seconds: 60, kph: 70 },
      { kind: 'ramp', toKph: 92, mps2: 1 },
      { kind: 'cruise', seconds: 40, kph: 92 },
      { kind: 'ramp', toKph: 70, mps2: 1.5 },
      { kind: 'cruise', seconds: 40, kph: 70 },
      { kind: 'ramp', toKph: 108, mps2: 2 },
      { kind: 'cruise', seconds: 15, kph: 108 },
      { kind: 'ramp', toKph: 70, mps2: 2 },
      { kind: 'cruise', seconds: 60, kph: 70 },
      { kind: 'ramp', toKph: 0, mps2: 2 },
      { kind: 'stop', seconds: 200 },
    ],
    limitAt: () => 70,
  });
}

/** 15-minute walk at 5 km/h — must never become a trip. */
export function walk(): SynthDrive {
  return synthesize({
    path: straight(PLACES.valClair, 200, 1500),
    startAt: T0,
    phases: [{ kind: 'walk', seconds: 900, kph: 5 }],
  });
}

/** 40 km/h through a 25 m-radius right-angle left turn (≈ 4.9 m/s² lateral) between two straights. */
export function sharpTurnDrive(): SynthDrive {
  const start = PLACES.valClair;
  const leg1 = straight(start, 90, 600, 25);
  const corner = leg1[leg1.length - 1]!;
  const centre = destination(corner, 0, 25);
  const arc: LatLng[] = [];
  for (let a = 5; a <= 90; a += 5) arc.push(destination(centre, 180 - a, 25));
  const exit = arc[arc.length - 1]!;
  const leg2 = straight(exit, 0, 800, 25).slice(1);
  return synthesize({
    path: [...leg1, ...arc, ...leg2],
    startAt: T0,
    phases: [
      { kind: 'ramp', toKph: 40, mps2: 2 },
      { kind: 'cruise', seconds: 110, kph: 40 },
      { kind: 'ramp', toKph: 0, mps2: 2 },
      { kind: 'stop', seconds: 200 },
    ],
    limitAt: () => 50,
  });
}
