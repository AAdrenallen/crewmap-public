import { SimplePool } from 'nostr-tools/pool';
import type { RelayPool } from '@crewmap/p2p';

/** nostr-tools pings every relay each 29 s; on React Native each ping is a full REQ round trip. */
const PING_EVERY_MS = 120_000;

/**
 * The single relay pool shared by every crew, the mailbox and invites: one WebSocket per relay however many crews
 * exist. Keep-alives are stretched from 29 s to 2 min (4x fewer radio wake-ups per relay); a dead socket is still
 * detected and reconnected, just up to ~2 min later, which the next catch-up covers.
 */
export function createRelayPool(): RelayPool {
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  const relays = (pool as unknown as { relays: Map<string, { pingFrequency: number }> }).relays;
  const set = relays.set.bind(relays);
  relays.set = (url, relay) => {
    relay.pingFrequency = PING_EVERY_MS;
    return set(url, relay);
  };
  return pool as unknown as RelayPool;
}
