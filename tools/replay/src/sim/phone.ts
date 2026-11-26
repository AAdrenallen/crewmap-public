import {
  replay,
  Router,
  utf8,
  fromUtf8,
  type CircleOp,
  type CircleState,
  type DeviceIdentity,
  type TransportConfig,
  type WakeService,
} from '@crewmap/p2p';
import { mulberry32 } from '../synth';
import type { SimClock } from './clock';
import type { SimDirectNet, SimRelayNet } from './network';

/**
 * App states that matter for delivery:
 * - `foreground`: app open; connections up.
 * - `sharing`: backgrounded but the location foreground service keeps connections up (normal Android state).
 * - `doze`: backgrounded, not sharing; no connections except short wake windows (ntfy ping, 15-min periodic sync).
 * - `offline`: no network.
 */
export type PhoneState = 'foreground' | 'sharing' | 'doze' | 'offline';

export interface Received {
  kind: string;
  sender: string;
  sentAt: number;
  receivedAt: number;
  payload: string;
}

export class SimWakeNet {
  private readonly rnd = mulberry32(5);
  readonly phones = new Map<string, SimPhone>();
  pings = 0;
  constructor(private readonly clock: SimClock) {}
  serviceFor(): WakeService {
    return {
      endpoint: async () => null,
      ping: async (endpoint) => {
        this.pings++;
        const target = this.phones.get(endpoint);
        if (!target || this.rnd() < 0.01) return false;
        this.clock.setTimeout(() => target.wake('push'), 500 + this.rnd() * 2500);
        return true;
      },
    };
  }
}

export class SimPhone {
  state: PhoneState = 'sharing';
  router: Router;
  circle: CircleState;
  readonly received: Received[] = [];
  private wakeUntil = 0;
  private lastOnlineS = 0;

  constructor(
    readonly name: string,
    readonly id: DeviceIdentity,
    log: CircleOp[],
    private readonly clock: SimClock,
    private readonly relays: SimRelayNet,
    private readonly direct: SimDirectNet,
    wakeNet: SimWakeNet,
    cfg: { config: TransportConfig; publicRelays: string[]; pcRelays: string[] },
  ) {
    this.circle = replay(log, id);
    const pool = this.relays.poolFor(id.deviceId);
    this.reconnectPool = pool.reconnect;
    wakeNet.phones.set(id.deviceId, this);
    this.router = new Router({
      self: id,
      circle: () => this.circle,
      pool,
      publicRelays: cfg.publicRelays,
      pcRelays: cfg.pcRelays,
      config: cfg.config,
      direct: direct.linksFor(id.deviceId),
      wake: wakeNet.serviceFor(),
      wakeEndpointOf: (peer) => peer,
      clock,
    });
    for (const kind of ['presence', 'emote', 'arrival'] as const) {
      this.router.on(kind, (m) =>
        this.received.push({ kind, sender: m.sender, sentAt: m.sentAt, receivedAt: m.receivedAt, payload: fromUtf8(m.payload) }),
      );
    }
    this.setNet(true);
    this.router.start(Math.floor(clock.now() / 1000) - 60);
    // WorkManager periodic sync while dozing (Android minimum interval: 15 min).
    clock.every(15 * 60_000, () => {
      if (this.state === 'doze') this.wake('periodic');
    });
  }

  private readonly reconnectPool: () => void;

  get connected(): boolean {
    return this.state === 'foreground' || this.state === 'sharing' || (this.state === 'doze' && this.clock.now() < this.wakeUntil);
  }

  setState(s: PhoneState): void {
    this.state = s;
    this.setNet(this.connected);
  }

  /** A wake-up opens connections for a short window and catches up on stored events. */
  wake(_reason: 'push' | 'periodic'): void {
    if (this.state !== 'doze') return;
    this.wakeUntil = this.clock.now() + 45_000;
    this.setNet(true);
    this.clock.setTimeout(() => {
      if (this.state === 'doze' && this.clock.now() >= this.wakeUntil) this.setNet(false);
    }, 45_000);
  }

  private setNet(on: boolean): void {
    const was = this.relays.online.get(this.id.deviceId) === 'online';
    this.relays.online.set(this.id.deviceId, on ? 'online' : 'offline');
    if (on && !was) {
      // Re-subscribe with `since` = last time we were online, so durable events are replayed.
      this.router.resubscribe(this.lastOnlineS - 60);
      this.reconnectPool();
    }
    if (!on && was) {
      this.lastOnlineS = Math.floor(this.clock.now() / 1000);
      this.direct.dropAll(this.id.deviceId);
    }
  }

  async sendPresence(lat: number, lng: number, speed: number): Promise<void> {
    if (!this.connected) return;
    await this.router.broadcast('presence', utf8(JSON.stringify({ lat, lng, speed, t: this.clock.now() })));
  }

  async sendEmote(to: string, preset: string): Promise<string | null> {
    if (!this.connected) return null;
    return this.router.sendTo(to, 'emote', utf8(JSON.stringify({ preset })));
  }

  async sendArrival(to: string, place: string): Promise<string | null> {
    if (!this.connected) return null;
    return this.router.sendTo(to, 'arrival', utf8(JSON.stringify({ place, event: 'arrive' })));
  }
}
