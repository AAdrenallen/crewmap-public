import { describe, expect, it } from 'vitest';
import { CircleAdmin, mergeLogs, replay, signOp, type CircleOp } from '../src/crypto/circle';
import { open, seal } from '../src/crypto/envelope';
import { exportIdentity, generateIdentity, importIdentity, publicIdentity } from '../src/crypto/identity';
import {
  acceptJoinRequest,
  buildJoinRequest,
  completeJoin,
  createInvite,
  decodeInvite,
  encodeInvite,
} from '../src/crypto/invite';
import { utf8, fromUtf8 } from '../src/crypto/sodium';

const NOW = 1_780_000_000_000;

function circleOf3() {
  const owner = generateIdentity();
  const alex = generateIdentity();
  const sam = generateIdentity();
  const admin = new CircleAdmin(owner);
  let log: CircleOp[] = admin.create('Crew', 'Owner', NOW);
  log = [...log, ...admin.add(replay(log, owner), publicIdentity(alex), 'Alex', NOW + 1)];
  log = [...log, ...admin.add(replay(log, owner), publicIdentity(sam), 'Sam', NOW + 2)];
  return { owner, alex, sam, admin, log };
}

describe('X1 identity', () => {
  it('round-trips through secure-storage serialisation', () => {
    const id = generateIdentity();
    const back = importIdentity(exportIdentity(id));
    expect(back.deviceId).toBe(id.deviceId);
    expect(back.signSk).toEqual(id.signSk);
  });
});

describe('X1 circle membership + E2E encryption', () => {
  it('members read each other; every member derives the same state', () => {
    const { owner, alex, sam, log } = circleOf3();
    const so = replay(log, owner);
    const sa = replay(log, alex);
    const ss = replay(log, sam);
    expect(so.members.size).toBe(3);
    expect(sa.head).toBe(so.head);
    const wire = seal(sa, alex, 'presence', utf8('{"lat":45.65}'), NOW);
    const got = open(ss, wire);
    expect(got.sender).toBe(alex.deviceId);
    expect(fromUtf8(got.payload)).toBe('{"lat":45.65}');
    expect(open(so, wire).kind).toBe('presence');
  });

  it('a non-member cannot read, and cannot inject', () => {
    const { owner, alex, log } = circleOf3();
    const outsider = generateIdentity();
    const st = replay(log, outsider);
    expect(st.epochKeys.size).toBe(0);
    const wire = seal(replay(log, alex), alex, 'presence', utf8('secret'), NOW);
    expect(() => open(st, wire)).toThrow(/unknown epoch/);
    // Outsider forging a message with a guessed key and a non-member signer.
    const ownerSt = replay(log, owner);
    const fake = { ...ownerSt, epochKeys: new Map([[ownerSt.epoch, new Uint8Array(32)]]) };
    const forged = seal(fake, outsider, 'presence', utf8('x'), NOW);
    expect(() => open(replay(log, owner), forged)).toThrow();
  });

  it('a removed member cannot read new data; key rotates; old-epoch injection is rejected', () => {
    const { owner, alex, sam, admin, log } = circleOf3();
    const samBefore = replay(log, sam);
    const log2 = [...log, ...admin.remove(replay(log, owner), sam.deviceId, NOW + 10)];
    const ownerAfter = replay(log2, owner);
    const alexAfter = replay(log2, alex);
    const samAfter = replay(log2, sam); // sam can still fetch and replay the public log…
    expect(ownerAfter.epoch).toBe(samBefore.epoch + 1);
    expect(samAfter.epochKeys.has(ownerAfter.epoch)).toBe(false); // …but has no new key.
    const wire = seal(alexAfter, alex, 'presence', utf8('after removal'), NOW + 11);
    expect(() => open(samAfter, wire)).toThrow();
    expect(() => open(samBefore, wire)).toThrow();
    expect(fromUtf8(open(ownerAfter, wire).payload)).toBe('after removal');
    // Sam still knows the previous epoch key and tries to inject under it → rejected (not a member).
    const injected = seal(samBefore, sam, 'presence', utf8('spoof'), NOW + 12);
    expect(() => open(ownerAfter, injected)).toThrow(/not a member/);
  });

  it('a new member cannot read messages from before they joined', () => {
    const { owner, alex, admin, log } = circleOf3();
    const old = seal(replay(log, alex), alex, 'presence', utf8('before'), NOW);
    const late = generateIdentity();
    const log2 = [...log, ...admin.add(replay(log, owner), publicIdentity(late), 'Late', NOW + 20)];
    expect(() => open(replay(log2, late), old)).toThrow();
  });

  it('rejects tampered logs, non-admin ops and forged signatures', () => {
    const { owner, alex, sam, log } = circleOf3();
    const st = replay(log, owner);
    // Alex (member) tries to remove Sam.
    const bad = signOp({ circleId: st.circleId, seq: st.seq + 1, prev: st.head, at: NOW, by: alex.deviceId, body: { type: 'remove', deviceId: sam.deviceId } }, alex);
    expect(() => replay([...log, bad])).toThrow(/not an admin/);
    // Tampered body.
    const tampered = log.map((op, i) => (i === 2 ? { ...op, at: op.at + 1 } : op));
    expect(() => replay(tampered)).toThrow(/bad signature/);
    // Reordered.
    expect(() => replay([log[0]!, log[2]!, log[1]!, ...log.slice(3)])).toThrow();
    // Epoch sealed to a non-member set.
    const fakeEpoch = signOp({ circleId: st.circleId, seq: st.seq + 1, prev: st.head, at: NOW, by: owner.deviceId, body: { type: 'epoch', epoch: st.epoch + 1, sealed: {} } }, owner);
    expect(() => replay([...log, fakeEpoch])).toThrow(/sealed set/);
  });

  it('weekly rotation gives everyone the new key', () => {
    const { owner, alex, admin, log } = circleOf3();
    const log2 = [...log, ...admin.rotate(replay(log, owner), NOW + 7 * 86_400_000)];
    const a = replay(log2, alex);
    expect(a.epochKeys.has(a.epoch)).toBe(true);
    expect(fromUtf8(open(a, seal(replay(log2, owner), owner, 'k', utf8('hi'), NOW)).payload)).toBe('hi');
  });

  it('concurrent admin forks resolve identically on every device', () => {
    const { owner, alex, admin, log } = circleOf3();
    const ownerAdm = admin;
    let base = [...log, ...ownerAdm.setRole(replay(log, owner), alex.deviceId, 'admin', NOW + 1)];
    const alexAdm = new CircleAdmin(alex);
    const a = [...base, ...alexAdm.rename(replay(base, alex), 'Alex name', NOW + 2)];
    const b = [...base, ...ownerAdm.rename(replay(base, owner), 'Owner name', NOW + 2)];
    const m1 = mergeLogs(a, b);
    const m2 = mergeLogs(b, a);
    expect(replay(m1).head).toBe(replay(m2).head);
    base = m1;
    expect(replay(base).seq).toBe(replay(a).seq);
  });
});

describe('X1 invites (QR / one-time link)', () => {
  it('join via invite: one-time, expiring, proof-checked', () => {
    const owner = generateIdentity();
    const admin = new CircleAdmin(owner);
    const log = admin.create('Crew', 'Owner', NOW);
    const st = replay(log, owner);
    const { token, pending } = createInvite(st, owner, NOW, ['wss://nos.lol']);
    const link = encodeInvite(token);
    expect(link.startsWith('crewmap://join#')).toBe(true);
    const parsed = decodeInvite(link);

    const joiner = generateIdentity();
    const req = buildJoinRequest(parsed, joiner, 'Alex');
    const res = acceptJoinRequest(st, owner, pending, req, NOW + 1000);
    expect(res.name).toBe('Alex');
    const joined = completeJoin(joiner, parsed, res.reply);
    expect(joined.members.has(joiner.deviceId)).toBe(true);
    const ownerSt = replay([...log, ...res.ops], owner);
    expect(fromUtf8(open(ownerSt, seal(joined, joiner, 'hello', utf8('yo'), NOW)).payload)).toBe('yo');

    // Reuse fails.
    const other = generateIdentity();
    expect(() => acceptJoinRequest(ownerSt, owner, pending, buildJoinRequest(parsed, other, 'Eve'), NOW + 2000)).toThrow(/already used/);
    // Expired fails.
    const { token: t2, pending: p2 } = createInvite(ownerSt, owner, NOW, []);
    expect(() => acceptJoinRequest(ownerSt, owner, p2, buildJoinRequest(t2, other, 'Eve'), NOW + 25 * 3600_000)).toThrow(/expired/);
    // Wrong secret (attacker who saw only the invite id) fails.
    const { token: t3, pending: p3 } = createInvite(ownerSt, owner, NOW, []);
    const forgedToken = { ...t3, k: token.k };
    expect(() => acceptJoinRequest(ownerSt, owner, p3, buildJoinRequest(forgedToken, other, 'Eve'), NOW + 10)).toThrow(/bad proof/);
  });
});
