import type { CircleState } from './crypto/circle';
import { open, sealWithId, type Opened } from './crypto/envelope';
import type { DeviceIdentity } from './crypto/identity';
import { fromUtf8, utf8 } from './crypto/sodium';
import { NostrCarrier } from './transport/nostr';
import {
  DEFAULT_PUBLIC_RELAYS,
  DEFAULT_TRANSPORT_CONFIG,
  systemClock,
  type Clock,
  type DirectLinks,
  type FunctionName,
  type RelayPool,
  type TransportConfig,
  type WakeService,
} from './transport/types';

/** Message kinds carried inside envelopes, and which switchable function each belongs to. */
export const KINDS = {
  presence: { fn: 'presence', durable: false, ttlS: 0, ack: false },
  'presence-precise': { fn: 'presence', durable: false, ttlS: 0, ack: false },
  'sender-key': { fn: 'presence', durable: true, ttlS: 86_400, ack: true },
  // Per-friend overrides (D52): a tier key box-sealed to each tier member, then one secretbox presence per tier.
  'tier-key': { fn: 'presence', durable: true, ttlS: 86_400, ack: true },
  'presence-tier': { fn: 'presence', durable: false, ttlS: 0, ack: false },
  signal: { fn: 'presence', durable: false, ttlS: 0, ack: false },
  // Kept 72 h (NIP-40) so a friend who is offline still gets the build-up when they open the app.
  emote: { fn: 'emotes', durable: true, ttlS: 72 * 3600, ack: true },
  // Custom quips (quips.ts): manifest (acked) plus content-addressed blob chunks, kept 72 h like emotes.
  quip: { fn: 'emotes', durable: true, ttlS: 72 * 3600, ack: true },
  'quip-blob': { fn: 'emotes', durable: true, ttlS: 72 * 3600, ack: false },
  // Text chat (see chat.ts): kept on relays for the router's 3-day catch-up window.
  chat: { fn: 'emotes', durable: true, ttlS: 3 * 86_400, ack: true },
  arrival: { fn: 'arrivals', durable: true, ttlS: 3600, ack: true },
  // Safety check-in (D66): "didn't answer after a long stop" / "all fine", sealed to each opted-in crewmate.
  'check-in': { fn: 'arrivals', durable: true, ttlS: 6 * 3600, ack: true },
  'sync-update': { fn: 'sync', durable: true, ttlS: 7 * 86_400, ack: false },
  'sync-sv': { fn: 'sync', durable: false, ttlS: 0, ack: false },
  'sync-diff': { fn: 'sync', durable: true, ttlS: 86_400, ack: false },
  membership: { fn: 'sync', durable: true, ttlS: 30 * 86_400, ack: false },
  config: { fn: 'sync', durable: true, ttlS: 30 * 86_400, ack: false },
  hazards: { fn: 'chores', durable: true, ttlS: 3600, ack: false },
  // Map points (D64): fuel prices, chargers, traffic cameras fetched by the chore peer. Older builds ignore the kind.
  pois: { fn: 'chores', durable: true, ttlS: 3600, ack: false },
  chore: { fn: 'chores', durable: false, ttlS: 0, ack: false },
  ack: { fn: 'presence', durable: false, ttlS: 0, ack: false },
  // Drive-along (D31). Session ops are acked; the live stream is never stored, acked or woken for; payloads are sealed
  // to the one recipient (companions.ts), so other crew members who see the event cannot read it.
  'drive-along': { fn: 'presence', durable: true, ttlS: 900, ack: true },
  'presence-live': { fn: 'presence', durable: false, ttlS: 0, ack: false },
  'route-share': { fn: 'presence', durable: true, ttlS: 3600, ack: false },
  'loc-request': { fn: 'presence', durable: true, ttlS: 300, ack: true },
  // Location asks (D47): ask / answer / one-time share / decline, sealed to one recipient. Kept while an ask can still be pending.
  'where-ask': { fn: 'presence', durable: true, ttlS: 1800, ack: true },
  'eta-share': { fn: 'presence', durable: true, ttlS: 3600, ack: false },
  // Viewer demand (demand.ts): "my app is open until t". Live only; a missed one just means the default cadence.
  watch: { fn: 'presence', durable: false, ttlS: 0, ack: false },
  // Leaderboard aggregates (statsAgg.ts, D56): counts only; kept a week so an offline friend still gets the latest.
  'stats-agg': { fn: 'sync', durable: true, ttlS: 7 * 86_400, ack: false },
  // Trip memories (memories.ts, D68): sealed to each outing member; kept a week so an offline crewmate still gets them.
  memory: { fn: 'emotes', durable: true, ttlS: 7 * 86_400, ack: true },
  'memory-photo': { fn: 'emotes', durable: true, ttlS: 7 * 86_400, ack: true },
  'memory-blob': { fn: 'emotes', durable: true, ttlS: 7 * 86_400, ack: false },
  'memory-react': { fn: 'emotes', durable: true, ttlS: 7 * 86_400, ack: false },
  // Benchmark probe: acked, never shown to the recipient.
  bench: { fn: 'emotes', durable: true, ttlS: 600, ack: true },
} as const satisfies Record<string, { fn: FunctionName; durable: boolean; ttlS: number; ack: boolean }>;

export type Kind = keyof typeof KINDS;

export interface Incoming extends Opened {
  via: 'direct' | 'nostr' | 'relay';
  receivedAt: number;
}

export interface RouterOptions {
  self: DeviceIdentity;
  circle: () => CircleState;
  pool: RelayPool;
  publicRelays?: string[];
  /** Central-PC relay URLs (empty unless the optional relay is set up). */
  pcRelays?: string[];
  config?: TransportConfig;
  direct?: DirectLinks;
  wake?: WakeService;
  /** Wake endpoint of a peer (from the circle doc). */
  wakeEndpointOf?: (deviceId: string) => string | null;
  clock?: Clock;
  /** Retry delays for acked messages (ms). */
  retryMs?: number[];
}

export interface DeliveryReport {
  id: string;
  kind: Kind;
  to: string;
  ok: boolean;
  latencyMs: number;
  attempts: number;
}

interface Pending {
  id: string;
  kind: Kind;
  to: string;
  env: Uint8Array;
  sentAt: number;
  attempts: number;
  timer: unknown;
}

/**
 * Routes encrypted messages per function: direct links first, Nostr (public relays, or the PC relay when that
 * function is switched to 'relay') for everything else and for durability. Handles acks, retries, wake-ups and
 * de-duplication. One instance per circle.
 */
export class Router {
  private readonly carrier: NostrCarrier;
  private readonly handlers = new Map<string, ((m: Incoming) => void)[]>();
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly lastSeen = new Map<string, number>();
  private readonly deliveryListeners: ((r: DeliveryReport) => void)[] = [];
  private config: TransportConfig;
  private readonly clock: Clock;
  private readonly retryMs: number[];
  private running = false;
  /** Messages sent and not yet acknowledged (retry queue). */
  get queued(): number {
    return this.pending.size;
  }
  readonly stats = { sentDirect: 0, sentNostr: 0, sentRelay: 0, received: 0, rejected: 0, wakes: 0, bytesOut: 0 };

  constructor(private readonly o: RouterOptions) {
    this.carrier = new NostrCarrier(o.pool, o.self.deviceId);
    this.config = o.config ?? { ...DEFAULT_TRANSPORT_CONFIG };
    this.clock = o.clock ?? systemClock;
    this.retryMs = o.retryMs ?? [4000, 10_000, 20_000];
    o.direct?.onMessage((peer, bytes) => this.receive(bytes, 'direct', peer));
    o.direct?.onSignal((peer, signal) => {
      void this.sendTo(peer, 'signal', utf8(JSON.stringify(signal)));
    });
    this.on('signal', (m) => o.direct?.handleSignal(m.sender, JSON.parse(fromUtf8(m.payload))));
    this.on('ack', (m) => this.handleAck(m));
  }

  get transportConfig(): TransportConfig {
    return { ...this.config };
  }

  /** Switch functions between P2P and the PC relay at runtime (no app changes). */
  setConfig(cfg: TransportConfig): void {
    this.config = { ...cfg };
    if (this.running) this.resubscribe(Math.floor(this.clock.now() / 1000) - 600);
  }

  start(sinceS: number): void {
    this.running = true;
    this.resubscribe(sinceS);
    this.scheduleDayRollover();
  }

  private rolloverTimer: unknown = null;

  /** Topics are per UTC day: re-subscribe shortly after each midnight. */
  private scheduleDayRollover(): void {
    const now = this.clock.now();
    const next = (Math.floor(now / 86_400_000) + 1) * 86_400_000 + 5_000;
    this.rolloverTimer = this.clock.setTimeout(() => {
      if (!this.running) return;
      this.resubscribe(Math.floor(this.clock.now() / 1000) - 600);
      this.scheduleDayRollover();
    }, next - now);
  }

  /** Re-subscribe after an epoch rotation or day change. */
  resubscribe(sinceS: number): void {
    // Alone in the crew: nobody can address us on these topics (joins and removals travel through the invite
    // topics and the mailbox), so no relay subscription is held until a member appears (the caller resubscribes then).
    const relays = this.hasPeers() ? this.subscribedRelays() : [];
    this.carrier.subscribe(relays, this.o.circle(), this.clock.now(), sinceS, (env) => this.receive(env, 'nostr'));
  }

  stop(): void {
    this.running = false;
    if (this.rolloverTimer) this.clock.clearTimeout(this.rolloverTimer);
    this.carrier.close();
    // Idle peer connections still send ICE consent checks every few seconds: a stopped router drops them.
    this.o.direct?.close();
    for (const p of this.pending.values()) this.clock.clearTimeout(p.timer);
    this.pending.clear();
  }

  on(kind: Kind, h: (m: Incoming) => void): () => void {
    const list = this.handlers.get(kind) ?? [];
    list.push(h);
    this.handlers.set(kind, list);
    return () => {
      const l = this.handlers.get(kind);
      if (l) this.handlers.set(kind, l.filter((x) => x !== h));
    };
  }

  onDelivery(h: (r: DeliveryReport) => void): void {
    this.deliveryListeners.push(h);
  }

  /** Last time we heard anything from each peer. */
  peerLastSeen(deviceId: string): number | null {
    return this.lastSeen.get(deviceId) ?? null;
  }

  async broadcast(kind: Kind, payload: Uint8Array): Promise<string> {
    const st = this.o.circle();
    const now = this.clock.now();
    const { id, wire: env } = sealWithId(st, this.o.self, kind, payload, now);
    this.markSeen(id);
    const spec = KINDS[kind];
    const members = [...st.members.keys()].filter((m) => m !== this.o.self.deviceId);
    if (members.length === 0) return id;
    const direct = new Set(this.o.direct?.connected() ?? []);
    for (const m of members) {
      if (direct.has(m) && this.o.direct!.send(m, env)) {
        this.stats.sentDirect++;
        this.stats.bytesOut += env.length;
      }
    }
    const allDirect = members.every((m) => direct.has(m));
    // Everyone got it directly: a durable kind keeps one relay copy for catch-up instead of one per relay.
    if (spec.durable || !allDirect) await this.viaNostr(kind, env, now, undefined, allDirect ? 1 : undefined);
    return id;
  }

  async sendTo(peer: string, kind: Kind, payload: Uint8Array): Promise<string> {
    const st = this.o.circle();
    const now = this.clock.now();
    const { id, wire: env } = sealWithId(st, this.o.self, kind, payload, now);
    this.markSeen(id);
    // Register before transmitting: on a fast link the ack can arrive before transmit() resolves.
    const p: Pending | null = KINDS[kind].ack ? { id, kind, to: peer, env, sentAt: now, attempts: 1, timer: null } : null;
    if (p) this.pending.set(id, p);
    await this.transmit(peer, kind, env, now);
    if (p && this.pending.has(id)) this.scheduleRetry(p);
    return id;
  }

  private async transmit(peer: string, kind: Kind, env: Uint8Array, now: number): Promise<void> {
    const spec = KINDS[kind];
    let sentDirect = false;
    if (this.o.direct?.connected().includes(peer)) {
      sentDirect = this.o.direct.send(peer, env);
      if (sentDirect) {
        this.stats.sentDirect++;
        this.stats.bytesOut += env.length;
      }
    }
    if (!sentDirect || spec.durable) await this.viaNostr(kind, env, now, peer, sentDirect ? 1 : undefined);
  }

  /** `maxRelays`: already delivered directly, so the relay copy is only a backup (fewer sockets and radio bursts). */
  private async viaNostr(kind: Kind, env: Uint8Array, now: number, to?: string, maxRelays?: number): Promise<void> {
    const spec = KINDS[kind];
    const mode = this.config[spec.fn];
    const all = mode === 'relay' ? (this.o.pcRelays ?? []) : (this.o.publicRelays ?? DEFAULT_PUBLIC_RELAYS);
    const relays = maxRelays ? all.slice(0, maxRelays) : all;
    const opts = to ? { durable: spec.durable, ttlS: spec.ttlS, to } : { durable: spec.durable, ttlS: spec.ttlS };
    const ev = this.carrier.buildEvent(this.o.circle(), env, now, opts);
    const ok = await this.carrier.publish(relays, ev);
    if (ok) {
      if (mode === 'relay') this.stats.sentRelay++;
      else this.stats.sentNostr++;
      this.stats.bytesOut += ev.content.length;
    }
  }

  private scheduleRetry(p: Pending): void {
    const delay = this.retryMs[p.attempts - 1];
    if (delay === undefined) {
      p.timer = null;
      this.clock.setTimeout(() => this.fail(p), 10_000);
      return;
    }
    p.timer = this.clock.setTimeout(() => {
      if (!this.pending.has(p.id)) return;
      p.attempts++;
      void this.transmit(p.to, p.kind, p.env, this.clock.now());
      if (p.attempts === 2) void this.wakePeer(p.to);
      this.scheduleRetry(p);
    }, delay);
  }

  private fail(p: Pending): void {
    if (!this.pending.delete(p.id)) return;
    const r: DeliveryReport = { id: p.id, kind: p.kind, to: p.to, ok: false, latencyMs: this.clock.now() - p.sentAt, attempts: p.attempts };
    for (const l of this.deliveryListeners) l(r);
  }

  private handleAck(m: Incoming): void {
    const id = fromUtf8(m.payload);
    const p = this.pending.get(id);
    if (!p || p.to !== m.sender) return;
    this.pending.delete(id);
    if (p.timer) this.clock.clearTimeout(p.timer);
    const r: DeliveryReport = { id, kind: p.kind, to: p.to, ok: true, latencyMs: m.receivedAt - p.sentAt, attempts: p.attempts };
    for (const l of this.deliveryListeners) l(r);
  }

  /** Content-free wake ping to a backgrounded peer. */
  async wakePeer(peer: string): Promise<boolean> {
    const ep = this.o.wakeEndpointOf?.(peer);
    if (!ep || !this.o.wake) return false;
    this.stats.wakes++;
    return this.o.wake.ping(ep);
  }

  /** Entry point for envelopes from any carrier. */
  receive(env: Uint8Array, via: Incoming['via'], directPeer?: string): void {
    let m: Opened;
    try {
      m = open(this.o.circle(), env);
    } catch {
      this.stats.rejected++;
      return;
    }
    if (directPeer && m.sender !== directPeer) {
      this.stats.rejected++;
      return;
    }
    const now = this.clock.now();
    this.lastSeen.set(m.sender, Math.max(this.lastSeen.get(m.sender) ?? 0, now));
    const kind = m.kind as Kind;
    // Ack even duplicates (the first ack may have been lost).
    if (KINDS[kind]?.ack) void this.sendTo(m.sender, 'ack', utf8(m.id));
    if (this.markSeen(m.id)) return;
    this.stats.received++;
    const inc: Incoming = { ...m, via, receivedAt: now };
    // A handler that chokes on a payload from a different app version must not drop the rest of the envelope.
    for (const h of this.handlers.get(kind) ?? []) {
      try {
        h(inc);
      } catch {
        this.stats.rejected++;
      }
    }
    // Opportunistically open a direct link to peers we hear from over Nostr.
    if (via !== 'direct' && this.o.direct && !this.o.direct.connected().includes(m.sender)) {
      if (this.o.self.deviceId < m.sender) this.o.direct.connect(m.sender);
    }
  }

  private hasPeers(): boolean {
    const st = this.o.circle();
    for (const id of st.members.keys()) if (id !== this.o.self.deviceId) return true;
    return false;
  }

  private subscribedRelays(): string[] {
    const set = new Set<string>();
    const modes = new Set(Object.values(this.config));
    if (modes.has('p2p')) for (const r of this.o.publicRelays ?? DEFAULT_PUBLIC_RELAYS) set.add(r);
    if (modes.has('relay')) for (const r of this.o.pcRelays ?? []) set.add(r);
    return [...set];
  }

  private markSeen(id: string): boolean {
    if (this.seenIds.has(id)) return true;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 10_000) this.seenIds.delete(this.seenOrder.shift()!);
    return false;
  }
}
