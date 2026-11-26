import { CircleAdmin, canonical, replay, type CircleOp, type CircleState } from './circle';
import { openFrom, sealTo } from './envelope';
import type { DeviceIdentity, PublicIdentity } from './identity';
import { verifyPublicIdentity } from './identity';
import { b64, bytesEqual, fromUtf8, hex, keyedHash, sodium, unb64, utf8 } from './sodium';

/** What the QR code / one-time link carries. Never sent to a server: links put it in the URL fragment. */
export interface InviteToken {
  v: 1;
  /** circle id */
  c: string;
  /** circle name (display only) */
  n: string;
  /** invite id */
  i: string;
  /** one-time secret */
  k: string;
  /** issuer device id, box pk, sign pk */
  o: string;
  b: string;
  s: string;
  /** expires at (epoch ms) */
  e: number;
  /** relay hints */
  r: string[];
}

export interface PendingInvite {
  inviteId: string;
  secret: Uint8Array;
  expiresAt: number;
  used: boolean;
}

export const INVITE_TTL_MS = 24 * 3600_000;
const LINK_PREFIX = 'crewmap://join#';

export function createInvite(
  st: CircleState,
  issuer: DeviceIdentity,
  now: number,
  relays: string[],
  ttlMs = INVITE_TTL_MS,
): { token: InviteToken; pending: PendingInvite } {
  const s = sodium();
  const secret = s.randombytes_buf(32);
  const inviteId = b64(s.randombytes_buf(9));
  const token: InviteToken = {
    v: 1,
    c: st.circleId,
    n: st.name,
    i: inviteId,
    k: b64(secret),
    o: issuer.deviceId,
    b: b64(issuer.boxPk),
    s: b64(issuer.signPk),
    e: now + ttlMs,
    r: relays,
  };
  return { token, pending: { inviteId, secret, expiresAt: now + ttlMs, used: false } };
}

export function encodeInvite(t: InviteToken): string {
  return LINK_PREFIX + b64(utf8(canonical(t)));
}

/**
 * Newer builds may add fields (ignored here) and bump `v`; the fields below are the stable core every version keeps,
 * so an invite from a newer or older build still opens. Tolerates surrounding whitespace.
 */
export function decodeInvite(raw: string): InviteToken {
  const link = raw.trim();
  const i = link.indexOf('#');
  if (!link.startsWith('crewmap://join') || i < 0) throw new Error('not a CrewMap invite');
  let t: InviteToken;
  try {
    t = JSON.parse(fromUtf8(unb64(link.slice(i + 1)))) as InviteToken;
  } catch {
    throw new Error('malformed invite');
  }
  if (typeof t.v !== 'number' || t.v < 1 || !t.c || !t.i || !t.k || !t.b || !t.s || typeof t.e !== 'number') throw new Error('malformed invite');
  if (!Array.isArray(t.r)) t.r = [];
  return t;
}

/** Nostr topics (tag values) for the join handshake, derived from the secret so only holders can find them. */
export function inviteTopics(secret: Uint8Array): { request: string; reply: string } {
  return {
    request: hex(keyedHash(secret, 'invite-request')).slice(0, 32),
    reply: hex(keyedHash(secret, 'invite-reply')).slice(0, 32),
  };
}

interface JoinRequestBody {
  inviteId: string;
  proof: string;
  member: PublicIdentity;
  name: string;
  sig: string;
}

/** Joiner → issuer, sealed to the issuer's box key. */
export function buildJoinRequest(token: InviteToken, me: DeviceIdentity, name: string): Uint8Array {
  const s = sodium();
  const secret = unb64(token.k);
  const member: PublicIdentity = { deviceId: me.deviceId, signPk: b64(me.signPk), boxPk: b64(me.boxPk) };
  const unsigned = { inviteId: token.i, proof: b64(keyedHash(secret, 'join-proof', me.signPk)), member, name };
  const sig = b64(s.crypto_sign_detached(utf8(canonical(unsigned)), me.signSk));
  return sealTo(unb64(token.b), utf8(JSON.stringify({ ...unsigned, sig } satisfies JoinRequestBody)));
}

export class InviteError extends Error {}

/**
 * Issuer side: validate a join request against a pending one-time invite and produce the membership ops plus the
 * sealed reply (the full op log, so the joiner can replay and open its epoch key).
 */
export function acceptJoinRequest(
  st: CircleState,
  issuer: DeviceIdentity,
  pending: PendingInvite,
  wire: Uint8Array,
  now: number,
): { ops: CircleOp[]; reply: Uint8Array; member: PublicIdentity; name: string } {
  const s = sodium();
  if (pending.used) throw new InviteError('invite already used');
  if (now > pending.expiresAt) throw new InviteError('invite expired');
  let body: JoinRequestBody;
  try {
    body = JSON.parse(fromUtf8(openFrom(issuer, wire))) as JoinRequestBody;
  } catch {
    throw new InviteError('cannot open join request');
  }
  if (body.inviteId !== pending.inviteId) throw new InviteError('wrong invite');
  if (!verifyPublicIdentity(body.member)) throw new InviteError('bad identity');
  const signPk = unb64(body.member.signPk);
  if (!bytesEqual(unb64(body.proof), keyedHash(pending.secret, 'join-proof', signPk))) throw new InviteError('bad proof');
  const { sig, ...unsigned } = body;
  if (!s.crypto_sign_verify_detached(unb64(sig), utf8(canonical(unsigned)), signPk)) throw new InviteError('bad signature');
  if (st.members.has(body.member.deviceId)) throw new InviteError('already a member');
  const name = body.name.trim().slice(0, 40) || 'Friend';
  const ops = new CircleAdmin(issuer).add(st, body.member, name, now, 'member', pending.inviteId);
  pending.used = true;
  const fullLog = [...st.ops, ...ops];
  const reply = sealTo(unb64(body.member.boxPk), utf8(JSON.stringify(fullLog)));
  return { ops, reply, member: body.member, name };
}

/** Joiner side: open the reply and replay the log (verifies every op and opens our epoch key). */
export function completeJoin(me: DeviceIdentity, token: InviteToken, reply: Uint8Array): CircleState {
  const ops = JSON.parse(fromUtf8(openFrom(me, reply))) as CircleOp[];
  const st = replay(ops, me);
  if (st.circleId !== token.c) throw new InviteError('reply is for another circle');
  const issuer = st.members.get(token.o);
  if (!issuer || issuer.signPk !== token.s) throw new InviteError('issuer mismatch');
  if (!st.members.has(me.deviceId) || !st.epochKeys.has(st.epoch)) throw new InviteError('not added');
  return st;
}
