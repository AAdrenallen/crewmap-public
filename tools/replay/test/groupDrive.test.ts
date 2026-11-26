import { describe, expect, it } from 'vitest';
import {
  CircleAdmin,
  DEFAULT_TRANSPORT_CONFIG,
  generateIdentity,
  openJson,
  publicIdentity,
  replay,
  sealJson,
  type CircleOp,
} from '@crewmap/p2p';
import {
  adoptDest,
  allArrived,
  applyOp,
  changeDest,
  groupSummary,
  inviteOp,
  markArrived,
  newSession,
  parseOp,
  sessionFromInvite,
  type DriveAlongOp,
  type DriveAlongSession,
  type GroupDest,
} from '@crewmap/shared/companions';
import { T0 } from '../src/fixtures';
import { SimClock } from '../src/sim/clock';
import { PUBLIC_RELAY, SimDirectNet, SimRelayNet } from '../src/sim/network';
import { SimPhone, SimWakeNet } from '../src/sim/phone';

const dest: GroupDest = { name: 'Mont Royal', lat: 45.5048, lng: -73.5878 };
const dest2: GroupDest = { name: 'Old Port', lat: 45.5017, lng: -73.5543 };

/** One phone's group-drive state, driven by the same pure reducer the app uses, over real Router + sealed payloads. */
class Peer {
  session: DriveAlongSession | null = null;
  invite: Extract<DriveAlongOp, { op: 'invite' }> | null = null;
  inviteFrom = '';
  constructor(readonly phone: SimPhone, readonly all: Peer[]) {
    phone.router.on('drive-along', (m) => this.onOp(m.sender, parseOp(openJson(phone.id, m.payload))));
  }
  get id(): string {
    return this.phone.id.deviceId;
  }
  private send(to: string, op: DriveAlongOp): void {
    const target = this.all.find((p) => p.id === to)!;
    // Fire and forget: the virtual clock only advances in runUntil, so awaiting delivery here would never resolve.
    void this.phone.router.sendTo(to, 'drive-along', sealJson(target.phone.id.boxPk, op));
  }
  private others(): string[] {
    return this.all.filter((p) => p.id !== this.id).map((p) => p.id);
  }
  private onOp(from: string, op: DriveAlongOp | null): void {
    if (!op) return;
    if (op.op === 'invite' && !this.session) {
      this.invite = op;
      this.inviteFrom = from;
      return;
    }
    if (!this.session) return;
    this.session = applyOp(this.session, from, op, T0);
  }
  host(invitees: Peer[], to: GroupDest): void {
    this.session = newSession('sim', { id: this.id, name: this.phone.name }, invitees.map((p) => ({ id: p.id, name: p.phone.name })), null, T0, to);
    const op = inviteOp(this.session, T0);
    for (const p of invitees) this.send(p.id, op);
  }
  join(): void {
    const inv = this.invite!;
    this.session = sessionFromInvite(inv, this.inviteFrom, this.id, T0);
    this.invite = null;
    const op: DriveAlongOp = { v: 1, op: 'accept', sid: inv.sid, t: T0 };
    for (const id of [this.inviteFrom, ...inv.members.map((m) => m.id)]) if (id !== this.id) this.send(id, op);
  }
  broadcast(op: DriveAlongOp): void {
    for (const id of this.others()) this.send(id, op);
  }
  arrive(at: number): void {
    const s = this.session!;
    this.session = markArrived(s, this.id, at);
    this.broadcast({ v: 1, op: 'arrive', sid: s.sid, t: at, rev: s.destRev });
  }
}

function sim(n: number) {
  const clock = new SimClock(T0);
  const relays = new SimRelayNet(clock);
  const publicRelays = ['wss://r1.sim', 'wss://r2.sim', 'wss://r3.sim'];
  for (const r of publicRelays) relays.addRelay(r, PUBLIC_RELAY);
  const direct = new SimDirectNet(clock, relays.online);
  const wakeNet = new SimWakeNet(clock);
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Sim', 'H', T0);
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), i === 1 ? 'A' : 'B', T0)];
  const cfg = { config: { ...DEFAULT_TRANSPORT_CONFIG }, publicRelays, pcRelays: [] as string[] };
  const peers: Peer[] = [];
  ids.forEach((id, i) => peers.push(new Peer(new SimPhone(i === 0 ? 'H' : i === 1 ? 'A' : 'B', id, log, clock, relays, direct, wakeNet, cfg), peers)));
  return { clock, peers };
}

describe('3-peer group drive over the simulated network', () => {
  it('invite with destination, join, destination change, arrivals and summary', async () => {
    const { clock, peers } = sim(3);
    const [h, a, b] = peers as [Peer, Peer, Peer];
    for (const p of peers) p.phone.setState('foreground');
    h.host([a, b], dest);
    await clock.runUntil(T0 + 60_000);
    // Invitees see the invite with the destination and the host's name.
    expect(a.invite?.dest).toEqual(dest);
    expect(b.invite?.ownerName).toBe('H');
    a.join();
    b.join();
    await clock.runUntil(T0 + 120_000);
    for (const p of peers) {
      expect(Object.values(p.session!.members).every((m) => m.state === 'joined')).toBe(true);
      expect(p.session!.dest).toEqual(dest);
    }
    // Host moves the destination: members get a prompt, then adopt it.
    h.session = changeDest(h.session!, dest2);
    h.broadcast({ v: 1, op: 'dest', sid: 'sim', t: T0 + 130_000, dest: dest2, rev: 1 });
    await clock.runUntil(T0 + 180_000);
    expect(a.session!.pendingDest?.dest).toEqual(dest2);
    a.session = adoptDest(a.session!);
    b.session = adoptDest(b.session!);
    // Arrivals propagate to everyone; the summary orders them.
    a.arrive(T0 + 600_000);
    await clock.runUntil(T0 + 620_000);
    expect(h.session!.arrived).toEqual({ [a.id]: T0 + 600_000 });
    b.arrive(T0 + 700_000);
    h.arrive(T0 + 800_000);
    await clock.runUntil(T0 + 900_000);
    for (const p of peers) {
      expect(allArrived(p.session!)).toBe(true);
      expect(groupSummary(p.session!)!.arrivals.map((x) => x.id)).toEqual([a.id, b.id, h.id]);
    }
  });

  it('host leaves: the other members agree on the same new host and keep going', async () => {
    const { clock, peers } = sim(3);
    const [h, a, b] = peers as [Peer, Peer, Peer];
    for (const p of peers) p.phone.setState('foreground');
    h.host([a, b], dest);
    await clock.runUntil(T0 + 60_000);
    a.join();
    b.join();
    await clock.runUntil(T0 + 120_000);
    h.broadcast({ v: 1, op: 'leave', sid: 'sim', t: T0 + 130_000 });
    h.session = null;
    await clock.runUntil(T0 + 180_000);
    const expected = [a.id, b.id].sort()[0];
    expect(a.session!.owner).toBe(expected);
    expect(b.session!.owner).toBe(expected);
    expect(a.session!.members[h.id]!.state).toBe('left');
  });

  it('a declined invite stays declined for the host and never joins', async () => {
    const { clock, peers } = sim(3);
    const [h, a, b] = peers as [Peer, Peer, Peer];
    for (const p of peers) p.phone.setState('foreground');
    h.host([a, b], dest);
    await clock.runUntil(T0 + 60_000);
    a.join();
    b['send'](h.id, { v: 1, op: 'decline', sid: 'sim', t: T0 + 70_000 });
    await clock.runUntil(T0 + 120_000);
    expect(h.session!.members[a.id]!.state).toBe('joined');
    expect(h.session!.members[b.id]!.state).toBe('declined');
  });
});
