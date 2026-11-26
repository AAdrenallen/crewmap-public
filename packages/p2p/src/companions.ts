import type { Kind } from './router';
import type { DeviceIdentity } from './crypto/identity';
import { openFrom, sealTo } from './crypto/envelope';
import { fromUtf8, utf8 } from './crypto/sodium';
import { driveAlongAllowed, stripPresence, type SharingPolicy } from './sharing';
import type { Presence } from './presence';

/**
 * Friend companion features on the wire (D31): drive-along session ops, the live presence stream, shared route
 * lines, "ask for location" and live ETA shares. Every payload is box-sealed to its one recipient, so a crew member
 * who sees the relay event (sealed with the shared epoch key) still cannot read it. Policy is enforced here, on the
 * sending side, with the policy of the crew that carries the message.
 */

/** Kinds whose payload must be sealed to one recipient. */
export const COMPANION_KINDS = ['drive-along', 'presence-live', 'route-share', 'loc-request', 'eta-share', 'where-ask'] as const satisfies readonly Kind[];
export type CompanionKind = (typeof COMPANION_KINDS)[number];

export const isCompanionKind = (k: Kind): k is CompanionKind => (COMPANION_KINDS as readonly string[]).includes(k);

/**
 * Which crews may carry a companion kind. Drive-along needs exact location (it exists to show precise positions);
 * asking for location needs any location; live ETA needs the speed/ETA field and some location.
 */
export function companionKindAllowed(kind: CompanionKind, pol: SharingPolicy): boolean {
  switch (kind) {
    case 'drive-along':
    case 'presence-live':
    case 'route-share':
      return driveAlongAllowed(pol);
    case 'loc-request':
      return pol.location !== 'hidden';
    case 'where-ask':
      // Asking carries no location. A one-time share answers an explicit request and bypasses the standing policy by design (D47).
      return true;
    case 'eta-share':
      return pol.location !== 'hidden' && pol.speed;
  }
}

/** Live presence as the crew policy allows it (never the offline trail, never ghost). Null = must not send. */
export function livePresenceFor(p: Presence, pol: SharingPolicy, ghost: boolean): Presence | null {
  if (ghost || !driveAlongAllowed(pol)) return null;
  const { trail: _trail, ...rest } = stripPresence(p, pol);
  return { ...rest, prec: 'p' };
}

export function sealJson(recipientBoxPk: Uint8Array, value: unknown): Uint8Array {
  return sealTo(recipientBoxPk, utf8(JSON.stringify(value)));
}

export function openJson(me: DeviceIdentity, payload: Uint8Array): unknown {
  try {
    return JSON.parse(fromUtf8(openFrom(me, payload))) as unknown;
  } catch {
    return null;
  }
}

/** Shared route (payload of 'route-share'): a thinned line, the destination name and ETA. `line: []` withdraws it. */
export interface RouteShare {
  v: 1;
  sid: string;
  line: [number, number][];
  dest: string;
  eta: number | null;
  t: number;
}

export function parseRouteShare(raw: unknown): RouteShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.sid !== 'string' || !Array.isArray(o.line) || o.line.length > 1000 || typeof o.t !== 'number') return null;
  const line = (o.line as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return { v: 1, sid: o.sid, line, dest: typeof o.dest === 'string' ? o.dest.slice(0, 60) : '', eta: typeof o.eta === 'number' ? o.eta : null, t: o.t };
}
