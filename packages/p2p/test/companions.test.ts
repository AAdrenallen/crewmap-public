import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/crypto/identity';
import { mergePresence } from '../src/sharing';
import { companionKindAllowed, COMPANION_KINDS, livePresenceFor, openJson, parseRouteShare, sealJson } from '../src/companions';
import { KINDS } from '../src/router';
import { BASELINE_CAPS, CAPS, capMask, LOCAL_CAP_MASK, PROTOCOL_VERSION, peerSupports, protocolStamp } from '../src/protocol';
import { DEFAULT_SHARING, type SharingPolicy } from '../src/sharing';
import type { Presence } from '../src/presence';

const here: Presence = { lat: 45.65191, lng: -74.33693, acc: 5, spd: 13.9, hdg: 90, act: 'automotive', bat: 81, chg: false, t: 1, prec: 'p', trail: [[1, 2, 3]] };
const pol = (p: Partial<SharingPolicy>): SharingPolicy => ({ ...DEFAULT_SHARING, ...p });

describe('companion protocol compat', () => {
  it('protocol 3 advertises drive-along, locate and ETA share', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
    const me = protocolStamp();
    expect(peerSupports(me, 'driveAlong')).toBe(true);
    expect(peerSupports(me, 'locate')).toBe(true);
    expect(peerSupports(me, 'etaShare')).toBe(true);
    expect(LOCAL_CAP_MASK & CAPS.driveAlong).toBeTruthy();
  });
  it('older builds degrade: protocol 1 (no cp), protocol 2 masks and unknown peers', () => {
    expect(peerSupports({}, 'driveAlong')).toBe(false);
    expect(BASELINE_CAPS).not.toContain('driveAlong');
    const v2 = { pv: 2, cp: capMask(['precisePresence', 'chat', 'hazards', 'arrivals', 'sharingPolicy']) };
    expect(peerSupports(v2, 'driveAlong')).toBe(false);
    expect(peerSupports(v2, 'locate')).toBe(false);
    expect(peerSupports(v2, 'chat')).toBe(true);
    expect(peerSupports(null, 'driveAlong')).toBeNull();
    // A precise-channel presence carries no stamp; the book keeps the earlier one (see compat.test), else unknown.
    expect(peerSupports({ pv: undefined, cp: undefined }, 'driveAlong')).toBe(false);
  });
  it('the live stream is never stored, acked or woken for; session ops are acked', () => {
    expect(KINDS['presence-live']).toMatchObject({ durable: false, ack: false, ttlS: 0 });
    expect(KINDS['drive-along'].ack).toBe(true);
    for (const k of COMPANION_KINDS) expect(KINDS[k].fn).toBe('presence');
  });
});

describe('group drive protocol', () => {
  it('protocol 5 advertises groupDrive; a driveAlong-only peer does not', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(5);
    expect(peerSupports(protocolStamp(), 'groupDrive')).toBe(true);
    const v4 = { pv: 4, cp: capMask(['precisePresence', 'chat', 'hazards', 'arrivals', 'sharingPolicy', 'driveAlong', 'locate', 'etaShare', 'viewerDemand']) };
    expect(peerSupports(v4, 'driveAlong')).toBe(true);
    expect(peerSupports(v4, 'groupDrive')).toBe(false);
    expect(peerSupports(null, 'groupDrive')).toBeNull();
  });
  it('merging crews keeps the capability stamp even when the winning presence has none', () => {
    const stamped: Presence = { ...here, prec: 'a', t: 5, ...protocolStamp() };
    const precise: Presence = { ...here, prec: 'p', t: 9 };
    const m = mergePresence(precise, stamped)!;
    expect(peerSupports(m, 'driveAlong')).toBe(true);
    expect(peerSupports(m, 'groupDrive')).toBe(true);
  });
});

describe('companion sharing policy (sender side)', () => {
  it('drive-along needs exact location; locate any; ETA share needs speed', () => {
    for (const k of ['drive-along', 'presence-live', 'route-share'] as const) {
      expect(companionKindAllowed(k, pol({}))).toBe(true);
      expect(companionKindAllowed(k, pol({ location: 'approx' }))).toBe(false);
      expect(companionKindAllowed(k, pol({ location: 'hidden' }))).toBe(false);
    }
    expect(companionKindAllowed('loc-request', pol({ location: 'city' }))).toBe(true);
    expect(companionKindAllowed('loc-request', pol({ location: 'hidden' }))).toBe(false);
    expect(companionKindAllowed('eta-share', pol({ speed: false }))).toBe(false);
    expect(companionKindAllowed('eta-share', pol({ location: 'approx' }))).toBe(true);
  });
  it('live presence strips what the policy forbids, never the trail, nothing in ghost or coarse crews', () => {
    const p = livePresenceFor(here, pol({ battery: false, speed: false }), false)!;
    expect(p.bat).toBeNull();
    expect(p.spd).toBeNull();
    expect(p.trail).toBeUndefined();
    expect(p.lat).toBe(here.lat);
    expect(livePresenceFor(here, pol({}), true)).toBeNull();
    expect(livePresenceFor(here, pol({ location: 'approx' }), false)).toBeNull();
  });
  it('payloads open only for their recipient', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const wire = sealJson(a.boxPk, { v: 1, x: 1 });
    expect(openJson(a, wire)).toEqual({ v: 1, x: 1 });
    expect(openJson(b, wire)).toBeNull();
  });
  it('route share parsing drops junk points', () => {
    const r = parseRouteShare({ v: 1, sid: 's', line: [[1, 2], [NaN, 1], 'x', [3, 4]], dest: 'D', eta: 5, t: 1 });
    expect(r?.line).toEqual([[1, 2], [3, 4]]);
    expect(parseRouteShare({ v: 1, sid: 's', line: 'x', t: 1 })).toBeNull();
  });
});

describe('location asks protocol (D47)', () => {
  it('protocol 6 advertises askWhere; a groupDrive-only peer does not, and an unknown peer is null', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(6);
    expect(peerSupports(protocolStamp(), 'askWhere')).toBe(true);
    const v5 = { pv: 5, cp: capMask(['precisePresence', 'chat', 'hazards', 'arrivals', 'sharingPolicy', 'driveAlong', 'locate', 'etaShare', 'viewerDemand', 'groupDrive']) };
    expect(peerSupports(v5, 'groupDrive')).toBe(true);
    expect(peerSupports(v5, 'askWhere')).toBe(false);
    expect(peerSupports(null, 'askWhere')).toBeNull();
  });
  it('asking is carried by every crew policy (it holds no location), including hidden', () => {
    for (const location of ['exact', 'approx', 'city', 'hidden'] as const) expect(companionKindAllowed('where-ask', pol({ location }))).toBe(true);
    expect(COMPANION_KINDS).toContain('where-ask');
  });
  it('payloads are sealed to one recipient: another member cannot open them', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    const sealed = sealJson(b.boxPk, { v: 1, op: 'ask', id: 'x', ask: 'once', t: 1 });
    expect(openJson(b, sealed)).toMatchObject({ op: 'ask' });
    expect(openJson(c, sealed)).toBeNull();
    expect(openJson(a, sealed)).toBeNull();
  });
});
