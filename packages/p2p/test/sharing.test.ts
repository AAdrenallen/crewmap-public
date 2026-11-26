import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp, type CircleState } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { open } from '../src/crypto/envelope';
import { fromUtf8, unb64 } from '../src/crypto/sodium';
import { Router } from '../src/router';
import { PresenceBook, PresencePublisher, type FriendPresence, type Presence } from '../src/presence';
import { DEFAULT_SHARING, mergePresence, migrateCrewStorage, normalizePolicy, profileForPolicy, type SharingPolicy } from '../src/sharing';
import { TestNet, tick } from './net';

function circleOf(owner: DeviceIdentity, others: DeviceIdentity[], name: string): CircleOp[] {
  const admin = new CircleAdmin(owner);
  let log = admin.create(name, 'Owner', Date.now());
  for (const o of others) log = [...log, ...admin.add(replay(log, owner), publicIdentity(o), 'M', Date.now())];
  return log;
}

function routerFor(net: TestNet, id: DeviceIdentity, st: CircleState) {
  const r = new Router({ self: id, circle: () => st, pool: net.pool(id.deviceId), publicRelays: ['wss://t'], retryMs: [50, 100] });
  r.start(Math.floor(Date.now() / 1000) - 60);
  return r;
}

const here: Presence = { lat: 45.651913, lng: -74.336937, acc: 5, spd: 27.4, hdg: 90, act: 'automotive', bat: 81, chg: true, t: Date.now(), prec: 'p', eta: 123456789 };

/** Plaintext of every event that left the phone and opens with this crew's keys. */
function plaintextFor(net: TestNet, st: CircleState): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  for (const ev of net.published) {
    try {
      const m = open(st, unb64(ev.content));
      out.push({ kind: m.kind, text: fromUtf8(m.payload) });
    } catch {
      // another crew's event (or not an envelope): not readable with these keys
    }
  }
  return out;
}

describe('Multiple crews + per-crew sharing (sender-side enforcement)', () => {
  it('each crew only ever receives what its policy allows (decrypting every outgoing event)', async () => {
    const net = new TestNet();
    const me = generateIdentity();
    const family = generateIdentity();
    const work = generateIdentity();
    const both = generateIdentity();
    const famLog = circleOf(me, [family, both], 'Family');
    const workLog = circleOf(me, [work, both], 'Work');
    const famSt = replay(famLog, me);
    const workSt = replay(workLog, me);
    expect(famSt.circleId).not.toBe(workSt.circleId);

    const famPub = new PresencePublisher(routerFor(net, me, famSt), () => [family.deviceId, both.deviceId]);
    const workPub = new PresencePublisher(routerFor(net, me, workSt), () => [work.deviceId, both.deviceId]);
    const workBook = new PresenceBook(routerFor(net, work, replay(workLog, work)));
    const workPolicy: SharingPolicy = { ...DEFAULT_SHARING, location: 'city', speed: false, battery: false };

    await famPub.publish(here, { ghost: false, policy: DEFAULT_SHARING });
    await workPub.publish(here, { ghost: false, policy: workPolicy });
    await tick();

    const fam = plaintextFor(net, famSt).filter((m) => m.kind === 'presence');
    expect(fam.some((m) => m.text.includes('45.651913'))).toBe(true);

    const workTexts = plaintextFor(net, workSt);
    expect(workTexts.length).toBeGreaterThan(0);
    expect(workTexts.every((m) => m.kind === 'presence')).toBe(true);
    const all = workTexts.map((m) => m.text).join('\n');
    expect(all).not.toContain('45.651913');
    expect(all).not.toContain('27.4');
    expect(all).not.toContain('"bat":81');
    expect(all).not.toContain('automotive');
    expect(all).not.toContain('123456789');
    const seen = workBook.get(me.deviceId)!;
    expect(seen.prec).toBe('c');
    expect(Math.abs(seen.lat - here.lat) + Math.abs(seen.lng - here.lng)).toBeGreaterThan(0.001);
    expect(seen.spd).toBeNull();
    expect(seen.bat).toBeNull();
  });

  it('approximate crews get a 2 km cell; hidden crews get only a pause marker', async () => {
    const net = new TestNet();
    const me = generateIdentity();
    const f = generateIdentity();
    const log = circleOf(me, [f], 'C');
    const st = replay(log, me);
    const pub = new PresencePublisher(routerFor(net, me, st), () => [f.deviceId]);
    const book = new PresenceBook(routerFor(net, f, replay(log, f)));
    await pub.publish(here, { ghost: false, policy: { ...DEFAULT_SHARING, location: 'approx' } });
    await tick();
    const a = book.get(me.deviceId)!;
    expect(a.prec).toBe('a');
    expect(a.acc).toBeGreaterThanOrEqual(1000);
    expect(a.spd).toBe(here.spd);
    await pub.publish({ ...here, t: here.t + 1 }, { ghost: false, policy: { ...DEFAULT_SHARING, location: 'hidden' } });
    await tick();
    expect(book.isPaused(me.deviceId)).toBe(true);
    const texts = plaintextFor(net, st).map((m) => m.text);
    expect(texts.join('\n')).not.toContain('45.651913');
  });

  it('profile stats are stripped per policy', () => {
    const profile = { deviceId: 'x', stats: { week: { period: 'week' as const, updatedAt: 1, avgScore: 91, trips: 4, longestTrip: { id: '', km: 30 } } } };
    expect(profileForPolicy(profile, { ...DEFAULT_SHARING, stats: false }).stats).toBeUndefined();
    const noTrips = profileForPolicy(profile, { ...DEFAULT_SHARING, trips: false }).stats!.week as Record<string, unknown>;
    expect(noTrips.avgScore).toBe(91);
    expect(noTrips.trips).toBeUndefined();
    expect(noTrips.longestTrip).toBeUndefined();
    expect(profileForPolicy(profile, DEFAULT_SHARING)).toEqual(profile);
  });

  it('a friend in two crews merges to the most permissive view', () => {
    const base = { deviceId: 'f', receivedAt: 0, via: 'relay' as const };
    const city: FriendPresence = { ...here, ...base, prec: 'c', lat: 45.7, spd: null, bat: 50, t: here.t + 10 };
    const exact: FriendPresence = { ...here, ...base, bat: null, t: here.t };
    const m = mergePresence(city, exact)!;
    expect(m.prec).toBe('p');
    expect(m.lat).toBe(here.lat);
    expect(m.bat).toBe(50);
    expect(mergePresence(null, city)).toBe(city);
  });

  it('migrates single-circle storage to the crew list without losing the circle or its invites', () => {
    const invites = [{ inviteId: 'i1', secret: 's', expiresAt: 99, used: false }];
    const v2 = migrateCrewStorage({ circleId: 'c1', invites }, null);
    expect(v2.circles).toEqual(['c1']);
    expect(v2.invites.c1).toEqual(invites);
    expect(normalizePolicy(v2.sharing.c1)).toEqual(DEFAULT_SHARING);
    expect(migrateCrewStorage({ circleId: 'old' }, v2)).toBe(v2);
    expect(migrateCrewStorage({ circleId: null }, null)).toEqual({ circles: [], invites: {}, sharing: {} });
  });
});
