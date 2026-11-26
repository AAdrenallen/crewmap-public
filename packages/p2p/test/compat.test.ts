import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { acceptJoinRequest, buildJoinRequest, completeJoin, createInvite, decodeInvite, encodeInvite } from '../src/crypto/invite';
import { seal, sealWithId } from '../src/crypto/envelope';
import { fromUtf8, utf8 } from '../src/crypto/sodium';
import { Router } from '../src/router';
import { CircleSync, MemoryPersistence } from '../src/sync';
import { PresenceBook, PresencePublisher, type Presence } from '../src/presence';
import { PROTOCOL_VERSION, peerSupports, protocolOf } from '../src/protocol';
import type { RelayPool } from '../src/transport/types';
import { TestNet, tick } from './net';

const here: Presence = { lat: 45.65191, lng: -74.33693, acc: 5, spd: 13.9, hdg: 90, act: 'automotive', bat: 81, chg: false, t: Date.now(), prec: 'p' };

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

/** What a protocol-1 build does with presence: reads the original fields only, has no chat handler. */
function oldPeer(router: Router) {
  const seen: { lat: number; lng: number }[] = [];
  router.on('presence', (m) => {
    const p = JSON.parse(fromUtf8(m.payload)) as { lat: number; lng: number };
    seen.push({ lat: p.lat, lng: p.lng });
  });
  return seen;
}

describe('invites across versions', () => {
  it('a newer invite (higher v, extra fields) still opens and joins; v1 joins a newer issuer', () => {
    for (const v of [1, 3]) {
      const issuer = generateIdentity();
      const joiner = generateIdentity();
      const st = replay(new CircleAdmin(issuer).create('Crew', 'Issuer', Date.now()), issuer);
      const { token, pending } = createInvite(st, issuer, Date.now(), ['wss://a']);
      const future = { ...token, v, future: { x: 1 } } as unknown as typeof token;
      const back = decodeInvite(` ${encodeInvite(future)}\n`);
      expect(back.c).toBe(st.circleId);
      const req = buildJoinRequest(back, joiner, 'Joiner');
      const res = acceptJoinRequest(st, issuer, pending, req, Date.now());
      expect(completeJoin(joiner, back, res.reply).members.has(joiner.deviceId)).toBe(true);
    }
  });

  it('garbage and expired invites fail with distinguishable errors', () => {
    expect(() => decodeInvite('https://example.com')).toThrow('not a CrewMap invite');
    expect(() => decodeInvite('crewmap://join#@@@')).toThrow('malformed invite');
    const issuer = generateIdentity();
    const st = replay(new CircleAdmin(issuer).create('C', 'I', Date.now()), issuer);
    const { token, pending } = createInvite(st, issuer, Date.now() - 3 * 86_400_000, []);
    expect(decodeInvite(encodeInvite(token)).e).toBeLessThan(Date.now());
    const req = buildJoinRequest(token, generateIdentity(), 'J');
    expect(() => acceptJoinRequest(st, issuer, pending, req, Date.now())).toThrow('invite expired');
  });
});

describe('old and new peers in one crew', () => {
  it('presence both ways: the old peer ignores the stamp, the new one reads an unstamped peer as protocol 1', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const nu = phone(net, ids[0]!, log);
    const old = phone(net, ids[1]!, log);
    const oldSaw = oldPeer(old.router);
    const book = new PresenceBook(nu.router);
    const pub = new PresencePublisher(nu.router, () => [old.id.deviceId]);
    await pub.publish(here, { ghost: false });
    await tick();
    expect(oldSaw).toEqual([{ lat: here.lat, lng: here.lng }]);

    await old.router.broadcast('presence', utf8(JSON.stringify({ ...here, t: here.t + 1 })));
    await tick();
    const fp = book.get(old.id.deviceId)!;
    expect(fp.lat).toBe(here.lat);
    expect(protocolOf(fp).version).toBe(1);
    expect(peerSupports(fp, 'chat')).toBe(false);
    expect(peerSupports(fp, 'precisePresence')).toBe(true);
    expect(peerSupports(null, 'chat')).toBeNull();
  });

  it('a new peer is recognised as chat-capable, also through the precise channel', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [a, b, c] = ids.map((id) => phone(net, id, log));
    const book = new PresenceBook(c!.router, c!.id);
    const pub = new PresencePublisher(a!.router, () => [b!.id.deviceId, c!.id.deviceId]);
    const pks = new Map([b!, c!].map((x) => [x.id.deviceId, x.id.boxPk]));
    await pub.publish(here, { ghost: false, overrides: { [b!.id.deviceId]: { location: 'approx' } }, boxPkOf: (id) => pks.get(id) ?? null });
    await tick();
    const fp = book.get(a!.id.deviceId)!;
    expect(fp.prec).toBe('p');
    expect(peerSupports(fp, 'chat')).toBe(true);
    expect(protocolOf(fp).version).toBe(PROTOCOL_VERSION);
  });

  it('unknown kinds, unknown envelope versions and throwing handlers never break delivery', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const a = phone(net, ids[0]!, log);
    const b = phone(net, ids[1]!, log);
    const got: string[] = [];
    b.router.on('presence', () => {
      throw new Error('handler blew up on a payload from another version');
    });
    b.router.on('presence', () => got.push('second handler'));
    b.router.receive(sealWithId(a.st, a.id, 'hologram', utf8('{"from":"the future"}'), Date.now()).wire, 'nostr');
    await a.router.broadcast('presence', utf8('{broken'));
    await tick();
    expect(got).toEqual(['second handler']);

    const sealed = seal(a.st, a.id, 'presence', utf8('{}'), Date.now());
    const bumped = Uint8Array.from(sealed);
    bumped[0] = 9;
    const before = b.router.stats.rejected;
    b.router.receive(bumped, 'direct', a.id.deviceId);
    b.router.receive(new Uint8Array(64), 'nostr');
    expect(b.router.stats.rejected).toBe(before + 2);

    await a.router.broadcast('presence', utf8(JSON.stringify(here)));
    await tick();
    expect(got.length).toBe(2);
  });

  it('a kind only the sender knows is dropped without an ack or a crash on the receiver', () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const a = phone(net, ids[0]!, log);
    const b = phone(net, ids[1]!, log);
    const { wire } = sealWithId(a.st, a.id, 'hologram', utf8('x'), Date.now());
    const sentBefore = net.published.length;
    expect(() => b.router.receive(wire, 'nostr')).not.toThrow();
    expect(net.published.length).toBe(sentBefore);
  });

  it('acked emotes and CRDT sync work in both directions, keeping fields this build does not know', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const a = phone(net, ids[0]!, log);
    const b = phone(net, ids[1]!, log);
    const docs = [new Y.Doc(), new Y.Doc()];
    const syncs = [new CircleSync(docs[0]!, a.router, new MemoryPersistence()), new CircleSync(docs[1]!, b.router, new MemoryPersistence())];
    for (const s of syncs) await s.start();
    docs[0]!.getMap('places').set('p1', { name: 'Home' });
    docs[1]!.getMap('futureFeature').set('k', { anything: true });
    await tick();
    expect((docs[1]!.getMap('places').get('p1') as { name: string }).name).toBe('Home');
    expect((docs[0]!.getMap('futureFeature').get('k') as { anything: boolean }).anything).toBe(true);

    const reports: boolean[] = [];
    a.router.onDelivery((r) => reports.push(r.ok));
    b.router.onDelivery((r) => reports.push(r.ok));
    const heard: string[] = [];
    a.router.on('emote', () => heard.push('a'));
    b.router.on('emote', () => heard.push('b'));
    await a.router.sendTo(b.id.deviceId, 'emote', utf8('{"e":"wave"}'));
    await b.router.sendTo(a.id.deviceId, 'emote', utf8('{"e":"wave"}'));
    await tick();
    await tick();
    expect(heard.sort()).toEqual(['a', 'b']);
    expect(reports).toEqual([true, true]);
  });
});

describe('battery: nothing on the radio when alone in a crew', () => {
  it('no relay subscription, presence or sync broadcast while alone; both resume once a friend exists', async () => {
    const net = new TestNet();
    const me = generateIdentity();
    const friend = generateIdentity();
    let log = new CircleAdmin(me).create('Solo', 'Me', Date.now());
    let st = replay(log, me);
    const inner = net.pool(me.deviceId);
    const calls = { relaysSubscribed: 0, publish: 0 };
    const pool: RelayPool = {
      publish: (r, e) => {
        calls.publish++;
        return inner.publish(r, e);
      },
      subscribe: (r, f, p) => {
        calls.relaysSubscribed += r.length;
        return inner.subscribe(r, f, p);
      },
    };
    const router = new Router({ self: me, circle: () => st, pool, publicRelays: ['wss://t'] });
    router.start(Math.floor(Date.now() / 1000) - 60);
    const pub = new PresencePublisher(router, () => [...st.members.keys()].filter((k) => k !== me.deviceId));
    await pub.publish(here, { ghost: false });
    await router.broadcast('sync-update', new Uint8Array([0, 0]));
    expect(calls).toEqual({ relaysSubscribed: 0, publish: 0 });

    log = [...log, ...new CircleAdmin(me).add(st, publicIdentity(friend), 'F', Date.now())];
    st = replay(log, me);
    router.resubscribe(Math.floor(Date.now() / 1000) - 60);
    await pub.publish(here, { ghost: false });
    expect(calls.relaysSubscribed).toBe(1);
    expect(calls.publish).toBeGreaterThan(0);
  });
});
