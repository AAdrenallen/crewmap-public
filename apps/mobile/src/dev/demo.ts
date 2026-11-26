import { SimplePool } from 'nostr-tools/pool';
import {
  buildJoinRequest,
  completeJoin,
  crewThread,
  decodeChat,
  decodeInvite,
  DEFAULT_PUBLIC_RELAYS,
  encodeChat,
  fromUtf8,
  generateIdentity,
  hex,
  inviteTopics,
  openJson,
  CircleSync,
  MemoryPersistence,
  PresencePublisher,
  profileForPolicy,
  publishSealed,
  Router,
  sealJson,
  sodium,
  subscribeSealed,
  unb64,
  utf8,
  type ChatMessage,
  type CircleState,
  type DeviceIdentity,
  type Presence,
  type RelayPool,
} from '@crewmap/p2p';
import { CAR_COLORS, CARS, randomAvatar } from '@crewmap/shared/avatar';
import { parseOp } from '@crewmap/shared/companions';
import { EMOTE_PRESETS, type EmoteMessage } from '@crewmap/shared/emotes';
import type { LocationSample } from '@crewmap/shared/driving';
import { computeStats, shareableStats, type TripSummary } from '@crewmap/shared/stats';
import { CircleDoc } from '../core/doc';
import { engine } from '../core/engine';
import { kvGet, kvSet } from '../core/db';
import { useApp, type Profile } from '../core/store';

/**
 * DEV ONLY (imported behind __DEV__): an in-process second peer, "Demo Alex", for testing the social path on one
 * phone. It joins a separate "Demo crew" through a real invite over the same public relays, then talks to the owner
 * through real envelopes and routing: presence at 1 Hz, profile stats, chat replies, emotes back.
 */
const KV = 'dev.demo';
const NAME = 'Demo Alex';
const EXTRA_NAMES = ['Demo Bea', 'Demo Carl', 'Demo Dina', 'Demo Eli', 'Demo Faye', 'Demo Gus', 'Demo Hana', 'Demo Ivo', 'Demo Jade', 'Demo Kai'];
const REPLIES = ['Sounds good!', 'On it 👍', 'Haha, nice', 'See you soon', 'Can’t talk, driving later', 'Sure thing'];

interface Saved {
  circleId: string;
  deviceId: string;
}

export type DemoStatus = 'off' | 'joining' | 'running' | 'stopped';

let status: DemoStatus = 'off';
const listeners = new Set<(s: DemoStatus) => void>();
const setStatus = (s: DemoStatus) => {
  status = s;
  for (const l of listeners) l(s);
};
export const demoStatus = () => status;
export function onDemoStatus(cb: (s: DemoStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

class DemoPeer {
  private pool = new SimplePool({ enablePing: true, enableReconnect: true }) as unknown as RelayPool & { close(relays: string[]): void };
  private router: Router | null = null;
  private sync: CircleSync | null = null;
  private readonly doc = new CircleDoc();
  private timers: ReturnType<typeof setInterval>[] = [];
  private offs: (() => void)[] = [];
  private reply = 0;
  private emote = 0;
  private readonly profile: Profile;
  /** Last presence sent (answers "ask for location"). */
  private last: Presence | null = null;
  /** Drive-along session the owner invited this peer to (accepted automatically). */
  private sid: string | null = null;
  /** Latest live ETA share from the owner (accepted: nothing to answer). */
  etaShare: unknown = null;

  constructor(
    readonly id: DeviceIdentity,
    readonly st: CircleState,
    private readonly name: string = NAME,
    private readonly extra = false,
  ) {
    const car = { model: CARS[Math.floor(Math.random() * CARS.length)]!, color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]! };
    this.profile = { deviceId: id.deviceId, name, avatar: randomAvatar(), car, stats: seededStats() };
  }

  async start(): Promise<void> {
    const s = useApp.getState().settings;
    const router = new Router({ self: this.id, circle: () => this.st, pool: this.pool, publicRelays: DEFAULT_PUBLIC_RELAYS, config: s.transport });
    this.router = router;
    router.start(Math.floor(Date.now() / 1000) - 600);
    this.sync = new CircleSync(this.doc.doc, router, new MemoryPersistence());
    await this.sync.start();
    this.writeProfile();
    this.offs.push(
      useApp.subscribe((a, b) => {
        if (a.sharing[this.st.circleId] !== b.sharing[this.st.circleId]) this.writeProfile();
      }),
      router.on('drive-along', (m) => void this.onDriveAlong(m.sender, openJson(this.id, m.payload))),
      router.on('loc-request', (m) => void this.onLocate(m.sender)),
      router.on('eta-share', (m) => {
        this.etaShare = openJson(this.id, m.payload);
      }),
      router.on('chat', (m) => {
        if (this.extra) return;
        const msg = decodeChat(m.payload, m.sender, this.id);
        if (!msg) return;
        setTimeout(() => void this.sendChat(msg.to === null ? null : m.sender, REPLIES[this.reply++ % REPLIES.length]!), 1000 + Math.random() * 1000);
      }),
      router.on('emote', (m) => {
        if (this.extra) return;
        const got = JSON.parse(fromUtf8(m.payload)) as EmoteMessage;
        if (got.preset === 'custom' || !EMOTE_PRESETS.includes(got.preset)) return;
        setTimeout(() => void this.sendEmote(), 1500);
      }),
    );
    if (this.extra) this.moveExtra();
    else this.move();
    await this.sync.announce();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const o of this.offs) o();
    this.offs = [];
    this.sync?.stop();
    this.router?.stop();
    this.router = null;
    try {
      this.pool.close(DEFAULT_PUBLIC_RELAYS);
    } catch {
      // already closed
    }
  }

  private policy() {
    return engine.crews.policy(this.st.circleId);
  }

  private writeProfile(): void {
    this.doc.setProfile(profileForPolicy(this.profile, this.policy()));
  }

  async sendChat(to: string | null, text: string): Promise<void> {
    if (!this.router) return;
    const owner = engine.me;
    const msg: ChatMessage = { id: hex(sodium().randombytes_buf(12)), from: this.id.deviceId, to, text, t: Date.now() };
    if (to) await this.router.sendTo(to, 'chat', encodeChat(msg, owner.boxPk));
    else await this.router.broadcast('chat', encodeChat(msg));
  }

  /** Each preset in turn, to the owner. */
  async sendEmote(): Promise<void> {
    if (!this.router) return;
    const preset = EMOTE_PRESETS[this.emote++ % EMOTE_PRESETS.length]!;
    await this.router.sendTo(engine.me.deviceId, 'emote', utf8(JSON.stringify({ preset } satisfies EmoteMessage)));
  }

  /** Owner invited me to a drive-along: accept at once and stream live position from then on. */
  private async onDriveAlong(from: string, raw: unknown): Promise<void> {
    const op = parseOp(raw);
    if (!op || !this.router) return;
    if (op.op === 'invite') {
      this.sid = op.sid;
      await this.router.sendTo(from, 'drive-along', sealJson(engine.me.boxPk, { v: 1, op: 'accept', sid: op.sid, t: Date.now() })).catch(() => undefined);
    } else if (op.op === 'stop' && op.sid === this.sid) this.sid = null;
  }

  /** "Ask for location": one presence update right now. */
  private async onLocate(_from: string): Promise<void> {
    if (this.last) await this.publish({ ...this.last, t: Date.now() });
  }

  /** Simple dev-only mover for the extra crewmates: a loop around a random centre near Val-Clair. */
  private moveExtra(): void {
    const lat0 = 45.65 + (Math.random() - 0.5) * 0.08;
    const lng0 = -74.33 + (Math.random() - 0.5) * 0.12;
    const r = 0.004 + Math.random() * 0.012;
    const rate = (0.01 + Math.random() * 0.03) * (Math.random() < 0.5 ? 1 : -1);
    const act: Presence['act'] = (['automotive', 'walking', 'still', 'automotive'] as const)[Math.floor(Math.random() * 4)]!;
    const bat = 15 + Math.floor(Math.random() * 80);
    let a = Math.random() * Math.PI * 2;
    this.timers.push(
      setInterval(() => {
        a += act === 'still' ? 0 : rate;
        const spd = act === 'automotive' ? 12 : act === 'walking' ? 1.4 : 0;
        const hdg = ((((a * 180) / Math.PI + 90) % 360) + 360) % 360;
        void this.publish({ lat: lat0 + r * Math.sin(a), lng: lng0 + (r * Math.cos(a)) / 0.7, acc: 6, spd, hdg, act, bat, chg: false, t: Date.now(), prec: 'p' });
      }, 1000),
    );
  }

  /** Loop around Val-Clair from the replay fixtures: a drive, then a walk, forever, one presence per second. */
  private move(): void {
    void Promise.all([import('@crewmap/replay/fixtures'), import('@crewmap/replay/synth')]).then(([fx, sy]) => {
      if (!this.router) return;
      const c = fx.PLACES.valClair;
      const loop = sy.smooth([...fx.straight(c, 90, 1500), ...fx.straight({ lat: c.lat, lng: c.lng + 0.0193 }, 0, 1200).slice(1), ...fx.straight({ lat: c.lat + 0.0108, lng: c.lng + 0.0193 }, 270, 1500).slice(1), ...fx.straight({ lat: c.lat + 0.0108, lng: c.lng }, 180, 1200).slice(1)]);
      const drive = sy.synthesize({ path: loop, startAt: 0, phases: [{ kind: 'stop', seconds: 5 }, { kind: 'ramp', toKph: 50, mps2: 2 }, { kind: 'cruise', seconds: 300, kph: 50 }, { kind: 'ramp', toKph: 0, mps2: 2 }, { kind: 'stop', seconds: 10 }] });
      const walk = fx.walk();
      const legs: { pts: LocationSample[]; act: Presence['act'] }[] = [
        { pts: drive.locations, act: 'automotive' },
        { pts: walk.locations.slice(0, 300), act: 'walking' },
      ];
      let leg = 0;
      let i = 0;
      const bat = 60 + Math.floor(Math.random() * 35);
      const tick = () => {
        const l = legs[leg]!;
        const p = l.pts[i];
        if (!p) {
          leg = (leg + 1) % legs.length;
          i = 0;
          return;
        }
        i++;
        const pres: Presence = { lat: p.lat, lng: p.lng, acc: 5, spd: p.speed, hdg: p.heading, act: (p.speed ?? 0) < 1 && l.act === 'automotive' ? 'still' : l.act, bat, chg: false, t: Date.now(), prec: 'p' };
        void this.publish(pres);
      };
      this.timers.push(setInterval(tick, 1000));
    });
  }

  private pub: PresencePublisher | null = null;
  private async publish(p: Presence): Promise<void> {
    if (!this.router) return;
    this.last = p;
    if (this.sid) void this.router.sendTo(engine.me.deviceId, 'presence-live', sealJson(engine.me.boxPk, { ...p, sid: this.sid, prec: 'p' })).catch(() => undefined);
    this.pub ??= new PresencePublisher(this.router, () => [engine.me.deviceId]);
    await this.pub.publish(p, { ghost: false, policy: this.policy() }).catch(() => undefined);
  }
}

/** Seeded in-memory trips (never written to the owner's trip history) → shared stats per period. */
function seededStats(): Profile['stats'] {
  const now = Date.now();
  const trips: TripSummary[] = Array.from({ length: 24 }, (_, k) => {
    const startedAt = now - (k * 1.3 + 0.2) * 86_400_000;
    const km = 4 + ((k * 7) % 23);
    const kph = 38 + ((k * 5) % 30);
    return {
      id: `demo-${k}`,
      startedAt,
      endedAt: startedAt + (km / kph) * 3600_000,
      distanceM: km * 1000,
      durationS: (km / kph) * 3600,
      topSpeedKph: kph + 30,
      avgSpeedKph: kph,
      score: 72 + ((k * 3) % 27),
      passenger: false,
      events: k % 4 === 0 ? { hardBrake: 1 } : {},
    };
  });
  const vis = { score: true, distance: true, topSpeed: true, events: true, trips: true, places: false, streaks: true, badges: true };
  const tz = -new Date().getTimezoneOffset();
  return Object.fromEntries((['week', 'month', 'all'] as const).map((p) => [p, shareableStats(computeStats({ trips, walks: [], visits: [] }, p, now, tz), vis, now)]));
}

let peer: DemoPeer | null = null;
const extras: DemoPeer[] = [];

/** Demo identity whose id sorts below the owner's, so the owner never tries a WebRTC link to it (none exists). */
function demoIdentity(): DeviceIdentity {
  for (let i = 0; i < 500; i++) {
    const id = generateIdentity();
    if (id.deviceId < engine.me.deviceId) return id;
  }
  return generateIdentity();
}

/** Joiner side of a real invite, over the same relays the app uses. */
async function join(me: DeviceIdentity, link: string, pool: RelayPool): Promise<CircleState> {
  const token = decodeInvite(link);
  const topics = inviteTopics(unb64(token.k));
  const relays = token.r.length ? token.r : DEFAULT_PUBLIC_RELAYS;
  return new Promise<CircleState>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.close();
      reject(new Error('demo join timed out'));
    }, 120_000);
    const sub = subscribeSealed(pool, relays, topics.reply, Math.floor(Date.now() / 1000) - 60, (sealed) => {
      try {
        const st = completeJoin(me, token, sealed);
        clearTimeout(timer);
        sub.close();
        resolve(st);
      } catch {
        // reply for someone else
      }
    });
    void publishSealed(pool, relays, topics.request, buildJoinRequest(token, me, NAME), 86_400);
  });
}

/** Fresh start every time (a previous demo is removed first), so Maestro runs are deterministic. */
export async function startDemo(): Promise<void> {
  if (!__DEV__ || status === 'joining') return;
  await removeDemo();
  const me = useApp.getState().me;
  if (!me) return;
  setStatus('joining');
  try {
    const circleId = await engine.crews.create('Demo crew', me.name);
    const { link } = await engine.crews.manager(circleId)!.invite();
    const id = demoIdentity();
    const joinPool = new SimplePool() as unknown as RelayPool;
    const st = await join(id, link, joinPool);
    await kvSet(KV, { circleId, deviceId: id.deviceId } satisfies Saved);
    peer = new DemoPeer(id, st);
    await peer.start();
    setStatus('running');
  } catch (e) {
    if (__DEV__) console.warn('demo start failed', e);
    setStatus('off');
  }
}

export function stopDemo(): void {
  for (const e of extras.splice(0)) e.stop();
  peer?.stop();
  peer = null;
  if (status !== 'off') setStatus('stopped');
}

/** Dev only: adds up to 10 moving crewmates to the running Demo crew (never to the owner's real crews). */
export async function spawnDemoCrewmates(n = 8): Promise<number> {
  if (!__DEV__ || status !== 'running') return 0;
  const saved = await kvGet<Saved | null>(KV, null);
  const mgr = saved ? engine.crews.manager(saved.circleId) : null;
  if (!saved || !mgr) return 0;
  let added = 0;
  for (let i = 0; i < Math.min(10, Math.max(1, n)); i++) {
    try {
      const { link } = await mgr.invite();
      const id = demoIdentity();
      const st = await join(id, link, new SimplePool() as unknown as RelayPool);
      const mate = new DemoPeer(id, st, EXTRA_NAMES[(extras.length) % EXTRA_NAMES.length]!, true);
      await mate.start();
      extras.push(mate);
      added++;
    } catch (e) {
      if (__DEV__) console.warn('demo crewmate failed', e);
    }
  }
  return added;
}

/** Demo friend sends the next emote preset (receive path: popup, burst, notification). */
export async function demoSendEmote(): Promise<void> {
  await peer?.sendEmote();
}

/** Deletes the Demo crew and its data from this phone (existing crews are never touched). */
export async function removeDemo(): Promise<void> {
  stopDemo();
  const saved = await kvGet<Saved | null>(KV, null);
  if (saved) {
    if (engine.crews.ids.includes(saved.circleId)) await engine.crews.leave(saved.circleId).catch(() => undefined);
    await engine.chat.deleteThread(saved.deviceId);
    await engine.chat.deleteThread(crewThread(saved.circleId));
    await kvSet(KV, null);
  }
  setStatus('off');
}
