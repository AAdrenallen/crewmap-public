import { describe, expect, it } from 'vitest';
import { customFromSummary, shareSummary, shareUserMode } from '../src/shareSummary';
import { DEFAULT_SHARING, type SharingPolicy } from '../src/sharing';

const pol = (p: Partial<SharingPolicy>): SharingPolicy => ({ ...DEFAULT_SHARING, ...p });

describe('shareUserMode', () => {
  it('no or empty override follows the crew', () => {
    expect(shareUserMode(undefined)).toBe('crew');
    expect(shareUserMode({})).toBe('crew');
    expect(shareUserMode({ location: undefined })).toBe('crew');
  });
  it('any set field is custom', () => {
    expect(shareUserMode({ battery: false })).toBe('custom');
  });
});

describe('shareSummary', () => {
  it('no shared crew shows nothing', () => {
    expect(shareSummary([], null)).toMatchObject({ location: 'hidden', stats: false, fromCrew: null });
  });
  it('most permissive crew wins and is named', () => {
    const s = shareSummary(
      [
        { id: 'a', pol: pol({ location: 'city', battery: false, speed: false }) },
        { id: 'b', pol: pol({ location: 'exact', battery: false, speed: true }) },
      ],
      null,
    );
    expect(s).toMatchObject({ location: 'exact', speed: true, battery: false, driveAlong: true, fromCrew: 'b' });
  });
  it('override applies in every crew', () => {
    const s = shareSummary([{ id: 'a', pol: pol({}) }, { id: 'b', pol: pol({ location: 'city' }) }], { location: 'hidden', driveAlong: false });
    expect(s.location).toBe('hidden');
    expect(s.driveAlong).toBe(false);
    expect(s.fromCrew).toBe('a');
  });
  it('custom seeded from the summary changes nothing', () => {
    const crews = [{ id: 'a', pol: pol({ location: 'approx', battery: false }) }];
    const s = shareSummary(crews, null);
    expect(shareSummary(crews, customFromSummary(s))).toEqual(s);
  });
});

describe('statsAllowed', () => {
  it('stats off hides all, trips follows Trips, fields follow statsVis', async () => {
    const { statsAllowed } = await import('../src/shareSummary');
    expect(statsAllowed(pol({ stats: false }), 'distance')).toBe(false);
    expect(statsAllowed(pol({ trips: false }), 'trips')).toBe(false);
    expect(statsAllowed(pol({ statsVis: { ...DEFAULT_SHARING.statsVis, score: false } }), 'score')).toBe(false);
    expect(statsAllowed(pol({}), 'score')).toBe(true);
  });
  it('per-user override gates stats in every crew', async () => {
    const { statsAllowed } = await import('../src/shareSummary');
    const { resolveShare } = await import('../src/sharing');
    expect(statsAllowed(resolveShare(pol({}), { statsVis: { badges: false } }), 'badges')).toBe(false);
    expect(statsAllowed(resolveShare(pol({}), { statsVis: { badges: false } }), 'score')).toBe(true);
    expect(statsAllowed(resolveShare(pol({ stats: false }), { stats: true }), 'score')).toBe(true);
  });
});
