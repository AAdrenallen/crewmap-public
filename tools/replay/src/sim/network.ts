import { MemoryStore, RelayCore, type Ev, type Filter } from '@crewmap/relay';
import type { DirectLinks, NostrEvent, NostrFilter, RelayPool } from '@crewmap/p2p';
import { mulberry32 } from '../synth';
import type { SimClock } from './clock';

export interface LinkProfile {
  /** One-way latency range, ms. */
  latencyMs: [number, number];
  /** Probability a message is dropped. */
  loss: number;
  /** Fraction of time the relay is unreachable (outage windows). */
  downtime: number;
}

/** Public Nostr relays: variable latency, some loss, occasional outages. */
export const PUBLIC_RELAY: LinkProfile = { latencyMs: [60, 350], loss: 0.01, downtime: 0.02 };
/** Home PC relay through a tunnel: lower latency, rarely down. */
export const PC_RELAY: LinkProfile = { latencyMs: [30, 120], loss: 0.002, downtime: 0.01 };
/** Direct WebRTC data channel. */
export const DIRECT: LinkProfile = { latencyMs: [20, 90], loss: 0.005, downtime: 0 };

export type PhoneNet = 'online' | 'offline';

/** In-process Nostr relays (the real RelayCore) with simulated network conditions. */
export class SimRelayNet {
  private readonly relays = new Map<string, { core: RelayCore; profile: LinkProfile; downUntil: number }>();
  private readonly rnd = mulberry32(1234);
  readonly online = new Map<string, PhoneNet>();
  private connSeq = 0;

  constructor(private readonly clock: SimClock) {}

  addRelay(url: string, profile: LinkProfile): void {
    const core = new RelayCore(new MemoryStore(), { trustSignatures: true, now: () => this.clock.now() });
    this.relays.set(url, { core, profile, downUntil: 0 });
    // Outage process: on average `downtime` fraction of time down, in 5–20 minute windows.
    if (profile.downtime > 0) {
      const meanWindow = 12 * 60_000;
      const meanUp = (meanWindow * (1 - profile.downtime)) / profile.downtime;
      const schedule = () => {
        const up = meanUp * (0.5 + this.rnd());
        this.clock.setTimeout(() => {
          const r = this.relays.get(url)!;
          r.downUntil = this.clock.now() + meanWindow * (0.4 + this.rnd() * 1.2);
          schedule();
        }, up);
      };
      schedule();
    }
  }

  private up(url: string): boolean {
    const r = this.relays.get(url);
    return !!r && this.clock.now() >= r.downUntil;
  }

  private delay(p: LinkProfile): number {
    return p.latencyMs[0] + this.rnd() * (p.latencyMs[1] - p.latencyMs[0]);
  }

  private lost(p: LinkProfile): boolean {
    return this.rnd() < p.loss;
  }

  /** A RelayPool for one phone. Its subscriptions are live only while the phone is online. */
  poolFor(phone: string): RelayPool & { reconnect(): void } {
    const subs: { relays: string[]; filter: NostrFilter; onevent: (e: NostrEvent) => void; conns: string[] }[] = [];
    const attach = (s: (typeof subs)[number]) => {
      s.conns = [];
      for (const url of s.relays) {
        const r = this.relays.get(url);
        if (!r) continue;
        const conn = `${phone}#${this.connSeq++}`;
        s.conns.push(conn);
        r.core.connect(conn, (m) => {
          if (m[0] !== 'EVENT') return;
          if (this.online.get(phone) !== 'online' || !this.up(url) || this.lost(r.profile)) return;
          const ev = m[2] as unknown as NostrEvent;
          this.clock.setTimeout(() => {
            if (this.online.get(phone) === 'online') s.onevent(ev);
          }, this.delay(r.profile));
        });
        r.core.handle(conn, ['REQ', 'sub', s.filter as Filter]);
      }
    };
    const detach = (s: (typeof subs)[number]) => {
      for (const c of s.conns) for (const r of this.relays.values()) r.core.disconnect(c);
      s.conns = [];
    };
    return {
      publish: (relays, ev) =>
        relays.map(
          (url) =>
            new Promise<string>((resolve, reject) => {
              const r = this.relays.get(url);
              if (!r || this.online.get(phone) !== 'online' || !this.up(url) || this.lost(r.profile)) {
                reject(new Error('publish failed'));
                return;
              }
              this.clock.setTimeout(() => {
                const conn = `pub-${phone}-${this.connSeq++}`;
                r.core.connect(conn, () => undefined);
                r.core.handle(conn, ['EVENT', ev as unknown as Ev]);
                r.core.disconnect(conn);
                resolve(url);
              }, this.delay(r.profile));
            }),
        ),
      subscribe: (relays, filter, params) => {
        const s = { relays, filter, onevent: params.onevent, conns: [] as string[] };
        subs.push(s);
        if (this.online.get(phone) === 'online') attach(s);
        return {
          close: () => {
            detach(s);
            subs.splice(subs.indexOf(s), 1);
          },
        };
      },
      /** Re-open subscriptions after coming back online (what the app does on reconnect), replaying stored events. */
      reconnect: () => {
        for (const s of subs) {
          detach(s);
          attach(s);
        }
      },
    };
  }
}

/** Virtual direct links. A pair can connect only if both are online and NAT traversal succeeds for that pair. */
export class SimDirectNet {
  private readonly rnd = mulberry32(99);
  private readonly links = new Map<string, SimDirect>();
  readonly reachable = new Map<string, boolean>();

  constructor(
    private readonly clock: SimClock,
    private readonly online: Map<string, PhoneNet>,
    /** Probability that two phones can open a direct channel (carrier CGNAT often blocks it). */
    private readonly natSuccess = 0.55,
  ) {}

  private pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  canConnect(a: string, b: string): boolean {
    const k = this.pairKey(a, b);
    if (!this.reachable.has(k)) this.reachable.set(k, this.rnd() < this.natSuccess);
    return this.reachable.get(k)! && this.online.get(a) === 'online' && this.online.get(b) === 'online';
  }

  linksFor(phone: string): SimDirect {
    const l = new SimDirect(phone, this);
    this.links.set(phone, l);
    return l;
  }

  get(phone: string): SimDirect | undefined {
    return this.links.get(phone);
  }

  deliver(from: string, to: string, bytes: Uint8Array): boolean {
    if (!this.canConnect(from, to) || this.rnd() < DIRECT.loss) return false;
    const target = this.links.get(to);
    if (!target) return false;
    this.clock.setTimeout(() => target.inbound(from, bytes), DIRECT.latencyMs[0] + this.rnd() * (DIRECT.latencyMs[1] - DIRECT.latencyMs[0]));
    return true;
  }

  /** Drop links involving a phone that went offline. */
  dropAll(phone: string): void {
    for (const l of this.links.values()) l.drop(phone);
    this.links.get(phone)?.dropEverything();
  }
}

export class SimDirect implements DirectLinks {
  private readonly open = new Set<string>();
  private msgHandler: (peer: string, bytes: Uint8Array) => void = () => undefined;
  private signalHandler: (peer: string, signal: unknown) => void = () => undefined;

  constructor(
    private readonly self: string,
    private readonly net: SimDirectNet,
  ) {}

  connected(): string[] {
    return [...this.open].filter((p) => this.net.canConnect(this.self, p));
  }
  send(peer: string, bytes: Uint8Array): boolean {
    return this.open.has(peer) && this.net.deliver(this.self, peer, bytes);
  }
  onMessage(h: (peer: string, bytes: Uint8Array) => void): void {
    this.msgHandler = h;
  }
  onSignal(h: (peer: string, signal: unknown) => void): void {
    this.signalHandler = h;
  }
  /** Simulated ICE: an offer travels via the router (Nostr), the answer comes back, then the channel opens. */
  connect(peer: string): void {
    if (this.open.has(peer)) return;
    this.signalHandler(peer, { type: 'offer', from: this.self });
  }
  handleSignal(peer: string, signal: unknown): void {
    const s = signal as { type: string };
    if (s.type === 'offer') {
      if (this.net.canConnect(this.self, peer)) {
        // Send answer over Nostr before marking the channel open so the initiator receives it.
        this.signalHandler(peer, { type: 'answer', from: this.self });
        this.open.add(peer);
      }
    } else if (s.type === 'answer') {
      if (this.net.canConnect(this.self, peer)) this.open.add(peer);
    }
  }
  disconnect(peer: string): void {
    this.open.delete(peer);
  }
  close(): void {
    this.open.clear();
  }
  inbound(from: string, bytes: Uint8Array): void {
    if (this.open.has(from)) this.msgHandler(from, bytes);
  }
  drop(peer: string): void {
    this.open.delete(peer);
  }
  dropEverything(): void {
    this.open.clear();
  }
}
