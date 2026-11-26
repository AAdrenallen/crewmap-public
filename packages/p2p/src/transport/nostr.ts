import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { CircleState } from '../crypto/circle';
import { b64, hex, keyedHash, u32be, unb64, utf8 } from '../crypto/sodium';
import { KIND_DURABLE, KIND_EPHEMERAL, type NostrEvent, type NostrFilter, type RelayPool } from './types';

const DAY_MS = 86_400_000;

export function dayIndex(t: number): number {
  return Math.floor(t / DAY_MS);
}

/**
 * Per-device, per-circle, per-day pseudonymous Nostr author key: relays can't link a device across days or circles.
 * Derived from the epoch key, so it also changes on every rotation.
 */
export function authorKey(st: CircleState, epoch: number, deviceId: string, day: number): Uint8Array {
  const key = st.epochKeys.get(epoch);
  if (!key) throw new Error('no epoch key');
  for (let ctr = 0; ctr < 8; ctr++) {
    const sk = keyedHash(key, 'nostr-author', utf8(deviceId), u32be(day), u32be(ctr));
    try {
      getPublicKey(sk); // throws if not a valid secp256k1 scalar (probability ~2^-128)
      return sk;
    } catch {
      continue;
    }
  }
  throw new Error('could not derive author key');
}

/** Circle broadcast topic for a day (only members can compute it). */
export function circleTopic(st: CircleState, epoch: number, day: number): string {
  return hex(keyedHash(st.epochKeys.get(epoch)!, 'topic', u32be(day))).slice(0, 32);
}

/** Unicast hint for a recipient on a day. */
export function recipientTopic(st: CircleState, epoch: number, deviceId: string, day: number): string {
  return hex(keyedHash(st.epochKeys.get(epoch)!, 'to', utf8(deviceId), u32be(day))).slice(0, 32);
}

export interface PublishOptions {
  durable: boolean;
  /** For durable events: NIP-40 expiration, seconds from now. */
  ttlS: number;
  /** Unicast recipient device id. */
  to?: string;
}

/**
 * Carries sealed envelopes over Nostr relays. Relays see: an ephemeral or regular kind, a random-looking author,
 * an opaque topic tag, an expiration, and base64 ciphertext. Nothing else.
 */
export class NostrCarrier {
  private subs: { close(): void }[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(
    private readonly pool: RelayPool,
    private readonly selfId: string,
  ) {}

  buildEvent(st: CircleState, envelope: Uint8Array, now: number, opts: PublishOptions): NostrEvent {
    const day = dayIndex(now);
    const sk = authorKey(st, st.epoch, this.selfId, day);
    const tags: string[][] = [['t', opts.to ? recipientTopic(st, st.epoch, opts.to, day) : circleTopic(st, st.epoch, day)]];
    if (opts.durable) tags.push(['expiration', String(Math.floor(now / 1000) + opts.ttlS)]);
    return finalizeEvent(
      { kind: opts.durable ? KIND_DURABLE : KIND_EPHEMERAL, created_at: Math.floor(now / 1000), tags, content: b64(envelope) },
      sk,
    ) as NostrEvent;
  }

  /** Publish to all relays; resolves true if at least one relay accepted. */
  async publish(relays: string[], ev: NostrEvent): Promise<boolean> {
    if (relays.length === 0) return false;
    const results = await Promise.allSettled(this.pool.publish(relays, ev));
    return results.some((r) => r.status === 'fulfilled');
  }

  /**
   * Subscribe to the circle topics for yesterday, today and tomorrow (clock skew around midnight), for the current and previous epoch (rotation grace),
   * plus our unicast topics. `sinceS` replays durable events we missed while offline.
   */
  subscribe(relays: string[], st: CircleState, now: number, sinceS: number, onEnvelope: (env: Uint8Array, ev: NostrEvent) => void): void {
    this.close();
    if (relays.length === 0) return;
    const day = dayIndex(now);
    const topics: string[] = [];
    for (const ep of [st.epoch, st.epoch - 1]) {
      if (!st.epochKeys.has(ep)) continue;
      for (const d of [day - 1, day, day + 1]) {
        topics.push(circleTopic(st, ep, d), recipientTopic(st, ep, this.selfId, d));
      }
    }
    const filter: NostrFilter = { kinds: [KIND_EPHEMERAL, KIND_DURABLE], '#t': topics, since: sinceS };
    this.subs.push(
      this.pool.subscribe(relays, filter, {
        onevent: (e) => {
          if (this.markSeen(e.id)) return;
          try {
            onEnvelope(unb64(e.content), e);
          } catch {
            // Not base64 / not ours: ignore.
          }
        },
      }),
    );
  }

  close(): void {
    for (const s of this.subs) s.close();
    this.subs = [];
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
    return false;
  }
}
