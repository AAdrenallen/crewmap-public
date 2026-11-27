import { describe, expect, it } from 'vitest';
import { batteryChanged } from '../src/presence';

describe('batteryChanged', () => {
  it('publishes early on a 2 % step or a charger flip, not on 1 % noise', () => {
    expect(batteryChanged(null, { level: 70, charging: false })).toBe(false);
    expect(batteryChanged({ level: 68, charging: false }, { level: 69, charging: false })).toBe(false);
    expect(batteryChanged({ level: 68, charging: false }, { level: 70, charging: false })).toBe(true);
    expect(batteryChanged({ level: 68, charging: false }, { level: 68, charging: true })).toBe(true);
    expect(batteryChanged({ level: null, charging: false }, { level: 68, charging: false })).toBe(true);
  });
});
