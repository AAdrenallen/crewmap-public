import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, hueAt, svAt } from './colorMath';

describe('colorMath', () => {
  it('round-trips hex through HSV', () => {
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#5B6CFF', '#1F2937', '#FFFFFF', '#000000', '#D99E73']) expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });
  it('clamps picker positions', () => {
    expect(svAt(-5, 500, 100, 100)).toEqual({ s: 0, v: 0 });
    expect(hueAt(200, 100)).toBeLessThan(360);
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#FF0000');
  });
});
