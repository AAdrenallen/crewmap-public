import { describe, expect, it } from 'vitest';
import { ANGLE, VIEWBOX, glyphBounds } from './maneuverGeom';

describe('maneuver glyph geometry', () => {
  const kinds = ['turn', 'ramp', 'roundabout'] as const;
  for (const kind of kinds) {
    for (const [name, a] of Object.entries(ANGLE)) {
      it(`${kind} ${name} fits the viewBox once centred`, () => {
        const b = glyphBounds(kind, a);
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        expect(w).toBeLessThanOrEqual(VIEWBOX.w - 4);
        expect(h).toBeLessThanOrEqual(VIEWBOX.h - 4);
      });
    }
  }
  it('uturn and arrive fit', () => {
    for (const k of ['uturn', 'arrive'] as const) {
      const b = glyphBounds(k);
      expect(b.maxX - b.minX).toBeLessThanOrEqual(VIEWBOX.w - 4);
      expect(b.maxY - b.minY).toBeLessThanOrEqual(VIEWBOX.h - 4);
    }
  });
});


import { approachProgress, splitDuration, timeToTurnS } from './maneuverGeom';

describe('info column helpers', () => {
  it('time to turn', () => {
    expect(timeToTurnS(250, 10)).toBe(25);
    expect(timeToTurnS(250, 0)).toBeNull();
    expect(timeToTurnS(250, null)).toBeNull();
  });
  it('splits durations', () => {
    expect(splitDuration(25)).toEqual({ n: 25, unit: 'sec' });
    expect(splitDuration(120)).toEqual({ n: 2, unit: 'min' });
  });
  it('approach progress is clamped', () => {
    expect(approachProgress(100, 400)).toBeCloseTo(0.75);
    expect(approachProgress(500, 400)).toBe(0);
    expect(approachProgress(0, 400)).toBe(1);
    expect(approachProgress(10, 0)).toBe(0);
  });
});
