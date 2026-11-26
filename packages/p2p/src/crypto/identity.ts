import { b64, hex, sodium, unb64 } from './sodium';

/** A device's long-term identity. Private keys are wrapped by platform secure storage (Keystore/Keychain). */
export interface DeviceIdentity {
  /** Stable id: hex of the first 16 bytes of BLAKE2b(signPk). */
  deviceId: string;
  signPk: Uint8Array;
  signSk: Uint8Array;
  boxPk: Uint8Array;
  boxSk: Uint8Array;
}

/** Public half, shared with circle members. */
export interface PublicIdentity {
  deviceId: string;
  signPk: string;
  boxPk: string;
}

export function deviceIdOf(signPk: Uint8Array): string {
  return hex(sodium().crypto_generichash(16, signPk));
}

export function generateIdentity(): DeviceIdentity {
  const s = sodium();
  const sign = s.crypto_sign_keypair();
  const box = s.crypto_box_keypair();
  return {
    deviceId: deviceIdOf(sign.publicKey),
    signPk: sign.publicKey,
    signSk: sign.privateKey,
    boxPk: box.publicKey,
    boxSk: box.privateKey,
  };
}

export function publicIdentity(id: DeviceIdentity): PublicIdentity {
  return { deviceId: id.deviceId, signPk: b64(id.signPk), boxPk: b64(id.boxPk) };
}

/** Serialised form for secure storage (expo-secure-store). */
export function exportIdentity(id: DeviceIdentity): string {
  return JSON.stringify({ v: 1, signPk: b64(id.signPk), signSk: b64(id.signSk), boxPk: b64(id.boxPk), boxSk: b64(id.boxSk) });
}

export function importIdentity(json: string): DeviceIdentity {
  const o = JSON.parse(json) as { v: number; signPk: string; signSk: string; boxPk: string; boxSk: string };
  if (o.v !== 1) throw new Error('unsupported identity version');
  const signPk = unb64(o.signPk);
  return { deviceId: deviceIdOf(signPk), signPk, signSk: unb64(o.signSk), boxPk: unb64(o.boxPk), boxSk: unb64(o.boxSk) };
}

export function verifyPublicIdentity(p: PublicIdentity): boolean {
  try {
    return deviceIdOf(unb64(p.signPk)) === p.deviceId && unb64(p.boxPk).length === 32;
  } catch {
    return false;
  }
}
