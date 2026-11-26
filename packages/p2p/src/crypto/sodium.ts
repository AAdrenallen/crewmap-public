/**
 * The libsodium subset CrewMap uses. Matches the `libsodium-wrappers` API, which `react-native-libsodium`
 * (the app, JSI) and `libsodium-wrappers-sumo` (Node tests, simulator) both implement. Only functions present in
 * react-native-libsodium's supported list are allowed here.
 */
export interface Sodium {
  ready: Promise<void>;
  crypto_sign_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string };
  crypto_sign_detached(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_sign_verify_detached(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: string | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: string | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_keygen(): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array | string, key?: Uint8Array | null): Uint8Array;
  crypto_kdf_derive_from_key(subkeyLength: number, subkeyId: number, context: string, key: Uint8Array): Uint8Array;
  crypto_secretbox_easy(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_secretbox_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_pwhash(keyLength: number, password: Uint8Array | string, salt: Uint8Array, opsLimit: number, memLimit: number, algorithm: number): Uint8Array;
  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  randombytes_buf(length: number): Uint8Array;
  to_base64(input: Uint8Array, variant?: number): string;
  from_base64(input: string, variant?: number): Uint8Array;
  to_hex(input: Uint8Array): string;
  base64_variants: { ORIGINAL: number; URLSAFE_NO_PADDING: number };
}

let impl: Sodium | null = null;

/** Called once at startup by the app (react-native-libsodium) or tests (libsodium-wrappers-sumo). */
export async function initSodium(s: Sodium): Promise<void> {
  await s.ready;
  impl = s;
}

export function sodium(): Sodium {
  if (!impl) throw new Error('sodium not initialised: call initSodium() first');
  return impl;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function b64(bytes: Uint8Array): string {
  const s = sodium();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
}

export function unb64(str: string): Uint8Array {
  const s = sodium();
  return s.from_base64(str, s.base64_variants.URLSAFE_NO_PADDING);
}

export function hex(bytes: Uint8Array): string {
  return sodium().to_hex(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function readU32be(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, false);
}

/** Constant-time comparison for equal-length byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Keyed BLAKE2b, `len` bytes, domain-separated by `label`. */
export function keyedHash(key: Uint8Array, label: string, ...parts: Uint8Array[]): Uint8Array {
  return sodium().crypto_generichash(32, concat(utf8(label), new Uint8Array([0]), ...parts), key);
}
