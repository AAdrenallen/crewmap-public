import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { laneStrip, matchingIndication, parseLanes, parseMapboxRoute, RouteProgress, type MbDirectionsResponse, type NavRoute } from '../src/navigation';
import { formatNavDistance } from '../src/units';

const fixture = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8')) as MbDirectionsResponse;

describe('lanes — real Mapbox data', () => {
  it('A-15 → Avenue Maple: the exit banner lanes match the intersection lanes, so the strip shows both lanes', () => {
    const route = parseMapboxRoute(fixture('maple-store.directions.json').routes[0]!, 'r');
    const turn = route.steps.findIndex((s) => s.name === 'Avenue Maple');
    expect(route.steps[turn]!.maneuver.modifier).toBe('right');
    const b = route.steps[turn - 1]!.banners.find((x) => x.lanes)!;
    expect(b.lanes).toHaveLength(2);
    const strip = laneStrip(b.lanes, b.primary.modifier, route.steps[turn]!.maneuverLanes);
    expect(strip).toHaveLength(2);
  });

  it('turn off Avenue Maple: OSM bay `left|through|through;right` shows as 2 lanes, left one straight+left', () => {
    const route = parseMapboxRoute(fixture('maple-store.directions.json').routes[0]!, 'r');
    const on = route.steps.findIndex((s) => s.name === 'Avenue Maple');
    const b = route.steps[on]!.banners.find((x) => x.lanes)!;
    // Raw: 3 banner lanes and 3 lanes on the maneuver intersection.
    expect(b.lanes!.map((l) => l.directions)).toEqual([['left'], ['straight'], ['straight', 'right']]);
    expect(route.steps[on + 1]!.maneuverLanes).toHaveLength(3);
    // Our maneuver here is a left, which uses the bay: all 3 lanes stay, the left one valid.
    const strip = laneStrip(b.lanes, b.primary.modifier, route.steps[on + 1]!.maneuverLanes)!;
    expect(strip.map((l) => [l.directions, l.valid])).toEqual([
      [['left'], true],
      [['straight'], false],
      [['straight', 'right'], false],
    ]);
  });

  it('same Maple lanes when our maneuver is a right: the pocket merges into its neighbour (3 → 2)', () => {
    const banner = parseLanes([
      { directions: ['left'], active: false },
      { directions: ['straight'], active: false },
      { directions: ['straight', 'right'], active: true, active_direction: 'right' },
    ]);
    const inter = parseLanes([
      { indications: ['left'], valid: false },
      { indications: ['straight'], valid: false },
      { indications: ['straight', 'right'], valid: true, valid_indication: 'right' },
    ]);
    const strip = laneStrip(banner, 'right', inter)!;
    expect(strip.map((l) => [l.directions, l.valid])).toEqual([
      [['left', 'straight'], false],
      [['straight', 'right'], true],
    ]);
    expect(matchingIndication(strip[1]!, 'right')).toBe('right');
  });

  it('keeps the bay when our maneuver uses it', () => {
    const l = parseLanes([
      { directions: ['left'], active: true, active_direction: 'left' },
      { directions: ['straight'], active: false },
      { directions: ['straight', 'right'], active: false },
    ]);
    expect(laneStrip(l, 'left')).toHaveLength(3);
  });

  it('banner vs intersection count mismatch merges lanes sharing a movement, or hides when ambiguous', () => {
    const banner = parseLanes([
      { directions: ['left'], active: false },
      { directions: ['straight'], active: false },
      { directions: ['right'], active: true, active_direction: 'right' },
    ]);
    const inter = parseLanes([
      { indications: ['left', 'straight'], valid: false },
      { indications: ['right'], valid: true, valid_indication: 'right' },
    ]);
    expect(laneStrip(banner, 'right', inter)!.map((l) => l.directions)).toEqual([['left', 'straight'], ['right']]);
    const four = parseLanes([
      { directions: ['straight'], active: false },
      { directions: ['straight'], active: false },
      { directions: ['straight'], active: false },
      { directions: ['right'], active: true },
    ]);
    expect(laneStrip(four, 'right', inter)).toBeNull();
  });

  it('intersection lanes (indications/valid/valid_indication) parse to one lane each', () => {
    const steps = fixture('centrale-lanes.directions.json').routes[0]!.legs[0]!.steps as unknown as { intersections: { lanes?: unknown[] }[] }[];
    const raw = steps.flatMap((s) => s.intersections).find((i) => i.lanes)!.lanes as Parameters<typeof parseLanes>[0];
    const lanes = parseLanes(raw)!;
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toMatchObject({ directions: ['slight left'], valid: false });
    expect(lanes[1]).toMatchObject({ directions: ['straight'], valid: true, activeDirection: 'straight' });
    expect(laneStrip(lanes, 'straight')).toHaveLength(2);
  });
});

describe('lanes — synthetic', () => {
  // The owner-reported road: two lanes, left = straight+left, right = right only.
  const avenue = parseLanes([
    { type: 'lane', directions: ['straight', 'left'], active: false },
    { type: 'lane', directions: ['right'], active: true, active_direction: 'right' },
  ])!;

  it('one block per physical lane, indications ordered left→right inside the lane', () => {
    expect(avenue).toHaveLength(2);
    expect(avenue[0]!.directions).toEqual(['left', 'straight']);
    expect(matchingIndication(avenue[1]!, 'right')).toBe('right');
    expect(matchingIndication(avenue[0]!, 'right')).toBeNull();
    expect(laneStrip(avenue, 'right')).toHaveLength(2);
  });

  it('left turn from the same road highlights the left arrow of the shared lane', () => {
    const l = parseLanes([
      { directions: ['left', 'straight'], active: true, active_direction: 'left' },
      { directions: ['right'], active: false },
    ])!;
    expect(matchingIndication(l[0]!, 'left')).toBe('left');
  });

  it('normalises OSM/through/sharp/slight/uturn/none spellings', () => {
    const l = parseLanes([{ indications: ['through', 'sharp_left', 'reverse', 'weird'], valid: true }])!;
    expect(l[0]!.directions).toEqual(['uturn', 'sharp left', 'straight']);
    expect(parseLanes([{ indications: [] }])![0]!.directions).toEqual(['none']);
  });

  it('valid lane picks a same-side indication for slight/sharp maneuvers', () => {
    const [l] = parseLanes([{ indications: ['left', 'straight'], valid: true }])!;
    expect(matchingIndication(l!, 'slight left')).toBe('left');
  });

  it('hides implausible strips', () => {
    const mk = (n: number, valid: (i: number) => boolean) => parseLanes(Array.from({ length: n }, (_, i) => ({ indications: ['straight'], valid: valid(i) })));
    expect(laneStrip(mk(1, () => true), 'straight')).toBeNull(); // single lane
    expect(laneStrip(mk(9, (i) => i === 0), 'straight')).toBeNull(); // too many
    expect(laneStrip(mk(3, () => false), 'straight')).toBeNull(); // all invalid
    expect(laneStrip(mk(3, () => true), 'straight')).toBeNull(); // no choice
    // valid lane only points left while we turn right → contradictory
    expect(laneStrip(parseLanes([{ indications: ['left'], valid: true }, { indications: ['straight'], valid: false }]), 'right')).toBeNull();
    expect(laneStrip(undefined, 'right')).toBeNull();
  });
});

describe('formatNavDistance', () => {
  it('rounds like Google', () => {
    expect(formatNavDistance(37)).toBe('40 m');
    expect(formatNavDistance(3)).toBe('10 m');
    expect(formatNavDistance(237)).toBe('250 m');
    expect(formatNavDistance(980)).toBe('1.0 km');
    expect(formatNavDistance(1_440, 'fr')).toBe('1,4 km');
    expect(formatNavDistance(12_400)).toBe('12 km');
  });
});

describe('following maneuver', () => {
  const route: NavRoute = parseMapboxRoute(fixture('maple-store.directions.json').routes[0]!, 'r');

  it('always shows the maneuver after next with the distance from the current position', () => {
    const rp = new RouteProgress(route);
    const start = route.geometry[0]!;
    const p = rp.update({ t: 0, lat: start.lat, lng: start.lng, speed: null, heading: null, accuracy: 5 });
    expect(p.next!.step.index).toBe(1);
    expect(p.following!.step.index).toBe(2);
    expect(p.following!.distanceM).toBeCloseTo(route.steps[2]!.startAlongM - p.alongM, 0);
    expect(p.following!.distanceM).toBeGreaterThan(p.next!.distanceM);
    expect(p.following!.emphasized).toBe(false); // ~1 km apart
  });

  it('emphasises when the two maneuvers are close, and drops it on the last maneuver', () => {
    const rp = new RouteProgress(route);
    const last = route.steps.length - 1; // arrive
    const at = route.steps[last - 1]!; // the final turn
    const pt = route.geometry[route.geometry.length - 1]!;
    // Walk forward to just before the final turn.
    let p = rp.update({ t: 0, lat: route.geometry[0]!.lat, lng: route.geometry[0]!.lng, speed: null, heading: null, accuracy: 5 });
    for (let i = 1; i < route.geometry.length && p.stepIndex < last - 2; i++) {
      const g = route.geometry[i]!;
      p = rp.update({ t: i * 1000, lat: g.lat, lng: g.lng, speed: null, heading: null, accuracy: 5 });
    }
    expect(p.next!.step.index).toBe(at.index);
    expect(p.following!.step.maneuver.type).toBe('arrive');
    expect(p.following!.emphasized).toBe(true); // final turn and arrival are 61 m apart
    p = rp.update({ t: 1e7, lat: pt.lat, lng: pt.lng, speed: null, heading: null, accuracy: 5 });
    expect(p.following).toBeNull();
  });
});

describe('lanes — merge indications', () => {
  it('keeps merge_to_* as their own indication', () => {
    const l = parseLanes([{ indications: ['merge_to_left'], valid: true }, { indications: ['merge_to_right', 'straight'], valid: false }])!;
    expect(l[0]!.directions).toEqual(['merge-left']);
    expect(l[1]!.directions).toEqual(['straight', 'merge-right']);
  });
  it('still matches a slight maneuver on the same side', () => {
    const lane = parseLanes([{ indications: ['merge_to_left'], valid: true }])![0]!;
    expect(matchingIndication(lane, 'slight left')).toBe('merge-left');
    expect(matchingIndication(lane, 'left')).toBe('merge-left');
  });
});
