import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  deriveJoinCode,
  joinCodeBucket,
  joinCodeBuckets,
  JOIN_CODE_TTL_MS,
  openJoinCode,
  sealJoinCode,
  type PwhashCost,
} from '../crypto/joinCode';
import { b64, unb64 } from '../crypto/sodium';
import { KIND_DURABLE, type NostrEvent, type RelayPool } from './types';

/** What the admin keeps to retract a published code (NIP-09 deletion needs the event's own key). */
export interface PublishedCode {
  code: string;
  inviteId: string;
  eventId: string;
  sk: string;
  expiresAt: number;
}

/** Admin: seal `link` under the code and publish it, expiring (NIP-40) with the code. */
export async function publishJoinCode(
  pool: RelayPool,
  relays: string[],
  code: string,
  inviteId: string,
  link: string,
  now = Date.now(),
  cost?: PwhashCost,
): Promise<PublishedCode> {
  const expiresAt = now + JOIN_CODE_TTL_MS;
  const { topic, key } = deriveJoinCode(code, joinCodeBucket(now), cost);
  const sk = generateSecretKey();
  const ev = finalizeEvent(
    {
      kind: KIND_DURABLE,
      created_at: Math.floor(now / 1000),
      tags: [
        ['t', topic],
        ['expiration', String(Math.ceil(expiresAt / 1000))],
      ],
      content: b64(sealJoinCode(key, link, expiresAt)),
    },
    sk,
  ) as NostrEvent;
  await Promise.allSettled(pool.publish(relays, ev));
  return { code, inviteId, eventId: ev.id, sk: b64(sk), expiresAt };
}

/** Admin: best-effort NIP-09 deletion once the code is used or withdrawn (the one-time invite inside is the real guard). */
export async function retractJoinCode(pool: RelayPool, relays: string[], pub: PublishedCode, now = Date.now()): Promise<void> {
  const ev = finalizeEvent(
    { kind: 5, created_at: Math.floor(now / 1000), tags: [['e', pub.eventId], ['k', String(KIND_DURABLE)]], content: '' },
    unb64(pub.sk),
  ) as NostrEvent;
  await Promise.allSettled(pool.publish(relays, ev));
}

/** Joiner: derive the candidate buckets, look for a sealed link and open it; null if nothing opens within `waitMs`. */
export function resolveJoinCode(
  pool: RelayPool,
  relays: string[],
  code: string,
  now = Date.now(),
  waitMs = 8_000,
  cost?: PwhashCost,
): Promise<string | null> {
  const keys = joinCodeBuckets(now).map((b) => deriveJoinCode(code, b, cost));
  return new Promise((resolve) => {
    let done = false;
    const finish = (link: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub?.close();
      resolve(link);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    let sub: { close(): void } | null = null;
    sub = pool.subscribe(
      relays,
      { kinds: [KIND_DURABLE], '#t': keys.map((k) => k.topic), since: Math.floor((now - 2 * JOIN_CODE_TTL_MS) / 1000) },
      {
        onevent: (e) => {
          const topic = e.tags.find((t) => t[0] === 't')?.[1];
          const k = keys.find((x) => x.topic === topic);
          if (!k) return;
          let sealed: Uint8Array;
          try {
            sealed = unb64(e.content);
          } catch {
            return;
          }
          const link = openJoinCode(k.key, sealed, now);
          if (link) finish(link);
        },
      },
    );
    if (done) sub.close();
  });
}
