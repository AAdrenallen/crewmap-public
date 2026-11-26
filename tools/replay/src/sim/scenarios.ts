import {
  CircleAdmin,
  DEFAULT_TRANSPORT_CONFIG,
  generateIdentity,
  publicIdentity,
  replay,
  type CircleOp,
  type DeliveryReport,
  type TransportConfig,
} from '@crewmap/p2p';
import { highwayDrive, T0 } from '../fixtures';
import { mulberry32 } from '../synth';
import { SimClock } from './clock';
import { PC_RELAY, PUBLIC_RELAY, SimDirectNet, SimRelayNet } from './network';
import { SimPhone, SimWakeNet, type PhoneState } from './phone';

export interface ScenarioResult {
  name: string;
  mode: 'p2p' | 'relay';
  phones: number;
  durationMin: number;
  staleness: { p50S: number; p95S: number; samples: number } | null;
  emotes: Delivery;
  arrivals: Delivery;
  relayEventsPublished: number;
  directShare: number;
  wakePings: number;
}

export interface Delivery {
  sent: number;
  deliveredWithin30s: number;
  rate: number;
  p50S: number;
  p95S: number;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export interface ScenarioOptions {
  name: 'drive-1h' | 'idle-8h';
  mode: 'p2p' | 'relay';
  phones?: number;
  durationMin?: number;
  seed?: number;
}

/**
 * Multi-peer simulation with the real crypto, router and relay engine. Phone 0 drives (or idles); phones 1–3 share
 * location in the background (foreground service); the rest are backgrounded without sharing (doze) and only
 * wake via ntfy pings or the 15-minute periodic sync. Emotes and arrival alerts target dozing phones.
 */
export async function runScenario(o: ScenarioOptions): Promise<ScenarioResult> {
  const n = o.phones ?? 8;
  const durationMin = o.durationMin ?? (o.name === 'drive-1h' ? 60 : 480);
  const clock = new SimClock(T0);
  const relays = new SimRelayNet(clock);
  const publicRelays = ['wss://r1.sim', 'wss://r2.sim', 'wss://r3.sim'];
  const pcRelays = ['wss://pc.sim'];
  for (const r of publicRelays) relays.addRelay(r, PUBLIC_RELAY);
  relays.addRelay(pcRelays[0]!, PC_RELAY);
  const direct = new SimDirectNet(clock, relays.online);
  const wakeNet = new SimWakeNet(clock);
  const config: TransportConfig =
    o.mode === 'p2p'
      ? { ...DEFAULT_TRANSPORT_CONFIG }
      : { presence: 'relay', emotes: 'relay', arrivals: 'relay', sync: 'relay', chores: 'relay', wake: 'relay' };

  // Circle with n members.
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Sim', 'P0', T0);
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, T0)];

  const phones = ids.map((id, i) => new SimPhone(`P${i}`, id, log, clock, relays, direct, wakeNet, { config, publicRelays, pcRelays }));
  // Idle: every phone is backgrounded and still, so the radio governor has closed its relays (docs/BATTERY.md): it is
  // reachable only via wake pings / the 15-min sync, and opens the app (foreground) to send.
  const idleAll = o.name === 'idle-8h';
  const initial: PhoneState[] = phones.map((_, i) => (idleAll ? 'doze' : i === 0 ? 'foreground' : i <= 3 ? 'sharing' : 'doze'));
  phones.forEach((p, i) => p.setState(initial[i]!));

  const reports: DeliveryReport[] = [];
  for (const p of phones) p.router.onDelivery((r) => reports.push(r));
  const rnd = mulberry32(o.seed ?? 3);

  // Phone 0's movement.
  const drive = highwayDrive();
  const endAt = T0 + durationMin * 60_000;
  const driving = o.name === 'drive-1h';
  let tick = 0;
  clock.every(1000, () => {
    tick++;
    // Loop the highway fixture for drives longer than it.
    const loc = drive.locations[tick % drive.locations.length]!;
    // Adaptive cadence: 5 s while driving and watched; still and unwatched: a 15-min heartbeat (docs/BATTERY.md).
    const period = driving ? 5 : 900;
    if (tick % period === 0) {
      if (idleAll) phones[0]!.wake('periodic');
      void phones[0]!.sendPresence(loc.lat, loc.lng, driving ? (loc.speed ?? 0) : 0);
    }
    if (tick % (idleAll ? 900 : 300) === 0)
      for (const p of phones.slice(1)) {
        if (idleAll) p.wake('periodic');
        void p.sendPresence(45.65, -74.33, 0);
      }
  });

  // Staleness of phone 0's location as seen by connected observers.
  const stale: number[] = [];
  clock.every(1000, () => {
    if (!driving || clock.now() - T0 < 60_000) return;
    for (const p of phones.slice(1, 4)) {
      const last = p.received.findLast((r) => r.kind === 'presence' && r.sender === ids[0]!.deviceId);
      if (last) stale.push((clock.now() - last.sentAt) / 1000);
    }
  });

  // Emotes every 2 min from a connected phone to a dozing phone; arrivals every 15 min.
  const emoteIds: string[] = [];
  const arrivalIds: string[] = [];
  clock.every(120_000, () => {
    const from = phones[1 + Math.floor(rnd() * 3)]!;
    const to = phones[4 + Math.floor(rnd() * (n - 4))]!;
    if (idleAll && from.state === 'doze') {
      from.setState('foreground');
      clock.setTimeout(() => from.state === 'foreground' && from.setState('doze'), 60_000);
    }
    void from.sendEmote(to.id.deviceId, 'Where are you?').then((id) => id && emoteIds.push(id));
  });
  clock.every(15 * 60_000, () => {
    const to = phones[4 + Math.floor(rnd() * (n - 4))]!;
    if (idleAll) phones[0]!.wake('push');
    void phones[0]!.sendArrival(to.id.deviceId, 'Work').then((id) => id && arrivalIds.push(id));
  });

  // Network blips: each sharing phone loses connectivity for 2 min once an hour.
  for (const p of phones.slice(1, 4)) {
    clock.every(60 * 60_000, () => {
      const prev = p.state;
      p.setState('offline');
      clock.setTimeout(() => p.setState(prev), 120_000);
    }, () => rnd() * 600_000);
  }

  await clock.runUntil(endAt + 60_000);

  const summarize = (sentIds: string[]): Delivery => {
    const rs = reports.filter((r) => sentIds.includes(r.id));
    const ok = rs.filter((r) => r.ok && r.latencyMs <= 30_000);
    const lat = rs.filter((r) => r.ok).map((r) => r.latencyMs / 1000);
    return {
      sent: sentIds.length,
      deliveredWithin30s: ok.length,
      rate: sentIds.length ? ok.length / sentIds.length : 1,
      p50S: pct(lat, 50),
      p95S: pct(lat, 95),
    };
  };
  const st = phones.reduce(
    (a, p) => ({ d: a.d + p.router.stats.sentDirect, r: a.r + p.router.stats.sentNostr + p.router.stats.sentRelay }),
    { d: 0, r: 0 },
  );
  return {
    name: o.name,
    mode: o.mode,
    phones: n,
    durationMin,
    staleness: driving ? { p50S: pct(stale, 50), p95S: pct(stale, 95), samples: stale.length } : null,
    emotes: summarize(emoteIds),
    arrivals: summarize(arrivalIds),
    relayEventsPublished: st.r,
    directShare: st.d / Math.max(1, st.d + st.r),
    wakePings: wakeNet.pings,
  };
}
