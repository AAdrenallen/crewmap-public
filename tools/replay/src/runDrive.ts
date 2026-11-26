import {
  DrivingPipeline,
  type ImuSample,
  type InteractionSample,
  type RiskyEvent,
  type Trip,
} from '@crewmap/shared/driving';
import type { SynthDrive } from './synth';

export interface RunResult {
  trips: Trip[];
  liveEvents: RiskyEvent[];
  startedAt: number[];
}

/** Feeds a synthetic drive through the real on-device driving pipeline, in time order. */
export function runDrive(
  d: SynthDrive,
  extra: { imu?: ImuSample[]; touches?: InteractionSample[]; localHour?: (t: number) => number } = {},
): RunResult {
  let n = 0;
  const res: RunResult = { trips: [], liveEvents: [], startedAt: [] };
  const pipe = new DrivingPipeline(
    { newId: () => `trip-${++n}`, localHour: extra.localHour ?? (() => 14) },
    {
      onEvent: (e) => res.liveEvents.push(e),
      onTripStarted: (t) => res.startedAt.push(t),
    },
  );
  type Item =
    | { t: number; k: 'loc'; i: number }
    | { t: number; k: 'act'; i: number }
    | { t: number; k: 'imu'; i: number }
    | { t: number; k: 'touch'; i: number };
  const items: Item[] = [
    ...d.locations.map((l, i) => ({ t: l.t, k: 'loc' as const, i })),
    ...d.activities.map((a, i) => ({ t: a.t, k: 'act' as const, i })),
    ...(extra.imu ?? []).map((s, i) => ({ t: s.t, k: 'imu' as const, i })),
    ...(extra.touches ?? []).map((s, i) => ({ t: s.t, k: 'touch' as const, i })),
  ];
  const order = { act: 0, imu: 1, touch: 2, loc: 3 };
  items.sort((a, b) => a.t - b.t || order[a.k] - order[b.k]);
  for (const it of items) {
    switch (it.k) {
      case 'act':
        pipe.activity(d.activities[it.i]!);
        break;
      case 'imu':
        pipe.imu(extra.imu![it.i]!);
        break;
      case 'touch':
        pipe.interaction(extra.touches![it.i]!);
        break;
      case 'loc':
        res.trips.push(...pipe.location(d.locations[it.i]!, d.limits[it.i] ?? null));
        break;
    }
  }
  const last = d.locations[d.locations.length - 1]!;
  res.trips.push(...pipe.tick(last.t + 1));
  res.trips.push(...pipe.flush());
  return res;
}
