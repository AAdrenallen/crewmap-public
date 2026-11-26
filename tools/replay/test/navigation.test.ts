import { describe, expect, it } from 'vitest';
import { destination, pointAlong } from '@crewmap/shared/geo';
import { parseMapboxRoute, RouteProgress, type ProgressState } from '@crewmap/shared/navigation';
import { highwayRampRoute, twoTurnsRoute } from '../src/mapboxFixture';
import { PLACES, T0 } from '../src/fixtures';

function drive(route: ReturnType<typeof parseMapboxRoute>, kph: number, opts: { offsetAt?: [number, number, number] } = {}) {
  const prog = new RouteProgress(route);
  const v = kph / 3.6;
  const states: ProgressState[] = [];
  const total = route.cum[route.cum.length - 1]!;
  let t = T0;
  for (let s = 0; s <= total + 10; s += v) {
    let p = pointAlong(route.geometry, route.cum, s);
    if (opts.offsetAt && s >= opts.offsetAt[0] && s <= opts.offsetAt[1]) p = destination(p, 0, opts.offsetAt[2]);
    const st = prog.update({ t, lat: p.lat, lng: p.lng, speed: v, heading: null, accuracy: 5 });
    if (st.shouldReroute) prog.markRerouted(t);
    states.push(st);
    t += 1000;
  }
  return { states, prog };
}

describe('F11 dual-turn guidance (replay, two turns 150 m apart)', () => {
  const route = parseMapboxRoute(twoTurnsRoute(PLACES.valClair).routes[0]!, 'r1');

  it('shows next + following maneuver and emphasises the close one', () => {
    const { states } = drive(route, 50);
    const early = states[5]!;
    expect(early.next?.step.name).toBe('Rue Érable');
    expect(early.next?.step.maneuver.modifier).toBe('right');
    expect(early.following?.step.name).toBe('Avenue Cedar');
    expect(early.following?.gapM).toBeCloseTo(150, -1);
    expect(early.following?.emphasized).toBe(true);
    expect(early.following!.distanceM - early.next!.distanceM).toBeCloseTo(150, -1);
    // Lanes come with the banner.
    expect(early.next?.lanes?.find((l) => l.active)?.directions).toEqual(['right']);
    // After the first turn, the next maneuver is the left onto Cedar.
    const after = states.find((s) => s.stepIndex === 1)!;
    expect(after.next?.step.name).toBe('Avenue Cedar');
  });

  it('voice says "then…" for the close following turn, each announcement once', () => {
    const { states } = drive(route, 50);
    const spoken = states.flatMap((s) => s.speak);
    const closest = spoken.filter((s) => s.startsWith('Turn right onto Rue Érable'));
    expect(closest).toHaveLength(1);
    expect(closest[0]).toMatch(/then Avenue Cedar/);
    expect(spoken.filter((s) => s.startsWith('In 400 metres, Turn right'))).toHaveLength(1);
    expect(new Set(spoken).size).toBe(spoken.length);
  });

  it('arrives and reports speed limit + ETA', () => {
    const { states } = drive(route, 50);
    expect(states[3]!.limitKph).toBe(50);
    expect(states.find((s) => s.stepIndex === 1)!.limitKph).toBe(40);
    expect(states[0]!.remainingS).toBeGreaterThan(100);
    expect(states[states.length - 1]!.arrived).toBe(true);
  });
});

describe('F4a reroute', () => {
  const route = parseMapboxRoute(twoTurnsRoute(PLACES.valClair).routes[0]!, 'r1');
  it('flags off-route after 5 s more than 40 m away, with backoff, and never on route', () => {
    const { states } = drive(route, 50);
    expect(states.some((s) => s.offRoute)).toBe(false);
    const off = drive(route, 50, { offsetAt: [300, 700, 120] }).states;
    const firstOff = off.findIndex((s) => s.offRoute);
    expect(firstOff).toBeGreaterThan(0);
    const reqs = off.map((s, i) => (s.shouldReroute ? i : -1)).filter((i) => i >= 0);
    expect(reqs[0]).toBe(firstOff);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]! - reqs[i - 1]!).toBeGreaterThanOrEqual(10);
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    // Back on route → clears.
    expect(off[off.length - 1]!.offRoute).toBe(false);
  });
});

describe('F10 upcoming ramp highlight', () => {
  it('exposes the off-ramp geometry within 2 km, then clears after it', () => {
    const route = parseMapboxRoute(highwayRampRoute(PLACES.a15OnRamp).routes[0]!, 'r2');
    expect(route.steps[1]!.isRamp).toBe(true);
    expect(route.steps[0]!.isRamp).toBe(false);
    const { states } = drive(route, 100);
    expect(states[0]!.upcomingRamp).toBeNull(); // 3 km away
    const near = states.find((s) => s.upcomingRamp !== null)!;
    expect(near.upcomingRamp!.distanceM).toBeLessThanOrEqual(2000);
    expect(near.upcomingRamp!.line.length).toBeGreaterThan(2);
    const onA640 = states.find((s) => s.stepIndex === 2)!;
    expect(onA640.upcomingRamp).toBeNull();
  });
});
