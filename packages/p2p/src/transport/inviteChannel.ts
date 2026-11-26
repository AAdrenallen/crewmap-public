import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { b64, unb64 } from '../crypto/sodium';
import { KIND_DURABLE, type NostrEvent, type RelayPool } from './types';

/**
 * Join handshake transport (before the joiner has circle keys): sealed-box payloads published under a throwaway
 * Nostr key, tagged with a topic derived from the invite secret (only invite holders can compute it). Durable for the
 * invite's lifetime so the issuer can be offline when the request is sent.
 */
export async function publishSealed(pool: RelayPool, relays: string[], topic: string, sealed: Uint8Array, ttlS: number, now = Date.now()): Promise<boolean> {
  const ev = finalizeEvent(
    {
      kind: KIND_DURABLE,
      created_at: Math.floor(now / 1000),
      tags: [
        ['t', topic],
        ['expiration', String(Math.floor(now / 1000) + ttlS)],
      ],
      content: b64(sealed),
    },
    generateSecretKey(),
  ) as NostrEvent;
  const results = await Promise.allSettled(pool.publish(relays, ev));
  return results.some((r) => r.status === 'fulfilled');
}

export function subscribeSealed(pool: RelayPool, relays: string[], topic: string, sinceS: number, cb: (sealed: Uint8Array) => void): { close(): void } {
  const seen = new Set<string>();
  return pool.subscribe(relays, { kinds: [KIND_DURABLE], '#t': [topic], since: sinceS }, {
    onevent: (e) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      try {
        cb(unb64(e.content));
      } catch {
        // not ours
      }
    },
  });
}
