import { describe, expect, it } from 'vitest';
import { checkInAllowed, cleanOverride, customFromSummary, DEFAULT_SHARING, normalizePolicy, resolveShare, shareSummary } from '../src';

describe('safety check-in sharing (D66)', () => {
  it('is opt-in: existing and default crews are off', () => {
    expect(DEFAULT_SHARING.checkIn).toBeUndefined();
    expect(checkInAllowed(normalizePolicy({ location: 'exact' }))).toBe(false);
    expect(checkInAllowed(normalizePolicy({ checkIn: true }))).toBe(true);
  });

  it('per-friend override turns it on or off for one friend', () => {
    const on = normalizePolicy({ checkIn: true });
    const off = normalizePolicy({});
    expect(checkInAllowed(resolveShare(on, { checkIn: false }), { checkIn: false })).toBe(false);
    expect(checkInAllowed(resolveShare(off, { checkIn: true }), { checkIn: true })).toBe(true);
    expect(cleanOverride({ checkIn: true })).toEqual({ checkIn: true });
  });

  it('a friend hidden by override gets no alert unless explicitly opted in', () => {
    const on = normalizePolicy({ checkIn: true });
    const hidden = { location: 'hidden' as const };
    expect(checkInAllowed(resolveShare(on, hidden), hidden)).toBe(false);
    const hiddenButSafe = { location: 'hidden' as const, checkIn: true };
    expect(checkInAllowed(resolveShare(on, hiddenButSafe), hiddenButSafe)).toBe(true);
  });

  it('summary shows it and Custom pins it', () => {
    const crews = [
      { id: 'a', pol: normalizePolicy({}) },
      { id: 'b', pol: normalizePolicy({ checkIn: true }) },
    ];
    const s = shareSummary(crews, null);
    expect(s.checkIn).toBe(true);
    expect(customFromSummary(s).checkIn).toBe(true);
    expect(shareSummary(crews, customFromSummary(s))).toEqual(s);
    expect(shareSummary([crews[0]!], null).checkIn).toBe(false);
  });
});
