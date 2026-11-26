import { describe, expect, it } from 'vitest';
import { CELL, turnShape, MIN_STROKE_PX, isTurnOnly, laneDividers, laneShape, laneStripLayout, strokeUnits } from './laneGlyphs';

const INDS = ['uturn', 'sharp left', 'left', 'slight left', 'straight', 'slight right', 'right', 'sharp right', 'merge-left', 'merge-right'];
const combos: string[][] = [];
for (let m = 1; m < 1 << INDS.length; m++) {
  const c = INDS.filter((_, i) => m & (1 << i));
  if (c.length <= 3) combos.push(c);
}

describe('lane glyph geometry', () => {
  it('every indication combo stays inside the cell with padding', () => {
    for (const dirs of combos) {
      for (const use of [null, dirs[0]!]) {
        const s = laneShape({ directions: dirs, valid: use !== null, active: use !== null }, use);
        for (const [x, y] of s.pts) {
          expect(x, dirs.join()).toBeGreaterThanOrEqual(1);
          expect(x, dirs.join()).toBeLessThanOrEqual(CELL.w - 1);
          expect(y, dirs.join()).toBeGreaterThanOrEqual(1);
          expect(y, dirs.join()).toBeLessThanOrEqual(CELL.h - 1);
        }
      }
    }
  });
  it('is horizontally symmetric about the stem for mirrored sets', () => {
    const l = laneShape({ directions: ['left'], valid: true, active: true }, 'left');
    const r = laneShape({ directions: ['right'], valid: true, active: true }, 'right');
    const minL = Math.min(...l.pts.map((p) => p[0]));
    const maxR = Math.max(...r.pts.map((p) => p[0]));
    expect(minL + maxR).toBeCloseTo(CELL.w, 1);
  });
  it('highlights only the used movement and draws it last', () => {
    const s = laneShape({ directions: ['straight', 'left'], valid: true, active: true }, 'straight');
    expect(s.arrows.map((a) => a.hot)).toEqual([false, true]);
    expect(s.yourLane).toBe(true);
  });
  it('slight, normal and sharp have distinct silhouettes; merge adds a taper', () => {
    const sh = ['slight right', 'right', 'sharp right'].map((d) => turnShape(d).line);
    expect(new Set(sh).size).toBe(3);
    expect(turnShape('merge-left').taper).toBeTruthy();
    expect(turnShape('slight left').taper).toBeUndefined();
  });
  it('turn-only detection', () => {
    expect(isTurnOnly(['left'])).toBe(true);
    expect(isTurnOnly(['straight', 'left'])).toBe(false);
    expect(isTurnOnly(['none'])).toBe(false);
  });
  it('dividers: dashed between lanes, solid at edges', () => {
    const d = laneDividers(4);
    expect(d.dashed).toEqual([CELL.w, CELL.w * 2, CELL.w * 3]);
    expect(d.edges).toEqual([0, CELL.w * 4]);
    expect(laneDividers(1).dashed).toEqual([]);
  });
  it('layout fits the box for 1-6 lanes, compact and wide', () => {
    for (let n = 1; n <= 6; n++) {
      for (const compact of [false, true]) {
        const l = laneStripLayout(n, 120, 46, compact);
        expect(l.width).toBeLessThanOrEqual(120 + 0.01);
        expect(l.height).toBeLessThanOrEqual(46 + 0.01);
        expect(l.scale).toBeGreaterThan(0);
      }
    }
  });
  it('rendered strokes never fall under the px minimum', () => {
    for (const scale of [0.3, 0.55, 0.9, 1]) {
      expect(strokeUnits('hot', scale) * scale).toBeGreaterThanOrEqual(MIN_STROKE_PX.hot - 1e-9);
      expect(strokeUnits('dim', scale) * scale).toBeGreaterThanOrEqual(MIN_STROKE_PX.dim - 1e-9);
    }
  });
});
