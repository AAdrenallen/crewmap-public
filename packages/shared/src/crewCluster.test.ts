import { describe, expect, it } from 'vitest';
import { CLUSTER, boundsOf, clusterByPixels, clusterTap, fitZoom, isSameSpot, spreadM } from './crewCluster';
import { POSE_MAX, POSE_MIN, pickGroupPose, posesFor } from './groupPoses';

// Public landmark: around the Eiffel Tower.
const P = { lat: 48.8584, lng: 2.2945 };
const off = (dLat: number, dLng: number) => ({ lat: P.lat + dLat, lng: P.lng + dLng });

describe('clusterByPixels', () => {
  it('merges overlapping markers transitively and keeps singles', () => {
    const g = clusterByPixels(
      [
        { id: 'c', x: 100, y: 100 },
        { id: 'a', x: 130, y: 100 },
        { id: 'b', x: 170, y: 100 },
        { id: 'd', x: 400, y: 400 },
        { id: 'e', x: NaN, y: 0 },
      ],
      CLUSTER.overlapPx,
    );
    expect(g).toEqual([['a', 'b', 'c'], ['d']]);
  });
  it('splits when far apart', () => {
    expect(clusterByPixels([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }], 52)).toEqual([['a'], ['b']]);
  });
});

describe('same spot', () => {
  it('uses the metre threshold', () => {
    expect(isSameSpot([P, off(0.00005, 0)])).toBe(true); // ~5.6 m
    expect(isSameSpot([P, off(0.001, 0)])).toBe(false); // ~111 m
    expect(isSameSpot([P])).toBe(false);
    expect(spreadM([P, off(0.0001, 0)])).toBeCloseTo(11.1, 0);
  });
});

describe('clusterTap', () => {
  const view = { width: 400, height: 800 };
  it('lists at max zoom', () => {
    expect(clusterTap([P, off(0.01, 0)], CLUSTER.maxZoom, view).kind).toBe('list');
  });
  it('fits members inside the padded view, capped at max zoom', () => {
    const pts = [P, off(0.01, 0.01)];
    const t = clusterTap(pts, 12, view);
    expect(t.kind).toBe('zoom');
    if (t.kind !== 'zoom') return;
    expect(t.zoom).toBeLessThan(CLUSTER.maxZoom);
    expect(t.zoom).toBeCloseTo(fitZoom(boundsOf(pts)!, 400, 800, CLUSTER.fitPadding), 6);
    const same = clusterTap([P, off(0.00002, 0)], 12, view);
    expect(same.kind === 'zoom' && same.zoom).toBe(CLUSTER.maxZoom);
  });
  it('fitZoom shrinks as bounds grow', () => {
    const z1 = fitZoom(boundsOf([P, off(0.01, 0.01)])!, 400, 800, [0, 0, 0, 0]);
    const z2 = fitZoom(boundsOf([P, off(0.02, 0.02)])!, 400, 800, [0, 0, 0, 0]);
    expect(z1 - z2).toBeCloseTo(1, 1);
  });
});

describe('group poses', () => {
  it('offers 100+ distinct compositions for every count 2..8', () => {
    for (let n = POSE_MIN; n <= POSE_MAX; n++) {
      const list = posesFor(n);
      expect(list.length).toBeGreaterThanOrEqual(100);
      expect(new Set(list.map((p) => JSON.stringify(p.slots))).size).toBe(list.length);
      expect(new Set(list.map((p) => p.name)).size).toBe(list.length);
      for (const p of list) {
        expect(p.slots).toHaveLength(n);
        for (const s of p.slots) {
          expect([0, 1, 2]).toContain(s.frame);
          expect(s.heading).toBeGreaterThanOrEqual(0);
          expect(s.heading).toBeLessThan(16);
          expect(Math.abs(s.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(s.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
  it('selection is stable and order-independent', () => {
    const a = pickGroupPose(['zed', 'amy', 'bo']);
    const b = pickGroupPose(['bo', 'zed', 'amy']);
    expect(a).toEqual(b);
    expect([...a.members].sort()).toEqual(['amy', 'bo', 'zed']);
    expect(a.pose.slots).toHaveLength(3);
    const names = new Set(Array.from({ length: 40 }, (_, i) => pickGroupPose([`u${i}`, `v${i}`]).pose.name));
    expect(names.size).toBeGreaterThan(10);
  });
});
