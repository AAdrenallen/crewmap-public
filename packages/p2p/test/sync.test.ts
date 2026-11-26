import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { open } from '../src/crypto/envelope';
import { fromUtf8, unb64 } from '../src/crypto/sodium';
import { Router } from '../src/router';
import { CircleSync, MemoryPersistence } from '../src/sync';
import { PresenceBook, PresencePublisher, type Presence } from '../src/presence';
import { TestNet, tick } from './net';

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function phone(net: TestNet, id: DeviceIdentity, log: CircleOp[]) {
  const st = replay(log, id);
  const pool = net.pool(id.deviceId);
  const router = new Router({ self: id, circle: () => st, pool, publicRelays: ['wss://t'], retryMs: [50, 100] });
  router.start(Math.floor(Date.now() / 1000) - 60);
  return { id, st, pool, router };
}

const here: Presence = { lat: 45.65191, lng: -74.33693, acc: 5, spd: 13.9, hdg: 90, act: 'automotive', bat: 81, chg: false, t: Date.now(), prec: 'p' };

describe('X5 CRDT sync incl. offline catch-up', () => {
  it('edits made while a peer is offline reach it on reconnect (durable relay events + state vectors)', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [a, b, c] = ids.map((id) => phone(net, id, log));
    const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const syncs = [a!, b!, c!].map((p, i) => new CircleSync(docs[i]!, p.router, new MemoryPersistence()));
    for (const s of syncs) await s.start();
    docs[0]!.getMap('places').set('home-a', { name: 'Home', lat: 45.6, lng: -74.3, radiusM: 150, owner: a!.id.deviceId });
    await tick();
    expect((docs[1]!.getMap('places').get('home-a') as { name: string }).name).toBe('Home');

    net.online.set(c!.id.deviceId, false);
    docs[1]!.getMap('places').set('gym-b', { name: 'Gym', lat: 45.61, lng: -74.31, radiusM: 120, owner: b!.id.deviceId });
    docs[0]!.getMap('profiles').set(a!.id.deviceId, { name: 'A', car: 'pickup' });
    await tick();
    expect(docs[2]!.getMap('places').has('gym-b')).toBe(false);

    net.online.set(c!.id.deviceId, true);
    c!.pool.reconnect();
    await syncs[2]!.announce();
    await tick();
    await tick();
    expect(docs[2]!.getMap('places').has('gym-b')).toBe(true);
    expect((docs[2]!.getMap('profiles').get(a!.id.deviceId) as { car: string }).car).toBe('pickup');
    expect(Y.encodeStateVector(docs[2]!)).toEqual(Y.encodeStateVector(docs[0]!));
  });

  it('F7: a private place never appears in any sync payload; shared ones do', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const a = phone(net, ids[0]!, log);
    phone(net, ids[1]!, log);
    const doc = new Y.Doc();
    const sync = new CircleSync(doc, a.router, new MemoryPersistence());
    await sync.start();
    // The app keeps private places only in local SQLite; only shared ones are written to the doc.
    const privatePlace = { id: 'secret-clinic', name: 'Clinic', lat: 45.123456, lng: -74.654321, visibility: 'private' };
    const sharedPlace = { id: 'home', name: 'Home', lat: 45.6519, lng: -74.3369, visibility: 'shared' };
    for (const p of [privatePlace, sharedPlace]) if (p.visibility === 'shared') doc.getMap('places').set(p.id, p);
    await tick();
    // Decrypt every event that left the phone and search the plaintext.
    const plain = net.published.map((ev) => {
      const m = open(a.st, unb64(ev.content));
      // Yjs encodes strings as UTF-8 inside updates, so a plain decode exposes every name/number.
      return fromUtf8(m.payload);
    });
    const all = plain.join('\n');
    expect(all).toContain('Home');
    expect(all).not.toContain('Clinic');
    expect(all).not.toContain('45.123456');
    // And the ciphertext that relays see contains neither.
    expect(net.published.map((e) => e.content).join('')).not.toContain('Home');
  });
});

describe('X2 presence: ghost mode and per-friend precision', () => {
  it('approximate friends get a ~2 km cell; precise friends get the exact fix; ghost pauses for everyone', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [me, preciseFriend, approxFriend] = ids.map((id) => phone(net, id, log));
    const pub = new PresencePublisher(me!.router, () => [preciseFriend!.id.deviceId, approxFriend!.id.deviceId]);
    const bookP = new PresenceBook(preciseFriend!.router, preciseFriend!.id);
    const bookA = new PresenceBook(approxFriend!.router, approxFriend!.id);
    const pks = new Map([preciseFriend!, approxFriend!].map((x) => [x.id.deviceId, x.id.boxPk]));
    const settings = { ghost: false, overrides: { [approxFriend!.id.deviceId]: { location: 'approx' as const, speed: false } }, boxPkOf: (id: string) => pks.get(id) ?? null };
    await pub.publish(here, settings);
    await tick();
    await pub.publish({ ...here, t: here.t + 1 }, settings);
    await tick();
    const p = bookP.get(me!.id.deviceId)!;
    const a = bookA.get(me!.id.deviceId)!;
    expect(p.prec).toBe('p');
    expect(p.lat).toBeCloseTo(here.lat, 6);
    expect(a.prec).toBe('a');
    expect(Math.abs(a.lat - here.lat)).toBeGreaterThan(0.0001);
    expect(a.spd).toBeNull();
    // The approx friend can't open the precise event.
    expect(a.lat).not.toBeCloseTo(here.lat, 4);

    await pub.publish({ ...here, t: here.t + 2 }, { ...settings, ghost: true });
    await tick();
    expect(bookP.isPaused(me!.id.deviceId)).toBe(true);
    expect(bookP.get(me!.id.deviceId)).toBeNull();
    expect(bookA.get(me!.id.deviceId)).toBeNull();
  });
});
