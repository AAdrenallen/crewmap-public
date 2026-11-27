import { describe, expect, it } from 'vitest';
import { encodePolyline } from '../src/geo';
import { CANDIDATES, onMontrealIsland, parseMapboxRoute, roadPenaltyS } from '../src/navigation';

describe('right turn on red', () => {
  it('knows the island of Montréal from its neighbours', () => {
    expect(onMontrealIsland(45.558, -73.552)).toBe(true); // Olympic Stadium
    expect(onMontrealIsland(45.5017, -73.5673)).toBe(true); // downtown
    expect(onMontrealIsland(45.4706, -73.7408)).toBe(true); // Montréal–Trudeau airport
    expect(onMontrealIsland(45.57, -73.75)).toBe(false); // Laval
    expect(onMontrealIsland(45.531, -73.518)).toBe(false); // Longueuil
    expect(onMontrealIsland(46.8139, -71.208)).toBe(false); // Québec City
  });

  const routeAt = (loc: [number, number], signal: boolean, modifier: string) => {
    const pts = [0, 1, 2].map((i) => ({ lat: loc[1], lng: loc[0] + i * 0.001 }));
    const step = (type: string, mod: string | undefined, i: number, extra: object = {}) => ({
      distance: 80,
      duration: 8,
      name: '',
      geometry: '',
      maneuver: { type, modifier: mod, location: [pts[i]!.lng, pts[i]!.lat], bearing_after: 90, instruction: '' },
      intersections: [{ location: [pts[i]!.lng, pts[i]!.lat], geometry_index: i, ...extra }],
    });
    return parseMapboxRoute(
      {
        geometry: encodePolyline(pts, 6),
        distance: 160,
        duration: 16,
        legs: [{ steps: [step('depart', undefined, 0), step('turn', modifier, 1, signal ? { traffic_signal: true } : {}), step('arrive', undefined, 2)] as never }],
      },
      'x',
    );
  };

  it('counts signalised right turns on the island only', () => {
    expect(routeAt([-73.567, 45.501], true, 'right').controls!.noRedRightTurns).toBe(1);
    expect(routeAt([-73.567, 45.501], false, 'right').controls!.noRedRightTurns).toBe(0);
    expect(routeAt([-73.567, 45.501], true, 'left').controls!.noRedRightTurns).toBe(0);
    expect(routeAt([-73.518, 45.531], true, 'right').controls!.noRedRightTurns).toBe(0);
  });

  it('adds a ranking-only cost per such turn', () => {
    const on = routeAt([-73.567, 45.501], true, 'right');
    const off = routeAt([-73.518, 45.531], true, 'right');
    expect(roadPenaltyS(on) - roadPenaltyS(off)).toBeCloseTo(CANDIDATES.recommend.noRedRightS, 6);
  });
});
