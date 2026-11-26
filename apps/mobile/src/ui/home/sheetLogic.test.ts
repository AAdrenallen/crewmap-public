import { describe, expect, it } from 'vitest';
import { crewColor, crewInitial, filterRows, needsSheet, snapAfterDrag, snapAfterTap, snapHeights, sortRows, toRow, type RowInfo } from './sheetLogic';

const row = (o: Partial<RowInfo> & { id: string }): RowInfo => ({ name: o.id, act: 'still', paused: false, t: 1000, distM: null, etaS: null, ...o });

describe('sheet', () => {
  it('needs a sheet only beyond the comfortable count', () => {
    expect(needsSheet(4, false)).toBe(false);
    expect(needsSheet(5, false)).toBe(true);
    expect(needsSheet(3, true)).toBe(false);
    expect(needsSheet(4, true)).toBe(true);
  });
  it('snap heights are ordered', () => {
    for (const h of [360, 700, 900]) {
      const s = snapHeights(h);
      expect(s.collapsed).toBeLessThan(s.half);
      expect(s.half).toBeLessThan(s.full);
    }
  });
  it('drag release picks the nearest snap, flicks carry', () => {
    const s = snapHeights(800);
    expect(snapAfterDrag(s.collapsed + 5, 0, s)).toBe('collapsed');
    expect(snapAfterDrag(s.half - 10, 0, s)).toBe('half');
    expect(snapAfterDrag(s.full - 20, 0, s)).toBe('full');
    expect(snapAfterDrag(s.collapsed + 40, -2000, s)).not.toBe('collapsed');
    expect(snapAfterDrag(s.half + 20, 3000, s)).toBe('collapsed');
  });
  it('handle tap cycles', () => {
    expect(snapAfterTap('collapsed')).toBe('half');
    expect(snapAfterTap('half')).toBe('full');
    expect(snapAfterTap('full')).toBe('collapsed');
  });
});

describe('rows', () => {
  const now = 1000 + 60_000;
  const rows = [
    row({ id: 'Cy', act: 'automotive', distM: 9000, etaS: 600 }),
    row({ id: 'Al', act: 'walking', distM: 800, etaS: null }),
    row({ id: 'Bo', act: 'automotive', distM: 3000, etaS: 300, t: -400_000 }),
    row({ id: 'Di', paused: true, distM: 100, act: 'automotive' }),
  ];
  it('filters', () => {
    expect(filterRows(rows, 'driving', '', now).map((r) => r.id)).toEqual(['Cy', 'Bo']);
    expect(filterRows(rows, 'nearby', '', now).map((r) => r.id)).toEqual(['Al', 'Bo', 'Di']);
    expect(filterRows(rows, 'online', '', now).map((r) => r.id)).toEqual(['Cy', 'Al']);
    expect(filterRows(rows, 'all', ' b', now).map((r) => r.id)).toEqual(['Bo']);
  });
  it('sorts by distance and by ETA with nulls last', () => {
    expect(sortRows(rows, 'distance').map((r) => r.id)).toEqual(['Di', 'Al', 'Bo', 'Cy']);
    expect(sortRows(rows, 'eta').map((r) => r.id)).toEqual(['Bo', 'Cy', 'Al', 'Di']);
  });
  it('toRow prefers routed distance', () => {
    const f = { profile: { deviceId: 'x', name: 'X' }, presence: { lat: 45, lng: -74, act: 'still', t: 5 }, paused: false, etaS: null, routeM: 1234 };
    expect(toRow(f, { lat: 45, lng: -74 }).distM).toBe(1234);
    expect(toRow({ ...f, routeM: null }, { lat: 45, lng: -74 }).distM).toBe(0);
    expect(toRow({ ...f, routeM: null }, null).distM).toBeNull();
  });
  it('crew badge helpers are stable', () => {
    expect(crewColor('abc')).toBe(crewColor('abc'));
    expect(crewInitial(' maison')).toBe('M');
  });
});
