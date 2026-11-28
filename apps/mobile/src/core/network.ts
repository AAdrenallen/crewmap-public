import { platform } from '@crewmap/platform';
import {
  CircleSync,
  DEFAULT_PUBLIC_RELAYS,
  PresenceBook,
  PresencePublisher,
  peerSupports,
  profileForPolicy,
  Router,
  unb64,
  StatsAggChannel,
  ViewerDemand,
  type DeviceIdentity,
  type Presence,
  type RelayPool,
  type SharingPolicy,
  type UserOverride,
  type WakeService,
} from '@crewmap/p2p';
import { DEFAULT_AVATAR, DEFAULT_CAR } from '@crewmap/shared/avatar';
import type { CircleManager } from './circle';
import { CircleDoc } from './doc';
import { kvGet, kvSet, ydocStore } from './db';
import { useApp, type FriendView, type Profile } from './store';

/** UnifiedPush endpoints are plain HTTPS URLs (ntfy topic); a ping is an empty POST. */
const ntfyWake: WakeService = {
  endpoint: async () => platform.wake.endpoint(),
  ping: async (endpoint) => {
    if (!/^https:\/\//.test(endpoint)) return false;
    try {
      const res = await fetch(endpoint, { method: 'POST', body: '', headers: { 'X-Priority': '4' } });
      return res.ok;
    } catch {
      return false;
    }
  },
};

/**
 * One 5-min timer (inside the 10-min replay overlap) for every crew (a timer per crew woke the CPU N times a minute): each running network registers its
 * last-online writer here and the timer exists only while at least one is registered.
 */
const onlineWriters = new Set<() => void>();
let onlineTimer: ReturnType<typeof setInterval> | null = null;
function trackOnline(write: () => void): () => void {
  onlineWriters.add(write);
  onlineTimer ??= setInterval(() => onlineWriters.forEach((w) => w()), 300_000);
  return () => {
    onlineWriters.delete(write);
    if (onlineWriters.size === 0 && onlineTimer) {
      clearInterval(onlineTimer);
      onlineTimer = null;
    }
  };
}

/**
 * One crew's transport: its router (own epoch keys / Nostr topics), its Yjs doc, presence in and out. Everything
 * this phone sends here passes through the crew's sharing policy first (D26).
 */
export class Network {
  readonly pool: RelayPool;
  router: Router | null = null;
  sync: CircleSync | null = null;
  readonly doc = new CircleDoc();
  presencePub: PresencePublisher | null = null;
  presenceBook: PresenceBook | null = null;
  /** Whether anyone in this crew has the app open (protocol 4), and my own "watching" signal. */
  demand: ViewerDemand | null = null;
  /** Leaderboard aggregates, sealed per recipient (protocol 9, D57). */
  aggs: StatsAggChannel | null = null;
  private offs: (() => void)[] = [];

  constructor(
    readonly me: DeviceIdentity,
    readonly circle: CircleManager,
    pool: RelayPool,
    readonly policy: () => SharingPolicy,
    private readonly overrides: () => Readonly<Record<string, UserOverride>>,
    private readonly onFriends: () => void,
  ) {
    this.pool = pool;
  }

  publicRelays(): string[] {
    return DEFAULT_PUBLIC_RELAYS;
  }

  async start(): Promise<void> {
    const st = this.circle.state;
    if (!st || this.router) return;
    const s = useApp.getState().settings;
    const router = new Router({
      self: this.me,
      circle: () => this.circle.state!,
      pool: this.pool,
      publicRelays: this.publicRelays(),
      pcRelays: s.pcRelayUrl ? [s.pcRelayUrl] : [],
      config: s.transport,
      direct: platform.createDirectLinks(this.me.deviceId),
      wake: ntfyWake,
      wakeEndpointOf: (id) => this.doc.profile(id)?.wake ?? null,
    });
    this.router = router;
    this.sync = new CircleSync(this.doc.doc, router, ydocStore(st.circleId));
    this.presenceBook = new PresenceBook(router, this.me);
    this.presencePub = new PresencePublisher(router, () => this.friendIds());
    const book = this.presenceBook;
    this.demand = new ViewerDemand(router, () => this.friendIds(), (id) => book.get(id));
    this.aggs = new StatsAggChannel(router, this.me, () => this.friendIds(), (id) => {
      const pk = this.circle.state?.members.get(id)?.boxPk;
      return pk ? unb64(pk) : null;
    }, (id) => book.get(id));
    // Replay only what we missed: from the last time this crew was online (10 min overlap), never more than 3 days.
    // Replaying a fixed 3-day window on every launch re-verified and re-decrypted thousands of events (~45 s of CPU).
    const nowS = Math.floor(Date.now() / 1000);
    const onlineKey = `lastOnline:${st.circleId}`;
    const lastOnline = await kvGet<number>(onlineKey, 0);
    router.start(Math.max(nowS - 3 * 86_400, lastOnline - 600));
    const markOnline = () => void kvSet(onlineKey, Math.floor(Date.now() / 1000));
    markOnline();
    const untrack = trackOnline(markOnline);
    this.offs.push(() => {
      untrack();
      markOnline();
    });
    await this.sync.start();
    let lastEpoch = st.epoch;
    let lastMembers = st.members.size;
    this.offs.push(
      this.presenceBook.on(() => this.onFriends()),
      this.doc.onChange(() => this.onFriends()),
      this.circle.onChange(() => {
        const cur = this.circle.state;
        if (cur && (cur.epoch !== lastEpoch || cur.members.size !== lastMembers)) {
          lastEpoch = cur.epoch;
          lastMembers = cur.members.size;
          router.resubscribe(Math.floor(Date.now() / 1000) - 600);
        }
        this.onFriends();
      }),
      platform.wake.onPing(() => void this.catchUp()),
    );
    this.onFriends();
  }

  /** Transport health for the map chip: unacknowledged messages and open relay sockets. */
  connectivity(): { started: boolean; queued: number; relaysUp: number; relaysTotal: number } {
    const status = this.pool.listConnectionStatus?.();
    let up = 0;
    status?.forEach((ok) => {
      if (ok) up++;
    });
    return { started: !!this.router, queued: this.router?.queued ?? 0, relaysUp: up, relaysTotal: status?.size ?? 0 };
  }

  stop(): void {
    for (const o of this.offs) o();
    this.offs = [];
    this.demand?.stop();
    this.demand = null;
    this.aggs?.stop();
    this.aggs = null;
    this.sync?.stop();
    this.router?.stop();
    this.router = null;
  }

  /** After a wake ping / reconnect: re-subscribe from 10 min back and exchange state vectors. */
  async catchUp(): Promise<void> {
    if (!this.router) return;
    this.router.resubscribe(Math.floor(Date.now() / 1000) - 600);
    await this.sync?.announce();
  }

  applyTransportSettings(): void {
    const s = useApp.getState().settings;
    this.router?.setPcRelays(s.pcRelayUrl ? [s.pcRelayUrl] : []);
    this.router?.setConfig(s.transport);
  }

  friendIds(): string[] {
    const st = this.circle.state;
    return st ? [...st.members.keys()].filter((id) => id !== this.me.deviceId) : [];
  }

  has(deviceId: string): boolean {
    return deviceId !== this.me.deviceId && !!this.circle.state?.members.has(deviceId);
  }

  /** Writes my full profile, reduced to what this crew may see. */
  writeProfile(full: Profile): void {
    this.doc.setProfile(profileForPolicy(full, this.policy()));
  }

  async publishPresence(p: Presence): Promise<void> {
    if (!this.presencePub) return;
    const s = useApp.getState().settings;
    const members = this.circle.state?.members;
    await this.presencePub.publish(p, {
      ghost: s.ghost,
      policy: this.policy(),
      overrides: this.overrides(),
      boxPkOf: (id) => {
        const pk = members?.get(id)?.boxPk;
        return pk ? unb64(pk) : null;
      },
      // Unknown (not heard yet) = try; a known older build stays on the crew broadcast.
      canTier: (id) => peerSupports(this.presenceBook?.get(id), 'userShare') !== false,
    });
  }

  /** This crew's view of each member (merged across crews by Crews). */
  friendViews(): Record<string, FriendView> {
    const st = this.circle.state;
    const out: Record<string, FriendView> = {};
    if (!st) return out;
    for (const [id, m] of st.members) {
      if (id === this.me.deviceId) continue;
      const profile = this.doc.profile(id) ?? { deviceId: id, name: m.name, avatar: DEFAULT_AVATAR, car: DEFAULT_CAR };
      out[id] = {
        profile: { ...profile, name: profile.name || m.name },
        presence: this.presenceBook?.get(id) ?? null,
        paused: this.presenceBook?.isPaused(id) ?? false,
        etaS: null,
        routeM: null,
        isOwner: st.ownerId === id,
        crews: [st.circleId],
      };
    }
    return out;
  }
}
