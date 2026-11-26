import { describe, expect, it } from 'vitest';
import { haversineM, pointAlong } from '@crewmap/shared/geo';
import { MotionSmoother, type MotionFix, type MotionTrack } from '@crewmap/shared/motion';
import { parseMapboxRoute } from '@crewmap/shared/navigation';
import { hardBrakeDrive, highwayDrive, PLACES, sharpTurnDrive, speedingDrive, T0 } from '../src/fixtures';
import { twoTurnsRoute } from '../src/mapboxFixture';

/** Prediction error at each next fix's timestamp: hold-last-fix vs dead reckoning (moving pairs only). */
function errors(fixes: MotionFix[], track: MotionTrack | null = null) {
  const m = new MotionSmoother();
  m.setTrack(track);
  const hold: number[] = [];
  const dr: number[] = [];
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i]!;
    if (i > 0 && (fixes[i - 1]!.speed ?? 0) >= 1) {
      hold.push(haversineM(fixes[i - 1]!, f));
      dr.push(haversineM(m.predict(f.t)!, f));
    }
    m.push(f);
  }
  const stat = (a: number[]) => ({ mean: a.reduce((x, y) => x + y, 0) / a.length, max: Math.max(...a) });
  return { hold: stat(hold), dr: stat(dr) };
}

const asFixes = (d: { locations: { t: number; lat: number; lng: number; speed: number | null; heading: number | null }[] }): MotionFix[] =>
  d.locations.map((l) => ({ t: l.t, lat: l.lat, lng: l.lng, speed: l.speed, heading: l.heading }));

const fmt = (e: ReturnType<typeof errors>) =>
  `hold mean ${e.hold.mean.toFixed(2)} max ${e.hold.max.toFixed(2)} m → DR mean ${e.dr.mean.toFixed(2)} max ${e.dr.max.toFixed(2)} m`;

describe('dead reckoning on replay fixtures (1 Hz)', () => {
  for (const [name, mk] of [['highway', highwayDrive], ['hardBrake', hardBrakeDrive], ['speeding', speedingDrive], ['sharpTurn', sharpTurnDrive]] as const) {
    it(`${name}: predicts the next fix far better than holding the last one`, () => {
      const e = errors(asFixes(mk()));
      console.log(`[motion] ${name}: ${fmt(e)}`);
      expect(e.dr.mean).toBeLessThan(e.hold.mean * 0.35);
      expect(e.dr.max).toBeLessThan(e.hold.max);
    });
  }

  it('twoTurns route, heading-less fixes: route matching follows the turns', () => {
    const route = parseMapboxRoute(twoTurnsRoute(PLACES.valClair).routes[0]!, 'r');
    const v = 50 / 3.6;
    const fixes: MotionFix[] = [];
    for (let s = 0, i = 0; s <= route.cum.at(-1)!; s += v, i++) {
      const p = pointAlong(route.geometry, route.cum, s);
      fixes.push({ t: T0 + i * 1000, lat: p.lat, lng: p.lng, speed: v, heading: null });
    }
    const free = errors(fixes);
    const matched = errors(fixes, route);
    console.log(`[motion] twoTurns free: ${fmt(free)}`);
    console.log(`[motion] twoTurns matched: ${fmt(matched)}`);
    expect(matched.dr.max).toBeLessThan(1);
    expect(matched.dr.mean).toBeLessThan(free.dr.mean);
  });
});
