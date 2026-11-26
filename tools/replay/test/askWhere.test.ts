import { describe, expect, it } from 'vitest';
import {
  CircleAdmin,
  DEFAULT_TRANSPORT_CONFIG,
  KINDS,
  generateIdentity,
  openJson,
  publicIdentity,
  replay,
  sealJson,
  type CircleOp,
} from '@crewmap/p2p';
import {
  ASK,
  activeOnceShares,
  destinationCards,
  expireAsks,
  incomingPrompts,
  newAsk,
  parseAskOp,
  receiveAsk,
  resolveIncoming,
  shareOp,
  type AskEntry,
  type AskOp,
} from '@crewmap/shared/companions';
import { T0 } from '../src/fixtures';
import { SimClock } from '../src/sim/clock';
import { PUBLIC_RELAY, SimDirectNet, SimRelayNet } from '../src/sim/network';
import { SimPhone, SimWakeNet } from '../src/sim/phone';

const place = { name: 'Old Port', lat: 45.5017, lng: -73.5543 };

/** One phone's ask book, driven by the same pure reducers the app uses, over the real Router + sealed payloads. */
class Peer {
  entries: AskEntry[] = [];
  constructor(readonly phone: SimPhone, readonly all: () => Peer[], readonly clock: SimClock) {
    phone.router.on('where-ask', (m) => {
      const op = parseAskOp(openJson(phone.id, m.payload));
      if (op) this.entries = receiveAsk(this.entries, m.sender, op, this.clock.now()).entries;
    });
  }
  get id(): string {
    return this.phone.id.deviceId;
  }
  send(to: Peer, op: AskOp): void {
    // Fire and forget: the virtual clock only advances in runUntil.
    void this.phone.router.sendTo(to.id, 'where-ask', sealJson(to.phone.id.boxPk, op));
  }
  ask(to: Peer, kind: 'where' | 'once', id: string): boolean {
    const r = newAsk(this.entries, to.id, kind, id, this.clock.now());
    if (r.gate !== 'ok') return false;
    this.entries = r.entries;
    this.send(to, { v: 1, op: 'ask', id, ask: kind, t: this.clock.now() });
    return true;
  }
}

function sim() {
  const clock = new SimClock(T0);
  const relays = new SimRelayNet(clock);
  const publicRelays = ['wss://r1.sim', 'wss://r2.sim', 'wss://r3.sim'];
  for (const r of publicRelays) relays.addRelay(r, PUBLIC_RELAY);
  const direct = new SimDirectNet(clock, relays.online);
  const wakeNet = new SimWakeNet(clock);
  const ids = [generateIdentity(), generateIdentity()];
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Sim', 'A', T0);
  log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[1]!), 'B', T0)];
  const cfg = { config: { ...DEFAULT_TRANSPORT_CONFIG }, publicRelays, pcRelays: [] as string[] };
  const peers: Peer[] = [];
  const all = () => peers;
  peers.push(new Peer(new SimPhone('A', ids[0]!, log, clock, relays, direct, wakeNet, cfg), all, clock));
  peers.push(new Peer(new SimPhone('B', ids[1]!, log, clock, relays, direct, wakeNet, cfg), all, clock));
  for (const p of peers) p.phone.setState('foreground');
  return { clock, a: peers[0]!, b: peers[1]! };
}

describe('2-peer location asks over the simulated network', () => {
  it('the wire kind is acked, durable and relay-kept for the pending window', () => {
    expect(KINDS['where-ask']).toMatchObject({ ack: true, durable: true, ttlS: ASK.pendingMs / 1000 });
  });

  it('where: ask -> answer with a place -> ready-to-navigate card', async () => {
    const { clock, a, b } = sim();
    expect(a.ask(b, 'where', 'w1')).toBe(true);
    await clock.runUntil(T0 + 30_000);
    expect(incomingPrompts(b.entries)).toHaveLength(1);
    expect(incomingPrompts(b.entries)[0]!.peer).toBe(a.id);
    b.entries = resolveIncoming(b.entries, 'w1', 'answered', { place });
    b.send(a, { v: 1, op: 'answer', id: 'w1', place, note: 'by the clock tower', t: clock.now() });
    await clock.runUntil(T0 + 60_000);
    const [card] = destinationCards(a.entries);
    expect(card).toMatchObject({ peer: b.id, place, note: 'by the clock tower' });
  });

  it('once: ask -> share -> visible on the asker -> auto-expires on both sides', async () => {
    const { clock, a, b } = sim();
    expect(a.ask(b, 'once', 'o1')).toBe(true);
    await clock.runUntil(T0 + 30_000);
    expect(incomingPrompts(b.entries)).toHaveLength(1);
    const op = shareOp('o1', { lat: place.lat, lng: place.lng, acc: 6 }, 15, clock.now());
    b.entries = resolveIncoming(b.entries, 'o1', 'shared', { until: op.until });
    b.send(a, op);
    await clock.runUntil(T0 + 60_000);
    const live = activeOnceShares(a.entries, clock.now());
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ peer: b.id, lat: place.lat, lng: place.lng });
    // 14 minutes later it is still there; after the 15th it is gone everywhere and no position is kept.
    await clock.runUntil(T0 + 14 * 60_000);
    a.entries = expireAsks(a.entries, clock.now());
    expect(activeOnceShares(a.entries, clock.now())).toHaveLength(1);
    await clock.runUntil(T0 + 16 * 60_000);
    a.entries = expireAsks(a.entries, clock.now());
    b.entries = expireAsks(b.entries, clock.now());
    expect(activeOnceShares(a.entries, clock.now())).toHaveLength(0);
    expect(a.entries.every((e) => !e.loc)).toBe(true);
    expect(b.entries.every((e) => e.state !== 'shared')).toBe(true);
  });

  it('decline, and spam: a second ask inside the cooldown never reaches the prompt', async () => {
    const { clock, a, b } = sim();
    expect(a.ask(b, 'once', 'o1')).toBe(true);
    expect(a.ask(b, 'once', 'o2')).toBe(false);
    await clock.runUntil(T0 + 30_000);
    b.entries = resolveIncoming(b.entries, 'o1', 'declined');
    b.send(a, { v: 1, op: 'decline', id: 'o1', t: clock.now() });
    await clock.runUntil(T0 + 60_000);
    expect(a.entries[0]!.state).toBe('declined');
    // Still inside the cooldown: the sender refuses, and a forged repeat is dropped by the receiver too.
    expect(a.ask(b, 'once', 'o3')).toBe(false);
    a.send(b, { v: 1, op: 'ask', id: 'o4', ask: 'once', t: clock.now() });
    await clock.runUntil(T0 + 90_000);
    expect(incomingPrompts(b.entries)).toHaveLength(0);
    // After the cooldown a new ask is allowed again.
    await clock.runUntil(T0 + ASK.cooldownMs + 60_000);
    expect(a.ask(b, 'once', 'o5')).toBe(true);
  });
});
