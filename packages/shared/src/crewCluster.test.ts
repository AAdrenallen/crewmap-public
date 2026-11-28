import { describe, expect, it } from 'vitest';
import { CLUSTER, boundsOf, clusterByPixels, clusterCrew, clusterTap, fitZoom, isSameSpot, spreadM } from './crewCluster';
import { POSE_ACTIONS, POSE_MAX, POSE_MIN, pickGroupPose, posesFor } from './groupPoses';

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
  it('clusterCrew keeps same-spot crewmates together even when zoomed in past pixel overlap', () => {
    const g = clusterCrew([
      { id: 'a', x: 50, y: 200, lat: P.lat, lng: P.lng },
      { id: 'b', x: 260, y: 200, lat: P.lat + 0.0002, lng: P.lng }, // ~22 m apart
      { id: 'c', x: 350, y: 500, lat: P.lat + 0.01, lng: P.lng },
    ]);
    expect(g).toEqual([['a', 'b'], ['c']]);
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
  it('offers 500+ distinct non-stacking compositions for every count 2..8', () => {
    for (let n = POSE_MIN; n <= POSE_MAX; n++) {
      const list = posesFor(n);
      expect(list.length).toBeGreaterThanOrEqual(500);
      expect(new Set(list.map((p) => JSON.stringify(p.slots))).size).toBe(list.length);
      expect(new Set(list.map((p) => p.name)).size).toBe(list.length);
      let minPairDist = Infinity;
      let validSlots = true;
      for (const p of list) {
        if (p.slots.length !== n) validSlots = false;
        for (let i = 0; i < p.slots.length; i++) {
          const s = p.slots[i]!;
          if (
            (s.frame !== 0 && s.frame !== 1 && s.frame !== 2) ||
            s.action < 0 ||
            s.action >= POSE_ACTIONS ||
            s.heading < 0 ||
            s.heading >= 16 ||
            Math.abs(s.x) > 1 ||
            Math.abs(s.y) > 1
          ) {
            validSlots = false;
          }
          for (let j = i + 1; j < p.slots.length; j++) {
            const o = p.slots[j]!;
            const d = Math.hypot(s.x - o.x, s.y - o.y);
            if (d < minPairDist) minPairDist = d;
          }
        }
      }
      expect(validSlots).toBe(true);
      expect(minPairDist).toBeGreaterThan(0.15);
    }
  });
  it('selection is order-independent and rotates cleanly across open seeds', () => {
    const a = pickGroupPose(['zed', 'amy', 'bo'], 7);
    const b = pickGroupPose(['bo', 'zed', 'amy'], 7);
    expect(a).toEqual(b);
    expect([...a.members].sort()).toEqual(['amy', 'bo', 'zed']);
    expect(a.pose.slots).toHaveLength(3);
    const acrossSeeds = new Set(Array.from({ length: 30 }, (_, s) => pickGroupPose(['amy', 'bo'], s + 1).pose.name));
    expect(acrossSeeds.size).toBeGreaterThan(15);
  });
});
