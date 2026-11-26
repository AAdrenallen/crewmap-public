import { describe, expect, it } from 'vitest';
import { cumulativeDistances, destination, pointAlong, polylineChunks, projectNearPolyline, projectOnPolyline, slicePolyline, type LatLng } from '../src/geo';

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wiggly(r: () => number, n: number): LatLng[] {
  const out: LatLng[] = [{ lat: 45.6, lng: -74.3 }];
  let b = 90;
  for (let i = 1; i < n; i++) {
    b += (r() - 0.5) * 40;
    // Some loops back over itself so several far-apart chunks contain the same point.
    if (i % 500 === 0) b += 170;
    out.push(destination(out[i - 1]!, b, 5 + r() * 20));
  }
  return out;
}

function sliceRef(line: LatLng[], cum: number[], startM: number, endM: number): LatLng[] {
  const out: LatLng[] = [pointAlong(line, cum, startM)];
  for (let i = 0; i < line.length; i++) if (cum[i]! > startM && cum[i]! < endM) out.push(line[i]!);
  out.push(pointAlong(line, cum, endM));
  return out;
}

describe('polyline index', () => {
  const r = rng(7);
  const line = wiggly(r, 3000);
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1]!;

  it('projectNearPolyline matches the full scan within the corridor', () => {
    const idx = polylineChunks(line, 40);
    for (let k = 0; k < 2000; k++) {
      const base = pointAlong(line, cum, r() * total);
      const p = destination(base, r() * 360, r() * 120);
      const full = projectOnPolyline(p, line, cum);
      const near = projectNearPolyline(p, line, cum, idx);
      if (full.distanceM <= 40) expect(near).toEqual(full);
      else expect(near).toBeNull();
    }
  });

  it('slicePolyline matches the reference scan', () => {
    for (let k = 0; k < 300; k++) {
      const a = r() * total * 1.1 - total * 0.05;
      const b = a + r() * 3000;
      expect(slicePolyline(line, cum, a, b)).toEqual(sliceRef(line, cum, a, b));
    }
    expect(slicePolyline(line, cum, cum[10]!, cum[20]!)).toEqual(sliceRef(line, cum, cum[10]!, cum[20]!));
  });
});
