import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import { ALERT_THRESHOLDS, HAZARD_COST, hazardsOnRoute, mergeHazards, routeBearingAt, routeHazardCostS, sameDirection, type Hazard, type HazardType } from '../src';

// A straight northbound route near a public landmark (Mont Royal area), no real addresses.
const NOW = Date.UTC(2026, 10, 26, 15);
const line: LatLng[] = [{ lat: 45.5, lng: -73.6 }, { lat: 45.52, lng: -73.6 }];
const route = { geometry: line, cum: cumulativeDistances(line) } as unknown as NavRoute;
const mid = { lat: 45.51, lng: -73.6 };

function h(id: string, type: HazardType, heading: number | null, over: Partial<Hazard> = {}): Hazard {
  return { id, source: 'quebec', type, subtype: null, ...mid, heading, street: null, reportedAt: NOW - 60_000, expiresAt: NOW + 3600_000, reliability: 10, confirmations: 3, ...over };
}

describe('direction-aware hazards', () => {
  it('knows the route direction and which reports apply to it', () => {
    expect(routeBearingAt(route, 1000)).toBeCloseTo(0, 0);
    expect(sameDirection(route, 1000, null)).toBe(true);
    expect(sameDirection(route, 1000, 10)).toBe(true);
    expect(sameDirection(route, 1000, 90)).toBe(true);
    expect(sameDirection(route, 1000, 180)).toBe(false);
    expect(sameDirection(route, 1000, 360 - ALERT_THRESHOLDS.oppositeDeg + 5)).toBe(true);
  });

  it('does not warn about a report for the opposite carriageway', () => {
    const hz = mergeHazards([h('waze:a', 'accident', 180, { source: 'waze' }), h('waze:b', 'police', 0, { source: 'waze', lat: 45.512 })], NOW);
    const on = hazardsOnRoute(route, hz);
    expect(on.map((x) => x.hazard.type)).toEqual(['police']);
  });

  it('prices crashes, works and closures on a route for the ranking, not enforcement', () => {
    const closure = mergeHazards([h('quebec:c', 'closure', null)], NOW);
    expect(routeHazardCostS(route, closure)).toBeCloseTo(HAZARD_COST.typeS.closure * HAZARD_COST.levelFactor[closure[0]!.level], 6);
    expect(routeHazardCostS(route, mergeHazards([h('waze:p', 'police', null, { source: 'waze' })], NOW))).toBe(0);
    expect(routeHazardCostS(route, mergeHazards([h('waze:x', 'accident', 180, { source: 'waze' })], NOW))).toBe(0);
    const far = mergeHazards([h('quebec:f', 'closure', null, { lat: 45.51, lng: -73.55 })], NOW);
    expect(routeHazardCostS(route, far)).toBe(0);
    const many = mergeHazards(Array.from({ length: 6 }, (_, i) => h(`quebec:${i}`, 'closure', null, { lat: 45.501 + i * 0.003 })), NOW);
    expect(routeHazardCostS(route, many)).toBe(HAZARD_COST.maxS);
  });

  it('does not charge what Mapbox already priced into the route (its incidents are republished by the preview)', () => {
    expect(routeHazardCostS(route, mergeHazards([h('mapbox:1', 'accident', null, { source: 'mapbox' })], NOW))).toBe(0);
    // A feed report Mapbox also has merges into one hazard with both sources: still not charged.
    const both = mergeHazards([h('quebec:w', 'closure', null), h('mapbox:2', 'closure', null, { source: 'mapbox' })], NOW);
    expect(both).toHaveLength(1);
    expect(routeHazardCostS(route, both)).toBe(0);
  });
});
