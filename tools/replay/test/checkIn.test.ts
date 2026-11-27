import { describe, expect, it } from 'vitest';
import { CHECK_IN, type StopContext } from '@crewmap/shared/safety';
import { straight, T0 } from '../src/fixtures';
import { runCheckIn } from '../src/runCheckIn';
import { imuWithSpike, synthesize, type Phase } from '../src/synth';

/** Route 117 northbound through the La Vérendrye wildlife reserve: a long road with nothing around. */
const PATH = straight({ lat: 47.05, lng: -76.95 }, 10, 15_000);

const nothingAround: StopContext = {
  places: [],
  navDest: null,
  knownStopS: null,
  okBefore: false,
  trafficNearby: false,
  poisNearby: 0,
  surroundings: { buildings: 0, residential: false, restStop: false },
};

const drive = (phases: Phase[]) => synthesize({ path: PATH, phases, startAt: T0 });
const kinds = (r: { actions: { kind: string }[] }) => r.actions.map((a) => a.kind);

describe('safety check-in through the trip pipeline (D66)', () => {
  it('pull-over on a remote road: asks after the wait, tells the crew after the grace period', () => {
    const r = runCheckIn(drive([{ kind: 'ramp', toKph: 90, mps2: 2 }, { kind: 'cruise', seconds: 300, kph: 90 }, { kind: 'ramp', toKph: 0, mps2: 2.5 }, { kind: 'stop', seconds: 12 * 60 }]), nothingAround);
    expect(kinds(r)).toEqual(['ask', 'alert']);
    expect(r.actions[1]!.t - r.actions[0]!.t).toBe(CHECK_IN.graceS * 1000);
  });

  it('answered in time: nobody is told', () => {
    const d = drive([{ kind: 'ramp', toKph: 90, mps2: 2 }, { kind: 'cruise', seconds: 300, kph: 90 }, { kind: 'ramp', toKph: 0, mps2: 2.5 }, { kind: 'stop', seconds: 12 * 60 }]);
    const stopAt = d.locations.find((l, i) => i > 10 && (l.speed ?? 0) < CHECK_IN.stopSpeedMps)!.t;
    const r = runCheckIn(d, nothingAround, { answerAt: stopAt + 6 * 60_000 });
    expect(kinds(r)).toEqual(['ask', 'dismiss']);
  });

  it('same stop at a rest area: never asks', () => {
    const r = runCheckIn(drive([{ kind: 'ramp', toKph: 90, mps2: 2 }, { kind: 'cruise', seconds: 300, kph: 90 }, { kind: 'ramp', toKph: 0, mps2: 2.5 }, { kind: 'stop', seconds: 12 * 60 }]), {
      ...nothingAround,
      surroundings: { buildings: 1, residential: false, restStop: true },
    });
    expect(r.actions).toEqual([]);
  });

  it('parked and walked off (trailhead): never asks', () => {
    const r = runCheckIn(drive([{ kind: 'ramp', toKph: 90, mps2: 2 }, { kind: 'cruise', seconds: 300, kph: 90 }, { kind: 'ramp', toKph: 0, mps2: 2.5 }, { kind: 'stop', seconds: 60 }, { kind: 'walk', seconds: 10 * 60 }]), nothingAround);
    expect(r.actions).toEqual([]);
  });

  it('crash-like spike, then no movement: the pipeline crash event makes it ask within a minute', () => {
    const d = drive([{ kind: 'ramp', toKph: 80, mps2: 2 }, { kind: 'cruise', seconds: 200, kph: 80 }, { kind: 'ramp', toKph: 0, mps2: 9 }, { kind: 'stop', seconds: 6 * 60 }]);
    const brakeAt = d.locations.findLast((l) => (l.speed ?? 0) > 20)!.t;
    const imu = imuWithSpike(T0, d.locations[d.locations.length - 1]!.t, brakeAt + 500, 45);
    const r = runCheckIn(d, { ...nothingAround, surroundings: { buildings: 3, residential: true, restStop: false } }, { waitMin: 15, imu });
    expect(r.crashes).toHaveLength(1);
    expect(kinds(r)).toEqual(['ask', 'alert']);
    const ask = r.actions[0]!;
    expect(ask.kind === 'ask' && ask.stop.crash).toBe(true);
    expect(ask.t - brakeAt).toBeLessThanOrEqual((CHECK_IN.crash.waitS + 5) * 1000);
  });
});
