import { describe, expect, it } from 'vitest';
import { applyCustom, moveId, orderKey, orderRows } from './orderLogic';
import type { RowInfo } from './sheetLogic';

const row = (id: string, t: number | null, etaS: number | null): RowInfo => ({ id, name: id, act: null, paused: false, t, distM: null, etaS });
const rows = [row('a', 10, 600), row('b', 30, 60), row('c', null, null), row('d', 20, 300)];

describe('crew order', () => {
  it('keeps the saved order, drops leavers and appends newcomers by recency', () => {
    expect(applyCustom(rows, ['d', 'x', 'a']).map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(applyCustom(rows, []).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('sorts by ETA and by recency', () => {
    expect(orderRows(rows, 'eta', []).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(orderRows(rows, 'recent', ['c']).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(orderRows(rows, 'custom', ['c']).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
  });
  it('moves up, down and to the top without leaving the list', () => {
    expect(moveId(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', 'up')).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 'down')).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b'], 'z', 'top')).toEqual(['a', 'b']);
  });
  it('keys per crew filter', () => {
    expect(orderKey(null)).toBe('all');
    expect(orderKey('crew1')).toBe('crew1');
  });
});
