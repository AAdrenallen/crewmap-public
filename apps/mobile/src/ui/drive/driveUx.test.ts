import { describe, expect, it } from 'vitest';
import {
  DRIVE_UX,
  enqueue,
  hudPlan,
  nextMotion,
  queueChip,
  release,
  routeInterrupt,
  smoothStreakMin,
} from './driveUx';

describe('motion hysteresis', () => {
  it('moves at the threshold and stops only after the hold', () => {
    expect(nextMotion('stopped', DRIVE_UX.movingKph, null, 0)).toBe('moving');
    expect(nextMotion('stopped', 6, null, 0)).toBe('stopped');
    expect(nextMotion('moving', 6, 0, 10_000)).toBe('moving');
    expect(nextMotion('moving', 1, 0, DRIVE_UX.stopHoldMs - 1)).toBe('moving');
    expect(nextMotion('moving', 1, 0, DRIVE_UX.stopHoldMs)).toBe('stopped');
    expect(nextMotion('moving', null, 0, DRIVE_UX.stopHoldMs)).toBe('stopped');
  });
});

describe('hud plan', () => {
  it('hides secondary controls and enlarges primary ones while moving', () => {
    const m = hudPlan('moving');
    const s = hudPlan('stopped');
    expect(m.secondary).toBe(false);
    expect(s.secondary).toBe(true);
    expect(m.popups).toBe(false);
    expect(m.primaryDp).toBeGreaterThan(s.primaryDp);
    expect(s.primaryDp).toBeGreaterThanOrEqual(64);
  });
});

describe('interruptions', () => {
  it('queues social items while moving, shows them when stopped away from a turn', () => {
    expect(routeInterrupt('chat', 'moving', null)).toBe('queue');
    expect(routeInterrupt('emote', 'moving', 2000)).toBe('queue');
    expect(routeInterrupt('friend', 'stopped', null)).toBe('show');
    expect(routeInterrupt('friend', 'stopped', 100)).toBe('queue');
  });
  it('safety always shows; still-there only away from turns', () => {
    expect(routeInterrupt('safety', 'moving', 10)).toBe('show');
    expect(routeInterrupt('hazardConfirm', 'moving', 1000)).toBe('show');
    expect(routeInterrupt('hazardConfirm', 'moving', 100)).toBe('queue');
  });
  it('dedupes, releases at a stop and drops stale items', () => {
    let q = enqueue([], { id: 'a', kind: 'chat', at: 1 });
    q = enqueue(q, { id: 'b', kind: 'emote', at: 2 });
    q = enqueue(q, { id: 'a', kind: 'chat', at: 3 });
    expect(q.map((x) => x.id)).toEqual(['b', 'a']);
    expect(queueChip(q)).toEqual({ count: 2, kind: 'chat' });
    expect(queueChip([])).toBeNull();
    expect(release(q, 'moving', 10).keep).toHaveLength(2);
    const r = release(q, 'stopped', 2 + DRIVE_UX.queueMaxAgeMs + 1);
    expect(r.keep).toHaveLength(0);
    expect(r.show.map((x) => x.id)).toEqual(['a']);
  });
});

describe('faster offer, emotes, trip end', () => {
  it('holds the faster offer near a manoeuvre only', () => {
    expect(routeInterrupt('faster', 'moving', 1000)).toBe('show');
    expect(routeInterrupt('faster', 'moving', DRIVE_UX.maneuverQuietM - 1)).toBe('queue');
  });
  it('celebrates only clean driver trips of some length', () => {
    expect(smoothStreakMin({ durationS: 1200, events: 0, passenger: false })).toBe(20);
    expect(smoothStreakMin({ durationS: 1200, events: 1, passenger: false })).toBeNull();
    expect(smoothStreakMin({ durationS: 1200, events: 0, passenger: true })).toBeNull();
    expect(
      smoothStreakMin({ durationS: DRIVE_UX.celebrateMinS - 1, events: 0, passenger: false }),
    ).toBeNull();
  });
});

import { allowRepeat, friendContext, noticeMs, noticePolicy, NOTICE_UX, pairKey } from './driveUx';

describe('friend notice policy', () => {
  it('maps driving + motion to a context', () => {
    expect(friendContext(false, 'moving')).toBe('browse');
    expect(friendContext(true, 'moving')).toBe('driveMoving');
    expect(friendContext(true, 'stopped')).toBe('driveStopped');
  });
  it('browsing always gets an auto-closing toast', () => {
    expect(noticePolicy('friendsNearOthers', 'browse')).toBe('drop');
    for (const k of ['friendsNearMe', 'passPlace', 'arrival', 'chat', 'emote'] as const)
      expect(noticePolicy(k, 'browse')).toBe('toast');
    expect(noticeMs('toast')).toBe(NOTICE_UX.browseMs);
  });
  it('while moving: others meeting is dropped, me-related is a pill, chatter waits', () => {
    expect(noticePolicy('friendsNearOthers', 'driveMoving')).toBe('drop');
    expect(noticePolicy('friendsNearMe', 'driveMoving')).toBe('pill');
    expect(noticePolicy('groupDrive', 'driveMoving')).toBe('pill');
    expect(noticePolicy('groupDrive', 'driveMoving', 50)).toBe('defer');
    expect(noticePolicy('groupDrive', 'browse')).toBe('toast');
    // Location asks (D47): a pill while driving (never a modal), deferred right before a turn.
    expect(noticePolicy('ask', 'driveMoving')).toBe('pill');
    expect(noticePolicy('ask', 'driveMoving', 50)).toBe('defer');
    expect(noticePolicy('ask', 'browse')).toBe('toast');
    expect(noticePolicy('passPlace', 'driveMoving')).toBe('defer');
    expect(noticePolicy('chat', 'driveMoving')).toBe('defer');
    expect(noticeMs('pill')).toBe(NOTICE_UX.pillMs);
  });
  it('nothing pops near a manoeuvre', () => {
    expect(noticePolicy('friendsNearMe', 'driveMoving', 100)).toBe('defer');
    expect(noticePolicy('friendsNearMe', 'driveStopped', 100)).toBe('defer');
    expect(noticePolicy('chat', 'driveStopped', 1000)).toBe('pill');
  });
  it('rate-limits per pair, order-independent', () => {
    const seen = new Map<string, number>();
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
    expect(allowRepeat(seen, pairKey('a', 'b'), 0)).toBe(true);
    expect(allowRepeat(seen, pairKey('b', 'a'), 1000)).toBe(false);
    expect(allowRepeat(seen, pairKey('a', 'b'), NOTICE_UX.repeatMs)).toBe(true);
  });
});

import { momentNotice } from './driveUx';

describe('moment classification', () => {
  it('tells me-near from others-near and keys pairs', () => {
    expect(momentNotice({ kind: 'friendsNear', a: 'me', b: 'x' }, 'me').kind).toBe('friendsNearMe');
    const o = momentNotice({ kind: 'friendsNear', a: 'y', b: 'x' }, 'me');
    expect(o.kind).toBe('friendsNearOthers');
    expect(o.key).toBe(momentNotice({ kind: 'friendsNear', a: 'x', b: 'y' }, null).key);
    expect(momentNotice({ kind: 'passPlace', placeId: 'p', owner: 'x' }, 'me').kind).toBe('passPlace');
  });
});

import { emotePopup, notifyMode } from './driveUx';

describe('notification + emote routing', () => {
  it('system notifications: normal browsing, silent driving, skipped when dropped', () => {
    expect(notifyMode('arrival', 'browse')).toBe('normal');
    expect(notifyMode('arrival', 'driveMoving')).toBe('silent');
    expect(notifyMode('chat', 'driveStopped')).toBe('silent');
    expect(notifyMode('friendsNearOthers', 'driveMoving')).toBe('skip');
  });
  it('emote popups respect the driving setting and turns', () => {
    expect(emotePopup('browse', 10, false)).toBe(true);
    expect(emotePopup('driveMoving', null, true)).toBe(true);
    expect(emotePopup('driveMoving', null, false)).toBe(false);
    expect(emotePopup('driveMoving', 100, true)).toBe(false);
  });
});
