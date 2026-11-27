import { describe, expect, it } from 'vitest';
import { CONGESTION_COLOR, ROUTE_COLORS, alternativeFeatures, colorOfRoute, routeColor, routeFeatures } from './routeColors';

const g = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 45.5 + i * 0.001, lng: -73.6 }));
const TRAFFIC = ['#22A06B', '#F5A524', '#E5484D', '#9B1C31', ...Object.values(CONGESTION_COLOR).filter((c): c is string => c !== null)];

describe('route preview colours', () => {
  it('gives each candidate its own colour, none of them a traffic colour', () => {
    expect(new Set(ROUTE_COLORS).size).toBe(ROUTE_COLORS.length);
    for (const c of ROUTE_COLORS) expect(TRAFFIC.map((t) => t.toLowerCase())).not.toContain(c.toLowerCase());
    expect(routeColor(0)).toBe(ROUTE_COLORS[0]);
    expect(routeColor(ROUTE_COLORS.length)).toBe(ROUTE_COLORS[0]);
    expect(routeColor(-1)).toBe(ROUTE_COLORS[ROUTE_COLORS.length - 1]);
    expect(routeColor(Number.NaN)).toBe(ROUTE_COLORS[0]);
  });

  it('colours every unselected alternative (never an undefined colour) and leaves out the selected one', () => {
    const cands = ['a', 'b', 'c'].map((id) => ({ route: { id, geometry: g(3) } }));
    const fc = alternativeFeatures(cands, 'b');
    expect(fc.features.map((f) => f.properties.id)).toEqual(['a', 'c']);
    expect(fc.features.map((f) => f.properties.color)).toEqual([ROUTE_COLORS[0], ROUTE_COLORS[2]]);
    expect(colorOfRoute('c', cands)).toBe(ROUTE_COLORS[2]);
    expect(colorOfRoute('zzz', cands)).toBe(ROUTE_COLORS[0]);
    expect(colorOfRoute('a', null)).toBe(ROUTE_COLORS[0]);
  });

  it('draws the selected route in its own colour with traffic colours only where traffic is slow', () => {
    const fc = routeFeatures({ geometry: g(5), congestion: ['low', 'low', 'heavy', 'unknown'] }, ROUTE_COLORS[3]);
    expect(fc.features.map((f) => f.properties.color)).toEqual([ROUTE_COLORS[3], CONGESTION_COLOR.heavy, ROUTE_COLORS[3]]);
    expect(fc.features.reduce((n, f) => n + f.geometry.coordinates.length - 1, 0)).toBe(4);
    const bare = routeFeatures({ geometry: g(4), congestion: [] }, ROUTE_COLORS[1]);
    expect(bare.features).toHaveLength(1);
    expect(bare.features[0]!.properties.color).toBe(ROUTE_COLORS[1]);
    expect(routeFeatures({ geometry: g(1), congestion: [] }).features).toHaveLength(0);
  });
});
