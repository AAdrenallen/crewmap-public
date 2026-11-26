import { describe, expect, it } from 'vitest';
import { LocationRequestGate, ProfileGovernor } from './gate';

const opts = (interval: number) => ({ accuracy: 1, timeInterval: interval, foregroundService: { notificationTitle: 'a', notificationBody: 'b' } });

describe('LocationRequestGate', () => {
  it('starts once for repeated identical options', () => {
    const g = new LocationRequestGate();
    let starts = 0;
    for (let i = 0; i < 50; i++) {
      if (g.needsStart(opts(300_000), starts > 0)) {
        g.started(opts(300_000), i * 1000);
        starts++;
      }
    }
    expect(starts).toBe(1);
    expect(g.churn(50_000).starts).toBe(1);
  });

  it('ignores key order and restarts only on a real change or when the OS stopped it', () => {
    const g = new LocationRequestGate();
    g.started({ a: 1, b: { c: 2, d: 3 } }, 0);
    expect(g.needsStart({ b: { d: 3, c: 2 }, a: 1 }, true)).toBe(false);
    expect(g.needsStart({ a: 2, b: { c: 2, d: 3 } }, true)).toBe(true);
    expect(g.needsStart({ a: 1, b: { c: 2, d: 3 } }, false)).toBe(true);
  });

  it('counts starts and stops within the window', () => {
    const g = new LocationRequestGate();
    g.started(opts(1), 0);
    g.stopped(1000);
    g.started(opts(2), 2000);
    expect(g.churn(30_000)).toEqual({ starts: 2, stops: 1 });
    expect(g.churn(200_000)).toEqual({ starts: 0, stops: 0 });
  });
});

describe('ProfileGovernor', () => {
  it('never changes for repeated identical profiles', () => {
    const g = new ProfileGovernor();
    g.set('still', 0);
    for (let t = 0; t < 600_000; t += 2000) expect(g.propose('still', t).apply).toBeNull();
  });

  it('absorbs rapid still/walking flaps', () => {
    const g = new ProfileGovernor();
    g.set('still', 0);
    let changes = 0;
    for (let t = 0; t < 600_000; t += 3000) {
      if (g.propose(t % 6000 === 0 ? 'walking' : 'still', t).apply) changes++;
    }
    expect(changes).toBe(0);
  });

  it('applies a sustained walk after the dwell and min hold, and a downgrade after downMs', () => {
    const g = new ProfileGovernor({ upMs: 30_000, downMs: 60_000, minHoldMs: 60_000 });
    g.set('still', 0);
    const first = g.propose('walking', 100_000);
    expect(first.apply).toBeNull();
    expect(first.dueAt).toBe(130_000);
    expect(g.propose('walking', 129_000).apply).toBeNull();
    expect(g.propose('walking', 130_000).apply).toBe('walking');
    expect(g.propose('still', 140_000).apply).toBeNull();
    expect(g.propose('still', 199_000).apply).toBeNull();
    expect(g.propose('still', 200_000).apply).toBe('still');
  });

  it('applies driving and navigation at once', () => {
    const g = new ProfileGovernor();
    g.set('still', 0);
    expect(g.propose('driving', 1000).apply).toBe('driving');
    expect(g.propose('navigating', 2000).apply).toBe('navigating');
    expect(g.propose('driving', 3000).apply).toBe('driving');
    // Driving → still is a downgrade: held.
    expect(g.propose('still', 4000).apply).toBeNull();
  });
});
