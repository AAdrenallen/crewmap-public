import { describe, expect, it } from 'vitest';
import { cumulativeDistances, destination, type LatLng } from '../src/geo';
import { curveAdvisories, nextAdvisory } from '../src/navigation/advisory';

/** Straight `a` m north, then an arc of `deg` (positive = right) with radius `r`, then straight `b` m. */
function road(a: number, r: number, deg: number, b: number): LatLng[] {
  const pts: LatLng[] = [{ lat: 45.65, lng: -74.33 }];
  let p = pts[0]!;
  let hdg = 0;
  for (let s = 10; s <= a; s += 10) pts.push((p = destination(p, hdg, 10)));
  const stepDeg = 2;
  const segLen = (r * Math.PI * stepDeg) / 180;
  for (let t = 0; t < Math.abs(deg); t += stepDeg) {
    hdg += Math.sign(deg) * stepDeg;
    pts.push((p = destination(p, hdg, segLen)));
  }
  for (let s = 10; s <= b; s += 10) pts.push((p = destination(p, hdg, 10)));
  return pts;
}

function route(geometry: LatLng[], limit: number | null, stepAlongs: number[] = []) {
  const cum = cumulativeDistances(geometry);
  return { geometry, cum, maxspeedKph: geometry.slice(1).map(() => limit), steps: [{ startAlongM: 0 }, ...stepAlongs.map((s) => ({ startAlongM: s }))] };
}

describe('curve advisories', () => {
  it('a 60 m radius right bend on a 70 road gets a 30 km/h panel', () => {
    const r = route(road(500, 60, 90, 500), 70);
    const adv = curveAdvisories(r);
    expect(adv).toHaveLength(1);
    expect(adv[0]!.speedKph).toBe(30);
    expect(adv[0]!.side).toBe('right');
    expect(adv[0]!.sharp).toBe(true);
    expect(adv[0]!.startAlongM).toBeGreaterThan(400);
    expect(adv[0]!.startAlongM).toBeLessThan(520);
  });

  it('left bend of 150 m radius on a 90 road: 50 km/h, not sharp', () => {
    const adv = curveAdvisories(route(road(500, 150, -60, 500), 90));
    expect(adv).toHaveLength(1);
    expect(adv[0]!.speedKph).toBe(60);
    expect(adv[0]!.side).toBe('left');
    expect(adv[0]!.sharp).toBe(false);
  });

  it('gentle highway curves and slow streets produce nothing', () => {
    expect(curveAdvisories(route(road(500, 900, 40, 500), 100))).toHaveLength(0);
    expect(curveAdvisories(route(road(300, 60, 90, 300), 30))).toHaveLength(0);
  });

  it('turns at intersections (maneuver points) are not advisories', () => {
    const g = road(500, 15, 90, 500);
    expect(curveAdvisories(route(g, 50, [505]))).toHaveLength(0);
  });

  it('nextAdvisory shows within the lookahead and until the bend ends', () => {
    const adv = curveAdvisories(route(road(1000, 60, 90, 500), 70));
    const a = adv[0]!;
    expect(nextAdvisory(adv, a.startAlongM - 600)).toBeNull();
    expect(nextAdvisory(adv, a.startAlongM - 300)).toBe(a);
    expect(nextAdvisory(adv, (a.startAlongM + a.endAlongM) / 2)).toBe(a);
    expect(nextAdvisory(adv, a.endAlongM + 1)).toBeNull();
  });
});
