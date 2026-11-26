import {
  bearingDeg,
  cumulativeDistances,
  pointAlong,
  type LatLng,
} from '@crewmap/shared/geo';
import type {
  ActivitySample,
  ImuSample,
  InteractionSample,
  LocationSample,
} from '@crewmap/shared/driving';

/** One phase of a synthetic speed profile. */
export type Phase =
  | { kind: 'cruise'; seconds: number; kph: number }
  | { kind: 'ramp'; toKph: number; mps2: number }
  | { kind: 'stop'; seconds: number }
  | { kind: 'walk'; seconds: number; kph?: number };

export interface SynthOptions {
  path: LatLng[];
  phases: Phase[];
  startAt: number;
  /** Sample period, seconds. */
  dt?: number;
  /** Speed limit (km/h) as a function of distance along the path. */
  limitAt?: (alongM: number) => number | null;
  /** Deterministic GPS jitter in metres (0 = none). */
  jitterM?: number;
}

export interface SynthDrive {
  locations: LocationSample[];
  activities: ActivitySample[];
  limits: (number | null)[];
  /** Distance along `path` per location sample. */
  along: number[];
}

/** Small deterministic PRNG so fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a drive/walk along `path` following a speed profile, sampled at `dt`. Emits GPS fixes with speed and
 * heading, plus Activity Recognition samples consistent with the motion (automotive while > 10 km/h, still or
 * walking otherwise), the way Android's Transition API would report them.
 */
/** Chaikin corner-cutting: turns polyline kinks into curves, like real road geometry. */
export function smooth(path: LatLng[], iterations = 3): LatLng[] {
  let pts = path;
  for (let k = 0; k < iterations; k++) {
    const next: LatLng[] = [pts[0]!];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      next.push({ lat: 0.75 * a.lat + 0.25 * b.lat, lng: 0.75 * a.lng + 0.25 * b.lng });
      next.push({ lat: 0.25 * a.lat + 0.75 * b.lat, lng: 0.25 * a.lng + 0.75 * b.lng });
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

export function synthesize(opts: SynthOptions): SynthDrive {
  const dt = opts.dt ?? 1;
  const cum = cumulativeDistances(opts.path);
  const total = cum[cum.length - 1]!;
  const rnd = mulberry32(42);
  const out: SynthDrive = { locations: [], activities: [], limits: [], along: [] };
  let t = opts.startAt;
  let v = 0; // m/s
  let s = 0; // along metres
  let lastActivity: string | null = null;

  const emit = (walking: boolean) => {
    const p = pointAlong(opts.path, cum, Math.min(s, total));
    const ahead = pointAlong(opts.path, cum, Math.min(s + 5, total));
    const heading = v > 0.5 ? bearingDeg(p, ahead) : null;
    const j = opts.jitterM ?? 0;
    const jLat = j ? ((rnd() - 0.5) * 2 * j) / 111_320 : 0;
    const jLng = j ? ((rnd() - 0.5) * 2 * j) / (111_320 * Math.cos((p.lat * Math.PI) / 180)) : 0;
    out.locations.push({
      t,
      lat: p.lat + jLat,
      lng: p.lng + jLng,
      speed: v,
      heading,
      accuracy: 5,
    });
    out.limits.push(opts.limitAt ? opts.limitAt(s) : null);
    out.along.push(s);
    const activity = walking ? 'walking' : v * 3.6 > 10 ? 'automotive' : v < 0.3 ? 'still' : (lastActivity ?? 'still');
    if (activity !== lastActivity) {
      out.activities.push({ t, activity: activity as ActivitySample['activity'], confidence: 90 });
      lastActivity = activity;
    }
  };

  const step = (walking: boolean) => {
    s += v * dt;
    t += dt * 1000;
    emit(walking);
  };

  emit(false);
  for (const ph of opts.phases) {
    switch (ph.kind) {
      case 'cruise': {
        v = ph.kph / 3.6;
        for (let i = 0; i < ph.seconds / dt; i++) step(false);
        break;
      }
      case 'ramp': {
        const target = ph.toKph / 3.6;
        const a = Math.abs(ph.mps2) * Math.sign(target - v);
        while (Math.abs(target - v) > 1e-6) {
          const next = v + a * dt;
          v = a > 0 ? Math.min(target, next) : Math.max(target, next);
          step(false);
        }
        break;
      }
      case 'stop': {
        v = 0;
        for (let i = 0; i < ph.seconds / dt; i++) step(false);
        break;
      }
      case 'walk': {
        v = (ph.kph ?? 5) / 3.6;
        for (let i = 0; i < ph.seconds / dt; i++) step(true);
        v = 0;
        break;
      }
    }
  }
  return out;
}

/** IMU magnitude stream at `hz` with a spike at `spikeAt`. */
export function imuWithSpike(startAt: number, endAt: number, spikeAt: number, spikeMps2: number, hz = 10): ImuSample[] {
  const out: ImuSample[] = [];
  const rnd = mulberry32(7);
  for (let t = startAt; t <= endAt; t += 1000 / hz) {
    out.push({ t, magnitude: Math.abs(t - spikeAt) < 50 ? spikeMps2 : 0.3 + rnd() * 0.6 });
  }
  return out;
}

export function touchesBetween(startAt: number, endAt: number, everyMs = 1500): InteractionSample[] {
  const out: InteractionSample[] = [];
  for (let t = startAt; t <= endAt; t += everyMs) out.push({ t, kind: 'touch' });
  return out;
}
