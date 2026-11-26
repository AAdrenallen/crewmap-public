import type { CircleState } from './circle';
import type { DeviceIdentity } from './identity';
import { b64, concat, fromUtf8, readU32be, sodium, u32be, unb64, utf8 } from './sodium';

export const ENVELOPE_VERSION = 1;
const NONCE = 24;
/** Messages under epochs older than current − GRACE are rejected (old keys may be known to removed members). */
export const EPOCH_GRACE = 1;

export interface Opened {
  id: string;
  sender: string;
  kind: string;
  sentAt: number;
  payload: Uint8Array;
  epoch: number;
}

export class EnvelopeError extends Error {}

/** Additional data is a string: react-native-libsodium only accepts string AAD (UTF-8, same as libsodium-wrappers). */
function aad(circleId: string, epoch: number): string {
  return `crewmap/v1|${circleId}|${epoch}`;
}

function sigInput(circleId: string, epoch: number, inner: Uint8Array): Uint8Array {
  return concat(utf8('crewmap/msg/v1|'), utf8(circleId), u32be(epoch), inner);
}

/**
 * Encrypt + sign a message for the whole circle under the current epoch key.
 * Wire: [ver:1][epoch:u32][nonce:24][AEAD(innerLen:u32 | innerJSON | ed25519sig:64)].
 */
export function seal(st: CircleState, me: DeviceIdentity, kind: string, payload: Uint8Array, now: number): Uint8Array {
  return sealWithId(st, me, kind, payload, now).wire;
}

export function sealWithId(
  st: CircleState,
  me: DeviceIdentity,
  kind: string,
  payload: Uint8Array,
  now: number,
): { id: string; wire: Uint8Array } {
  const s = sodium();
  const key = st.epochKeys.get(st.epoch);
  if (!key) throw new EnvelopeError('no key for current epoch');
  const id = b64(s.randombytes_buf(12));
  const inner = utf8(JSON.stringify({ id, s: me.deviceId, k: kind, t: now, p: b64(payload) }));
  const sig = s.crypto_sign_detached(sigInput(st.circleId, st.epoch, inner), me.signSk);
  const plain = concat(u32be(inner.length), inner, sig);
  const nonce = s.randombytes_buf(NONCE);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, aad(st.circleId, st.epoch), null, nonce, key);
  return { id, wire: concat(new Uint8Array([ENVELOPE_VERSION]), u32be(st.epoch), nonce, ct) };
}

/** Decrypt + verify. Throws EnvelopeError for anything not from a current member under a valid epoch. */
export function open(st: CircleState, wire: Uint8Array): Opened {
  const s = sodium();
  if (wire.length < 1 + 4 + NONCE + 16 || wire[0] !== ENVELOPE_VERSION) throw new EnvelopeError('bad envelope');
  const epoch = readU32be(wire, 1);
  if (epoch < st.epoch - EPOCH_GRACE) throw new EnvelopeError('stale epoch');
  const key = st.epochKeys.get(epoch);
  if (!key) throw new EnvelopeError('unknown epoch');
  const nonce = wire.subarray(5, 5 + NONCE);
  let plain: Uint8Array;
  try {
    plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wire.subarray(5 + NONCE), aad(st.circleId, epoch), nonce, key);
  } catch {
    throw new EnvelopeError('decrypt failed');
  }
  const len = readU32be(plain, 0);
  const inner = plain.subarray(4, 4 + len);
  const sig = plain.subarray(4 + len);
  const msg = JSON.parse(fromUtf8(inner)) as { id: string; s: string; k: string; t: number; p: string };
  const member = st.members.get(msg.s);
  if (!member || st.removed.has(msg.s)) throw new EnvelopeError('sender not a member');
  if (!s.crypto_sign_verify_detached(sig, sigInput(st.circleId, epoch, inner), unb64(member.signPk))) {
    throw new EnvelopeError('bad signature');
  }
  return { id: msg.id, sender: msg.s, kind: msg.k, sentAt: msg.t, payload: unb64(msg.p), epoch };
}

/** Encrypt directly to one device (join replies, direct key delivery). Anonymous sender; content self-authenticates. */
export function sealTo(recipientBoxPk: Uint8Array, payload: Uint8Array): Uint8Array {
  return sodium().crypto_box_seal(payload, recipientBoxPk);
}

export function openFrom(me: DeviceIdentity, wire: Uint8Array): Uint8Array {
  return sodium().crypto_box_seal_open(wire, me.boxPk, me.boxSk);
}
