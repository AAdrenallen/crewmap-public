import { describe, expect, it } from 'vitest';
import {
  CircleAdmin,
  DEFAULT_TRANSPORT_CONFIG,
  generateIdentity,
  openJson,
  parseRouteShare,
  publicIdentity,
  replay,
  sealJson,
  type CircleOp,
} from '@crewmap/p2p';
import {
  applyOp,
  CONVOY,
  convoyLeader,
  convoyOp,
  ConvoyTracker,
  inviteOp,
  newSession,
  parseOp,
  regroupAudience,
  RegroupWatch,
  sessionFromInvite,
  thinRoute,
  type DriveAlongOp,
  type DriveAlongSession,
  type GroupDest,
} from '@crewmap/shared/companions';
import { destination, type LatLng } from '@crewmap/shared/geo';
import { T0 } from '../src/fixtures';
import { SimClock } from '../src/sim/clock';
import { PUBLIC_RELAY, SimDirectNet, SimRelayNet } from '../src/sim/network';
import { SimPhone, SimWakeNet } from '../src/sim/phone';

/** Synthetic 20 km drive due north from the Old Port of Montréal (public landmark), one vertex every 100 m. */
const OLD_PORT: LatLng = { lat: 45.5017, lng: -73.5543 };
const LINE: LatLng[] = Array.from({ length: 201 }, (_, i) => destination(OLD_PORT, 0, i * 100));
const dest: GroupDest = { name: 'North', ...LINE[200]! };
const LIMITS = { m: CONVOY.regroupM, s: CONVOY.regroupMin * 60 };

/** One phone's convoy: the app's pure reducer, tracker and regroup watches over the real Router and sealed payloads. */
class Peer {
  session: DriveAlongSession | null = null;
  invite: Extract<DriveAlongOp, { op: 'invite' }> | null = null;
  inviteFrom = '';
  readonly tracker = new ConvoyTracker();
  readonly watches = new Map<string, RegroupWatch>();
  readonly alerts: { about: string; at: number }[] = [];
  constructor(readonly phone: SimPhone, readonly all: Peer[]) {
    phone.router.on('drive-along', (m) => this.onOp(m.sender, parseOp(openJson(phone.id, m.payload))));
    phone.router.on('route-share', (m) => {
      const r = parseRouteShare(openJson(phone.id, m.payload));
      if (r && this.session && m.sender === convoyLeader(this.session)) this.tracker.setLine(r.line.map(([lat, lng]) => ({ lat, lng })), m.sender);
    });
    phone.router.on('presence-live', (m) => {
      const p = openJson(phone.id, m.payload) as { lat: number; lng: number; t: number; spd: number } | null;
      if (p) this.tracker.update(m.sender, p);
    });
  }
  get id(): string {
    return this.phone.id.deviceId;
  }
  private send(to: string, kind: 'drive-along' | 'route-share' | 'presence-live', value: unknown): void {
    const target = this.all.find((p) => p.id === to)!;
    void this.phone.router.sendTo(to, kind, sealJson(target.phone.id.boxPk, value));
  }
  others(): string[] {
    return this.all.filter((p) => p.id !== this.id).map((p) => p.id);
  }
  private onOp(from: string, op: DriveAlongOp | null): void {
    if (!op) return;
    if (op.op === 'invite' && !this.session) {
      this.invite = op;
      this.inviteFrom = from;
      return;
    }
    if (this.session) this.session = applyOp(this.session, from, op, T0);
  }
  host(invitees: Peer[]): void {
    this.session = newSession('cv', { id: this.id, name: this.phone.name }, invitees.map((p) => ({ id: p.id, name: p.phone.name })), null, T0, dest, true);
    const op = inviteOp(this.session, T0);
    for (const p of invitees) this.send(p.id, 'drive-along', op);
  }
  join(): void {
    const inv = this.invite!;
    this.session = sessionFromInvite(inv, this.inviteFrom, this.id, T0);
    const op: DriveAlongOp = { v: 1, op: 'accept', sid: inv.sid, t: T0 };
    for (const id of [this.inviteFrom, ...inv.members.map((m) => m.id)]) if (id !== this.id) this.send(id, 'drive-along', op);
  }
  handLead(to: string, t: number): void {
    const op = convoyOp(this.session!, true, to, t);
    this.session = applyOp(this.session!, this.id, op, t);
    for (const id of this.others()) this.send(id, 'drive-along', op);
  }
  shareRoute(t: number, line: LatLng[] = LINE): void {
    this.tracker.setLine(line, this.id);
    const value = { v: 1, sid: 'cv', line: thinRoute(line).map((p) => [p.lat, p.lng]), dest: dest.name, eta: null, t };
    for (const id of this.others()) this.send(id, 'route-share', value);
  }
  drive(at: LatLng, spd: number, t: number): void {
    this.tracker.update(this.id, { ...at, t, spd });
    for (const id of this.others()) this.send(id, 'presence-live', { lat: at.lat, lng: at.lng, t, spd, sid: 'cv' });
  }
  /** Same as `Companions.updateConvoy`: every phone runs every watch; only the audience is alerted. */
  check(now: number): void {
    const rows = this.tracker.standings([this.id, ...this.others()], new Set());
    for (const r of rows) {
      let w = this.watches.get(r.id);
      if (!w) this.watches.set(r.id, (w = new RegroupWatch()));
      if (w.update(r.gapM, r.gapS, LIMITS, now) && regroupAudience(rows, convoyLeader(this.session!), r.id).includes(this.id)) this.alerts.push({ about: r.id, at: now });
    }
  }
}

function sim(n: number) {
  const clock = new SimClock(T0);
  const relays = new SimRelayNet(clock);
  const publicRelays = ['wss://r1.sim', 'wss://r2.sim', 'wss://r3.sim'];
  for (const r of publicRelays) relays.addRelay(r, PUBLIC_RELAY);
  // Relays only (every car behind carrier NAT): live positions ride ephemeral relay events.
  const direct = new SimDirectNet(clock, relays.online, 0);
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

describe('3-car convoy over the simulated network', () => {
  it('order, along-route time gap, and one regroup alert as the last car drops back and recovers', async () => {
    const { clock, peers } = sim(3);
    const [h, a, b] = peers as [Peer, Peer, Peer];
    for (const p of peers) p.phone.setState('foreground');
    h.host([a, b]);
    await clock.runUntil(T0 + 30_000);
    a.join();
    b.join();
    await clock.runUntil(T0 + 60_000);
    for (const p of peers) expect(convoyLeader(p.session!)).toBe(h.id);
    h.shareRoute(T0 + 60_000);
    await clock.runUntil(T0 + 70_000);
    expect(a.tracker.hasLine && b.tracker.hasLine).toBe(true);

    // H leaves at 0 s at 15 m/s, A 20 s later, B 40 s later. From 200 s B crawls at 6 m/s, from 500 s it catches up at 25 m/s.
    const start = T0 + 100_000;
    const pos = { h: 0, a: 0, b: 0 };
    const STEP = 4;
    for (let s = 0; s <= 900; s += STEP) {
      const t = start + s * 1000;
      const vb = s < 40 ? 0 : s < 200 ? 15 : s < 500 ? 6 : 25;
      pos.h += s > 0 ? 15 * STEP : 0;
      if (s > 20) pos.a += 15 * STEP;
      if (s > 40) pos.b += vb * STEP;
      // B never passes A: once caught up it keeps A's pace.
      if (pos.b > pos.a - 100) pos.b = Math.max(0, pos.a - 100);
      h.drive(destination(OLD_PORT, 0, pos.h), 15, t);
      a.drive(destination(OLD_PORT, 0, pos.a), 15, t);
      b.drive(destination(OLD_PORT, 0, pos.b), vb, t);
      await clock.runUntil(t + 1000);
      for (const p of peers) p.check(t + 1000);
      if (s === 300) {
        // The leader reroutes: a new line from where it is, 40 m east of the old one. Everyone behind keeps their place.
        const rest = LINE.filter((_, i) => i * 100 >= pos.h).map((p) => destination(p, 90, 40));
        h.shareRoute(t + 1000, [destination(OLD_PORT, 0, pos.h), ...rest]);
      }
      if (s === 308 || s === 600) for (const p of peers) expect(p.tracker.standings([h.id, a.id, b.id], new Set()).map((r) => r.order)).toEqual([1, 2, 3]);
      if (s === 160) {
        // Steady convoy: every phone agrees on the order; A is ~20 s behind H along the route.
        for (const p of peers) expect(p.tracker.standings([h.id, a.id, b.id], new Set()).map((r) => r.order)).toEqual([1, 2, 3]);
        const ra = h.tracker.standings([h.id, a.id, b.id], new Set())[1]!;
        expect(ra.gapS!).toBeGreaterThan(14);
        expect(ra.gapS!).toBeLessThan(26);
        expect(ra.gapM!).toBeGreaterThan(200);
        expect(ra.gapM!).toBeLessThan(400);
      }
    }
    // Exactly one alert about B, on the leader's phone and on A's (the car ahead of the gap); none on B's own.
    expect(h.alerts.map((x) => x.about)).toEqual([b.id]);
    expect(a.alerts.map((x) => x.about)).toEqual([b.id]);
    expect(b.alerts).toEqual([]);
    expect(h.alerts[0]!.at).toBeGreaterThan(start + 200_000);
    expect(h.alerts[0]!.at).toBeLessThan(start + 500_000);
  });

  it('the leader hands over: every phone agrees on the new leader, and a leaving leader hands back to the host', async () => {
    const { clock, peers } = sim(3);
    const [h, a, b] = peers as [Peer, Peer, Peer];
    for (const p of peers) p.phone.setState('foreground');
    h.host([a, b]);
    await clock.runUntil(T0 + 30_000);
    a.join();
    b.join();
    await clock.runUntil(T0 + 60_000);
    h.handLead(a.id, T0 + 61_000);
    await clock.runUntil(T0 + 90_000);
    for (const p of peers) expect(convoyLeader(p.session!)).toBe(a.id);
    a.handLead(b.id, T0 + 91_000);
    await clock.runUntil(T0 + 120_000);
    for (const p of peers) expect(convoyLeader(p.session!)).toBe(b.id);
    for (const id of b.others()) b['send'](id, 'drive-along', { v: 1, op: 'leave', sid: 'cv', t: T0 + 121_000 });
    await clock.runUntil(T0 + 150_000);
    expect(convoyLeader(h.session!)).toBe(h.id);
    expect(convoyLeader(a.session!)).toBe(h.id);
  });
});
