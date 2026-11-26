import { describe, expect, it } from 'vitest';
import {
  ASK,
  activeOnceShares,
  askGate,
  destinationCards,
  dismissAsk,
  expireAsks,
  incomingPrompts,
  minutesLeft,
  newAsk,
  parseAskOp,
  receiveAsk,
  resolveIncoming,
  shareOp,
  type AskEntry,
} from '../src/companions/ask';

const T = 1_000_000;
const place = { name: 'Mont Royal', lat: 45.5048, lng: -73.5878 };
const fix = { lat: 45.5017, lng: -73.5543, acc: 8 };

describe('ask wire parsing', () => {
  it('accepts well-formed ops and clamps text', () => {
    expect(parseAskOp({ v: 1, op: 'ask', id: 'a', ask: 'once', t: 1 })).toMatchObject({ ask: 'once' });
    const a = parseAskOp({ v: 1, op: 'answer', id: 'a', place: { name: 'x'.repeat(200), lat: 1, lng: 2 }, note: ' hi '.repeat(100), t: 1 });
    expect(a?.op === 'answer' && a.place.name.length).toBe(ASK.placeMax);
    expect(a?.op === 'answer' && a.note!.length).toBeLessThanOrEqual(ASK.noteMax);
  });
  it('rejects junk, bad coordinates and unknown ops', () => {
    expect(parseAskOp(null)).toBeNull();
    expect(parseAskOp({ v: 2, op: 'ask', id: 'a', ask: 'once', t: 1 })).toBeNull();
    expect(parseAskOp({ v: 1, op: 'ask', id: 'a', ask: 'live', t: 1 })).toBeNull();
    expect(parseAskOp({ v: 1, op: 'share', id: 'a', lat: 99, lng: 0, acc: 5, t: 1, until: 2 })).toBeNull();
    expect(parseAskOp({ v: 1, op: 'answer', id: 'a', place: { name: 'p', lat: NaN, lng: 0 }, t: 1 })).toBeNull();
    expect(parseAskOp({ v: 1, op: 'nope', id: 'a', t: 1 })).toBeNull();
  });
});

describe('rate limit', () => {
  it('one pending per pair and kind, then a cooldown', () => {
    const r1 = newAsk([], 'bob', 'once', 'a1', T);
    expect(r1.gate).toBe('ok');
    expect(newAsk(r1.entries, 'bob', 'once', 'a2', T + 1000).gate).toBe('pending');
    expect(newAsk(r1.entries, 'bob', 'where', 'a3', T + 1000).gate).toBe('ok');
    expect(newAsk(r1.entries, 'cy', 'once', 'a4', T + 1000).gate).toBe('ok');
    const declined = r1.entries.map((e) => ({ ...e, state: 'declined' as const }));
    expect(askGate(declined, 'out', 'bob', 'once', T + ASK.cooldownMs - 1)).toBe('cooldown');
    expect(askGate(declined, 'out', 'bob', 'once', T + ASK.cooldownMs)).toBe('ok');
  });
  it('the receiver drops a repeat ask and any ask from a muted sender', () => {
    const first = receiveAsk([], 'bob', { v: 1, op: 'ask', id: 'a1', ask: 'once', t: T }, T);
    expect(first.effect).toBe('prompt');
    const again = receiveAsk(first.entries, 'bob', { v: 1, op: 'ask', id: 'a2', ask: 'once', t: T + 5 }, T + 5);
    expect(again.effect).toBe('ignored');
    expect(again.entries).toHaveLength(1);
    expect(receiveAsk([], 'bob', { v: 1, op: 'ask', id: 'a9', ask: 'where', t: T }, T, true).effect).toBe('ignored');
  });
});

describe('where flow', () => {
  it('ask -> answer gives the asker a destination card; dismiss removes it', () => {
    const asker = newAsk([], 'bob', 'where', 'w1', T).entries;
    const got = receiveAsk(asker, 'bob', { v: 1, op: 'answer', id: 'w1', place, note: 'meet at the lookout', t: T + 10 }, T + 10);
    expect(got.effect).toBe('destination');
    expect(destinationCards(got.entries)).toHaveLength(1);
    expect(destinationCards(got.entries)[0]).toMatchObject({ place, note: 'meet at the lookout' });
    expect(destinationCards(dismissAsk(got.entries, 'w1'))).toHaveLength(0);
  });
  it('an answer from someone else, for a different kind, or twice is ignored', () => {
    const asker = newAsk([], 'bob', 'where', 'w1', T).entries;
    expect(receiveAsk(asker, 'eve', { v: 1, op: 'answer', id: 'w1', place, t: T }, T).effect).toBe('ignored');
    const once = newAsk([], 'bob', 'once', 'o1', T).entries;
    expect(receiveAsk(once, 'bob', { v: 1, op: 'answer', id: 'o1', place, t: T }, T).effect).toBe('ignored');
    const done = receiveAsk(asker, 'bob', { v: 1, op: 'answer', id: 'w1', place, t: T }, T).entries;
    expect(receiveAsk(done, 'bob', { v: 1, op: 'answer', id: 'w1', place: { ...place, name: 'Other' }, t: T }, T).effect).toBe('ignored');
  });
  it('a where-card lapses after cardMs', () => {
    const asker = newAsk([], 'bob', 'where', 'w1', T).entries;
    const got = receiveAsk(asker, 'bob', { v: 1, op: 'answer', id: 'w1', place, t: T }, T).entries;
    expect(destinationCards(expireAsks(got, T + ASK.cardMs - 1))).toHaveLength(1);
    expect(destinationCards(expireAsks(got, T + ASK.cardMs))).toHaveLength(0);
  });
});

describe('one-time share', () => {
  it('share -> visible for the chosen time, then wiped on the asker', () => {
    const asker = newAsk([], 'bob', 'once', 'o1', T).entries;
    const op = shareOp('o1', fix, 15, T + 1000);
    expect(op.until).toBe(T + 1000 + 15 * 60_000);
    const got = receiveAsk(asker, 'bob', op, T + 1000);
    expect(got.effect).toBe('shared');
    expect(activeOnceShares(got.entries, T + 2000)).toHaveLength(1);
    expect(minutesLeft(op.until, T + 1000 + 12 * 60_000 + 30_000)).toBe(3);
    const after = expireAsks(got.entries, op.until);
    expect(activeOnceShares(after, op.until)).toHaveLength(0);
    expect(after.every((e) => !e.loc)).toBe(true);
  });
  it('clamps an over-long or already-expired claim', () => {
    const asker = newAsk([], 'bob', 'once', 'o1', T).entries;
    const long = receiveAsk(asker, 'bob', { ...shareOp('o1', fix, 15, T), until: T + 99 * 3_600_000 }, T);
    expect(long.entries[0]!.until).toBe(T + ASK.maxShareMs);
    expect(receiveAsk(asker, 'bob', { ...shareOp('o1', fix, 15, T), until: T - 1 }, T).effect).toBe('ignored');
  });
  it('an unsolicited share (no pending ask of mine) is ignored: the policy is bypassed only for a request', () => {
    expect(receiveAsk([], 'bob', shareOp('zz', fix, 15, T), T).effect).toBe('ignored');
  });
  it('shareOp clamps minutes to the longest option', () => {
    expect(shareOp('x', fix, 9999, T).until).toBe(T + Math.max(...ASK.onceMinutes) * 60_000);
  });
  it('decline ends the pending ask; unanswered asks lapse', () => {
    const asker = newAsk([], 'bob', 'once', 'o1', T).entries;
    expect(receiveAsk(asker, 'bob', { v: 1, op: 'decline', id: 'o1', t: T }, T).entries[0]!.state).toBe('declined');
    expect(expireAsks(asker, T + ASK.pendingMs).some((e) => e.state === 'pending')).toBe(false);
    expect(expireAsks(asker, T + ASK.cooldownMs - 1)[0]!.state).toBe('pending');
  });
});

describe('recipient side', () => {
  it('resolves a prompt once and the entry then expires', () => {
    const inc = receiveAsk([], 'bob', { v: 1, op: 'ask', id: 'a1', ask: 'once', t: T }, T).entries;
    expect(incomingPrompts(inc)).toHaveLength(1);
    const shared = resolveIncoming(inc, 'a1', 'shared', { until: T + 900_000 });
    expect(incomingPrompts(shared)).toHaveLength(0);
    expect(resolveIncoming(shared, 'a1', 'declined')[0]!.state).toBe('shared');
    const gone = expireAsks(shared, T + 900_000);
    expect(gone[0]!.state).toBe('expired');
    expect(expireAsks(gone, T + ASK.cooldownMs + 900_000)).toHaveLength(0);
  });
});

describe('invariants', () => {
  it('does not mutate its input', () => {
    const e: AskEntry[] = [{ id: 'a', dir: 'out', peer: 'b', ask: 'once', state: 'pending', t: T }];
    const snap = JSON.stringify(e);
    receiveAsk(e, 'b', { v: 1, op: 'decline', id: 'a', t: T }, T);
    expireAsks(e, T + ASK.pendingMs);
    expect(JSON.stringify(e)).toBe(snap);
  });
});
