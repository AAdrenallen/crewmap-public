import { concat, fromUtf8, keyedHash, sodium, u32be, utf8 } from './sodium';

/**
 * Short join codes (D34): a 6-character code that unlocks a full invite link published, sealed, on the relays for
 * ten minutes. The code only has ~29.7 bits, so the key and the rendezvous topic both come out of argon2id
 * (crypto_pwhash) salted with the 10-minute time bucket: no cheap hash of the code ever reaches a relay, and no
 * table can be precomputed for future buckets. Single use is enforced by the one-time invite inside, not by this layer.
 */

/** Crockford-style, minus the ambiguous 0 O 1 I L: 31 symbols. */
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_TTL_MS = 10 * 60_000;
export const JOIN_CODE_BUCKET_MS = 10 * 60_000;
/** Live codes one crew may have at a time. */
export const JOIN_CODE_MAX_LIVE = 3;
export const JOIN_CODE_MAX_FAILS = 5;
export const JOIN_CODE_LOCKOUT_MS = 60_000;

export function generateJoinCode(): string {
  const s = sodium();
  const n = JOIN_CODE_ALPHABET.length;
  const limit = 256 - (256 % n); // rejection sampling: no modulo bias
  let out = '';
  while (out.length < JOIN_CODE_LENGTH) {
    for (const b of s.randombytes_buf(16)) {
      if (b < limit && out.length < JOIN_CODE_LENGTH) out += JOIN_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

/** Uppercases and strips spaces/dashes; null unless exactly 6 alphabet symbols remain. */
export function normaliseJoinCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s\-_.]/g, '');
  if (c.length !== JOIN_CODE_LENGTH) return null;
  for (const ch of c) if (!JOIN_CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/** `ABC123` → `ABC 123`. */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export interface PwhashCost {
  ops: number;
  mem: number;
}

/** libsodium's INTERACTIVE argon2id limits (the only ones react-native-libsodium exposes). */
export function defaultPwhashCost(): PwhashCost {
  const s = sodium();
  return { ops: s.crypto_pwhash_OPSLIMIT_INTERACTIVE, mem: s.crypto_pwhash_MEMLIMIT_INTERACTIVE };
}

export const joinCodeBucket = (atMs: number): number => Math.floor(atMs / JOIN_CODE_BUCKET_MS);

export interface JoinCodeKeys {
  topic: string;
  key: Uint8Array;
}

export function deriveJoinCode(code: string, bucket: number, cost: PwhashCost = defaultPwhashCost()): JoinCodeKeys {
  const s = sodium();
  const salt = s.crypto_generichash(s.crypto_pwhash_SALTBYTES, concat(utf8('crewmap-join-code-v1'), new Uint8Array([0]), u32be(bucket)));
  const master = s.crypto_pwhash(32, utf8(code), salt, cost.ops, cost.mem, s.crypto_pwhash_ALG_ARGON2ID13);
  return { topic: s.to_hex(keyedHash(master, 'code-topic')).slice(0, 32), key: keyedHash(master, 'code-key') };
}

/** Tolerated clock skew between the two phones. */
export const JOIN_CODE_SKEW_MS = 2 * 60_000;

/**
 * Buckets a joiner tries at `now`: current and previous (a code lives at most one bucket length), plus the next one
 * when close to its start (admin clock ahead). Each costs one pwhash.
 */
export function joinCodeBuckets(now: number): number[] {
  const b = joinCodeBucket(now);
  const out = [b, b - 1];
  if (joinCodeBucket(now + JOIN_CODE_SKEW_MS) !== b) out.push(b + 1);
  return out;
}

interface CodeBody {
  l: string;
  e: number;
}

/** nonce ‖ secretbox({link, expiresAt}). */
export function sealJoinCode(key: Uint8Array, link: string, expiresAt: number): Uint8Array {
  const s = sodium();
  const nonce = s.randombytes_buf(24);
  return concat(nonce, s.crypto_secretbox_easy(utf8(JSON.stringify({ l: link, e: expiresAt } satisfies CodeBody)), nonce, key));
}

/** The link, or null when the key is wrong, the blob is malformed or the code has expired. */
export function openJoinCode(key: Uint8Array, sealed: Uint8Array, now: number): string | null {
  if (sealed.length < 24 + 16) return null;
  try {
    const body = JSON.parse(fromUtf8(sodium().crypto_secretbox_open_easy(sealed.slice(24), sealed.slice(0, 24), key))) as CodeBody;
    if (typeof body.l !== 'string' || typeof body.e !== 'number' || body.e < now) return null;
    return body.l;
  } catch {
    return null;
  }
}

/** Joiner-side attempt limiter (a UX guard against fat fingers and casual guessing, not a security boundary). */
export interface CodeLockout {
  fails: number;
  until: number;
}

export const NO_LOCKOUT: CodeLockout = { fails: 0, until: 0 };

export function lockoutRemainingMs(l: CodeLockout, now: number): number {
  return Math.max(0, l.until - now);
}

export function recordCodeAttempt(l: CodeLockout, ok: boolean, now: number): CodeLockout {
  if (ok) return NO_LOCKOUT;
  const fails = l.fails + 1;
  return fails >= JOIN_CODE_MAX_FAILS ? { fails: 0, until: now + JOIN_CODE_LOCKOUT_MS } : { fails, until: 0 };
}
