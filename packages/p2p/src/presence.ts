import type { Activity } from '@crewmap/shared/driving';
import type { Router, Incoming } from './router';
import type { DeviceIdentity } from './crypto/identity';
import { b64, concat, fromUtf8, sodium, unb64, utf8 } from './crypto/sodium';
import { openJson, sealJson } from './companions';
import { DEFAULT_SHARING, mergePresence, planPresence, presenceForView, type PresenceTier, type SharingPolicy, type UserOverride } from './sharing';
import { protocolStamp, type PeerProtocol } from './protocol';

/** What a phone shares about itself. Compact keys keep relay events small. */
export interface Presence extends PeerProtocol {
  lat: number;
  lng: number;
  /** accuracy, m */
  acc: number;
  /** speed m/s */
  spd: number | null;
  /** heading deg */
  hdg: number | null;
  act: Activity;
  /** battery %, charging */
  bat: number | null;
  chg: boolean;
  /** fix time */
  t: number;
  /** 'p' precise, 'a' approximate (≈ 1–2 km grid), 'c' city-level (≈ 20 km grid). */
  prec: 'p' | 'a' | 'c';
  /** Navigating: destination ETA (epoch ms). */
  eta?: number;
  /** `eta` comes from the Waze / Google Maps navigation notification (traffic-aware). */
  etaSrc?: 'waze' | 'gmaps';
  /** Ghost mode marker: friends show "paused" and drop the last position. */
  ghost?: true;
  /** Points queued while offline, sent with the first update after reconnecting: [lat, lng, t]. */
  trail?: [number, number, number][];
}

export interface SharingSettings {
  ghost: boolean;
  /** This crew's policy (absent = everything allowed). Applied before anything is sealed. */
  policy?: SharingPolicy;
  /** Per-friend overrides (D52), by deviceId. */
  overrides?: Readonly<Record<string, UserOverride>>;
  /** A member's box key (tier keys are box-sealed to it). Members without one stay on the broadcast. */
  boxPkOf?: (deviceId: string) => Uint8Array | null;
  /** Whether a member reads tiers (capability `userShare`; unknown = yes). */
  canTier?: (deviceId: string) => boolean;
}

/**
 * Publishes presence respecting ghost mode, the crew policy and per-friend overrides (D52). With no overrides: one
 * broadcast. Otherwise the broadcast carries the least any member may see, plus one 'presence-tier' event per richer
 * view, secretbox-sealed with a key only that tier's members have. The tier key is box-sealed to each member's own
 * key (not only the crew epoch key, which every member holds) and rotated when a tier's members change.
 */
export class PresencePublisher {
  private readonly tierKeys = new Map<string, { sig: string; key: Uint8Array }>();
  private ghostAnnounced = false;

  constructor(
    private readonly router: Router,
    private readonly members: () => string[],
  ) {}

  async publish(raw: Presence, s: SharingSettings): Promise<void> {
    const friends = this.members();
    // Alone in this crew: nobody can read it, so the radio stays off.
    if (friends.length === 0) return;
    if (s.ghost) return this.announceGhost(raw.t);
    const boxPkOf = s.boxPkOf ?? (() => null);
    const plan = planPresence(friends, s.policy ?? DEFAULT_SHARING, s.overrides ?? {}, (id) => (s.canTier?.(id) ?? true) && !!boxPkOf(id));
    const base = presenceForView(raw, plan.base);
    if (base) {
      this.ghostAnnounced = false;
      await this.router.broadcast('presence', utf8(JSON.stringify({ ...base, ...protocolStamp() })));
    } else await this.announceGhost(raw.t);
    for (const tier of plan.tiers) {
      const p = presenceForView(raw, tier.view);
      if (!p) continue;
      const key = await this.ensureTierKey(tier, boxPkOf);
      const sd = sodium();
      const nonce = sd.randombytes_buf(24);
      const box = sd.crypto_secretbox_easy(utf8(JSON.stringify({ ...p, ...protocolStamp() })), nonce, key);
      await this.router.broadcast('presence-tier', concat(nonce, box));
    }
    for (const k of [...this.tierKeys.keys()]) if (!plan.tiers.some((t) => t.key === k)) this.tierKeys.delete(k);
  }

  private async announceGhost(t: number): Promise<void> {
    if (this.ghostAnnounced) return;
    this.ghostAnnounced = true;
    await this.router.broadcast('presence', utf8(JSON.stringify({ ghost: true, t, ...protocolStamp() })));
  }

  private async ensureTierKey(tier: PresenceTier, boxPkOf: (id: string) => Uint8Array | null): Promise<Uint8Array> {
    const sig = tier.members.join(',');
    const cur = this.tierKeys.get(tier.key);
    if (cur && cur.sig === sig) return cur.key;
    const key = sodium().randombytes_buf(32);
    this.tierKeys.set(tier.key, { sig, key });
    await Promise.all(
      tier.members.map((f) => {
        const pk = boxPkOf(f);
        return pk ? this.router.sendTo(f, 'tier-key', sealJson(pk, { k: b64(key) })) : undefined;
      }),
    );
    return key;
  }
}

export interface FriendPresence extends Presence {
  deviceId: string;
  receivedAt: number;
  via: Incoming['via'];
}

/**
 * Receives friends' presence. Precise updates win over approximate ones of the same time; two of the same time and
 * precision (the broadcast and a tier of one fix) are merged. Still reads the pre-D52 'sender-key' /
 * 'presence-precise' pair from older senders. `me` is needed to open tier keys (box-sealed to this device).
 */
export class PresenceBook {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly tierKeys = new Map<string, Uint8Array>();
  private readonly latest = new Map<string, FriendPresence>();
  private readonly paused = new Set<string>();
  private readonly listeners = new Set<(p: FriendPresence | { deviceId: string; ghost: true }) => void>();

  constructor(router: Router, me?: DeviceIdentity) {
    if (me) {
      router.on('tier-key', (m) => {
        const v = openJson(me, m.payload) as { k?: unknown } | null;
        if (v && typeof v.k === 'string') this.tierKeys.set(m.sender, unb64(v.k));
      });
      router.on('presence-tier', (m) => this.openSecret(m, this.tierKeys.get(m.sender)));
    }
    router.on('sender-key', (m) => {
      const { k } = JSON.parse(fromUtf8(m.payload)) as { k: string };
      this.keys.set(m.sender, unb64(k));
    });
    router.on('presence', (m) => {
      const p = JSON.parse(fromUtf8(m.payload)) as Presence;
      if (p.ghost) {
        this.paused.add(m.sender);
        this.latest.delete(m.sender);
        for (const l of this.listeners) l({ deviceId: m.sender, ghost: true });
        return;
      }
      this.accept(m, p);
    });
    router.on('presence-precise', (m) => this.openSecret(m, this.keys.get(m.sender)));
  }

  private openSecret(m: Incoming, key: Uint8Array | undefined): void {
    if (!key || m.payload.length < 24 + 16) return;
    try {
      const plain = sodium().crypto_secretbox_open_easy(m.payload.subarray(24), m.payload.subarray(0, 24), key);
      this.accept(m, JSON.parse(fromUtf8(plain)) as Presence);
    } catch {
      // Key rotated away from us (we were moved down a tier): ignore.
    }
  }

  private accept(m: Incoming, p: Presence): void {
    this.paused.delete(m.sender);
    const prev = this.latest.get(m.sender);
    const rank = { p: 3, a: 2, c: 1 } as const;
    if (prev && (prev.t > p.t || (prev.t === p.t && rank[prev.prec] > rank[p.prec]))) return;
    let fp: FriendPresence = { ...p, deviceId: m.sender, receivedAt: m.receivedAt, via: m.via };
    // Same fix through the broadcast and a tier: keep the fields either one carried.
    if (prev && prev.t === p.t && prev.prec === p.prec) fp = mergePresence<FriendPresence>(fp, prev)!;
    // The precise channel's payload has no protocol stamp: keep what the approximate one told us.
    if (fp.cp === undefined && prev?.cp !== undefined) {
      fp.cp = prev.cp;
      if (prev.pv !== undefined) fp.pv = prev.pv;
    }
    this.latest.set(m.sender, fp);
    for (const l of this.listeners) l(fp);
  }

  get(deviceId: string): FriendPresence | null {
    return this.latest.get(deviceId) ?? null;
  }

  isPaused(deviceId: string): boolean {
    return this.paused.has(deviceId);
  }

  all(): FriendPresence[] {
    return [...this.latest.values()];
  }

  on(cb: (p: FriendPresence | { deviceId: string; ghost: true }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
