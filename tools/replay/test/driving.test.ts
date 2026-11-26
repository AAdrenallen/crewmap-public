import { describe, expect, it } from 'vitest';
import { markPassenger, tripScore } from '@crewmap/shared/driving';
import { hardBrakeDrive, highwayDrive, sharpTurnDrive, speedingDrive, T0, walk } from '../src/fixtures';
import { runDrive } from '../src/runDrive';
import { imuWithSpike, touchesBetween } from '../src/synth';

describe('F1a trip auto start/stop (replay)', () => {
  it('highway drive produces exactly one trip, back-dated to when movement began', () => {
    const d = highwayDrive();
    const r = runDrive(d);
    expect(r.trips).toHaveLength(1);
    const trip = r.trips[0]!;
    const firstMoving = d.locations.find((l) => (l.speed ?? 0) > 1.5)!.t;
    expect(Math.abs(trip.startedAt - firstMoving)).toBeLessThanOrEqual(2000);
    expect(trip.distanceM).toBeGreaterThan(9_000);
    expect(trip.topSpeedKph).toBe(100);
    expect(trip.durationS).toBeGreaterThan(400);
    expect(trip.durationS).toBeLessThan(600);
    // Ends when the car stops, not 3 minutes later.
    const stoppedAt = d.locations.findLast((l) => (l.speed ?? 0) >= 1.5)!.t;
    expect(trip.endedAt).toBe(stoppedAt);
    expect(trip.events.filter((e) => e.kind === 'hardBrake')).toHaveLength(0);
    expect(trip.score).toBe(100);
  });

  it('a walk never becomes a trip', () => {
    expect(runDrive(walk()).trips).toHaveLength(0);
    expect(runDrive(walk()).startedAt).toHaveLength(0);
  });
});

describe('F1c risky events (fixtures)', () => {
  it('detects the hard brake once, as severe, and nothing else', () => {
    const r = runDrive(hardBrakeDrive());
    expect(r.trips).toHaveLength(1);
    const ev = r.trips[0]!.events;
    const brakes = ev.filter((e) => e.kind === 'hardBrake');
    expect(brakes).toHaveLength(1);
    expect(brakes[0]!.value).toBeLessThanOrEqual(-3.4);
    expect(brakes[0]!.severity).toBe(1);
    expect(ev.filter((e) => e.kind === 'rapidAccel')).toHaveLength(0);
    expect(r.trips[0]!.score!).toBeLessThan(100);
  });

  it('grades two speeding episodes by km/h over and duration', () => {
    const r = runDrive(speedingDrive());
    const sp = r.trips[0]!.events.filter((e) => e.kind === 'speeding');
    expect(sp).toHaveLength(2);
    expect(sp[0]!.value).toBe(22);
    expect(sp[0]!.severity).toBe(1);
    expect((sp[0]!.tEnd! - sp[0]!.t) / 1000).toBeGreaterThanOrEqual(40);
    expect(sp[1]!.value).toBe(38);
    expect(sp[1]!.severity).toBe(2);
    expect(sp[1]!.limitKph).toBe(70);
  });

  it('detects phone handling above walking speed, and passenger override removes the trip from scoring', () => {
    const d = hardBrakeDrive();
    const r = runDrive(d, { touches: touchesBetween(T0 + 60_000, T0 + 75_000) });
    const trip = r.trips[0]!;
    const ph = trip.events.filter((e) => e.kind === 'phoneHandling');
    expect(ph).toHaveLength(1);
    expect(ph[0]!.value).toBe(15);
    expect(ph[0]!.severity).toBe(1);
    const asPassenger = markPassenger(trip, true);
    expect(asPassenger.score).toBeNull();
    expect(markPassenger(asPassenger, false).score).toBe(trip.score);
  });

  it('ignores touches while parked', () => {
    const d = hardBrakeDrive();
    const end = d.locations[d.locations.length - 1]!.t;
    const r = runDrive(d, { touches: touchesBetween(end - 100_000, end - 80_000) });
    expect(r.trips[0]!.events.filter((e) => e.kind === 'phoneHandling')).toHaveLength(0);
  });

  it('flags late-night driving', () => {
    const r = runDrive(highwayDrive(), { localHour: () => 2 });
    const ln = r.trips[0]!.events.filter((e) => e.kind === 'lateNight');
    expect(ln).toHaveLength(1);
    expect(ln[0]!.value).toBeGreaterThanOrEqual(5);
  });

  it('confirms a crash spike only when the car stops right after, and the score ignores it', () => {
    const d = hardBrakeDrive();
    // Spike while cruising at 50 km/h, car keeps going → not a crash.
    const brakeAt = T0 + 125_000;
    const noCrash = runDrive(d, { imu: imuWithSpike(T0, T0 + 400_000, brakeAt, 45) });
    expect(noCrash.trips[0]!.events.filter((e) => e.kind === 'crash')).toHaveLength(0);
    // Spike right before the final stop → crash.
    const stopAt = d.locations.findLast((l) => (l.speed ?? 0) >= 5)!.t;
    const crash = runDrive(d, { imu: imuWithSpike(T0, T0 + 400_000, stopAt, 45) });
    const c = crash.trips[0]!.events.filter((e) => e.kind === 'crash');
    expect(c).toHaveLength(1);
    const withoutCrash = crash.trips[0]!.events.filter((e) => e.kind !== 'crash');
    expect(crash.trips[0]!.score).toBe(tripScore(withoutCrash, crash.trips[0]!.distanceM, false));
  });
});

describe('F1c harsh cornering', () => {
  it('detects one severe cornering event in a tight turn, none on straights', () => {
    const r = runDrive(sharpTurnDrive());
    const c = r.trips[0]!.events.filter((e) => e.kind === 'cornering');
    expect(c).toHaveLength(1);
    expect(c[0]!.value).toBeGreaterThan(4);
    expect(c[0]!.severity).toBe(2);
    expect(runDrive(hardBrakeDrive()).trips[0]!.events.filter((e) => e.kind === 'cornering')).toHaveLength(0);
  });
});
