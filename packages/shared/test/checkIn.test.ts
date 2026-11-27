import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { destination, type LatLng } from '../src/geo';
import type { LocationSample } from '../src/driving/types';
import {
  assessStop,
  CHECK_IN,
  CheckInMonitor,
  checkInWaitS,
  looksLikeJam,
  okCellKey,
  parseSurroundings,
  surroundingsQuery,
  type CheckInAction,
  type KnownPlace,
  type StopContext,
  type StopVerdict,
} from '../src/safety';

interface Scenario {
  name: string;
  at: LatLng;
  approach: 'cruise' | 'crawl';
  kph: number;
  places: KnownPlace[];
  overpass: unknown;
  expect: StopVerdict;
}
const FIX = JSON.parse(readFileSync(new URL('./fixtures/check-in-stops.json', import.meta.url), 'utf8')) as { scenarios: Scenario[] };

const T0 = Date.UTC(2026, 6, 4, 18, 0, 0);

/** A drive that ends at `at`: 5 min on the approach, then `stopS` stopped there, one fix per second. */
function drive(at: LatLng, approach: 'cruise' | 'crawl', kph: number, stopS: number): LocationSample[] {
  const out: LocationSample[] = [];
  const v = kph / 3.6;
  // Cruise until 3 min before the stop, then either a 20 s pull-over or a 3 min crawl with stop-and-go.
  const profile: number[] = [];
  for (let i = 0; i < 120; i++) profile.push(v);
  if (approach === 'cruise') {
    for (let i = 0; i < 160; i++) profile.push(v);
    for (let i = 1; i <= 20; i++) profile.push(v * (1 - i / 20));
  } else {
    for (let i = 0; i < 180; i++) profile.push(i % 40 < 25 ? 1.8 : 0);
  }
  let along = profile.reduce((s, x) => s + x, 0);
  let t = T0;
  for (const s of profile) {
    along -= s;
    out.push({ t, ...destination(at, 270, along), speed: s, heading: 90, accuracy: 6 });
    t += 1000;
  }
  for (let i = 0; i < stopS; i++) {
    out.push({ t, ...at, speed: 0, heading: null, accuracy: 6 });
    t += 1000;
  }
  return out;
}

const ctxOf = (s: Scenario): StopContext => ({
  places: s.places,
  navDest: null,
  knownStopS: null,
  okBefore: false,
  trafficNearby: false,
  poisNearby: 0,
  surroundings: s.overpass ? parseSurroundings(s.overpass) : null,
});

const sinceOf = (a: CheckInAction | undefined): number => (a && a.kind !== 'dismiss' ? a.stop.since : Number.NaN);

function run(fixes: LocationSample[], ctx: StopContext, waitMin = 5, extra: { answerAt?: number; crashAt?: number } = {}) {
  const m = new CheckInMonitor(waitMin);
  const acts: (CheckInAction & { t: number })[] = [];
  for (const f of fixes) {
    if (extra.crashAt !== undefined && f.t === extra.crashAt) m.crash(f.t);
    for (const a of m.fix(f)) acts.push({ ...a, t: f.t });
    if (extra.answerAt !== undefined && f.t === extra.answerAt) for (const a of m.answer(f.t)) acts.push({ ...a, t: f.t });
    for (const a of m.tick(f.t, (s) => assessStop(s, ctx))) acts.push({ ...a, t: f.t });
  }
  return { m, acts };
}

describe('check-in fixtures (D66)', () => {
  for (const s of FIX.scenarios) {
    it(s.name, () => {
      const fixes = drive(s.at, s.approach, s.kph, 12 * 60);
      const { acts } = run(fixes, ctxOf(s));
      if (s.expect.ask) {
        const stoppedAt = sinceOf(acts[0]);
        expect(acts.map((a) => a.kind)).toEqual(['ask', 'alert']);
        expect(acts[0]!.t - stoppedAt).toBe(5 * 60_000);
        expect(acts[1]!.t - acts[0]!.t).toBe(CHECK_IN.graceS * 1000);
      } else {
        expect(acts).toEqual([]);
      }
    });
    it(`${s.name}: verdict`, () => {
      const fixes = drive(s.at, s.approach, s.kph, 400);
      const m = new CheckInMonitor(5);
      let verdict: StopVerdict | null = null;
      for (const f of fixes) {
        m.fix(f);
        m.tick(f.t, (st) => (verdict = assessStop(st, ctxOf(s))));
      }
      expect(verdict).toEqual(s.expect);
    });
  }
});

const remote = FIX.scenarios[0]!;

describe('check-in monitor', () => {
  it('asks only after the chosen wait (5 / 10 / 15 min)', () => {
    for (const min of CHECK_IN.waitChoicesMin) {
      const fixes = drive(remote.at, 'cruise', 90, (min + 4) * 60);
      const { acts } = run(fixes, ctxOf(remote), min);
      const stoppedAt = sinceOf(acts[0]);
      expect(acts[0]?.kind).toBe('ask');
      expect(acts[0]!.t - stoppedAt).toBe(min * 60_000);
    }
  });

  it('an answer before the grace period ends means nobody is told', () => {
    const fixes = drive(remote.at, 'cruise', 90, 12 * 60);
    const stoppedAt = fixes.find((f) => f.speed === 0)!.t;
    const { acts } = run(fixes, ctxOf(remote), 5, { answerAt: stoppedAt + 6 * 60_000 });
    expect(acts.map((a) => [a.kind, 'how' in a ? a.how : null])).toEqual([['ask', null], ['dismiss', 'ok']]);
  });

  it('a late answer after the alert resolves it for the crew', () => {
    const fixes = drive(remote.at, 'cruise', 90, 12 * 60);
    const stoppedAt = fixes.find((f) => f.speed === 0)!.t;
    const { acts } = run(fixes, ctxOf(remote), 5, { answerAt: stoppedAt + 10 * 60_000 });
    expect(acts.map((a) => a.kind)).toEqual(['ask', 'alert', 'resolve']);
  });

  it('driving off after the alert resolves it; driving off before clears the prompt', () => {
    const base = drive(remote.at, 'cruise', 90, 9 * 60);
    const last = base[base.length - 1]!;
    const away = (dt: number): LocationSample => ({ t: last.t + dt, ...destination(remote.at, 90, 300), speed: 15, heading: 90, accuracy: 6 });
    const after = run([...base, away(1000)], ctxOf(remote)).acts;
    expect(after.map((a) => a.kind)).toEqual(['ask', 'alert', 'resolve']);
    const early = drive(remote.at, 'cruise', 90, 6 * 60);
    const e = early[early.length - 1]!;
    const before = run([...early, { ...e, t: e.t + 1000, ...destination(remote.at, 90, 300), speed: 15 }], ctxOf(remote)).acts;
    expect(before.map((a) => a.kind)).toEqual(['ask', 'dismiss']);
  });

  it('GPS drift inside the stop does not restart it', () => {
    const fixes = drive(remote.at, 'cruise', 90, 8 * 60).map((f, i) =>
      f.speed === 0 ? { ...f, ...destination(remote.at, (i * 37) % 360, 15), speed: i % 7 === 0 ? 0.8 : 0 } : f,
    );
    expect(run(fixes, ctxOf(remote)).acts[0]?.kind).toBe('ask');
  });

  it('walking away from the car cancels a pending stop', () => {
    const fixes = drive(remote.at, 'cruise', 90, 6 * 60);
    const m = new CheckInMonitor(5);
    const acts: CheckInAction[] = [];
    for (const f of fixes) {
      acts.push(...m.fix(f));
      if (f.t === fixes[fixes.length - 1]!.t) acts.push(...m.walking(f.t));
      acts.push(...m.tick(f.t, (s) => assessStop(s, ctxOf(remote))));
    }
    expect(acts.map((a) => a.kind)).toEqual(['ask', 'dismiss']);
    expect(m.snapshot().phase).toBe('none');
  });

  it('a parked phone that never travelled is never asked', () => {
    const fixes = drive(remote.at, 'cruise', 90, 20 * 60).filter((f) => f.speed === 0);
    expect(run(fixes, ctxOf(remote)).acts).toEqual([]);
  });

  it('a crash-like spike then no movement asks sooner, even at home', () => {
    const home = FIX.scenarios[2]!;
    const fixes = drive(home.at, 'cruise', 40, 6 * 60);
    const firstStill = fixes.find((f) => f.speed === 0)!.t;
    const { acts } = run(fixes, ctxOf(home), 15, { crashAt: firstStill + 3000 });
    expect(acts.map((a) => a.kind)).toEqual(['ask', 'alert']);
    const stoppedAt = sinceOf(acts[0]);
    expect(acts[0]!.t - stoppedAt).toBe(CHECK_IN.crash.waitS * 1000);
    expect(acts[1]!.t - acts[0]!.t).toBe(CHECK_IN.crash.graceS * 1000);
    expect(acts[0]!.kind === 'ask' && acts[0]!.stop.crash).toBe(true);
  });

  it('"I\'m OK" on the crash notice before the ask: nobody is asked or told', () => {
    const fixes = drive(remote.at, 'cruise', 90, 6 * 60);
    const firstStill = fixes.find((f) => f.speed === 0)!.t;
    const { acts } = run(fixes, ctxOf(remote), 5, { crashAt: firstStill + 2000, answerAt: firstStill + 10_000 });
    expect(acts.map((a) => [a.kind, 'how' in a ? a.how : null])).toEqual([['dismiss', 'ok']]);
  });

  it('reports the candidate stop once it is old enough for a surroundings lookup', () => {
    const fixes = drive(remote.at, 'cruise', 90, 120);
    const m = new CheckInMonitor(5);
    for (const f of fixes) m.fix(f);
    const stop = m.snapshot().stop!;
    expect(m.candidate(stop.since + 60_000)).toBeNull();
    expect(m.candidate(stop.since + CHECK_IN.contextAtS * 1000)).toEqual(stop);
    expect(m.dueAt()).toBe(stop.since + 5 * 60_000);
  });
});

describe('stop assessment', () => {
  const stop = { ...remote.at, since: T0, acc: 6, crash: false, approach: [] };
  const ctx = ctxOf(remote);
  it('remote spot with nothing around asks; unknown surroundings still ask', () => {
    expect(assessStop(stop, ctx)).toEqual({ ask: true, reason: 'remote' });
    expect(assessStop(stop, { ...ctx, surroundings: null })).toEqual({ ask: true, reason: 'unknown' });
  });
  it('excludes saved places, navigation destination, known stops, OK-before, traffic, cached POIs, houses', () => {
    expect(assessStop(stop, { ...ctx, places: [{ ...destination(stop, 0, 150), radiusM: 100, home: false }] }).reason).toBe('place');
    expect(assessStop(stop, { ...ctx, places: [{ ...destination(stop, 0, 900), radiusM: 50, home: true }] }).reason).toBe('home');
    expect(assessStop(stop, { ...ctx, places: [{ ...destination(stop, 0, 1500), radiusM: 50, home: true }] }).ask).toBe(true);
    expect(assessStop(stop, { ...ctx, navDest: destination(stop, 0, 200) }).reason).toBe('navDest');
    expect(assessStop(stop, { ...ctx, knownStopS: 40 }).reason).toBe('knownStop');
    expect(assessStop(stop, { ...ctx, okBefore: true }).reason).toBe('okBefore');
    expect(assessStop(stop, { ...ctx, trafficNearby: true }).reason).toBe('jam');
    expect(assessStop(stop, { ...ctx, poisNearby: 1 }).reason).toBe('restStop');
    expect(assessStop(stop, { ...ctx, surroundings: { buildings: 2, residential: false, restStop: false } }).reason).toBe('settled');
    expect(assessStop(stop, { ...ctx, surroundings: { buildings: 0, residential: true, restStop: false } }).reason).toBe('settled');
  });
  it('jam test needs a crawl over the window, not a quick pull-over', () => {
    const cruise = drive(remote.at, 'cruise', 90, 1);
    const crawl = drive(remote.at, 'crawl', 90, 1);
    const at = (fs: LocationSample[]) => ({ ...stop, since: fs[fs.length - 1]!.t, approach: fs });
    expect(looksLikeJam(at(cruise))).toBe(false);
    expect(looksLikeJam(at(crawl))).toBe(true);
  });
});

describe('surroundings lookup and tunables', () => {
  it('query is three counts around the stop', () => {
    const q = surroundingsQuery(remote.at);
    expect(q.match(/out count;/g)).toHaveLength(3);
    expect(q).toContain(`around:${CHECK_IN.surroundingsM},47.10320,-76.94310`);
    expect(q).toContain('[building]');
    expect(q).toContain('rest_area|services');
  });
  it('parses counts; anything else is unknown', () => {
    expect(parseSurroundings(FIX.scenarios[1]!.overpass)).toEqual({ buildings: 2, residential: false, restStop: true });
    expect(parseSurroundings({ elements: [] })).toBeNull();
    expect(parseSurroundings({ remark: 'runtime error' })).toBeNull();
  });
  it('wait clamps to the offered choices; crash uses its own wait', () => {
    expect(CHECK_IN.waitChoicesMin).toEqual([5, 10, 15]);
    expect(CHECK_IN.waitChoicesMin[0]).toBe(CHECK_IN.defaultWaitMin);
    expect(checkInWaitS(10, false)).toBe(600);
    expect(checkInWaitS(1, false)).toBe(300);
    expect(checkInWaitS(60, false)).toBe(900);
    expect(checkInWaitS(Number.NaN, false)).toBe(300);
    expect(checkInWaitS(15, true)).toBe(CHECK_IN.crash.waitS);
    expect(CHECK_IN.graceS).toBeGreaterThanOrEqual(120);
    expect(CHECK_IN.crash.waitS).toBeLessThan(CHECK_IN.defaultWaitMin * 60);
    expect(CHECK_IN.leaveM).toBeGreaterThan(CHECK_IN.stopRadiusM);
  });
  it('OK memory is keyed on a coarse cell', () => {
    expect(okCellKey(remote.at)).toBe(okCellKey(destination(remote.at, 45, 20)));
    expect(okCellKey(remote.at)).not.toBe(okCellKey(destination(remote.at, 45, 2000)));
  });
});
