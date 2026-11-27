import { describe, expect, it } from 'vitest';
import {
  applyOp,
  arrivalGaps,
  CONVOY,
  ConvoyCallouts,
  convoyCrew,
  convoyLeader,
  convoyOp,
  ConvoyTracker,
  followLine,
  gapLabel,
  groupSummary,
  inviteOp,
  lightsBetween,
  markArrived,
  neighbours,
  newSession,
  parseOp,
  regroupAudience,
  RegroupWatch,
  sessionFromInvite,
  type DriveAlongSession,
} from '../src/companions';
import { destination, type LatLng } from '../src/geo';

const t0 = 1_000_000;
const dest = { name: 'Mont Royal', lat: 45.5048, lng: -73.5878 };
const host = { id: 'h', name: 'Host' };
const start: LatLng = { lat: 45.4, lng: -73.6 };

/** A 10 km line due north, one vertex every 100 m. */
const line: LatLng[] = Array.from({ length: 101 }, (_, i) => destination(start, 0, i * 100));
const at = (m: number, sideM = 0): LatLng => (sideM ? destination(destination(start, 0, m), 90, sideM) : destination(start, 0, m));

function convoy(): DriveAlongSession {
  let s = newSession('s1', host, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], null, t0, dest, true);
  for (const id of ['a', 'b']) s = applyOp(s, id, { v: 1, op: 'accept', sid: 's1', t: t0 }, t0 + 1)!;
  return s;
}

describe('convoy session ops', () => {
  it('invite carries the convoy and its leader; old readers just see a group drive', () => {
    const s = newSession('s1', host, [{ id: 'a', name: 'A' }], null, t0, dest, true);
    const op = inviteOp(s, t0);
    const parsed = parseOp(JSON.parse(JSON.stringify(op)));
    expect(parsed).toEqual(op);
    if (parsed?.op !== 'invite') throw new Error('invite');
    const mine = sessionFromInvite(parsed, 'h', 'a', t0);
    expect(convoyLeader(mine)).toBe('h');
    expect(parseOp({ v: 1, op: 'convoy', sid: 's1', t: 1, on: 'yes', leader: 'a', rev: 1 })).toBeNull();
  });

  it('host picks the leader; the leader may hand over; others and stale revisions are ignored', () => {
    let s = convoy();
    s = applyOp(s, 'h', convoyOp(s, true, 'a', t0), t0)!;
    expect(convoyLeader(s)).toBe('a');
    // A non-leader member cannot take the lead.
    expect(applyOp(s, 'b', { ...convoyOp(s, true, 'b', t0) }, t0)).toBe(s);
    // The leader hands over to b.
    const hand = convoyOp(s, true, 'b', t0);
    s = applyOp(s, 'a', hand, t0)!;
    expect(convoyLeader(s)).toBe('b');
    // A late, older revision does not undo it.
    expect(applyOp(s, 'h', { ...hand, leader: 'a', rev: 1 }, t0)).toBe(s);
    // The leader cannot turn convoy mode off; the host can.
    expect(applyOp(s, 'b', convoyOp(s, false, 'b', t0), t0)).toBe(s);
    s = applyOp(s, 'h', convoyOp(s, false, 'b', t0), t0)!;
    expect(convoyLeader(s)).toBeNull();
  });

  it('a leader must be a joined member', () => {
    let s = newSession('s1', host, [{ id: 'a', name: 'A' }], null, t0, dest, true);
    s = applyOp(s, 'h', convoyOp(s, true, 'a', t0), t0)!;
    expect(convoyLeader(s)).toBe('h');
  });

  it('a leaving leader hands the lead to the host; a leaving host-leader to the successor', () => {
    let s = convoy();
    s = applyOp(s, 'h', convoyOp(s, true, 'b', t0), t0)!;
    const left = applyOp(s, 'b', { v: 1, op: 'leave', sid: 's1', t: t0 }, t0)!;
    expect(convoyLeader(left)).toBe('h');
    const hostLeft = applyOp(convoy(), 'h', { v: 1, op: 'leave', sid: 's1', t: t0 }, t0)!;
    expect(hostLeft.owner).toBe('a');
    expect(convoyLeader(hostLeft)).toBe('a');
  });
});

describe('convoy tracker', () => {
  it('orders along the route and measures distance gaps along it, not straight line', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    tr.update('h', { ...at(5000), t: t0, spd: 15 });
    tr.update('a', { ...at(4200, 30), t: t0, spd: 15 });
    tr.update('b', { ...at(2000), t: t0, spd: 15 });
    tr.update('x', { ...at(3000, 2000), t: t0, spd: 15 });
    const rows = tr.standings(['b', 'x', 'a', 'h'], new Set());
    expect(rows.map((r) => [r.id, r.order])).toEqual([['h', 1], ['a', 2], ['b', 3], ['x', null]]);
    expect(rows[1]!.gapM).toBeCloseTo(800, -1);
    expect(rows[2]!.gapM).toBeCloseTo(2200, -1);
    expect(rows[3]!.onRoute).toBe(false);
    expect(neighbours(rows, 'a')).toMatchObject({ ahead: { id: 'h' }, behind: { id: 'b' } });
  });

  it('time gap = when the car ahead passed my point (from its history)', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    // h drives at 20 m/s from 0; b follows 90 s later at the same speed.
    for (let s = 0; s <= 300; s += 2) {
      const t = t0 + s * 1000;
      tr.update('h', { ...at(s * 20), t, spd: 20 });
      if (s >= 90) tr.update('b', { ...at((s - 90) * 20), t, spd: 20 });
    }
    const rows = tr.standings(['h', 'b'], new Set());
    expect(rows[1]!.gapS).toBeCloseTo(90, 0);
    expect(rows[1]!.gapM).toBeCloseTo(1800, -1);
    expect(tr.relative('b', 'h')!.s).toBeCloseTo(90, 0);
    expect(tr.relative('h', 'b')!.m).toBeCloseTo(-1800, -1);
  });

  it('a leader reroute keeps the line behind the leader: followers keep their place and time gap', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    for (let s = 0; s <= 300; s += 2) {
      const t = t0 + s * 1000;
      tr.update('h', { ...at(s * 20), t, spd: 20 });
      if (s >= 90) tr.update('b', { ...at((s - 90) * 20), t, spd: 20 });
    }
    // At 6 km the leader takes another way: a new line from its position, 300 m east then north.
    const from = at(6000);
    const detour = [from, destination(from, 90, 300), ...Array.from({ length: 30 }, (_, i) => destination(destination(from, 90, 300), 0, (i + 1) * 100))];
    tr.setLine(detour, 'h');
    const rows = tr.standings(['h', 'b'], new Set());
    expect(rows.map((r) => r.order)).toEqual([1, 2]);
    expect(rows[1]!.gapS).toBeCloseTo(90, 0);
    // The leader continues on the detour and stays on the line.
    expect(tr.update('h', { ...destination(destination(from, 90, 300), 0, 200), t: t0 + 330_000, spd: 20 })).toBeGreaterThan(6400);
    // A line that does not start near the leader is a new line: everything resets.
    tr.setLine(line.slice(5), 'h');
    expect(tr.standings(['b'], new Set())[0]!.order).toBeNull();
  });

  it('falls back to distance over speed when the history does not reach back', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    tr.update('h', { ...at(3000), t: t0, spd: 20 });
    tr.update('b', { ...at(1000), t: t0, spd: 20 });
    expect(tr.standings(['h', 'b'], new Set())[1]!.gapS).toBeCloseTo(100, 0);
  });

  it('a doubling-back route keeps each car on its own leg (windowed projection)', () => {
    // Out 2 km north, back 2 km south 40 m to the east: the legs are closer than the on-route tolerance.
    const out = Array.from({ length: 21 }, (_, i) => destination(start, 0, i * 100));
    const back = Array.from({ length: 21 }, (_, i) => destination(destination(start, 0, 2000 - i * 100), 90, 40));
    const tr = new ConvoyTracker();
    tr.setLine([...out, ...back]);
    let along = 0;
    for (let m = 0; m <= 3500; m += 100) {
      // GPS noise pulls the return leg 30 m west, nearer the outbound leg than its own.
      const p = m <= 2000 ? destination(start, 0, m) : destination(destination(start, 0, 4000 - m), 90, 10);
      along = tr.update('h', { ...p, t: t0 + m * 50, spd: 20 })!;
    }
    expect(along).toBeGreaterThan(3300);
  });

  it('arrived members sit at the front; a new line resets the tracks', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    tr.update('h', { ...at(9000), t: t0, spd: 10 });
    tr.update('a', { ...at(9500), t: t0, spd: 10 });
    expect(tr.standings(['h', 'a'], new Set(['h']))[0]!.id).toBe('h');
    tr.setLine(line.slice(10));
    expect(tr.standings(['h'], new Set())[0]!.order).toBeNull();
  });

  it('order map and lights between two points', () => {
    expect(lightsBetween([100, 300, 900], 50, 300)).toBe(2);
    expect(lightsBetween([100, 300, 900], 900, 300)).toBe(1);
    expect(lightsBetween(undefined, 0, 1)).toBeNull();
  });
});

describe('convoy callouts and regroup', () => {
  it('labels: lights on short gaps, then minutes, then metres', () => {
    expect(gapLabel('behind', 100, 20, 1)).toBeNull();
    expect(gapLabel('behind', 600, 50, 2)).toEqual({ dir: 'behind', kind: 'lights', n: 2 });
    expect(gapLabel('behind', 600, 50, 5)).toEqual({ dir: 'behind', kind: 'm', n: 500 });
    expect(gapLabel('ahead', 3000, 250, 6)).toEqual({ dir: 'ahead', kind: 'min', n: 3 });
    expect(gapLabel('ahead', 300, 30, null)).toBeNull();
  });

  it('a label must hold, and callouts respect the cooldown', () => {
    const c = new ConvoyCallouts();
    const two = gapLabel('behind', 600, 50, 2);
    expect(c.update(two, t0)).toBeNull();
    expect(c.update(two, t0 + CONVOY.calloutHoldMs)).toEqual(two);
    expect(c.update(two, t0 + 2 * CONVOY.calloutHoldMs)).toBeNull();
    const three = gapLabel('behind', 900, 70, 3);
    c.update(three, t0 + 20_000);
    // Held but still in the cooldown.
    expect(c.update(three, t0 + 40_000)).toBeNull();
    expect(c.update(three, t0 + CONVOY.calloutHoldMs + CONVOY.calloutEveryMs)).toEqual(three);
  });

  it('regroup fires once after the hold, re-arms only after closing the gap, and never for an unknown gap', () => {
    const w = new RegroupWatch();
    const lim = { m: 2000, s: 180 };
    expect(w.update(2500, 100, lim, t0)).toBe(false);
    expect(w.update(2500, 100, lim, t0 + CONVOY.regroupHoldMs)).toBe(true);
    expect(w.update(2600, 100, lim, t0 + CONVOY.regroupHoldMs + 1000)).toBe(false);
    // Dipping just under the limit does not re-arm.
    w.update(1900, 100, lim, t0 + 60_000);
    w.update(2500, 100, lim, t0 + 400_000);
    expect(w.update(2500, 100, lim, t0 + 400_000 + CONVOY.regroupHoldMs)).toBe(false);
    // Closing the gap re-arms; after the cooldown it fires again (time limit this time).
    w.update(500, 30, lim, t0 + 500_000);
    w.update(800, 200, lim, t0 + 600_000);
    expect(w.update(800, 200, lim, t0 + 600_000 + CONVOY.regroupHoldMs)).toBe(true);
    expect(new RegroupWatch().update(null, null, lim, t0)).toBe(false);
  });

  it('audience: the leader and the car ahead of the gap, never the straggler', () => {
    const tr = new ConvoyTracker();
    tr.setLine(line);
    tr.update('h', { ...at(6000), t: t0, spd: 15 });
    tr.update('a', { ...at(5000), t: t0, spd: 15 });
    tr.update('b', { ...at(1000), t: t0, spd: 15 });
    const rows = tr.standings(['h', 'a', 'b'], new Set());
    expect(regroupAudience(rows, 'h', 'b')).toEqual(['a', 'h']);
    expect(regroupAudience(rows, 'b', 'b')).toEqual(['a']);
  });
});

describe('convoy helpers', () => {
  it('follow line starts at me and runs to the end of the leader line', () => {
    const f = followLine(line, at(3000, 50))!;
    expect(f[0]).toEqual(at(3000, 50));
    expect(f[f.length - 1]!.lat).toBeCloseTo(line[100]!.lat, 6);
    expect(followLine(line, at(9990))).toBeNull();
  });

  it('crew for mute: session crew, else the first crew holding every joined member', () => {
    const s = convoy();
    const crews = [
      { id: 'z', memberIds: ['h', 'a', 'b'] },
      { id: 'c', memberIds: ['h', 'a'] },
      { id: 'd', memberIds: ['h', 'a', 'b', 'q'] },
    ];
    expect(convoyCrew(s, crews)).toBe('d');
    expect(convoyCrew({ ...s, crew: 'c' }, crews)).toBe('c');
    expect(convoyCrew(s, [])).toBeNull();
  });

  it('arrival gaps after the first arrival', () => {
    let s = convoy();
    s = markArrived(s, 'a', t0 + 60_000);
    s = markArrived(s, 'h', t0 + 240_000);
    expect(arrivalGaps(groupSummary(s)!).map((r) => [r.id, r.afterS])).toEqual([['a', 0], ['h', 180]]);
  });
});
