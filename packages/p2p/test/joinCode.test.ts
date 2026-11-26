import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay } from '../src/crypto/circle';
import { generateIdentity } from '../src/crypto/identity';
import { acceptJoinRequest, buildJoinRequest, completeJoin, createInvite, decodeInvite, encodeInvite, inviteTopics } from '../src/crypto/invite';
import {
  deriveJoinCode,
  formatJoinCode,
  generateJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_BUCKET_MS,
  JOIN_CODE_LOCKOUT_MS,
  JOIN_CODE_TTL_MS,
  joinCodeBucket,
  joinCodeBuckets,
  lockoutRemainingMs,
  normaliseJoinCode,
  NO_LOCKOUT,
  openJoinCode,
  recordCodeAttempt,
  sealJoinCode,
  type PwhashCost,
} from '../src/crypto/joinCode';
import { sodium } from '../src/crypto/sodium';
import { publishJoinCode, resolveJoinCode } from '../src/transport/codeChannel';
import { publishSealed, subscribeSealed } from '../src/transport/inviteChannel';
import { TestNet, tick } from './net';

const NOW = 1_780_000_000_000;
/** argon2id minimum cost keeps the suite fast; one test runs the real INTERACTIVE cost. */
const CHEAP: PwhashCost = { ops: 1, mem: 8192 };

describe('join codes', () => {
  it('generates 6 symbols from the unambiguous alphabet', () => {
    expect(JOIN_CODE_ALPHABET).toHaveLength(31);
    for (const ch of '01OIL') expect(JOIN_CODE_ALPHABET).not.toContain(ch);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateJoinCode();
      expect(c).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });

  it('normalises typed and pasted input', () => {
    expect(normaliseJoinCode('abc 234')).toBe('ABC234');
    expect(normaliseJoinCode(' ab-c2 34\n')).toBe('ABC234');
    expect(normaliseJoinCode(formatJoinCode('XYZ789'))).toBe('XYZ789');
    expect(formatJoinCode('XYZ789')).toBe('XYZ 789');
    expect(normaliseJoinCode('ABC23')).toBeNull();
    expect(normaliseJoinCode('ABC2345')).toBeNull();
    expect(normaliseJoinCode('ABC230')).toBeNull(); // 0 is not in the alphabet
    expect(normaliseJoinCode('ABCI23')).toBeNull();
  });

  it('derives deterministically per code and bucket', () => {
    const a = deriveJoinCode('ABC234', 7, CHEAP);
    const b = deriveJoinCode('ABC234', 7, CHEAP);
    expect(a.topic).toBe(b.topic);
    expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(true);
    expect(a.topic).toHaveLength(32);
    expect(deriveJoinCode('ABC235', 7, CHEAP).topic).not.toBe(a.topic);
    expect(deriveJoinCode('ABC234', 8, CHEAP).topic).not.toBe(a.topic);
    expect(a.topic).not.toBe(sodium().to_hex(a.key).slice(0, 32));
  });

  it('runs with the real INTERACTIVE argon2id cost', () => {
    const k = deriveJoinCode('ABC234', 1);
    expect(k.key).toHaveLength(32);
  });

  it('tries the current and previous bucket, and the next near its start', () => {
    const start = 1000 * JOIN_CODE_BUCKET_MS;
    expect(joinCodeBuckets(start + 1000)).toEqual([1000, 999]);
    expect(joinCodeBuckets(start + JOIN_CODE_BUCKET_MS - 1000)).toEqual([1000, 999, 1001]);
  });

  it('seals and opens; wrong code, tampering and expiry fail', () => {
    const k = deriveJoinCode('ABC234', 3, CHEAP).key;
    const sealed = sealJoinCode(k, 'crewmap://join#x', NOW + JOIN_CODE_TTL_MS);
    expect(openJoinCode(k, sealed, NOW)).toBe('crewmap://join#x');
    expect(openJoinCode(deriveJoinCode('ABC235', 3, CHEAP).key, sealed, NOW)).toBeNull();
    const bad = sealed.slice();
    bad[30] = bad[30]! ^ 1;
    expect(openJoinCode(k, bad, NOW)).toBeNull();
    expect(openJoinCode(k, sealed, NOW + JOIN_CODE_TTL_MS + 1)).toBeNull();
    expect(openJoinCode(k, new Uint8Array(10), NOW)).toBeNull();
  });

  it('locks out after 5 wrong codes for 60 s; success resets', () => {
    let l = NO_LOCKOUT;
    for (let i = 0; i < 4; i++) l = recordCodeAttempt(l, false, NOW);
    expect(lockoutRemainingMs(l, NOW)).toBe(0);
    l = recordCodeAttempt(l, false, NOW);
    expect(lockoutRemainingMs(l, NOW)).toBe(JOIN_CODE_LOCKOUT_MS);
    expect(lockoutRemainingMs(l, NOW + JOIN_CODE_LOCKOUT_MS)).toBe(0);
    l = recordCodeAttempt(l, false, NOW + JOIN_CODE_LOCKOUT_MS);
    expect(l.fails).toBe(1);
    expect(recordCodeAttempt(l, true, NOW)).toEqual(NO_LOCKOUT);
  });

  it('two peers: code → sealed link on the relay → existing invite handshake', async () => {
    const NOW = Date.now();
    const net = new TestNet();
    const adminPool = net.pool('admin');
    const joinPool = net.pool('joiner');
    const owner = generateIdentity();
    const log = new CircleAdmin(owner).create('Crew', 'Owner', NOW);
    const st = replay(log, owner);
    const { token, pending } = createInvite(st, owner, NOW, [], JOIN_CODE_TTL_MS);
    const code = generateJoinCode();
    await publishJoinCode(adminPool, [], code, pending.inviteId, encodeInvite(token), NOW, CHEAP);
    expect(net.published[0]!.content).not.toContain(token.k);
    expect(net.published[0]!.tags.flat().join(' ')).not.toContain(code);

    // Wrong code finds nothing.
    expect(await resolveJoinCode(joinPool, [], code === 'ABC234' ? 'ABC235' : 'ABC234', NOW + 60_000, 20, CHEAP)).toBeNull();

    // Joiner types it, lowercase with a space, a minute later.
    const typed = normaliseJoinCode(formatJoinCode(code).toLowerCase())!;
    const link = await resolveJoinCode(joinPool, [], typed, NOW + 60_000, 1000, CHEAP);
    expect(link).toBe(encodeInvite(token));

    // Existing handshake over the same relay.
    const joiner = generateIdentity();
    const parsed = decodeInvite(link!);
    const topics = inviteTopics(pending.secret);
    let reply: Uint8Array | null = null;
    subscribeSealed(adminPool, [], topics.request, 0, (sealed) => {
      const res = acceptJoinRequest(st, owner, pending, sealed, NOW + 61_000);
      void publishSealed(adminPool, [], topics.reply, res.reply, 600, NOW + 61_000);
    });
    subscribeSealed(joinPool, [], topics.reply, 0, (sealed) => (reply = sealed));
    await publishSealed(joinPool, [], topics.request, buildJoinRequest(parsed, joiner, 'Alex'), 600, NOW + 60_500);
    await tick();
    expect(reply).not.toBeNull();
    expect(completeJoin(joiner, parsed, reply!).members.has(joiner.deviceId)).toBe(true);

    // Single use: a second joiner with the same code gets the link but the one-time invite refuses.
    const eve = generateIdentity();
    expect(() => acceptJoinRequest(st, owner, pending, buildJoinRequest(parsed, eve, 'Eve'), NOW + 62_000)).toThrow(/already used/);
    // After expiry the link no longer opens.
    expect(await resolveJoinCode(joinPool, [], typed, NOW + JOIN_CODE_TTL_MS + 1, 20, CHEAP)).toBeNull();
    expect(joinCodeBucket(NOW)).toBeGreaterThan(0);
  });
});
