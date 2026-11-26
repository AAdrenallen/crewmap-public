import { describe, expect, it } from 'vitest';
import {
  adoptDest,
  allArrived,
  applyOp,
  atDestination,
  changeDest,
  DRIVE_ALONG,
  groupRows,
  groupSummary,
  heard,
  inviteOp,
  newSession,
  parseOp,
  roughEtaMs,
  sessionFromInvite,
  successor,
  tick,
  type DriveAlongOp,
  type DriveAlongSession,
} from '../src/companions';

const t0 = 1_000_000;
const dest = { name: 'Mont Royal', lat: 45.5048, lng: -73.5878 };
const host = { id: 'h', name: 'Host' };

function joined(): DriveAlongSession {
  let s = newSession('s1', host, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], null, t0, dest);
  for (const id of ['a', 'b']) s = applyOp(s, id, { v: 1, op: 'accept', sid: 's1', t: t0 }, t0 + 1)!;
  return s;
}

describe('group drive session', () => {
  it('the invite carries the destination; old readers ignore the extras', () => {
    const op = inviteOp(newSession('s1', host, [{ id: 'a', name: 'A' }], null, t0, dest), t0);
    const parsed = parseOp(JSON.parse(JSON.stringify(op)));
    expect(parsed).toEqual(op);
    if (parsed?.op !== 'invite') throw new Error('invite');
    expect(parsed.dest).toEqual(dest);
    expect(sessionFromInvite(parsed, 'h', 'a', t0).dest).toEqual(dest);
    // An invite without a usable destination (plain drive-along, or an older host) is still a valid invite.
    const plain = parseOp({ v: 1, op: 'invite', sid: 's', t: 1, members: [], ownerName: 'o', dest: { lat: 'x' } });
    expect(plain && plain.op === 'invite' && plain.dest).toBeFalsy();
  });
  it('rejects malformed destination ops', () => {
    expect(parseOp({ v: 1, op: 'dest', sid: 's', t: 1, rev: 1, dest: { name: 'x', lat: 95, lng: 0 } })).toBeNull();
    expect(parseOp({ v: 1, op: 'arrive', sid: 's', t: 1 })).toBeNull();
  });
  it('host changes destination: members get a prompt and adopt it; stale revisions are ignored', () => {
    const s = joined();
    const next = { name: 'Old Port', lat: 45.5, lng: -73.55 };
    expect(changeDest(s, next).destRev).toBe(1);
    const op: DriveAlongOp = { v: 1, op: 'dest', sid: 's1', t: t0 + 5, dest: next, rev: 1 };
    let m = applyOp(s, 'h', op, t0 + 6)!;
    expect(m.dest).toEqual(dest);
    expect(m.pendingDest).toEqual({ dest: next, rev: 1 });
    expect(applyOp(m, 'a', { ...op, rev: 2 }, t0)).toBe(m);
    expect(applyOp(m, 'h', op, t0)).toBe(m);
    m = adoptDest(m);
    expect(m.dest).toEqual(next);
    expect(m.pendingDest).toBeNull();
    expect(m.arrived).toEqual({});
  });
  it('arrivals count only for the current destination from joined members', () => {
    let s = joined();
    s = applyOp(s, 'a', { v: 1, op: 'arrive', sid: 's1', t: t0 + 100, rev: 0 }, t0 + 101)!;
    expect(s.arrived).toEqual({ a: t0 + 100 });
    expect(applyOp(s, 'b', { v: 1, op: 'arrive', sid: 's1', t: t0 + 100, rev: 3 }, t0)).toBe(s);
    expect(applyOp(s, 'zz', { v: 1, op: 'arrive', sid: 's1', t: t0 + 100, rev: 0 }, t0)).toBe(s);
    expect(allArrived(s)).toBe(false);
    s = applyOp(s, 'b', { v: 1, op: 'arrive', sid: 's1', t: t0 + 200, rev: 0 }, t0)!;
    s = { ...s, arrived: { ...s.arrived, h: t0 + 300 } };
    expect(allArrived(s)).toBe(true);
    const sum = groupSummary(s)!;
    expect(sum.arrivals.map((a) => a.id)).toEqual(['a', 'b', 'h']);
    expect(sum.missing).toEqual([]);
  });
  it('a member who declined or left does not block "all arrived"', () => {
    let s = newSession('s1', host, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], null, t0, dest);
    s = applyOp(s, 'a', { v: 1, op: 'accept', sid: 's1', t: t0 }, t0)!;
    s = applyOp(s, 'b', { v: 1, op: 'decline', sid: 's1', t: t0 }, t0)!;
    s = { ...s, arrived: { h: 1, a: 2 } };
    expect(allArrived(s)).toBe(true);
  });
  it('host leaves: the joined member with the smallest id takes over, on every peer', () => {
    const s = joined();
    expect(successor(s, 'h')).toBe('a');
    const leave: DriveAlongOp = { v: 1, op: 'leave', sid: 's1', t: t0 + 9 };
    const atA = applyOp(s, 'h', leave, t0 + 10)!;
    expect(atA.owner).toBe('a');
    expect(atA.members.h!.state).toBe('left');
    // The new host can end it; the old one no longer can.
    expect(applyOp(atA, 'h', { v: 1, op: 'stop', sid: 's1', t: t0 }, t0)).toBe(atA);
    expect(applyOp(atA, 'a', { v: 1, op: 'stop', sid: 's1', t: t0 }, t0)).toBeNull();
    // Nobody left to take over: it is over.
    const solo = newSession('s1', host, [{ id: 'a', name: 'A' }], null, t0, dest);
    expect(applyOp(solo, 'h', leave, t0)).toBeNull();
  });
  it('host adds crewmates later: newcomers are invited, a missed destination change becomes a prompt', () => {
    let s = joined();
    const more = inviteOp(newSession('s1', host, [{ id: 'c', name: 'C' }], null, t0, dest), t0);
    s = applyOp(s, 'h', { ...more, rev: 2 } as DriveAlongOp, t0 + 2)!;
    expect(s.members.c!.state).toBe('invited');
    expect(s.pendingDest?.rev).toBe(2);
    // A non-host cannot add people.
    expect(applyOp(s, 'a', inviteOp(newSession('s1', host, [{ id: 'd', name: 'D' }], null, t0), t0), t0)).toBe(s);
  });
  it('arrival radius and rough ETA', () => {
    expect(atDestination({ lat: dest.lat + 0.0003, lng: dest.lng }, dest)).toBe(true);
    expect(atDestination({ lat: dest.lat + 0.01, lng: dest.lng }, dest)).toBe(false);
    const eta = roughEtaMs({ lat: dest.lat + 0.09, lng: dest.lng }, dest);
    expect(eta).toBeGreaterThan(5 * 60_000);
    expect(eta).toBeLessThan(30 * 60_000);
  });
  it('member rows: arrived first, then by ETA; own nav ETA beats the guess', () => {
    const s = { ...joined(), arrived: { b: t0 + 50 } };
    const rows = groupRows(s, 'h', { lat: dest.lat + 0.05, lng: dest.lng, eta: null }, { a: { lat: dest.lat + 0.01, lng: dest.lng, eta: t0 + 1000 } }, t0);
    expect(rows.map((r) => [r.id, r.status])).toEqual([['b', 'arrived'], ['a', 'driving'], ['h', 'driving']]);
    expect(rows[1]!.etaAt).toBe(t0 + 1000);
    expect(rows[2]!.etaAt).toBeGreaterThan(t0);
  });
  it('live presence stops 5 min after I arrived; the drive does not end for the others', () => {
    let s = joined();
    s = heard(heard(s, 'a', t0 + 10), 'b', t0 + 10);
    s = { ...s, arrived: { a: t0 + 100 } };
    expect(tick(s, 'a', t0 + 100 + DRIVE_ALONG.arrivedLingerMs - 1, null).end).toBeNull();
    expect(tick(s, 'a', t0 + 100 + DRIVE_ALONG.arrivedLingerMs + 1, null).end).toBe('arrived');
    expect(tick(s, 'b', t0 + 100 + DRIVE_ALONG.arrivedLingerMs + 1, null).end).toBeNull();
  });
  it('regression: parking that began before the session does not end it on the first tick', () => {
    const s = joined();
    const parkedHourAgo = t0 - 3600_000;
    expect(tick(s, 'h', t0 + 5000, parkedHourAgo).end).toBeNull();
    expect(tick(s, 'h', t0 + DRIVE_ALONG.parkedEndMs + 5000, parkedHourAgo).end).toBe('parked');
  });
});
