import { describe, expect, it } from 'vitest';
import { destination, type LatLng } from '../src/geo';
import {
  applyOp,
  BatteryWatch,
  CompanionCues,
  DRIVE_ALONG,
  edgePlacement,
  etaShareDue,
  FRIEND_ALERTS,
  heard,
  inviteOp,
  liveTargets,
  livePeriodMs,
  LocateLimiter,
  newSession,
  parseEtaShare,
  parseOp,
  regroupPoint,
  relation,
  relationLabel,
  routeRef,
  safeRect,
  sessionFromInvite,
  spreadBlips,
  thinRoute,
  tick,
} from '../src/companions';

const O: LatLng = { lat: 45.5, lng: -73.6 };
const line = (from: LatLng, brg: number, km: number, n = 21): LatLng[] => Array.from({ length: n }, (_, i) => destination(from, brg, (km * 1000 * i) / (n - 1)));

describe('edgePlacement', () => {
  const safe = safeRect(400, 800, { top: 120, bottom: 100, right: 0 });
  it('inside the safe rect is on screen', () => {
    expect(edgePlacement({ x: 200, y: 400 }, 0, safe)).toEqual({ onScreen: true, x: 200, y: 400 });
  });
  it('a point above the top banner clamps to the top edge, arrow up', () => {
    const e = edgePlacement({ x: 200, y: 50 }, 0, safe);
    expect(e.onScreen).toBe(false);
    if (e.onScreen) return;
    expect(e.edge).toBe('top');
    expect(e.y).toBeCloseTo(120 + 22);
    expect(e.angleDeg).toBeCloseTo(0);
  });
  it('far right clamps to the right edge, arrow 90°', () => {
    const cy = (120 + 700) / 2;
    const e = edgePlacement({ x: 5000, y: cy }, 0, safe);
    if (e.onScreen) throw new Error('expected off screen');
    expect(e.edge).toBe('right');
    expect(e.x).toBeCloseTo(400 - 22);
    expect(e.angleDeg).toBeCloseTo(90);
  });
  it('falls back to the relative bearing when projection failed', () => {
    const e = edgePlacement(null, 180, safe);
    if (e.onScreen) throw new Error('expected off screen');
    expect(e.edge).toBe('bottom');
    expect(e.angleDeg).toBeCloseTo(180);
    const nan = edgePlacement({ x: NaN, y: 3 }, 270, safe);
    if (nan.onScreen) throw new Error('expected off screen');
    expect(nan.edge).toBe('left');
  });
  it('always stays inside the safe rect', () => {
    for (let b = 0; b < 360; b += 15) {
      const e = edgePlacement(null, b, safe);
      expect(e.x).toBeGreaterThanOrEqual(safe.left);
      expect(e.x).toBeLessThanOrEqual(safe.right);
      expect(e.y).toBeGreaterThanOrEqual(safe.top);
      expect(e.y).toBeLessThanOrEqual(safe.bottom);
    }
  });
  it('spreadBlips separates blips on one edge', () => {
    const out = spreadBlips([
      { x: 100, y: 142, edge: 'top' as const },
      { x: 110, y: 142, edge: 'top' as const },
    ]);
    expect(out[1]!.x - out[0]!.x).toBeGreaterThanOrEqual(40);
  });
});

describe('drive-along session', () => {
  const me = { id: 'me', name: 'Me' };
  const t0 = 1_000_000;
  it('invite → accept → live targets', () => {
    let s = newSession('s1', me, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'crew1', t0);
    expect(liveTargets(s, 'me')).toEqual([]);
    s = applyOp(s, 'a', { v: 1, op: 'accept', sid: 's1', t: t0 }, t0 + 1)!;
    expect(liveTargets(s, 'me')).toEqual(['a']);
    s = applyOp(s, 'b', { v: 1, op: 'decline', sid: 's1', t: t0 }, t0 + 1)!;
    expect(s.members.b!.state).toBe('declined');
    expect(applyOp(s, 'x', { v: 1, op: 'accept', sid: 's1', t: t0 }, t0)).toBe(s);
    expect(applyOp(s, 'a', { v: 1, op: 'accept', sid: 'other', t: t0 }, t0)).toBe(s);
  });
  it('only the organiser can stop it', () => {
    const s = newSession('s1', me, [{ id: 'a', name: 'A' }], null, t0);
    expect(applyOp(s, 'a', { v: 1, op: 'stop', sid: 's1', t: t0 }, t0)).toBe(s);
    expect(applyOp(s, 'me', { v: 1, op: 'stop', sid: 's1', t: t0 }, t0)).toBeNull();
  });
  it('invitee view from an invite; live update implies joined', () => {
    const owner = newSession('s1', { id: 'o', name: 'O' }, [me, { id: 'c', name: 'C' }], null, t0);
    const op = inviteOp(owner, t0);
    const parsed = parseOp(JSON.parse(JSON.stringify(op)));
    expect(parsed).toEqual(op);
    if (parsed?.op !== 'invite') throw new Error('invite');
    let s = sessionFromInvite(parsed, 'o', 'me', t0);
    expect(liveTargets(s, 'me')).toEqual(['o']);
    s = heard(s, 'c', t0 + 5);
    expect(liveTargets(s, 'me')).toEqual(['c', 'o']);
  });
  it('rejects malformed ops', () => {
    expect(parseOp(null)).toBeNull();
    expect(parseOp({ v: 2, op: 'accept', sid: 's', t: 1 })).toBeNull();
    expect(parseOp({ v: 1, op: 'hack', sid: 's', t: 1 })).toBeNull();
    expect(parseOp({ v: 1, op: 'invite', sid: 's', t: 1, members: 'x', ownerName: 'o' })).toBeNull();
  });
  it('ends: lapsed invites, silence, parked, max', () => {
    const s = newSession('s1', me, [{ id: 'a', name: 'A' }], null, t0);
    expect(tick(s, 'me', t0 + 1000, null).end).toBeNull();
    expect(tick(s, 'me', t0 + DRIVE_ALONG.inviteTtlMs + 1, null).end).toBe('alone');
    let j = applyOp(s, 'a', { v: 1, op: 'accept', sid: 's1', t: t0 }, t0)!;
    j = heard(j, 'a', t0 + 10);
    expect(tick(j, 'me', t0 + DRIVE_ALONG.silenceEndMs + 11, null).end).toBe('silence');
    expect(tick(j, 'me', t0 + 60_000, t0).end).toBeNull();
    expect(tick(j, 'me', t0 + DRIVE_ALONG.parkedEndMs + 1, t0).end).toBe('parked');
    expect(tick({ ...j, heard: { a: t0 + DRIVE_ALONG.maxSessionMs } }, 'me', t0 + DRIVE_ALONG.maxSessionMs + 1, null).end).toBe('max');
  });
  it('live period follows driving', () => {
    expect(livePeriodMs(true)).toBeLessThanOrEqual(2000);
    expect(livePeriodMs(false)).toBeGreaterThan(livePeriodMs(true));
  });
});

describe('relation and cues', () => {
  const route = routeRef(line(O, 90, 20))!;
  it('ahead / behind along my route, away without one', () => {
    const me = destination(O, 90, 5000);
    const ahead = destination(O, 90, 7100);
    const behind = destination(O, 90, 2900);
    expect(relationLabel(relation(me, ahead, route)).kind).toBe('ahead');
    const b = relationLabel(relation(me, behind, route));
    expect(b.kind).toBe('behind');
    expect(b.m).toBeGreaterThan(2000);
    expect(relation(me, destination(me, 0, 3000), route).onMyRoute).toBe(false);
    expect(relationLabel(relation(me, ahead, null)).kind).toBe('away');
    expect(relationLabel(relation(me, destination(me, 0, 50), null)).kind).toBe('here');
  });
  it('announces bucket crossings with a cooldown, and off-route after the hold', () => {
    const c = new CompanionCues();
    const me = destination(O, 90, 9000);
    const at = (gapM: number) => relation(me, destination(O, 90, 9000 - gapM), route);
    expect(c.update(at(2100), 0)).toEqual({ kind: 'gap', label: { kind: 'behind', m: 2000 } });
    expect(c.update(at(2300), 1000)).toBeNull();
    expect(c.update(at(5200), 2000)).toBeNull();
    expect(c.update(at(5300), DRIVE_ALONG.gapEveryMs + 1)).toEqual({ kind: 'gap', label: { kind: 'behind', m: 5000 } });
    expect(c.update(at(5400), DRIVE_ALONG.gapEveryMs * 3)).toBeNull();
    const c2 = new CompanionCues();
    const off = relation(me, destination(me, 0, 2000), route);
    c2.update(off, 0);
    expect(c2.update(off, DRIVE_ALONG.offRouteHoldMs)).toEqual({ kind: 'offRoute' });
    expect(c2.update(off, DRIVE_ALONG.offRouteHoldMs + 5000)?.kind).not.toBe('offRoute');
    expect(c2.update(at(1500), DRIVE_ALONG.offRouteHoldMs * 3)).toEqual({ kind: 'backOnRoute' });
  });
  it('regroup picks the first shared place ahead', () => {
    const theirs = routeRef([destination(O, 0, 3000), destination(O, 90, 10_000), destination(O, 90, 20_000)])!;
    const me = destination(O, 90, 1000);
    const near = { id: 'n', name: 'N', ...destination(O, 90, 2500) };
    const shared = { id: 's', name: 'S', ...destination(O, 90, 12_000) };
    const later = { id: 'l', name: 'L', ...destination(O, 90, 15_000) };
    const offTheirs = { id: 'o', name: 'O', ...destination(O, 90, 6000) };
    expect(regroupPoint(me, route, theirs, [later, near, offTheirs, shared])?.id).toBe('s');
    expect(regroupPoint(me, route, theirs, [near])).toBeNull();
  });
  it('thinRoute keeps ends and caps length', () => {
    const l = line(O, 0, 10, 1000);
    const t = thinRoute(l, 50);
    expect(t).toHaveLength(50);
    expect(t[0]).toEqual(l[0]);
    expect(t[49]).toEqual(l[999]);
  });
});

describe('friend alerts', () => {
  it('battery alert fires once per discharge', () => {
    const w = new BatteryWatch();
    expect(w.update(50, false)).toBe(false);
    expect(w.update(FRIEND_ALERTS.batteryLowPct - 1, false)).toBe(true);
    expect(w.update(5, false)).toBe(false);
    expect(w.update(5, true)).toBe(false);
    expect(w.update(8, false)).toBe(true);
    expect(w.update(null, false)).toBe(false);
  });
  it('locate limiter: one answer per requester per window', () => {
    const l = new LocateLimiter();
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 1000)).toBe(false);
    expect(l.allow('b', 1000)).toBe(true);
    expect(l.allow('a', FRIEND_ALERTS.locateAnswerEveryMs + 1)).toBe(true);
  });
  it('eta share resend rule and parsing', () => {
    expect(etaShareDue(null, 0, 0)).toBe(true);
    expect(etaShareDue({ eta: 1000, at: 0 }, 1000 + 60_000, 1000)).toBe(false);
    expect(etaShareDue({ eta: 1000, at: 0 }, 1000 + FRIEND_ALERTS.etaResendDeltaMs, 1000)).toBe(true);
    expect(etaShareDue({ eta: 1000, at: 0 }, 1000, FRIEND_ALERTS.etaResendEveryMs)).toBe(true);
    expect(parseEtaShare({ v: 1, sid: 's', dest: 'D', eta: 5, remainingM: 10, t: 1, end: 'arrived' })?.end).toBe('arrived');
    expect(parseEtaShare({ v: 1, sid: 's', dest: 'D', eta: 5, t: 1, end: 'x' })).toEqual({ v: 1, sid: 's', dest: 'D', eta: 5, remainingM: 0, t: 1 });
    expect(parseEtaShare({ v: 1 })).toBeNull();
  });
});

describe('one-shot arrival alerts', () => {
  const base = { arrive: true, leave: false };
  it('recurring stays; once clears the fired kind and deletes when empty', async () => {
    const { consumeOnce } = await import('../src/companions');
    expect(consumeOnce(base, 'arrive')).toBe(base);
    expect(consumeOnce({ ...base, once: true }, 'arrive')).toBeNull();
    expect(consumeOnce({ arrive: true, leave: true, once: true }, 'arrive')).toEqual({ arrive: false, leave: true, once: true });
    expect(consumeOnce({ ...base, once: true }, 'leave')).toEqual({ ...base, once: true });
  });
});
