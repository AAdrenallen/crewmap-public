/** Functions whose transport can be switched between P2P and the central PC relay (Section 2A). */
export type FunctionName = 'presence' | 'emotes' | 'arrivals' | 'sync' | 'chores' | 'wake';

export type TransportMode = 'p2p' | 'relay';

export type TransportConfig = Record<FunctionName, TransportMode>;

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  presence: 'p2p',
  emotes: 'p2p',
  arrivals: 'p2p',
  sync: 'p2p',
  chores: 'p2p',
  wake: 'p2p',
};

/** Public Nostr relays that advertise NIP-40 (checked via NIP-11, see docs/RESEARCH.md). */
export const DEFAULT_PUBLIC_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://offchain.pub',
];

/** Nostr event kinds. Ephemeral (20000–29999) are never stored by relays; regular ones carry NIP-40 expiration. */
export const KIND_EPHEMERAL = 21420;
export const KIND_DURABLE = 1420;

/** Minimal Nostr event + filter shapes (NIP-01). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  kinds?: number[];
  '#t'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
  ids?: string[];
}

/** The subset of nostr-tools' SimplePool we use, so the simulator can substitute an in-memory relay network. */
export interface RelayPool {
  publish(relays: string[], event: NostrEvent): Promise<string>[];
  subscribe(
    relays: string[],
    filter: NostrFilter,
    params: { onevent: (e: NostrEvent) => void; oneose?: () => void },
  ): { close(): void };
  /** Socket state per relay url (true = connected), when the pool exposes it. */
  listConnectionStatus?(): Map<string, boolean>;
  /** Close these relay sockets (they reopen on the next publish/subscribe). */
  close?(relays: string[]): void;
}

/** A direct, low-latency link to individual peers (WebRTC data channels on device; virtual links in the simulator). */
export interface DirectLinks {
  /** Peers with an open channel right now. */
  connected(): string[];
  send(peer: string, bytes: Uint8Array): boolean;
  onMessage(h: (peer: string, bytes: Uint8Array) => void): void;
  /** Feed a signalling message from `peer` (SDP/ICE), delivered via the router. */
  handleSignal(peer: string, signal: unknown): void;
  /** Called by the links layer when it needs to send a signalling message to `peer`. */
  onSignal(h: (peer: string, signal: unknown) => void): void;
  /** Try to establish a link (initiator role decided by device id ordering). */
  connect(peer: string): void;
  disconnect(peer: string): void;
  close(): void;
}

/** Content-free wake-ups for backgrounded peers (UnifiedPush via ntfy). */
export interface WakeService {
  /** This device's push endpoint (shared with the circle inside the encrypted doc), or null if unavailable. */
  endpoint(): Promise<string | null>;
  ping(endpoint: string): Promise<boolean>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
