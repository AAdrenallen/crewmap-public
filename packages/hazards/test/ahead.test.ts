import { describe, expect, it } from 'vitest';
import { ALERT_THRESHOLDS, HazardAnnouncer, hazardsFromReports, mergeHazards, type FriendReport, type HazardOnRoute, type MergedHazard } from '../src';

const NOW = 1781547600000;
const ME = 'device-me';

function hz(id: string, reporters: string[] = []): MergedHazard {
  return {
    id, source: 'friends', type: 'pothole', subtype: null, lat: 45.5, lng: -73.6, heading: null, street: null,
    reportedAt: NOW, expiresAt: NOW + 3600_000, reliability: 6, confirmations: 1, sources: ['friends'], memberIds: [id], latestReportAt: NOW, reporters, confidence: 0.8, level: 'high', fade: 1, mix: [{ source: 'friends', n: 1 }], independent: 1,
  };
}
const at = (h: MergedHazard, alongM: number): HazardOnRoute => ({ hazard: h, alongM });

describe('HazardAnnouncer', () => {
  it('never announces a hazard the user reported', () => {
    const a = new HazardAnnouncer();
    expect(a.update([at(hz('h1', [ME]), 700)], 0, null, { selfId: ME, now: NOW })).toEqual([]);
  });

  it('never announces closer than the minimum distance, nor later on', () => {
    const a = new HazardAnnouncer();
    const h = at(hz('h1', ['friend']), 1000);
    expect(a.update([h], 990, null, { selfId: ME, now: NOW })).toEqual([]);
    expect(a.update([h], 995, null, { selfId: ME, now: NOW })).toEqual([]);
  });

  it('announces between the minimum distance and the lookahead', () => {
    const a = new HazardAnnouncer();
    const h = at(hz('h1', ['friend']), 1000);
    const out = a.update([h], 1000 - 250, null, { selfId: ME, now: NOW });
    expect(out).toEqual([expect.objectContaining({ kind: 'announce', thresholdM: 300, distanceM: 250 })]);
    expect(ALERT_THRESHOLDS.minAnnounceM).toBeGreaterThanOrEqual(150);
  });

  it('stays quiet right after the user reports something, then resumes', () => {
    const a = new HazardAnnouncer();
    const h = at(hz('h1', ['friend']), 1000);
    expect(a.update([h], 300, null, { selfId: ME, now: NOW, lastOwnReportAt: NOW - 5_000 })).toEqual([]);
    expect(a.update([h], 300, null, { selfId: ME, now: NOW + ALERT_THRESHOLDS.quietAfterOwnReportMs, lastOwnReportAt: NOW - 5_000 })).toHaveLength(1);
  });

  it('merged hazards carry the reporter device ids', () => {
    const r: FriendReport = { id: 'r1', by: ME, type: 'pothole', lat: 45.5, lng: -73.6, heading: null, street: null, at: NOW, votes: { [ME]: 1 } };
    const [m] = mergeHazards(hazardsFromReports([r], NOW), NOW);
    expect(m!.reporters).toEqual([ME]);
  });
});
