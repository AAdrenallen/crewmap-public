/**
 * Wire-level protocol version and capability flags, so builds of different ages (preview, dev, production) can share
 * a crew and degrade gracefully.
 *
 * Rules that keep this safe:
 * - The envelope byte (`ENVELOPE_VERSION`) only changes for incompatible crypto framing. Everything else is additive.
 * - Message kinds a build does not know are ignored (never acked, never an error). New fields in JSON payloads are
 *   ignored by older readers.
 * - Presence carries `pv` (protocol version) and `cp` (capability bitmask). Absent means a pre-capability build
 *   (protocol 1) that supports the baseline kinds only.
 */
export const PROTOCOL_VERSION = 10;

export const CAPS = {
  /** 'presence-precise' + 'sender-key' (per-friend precision). */
  precisePresence: 1,
  /** Text chat ('chat' kind). */
  chat: 2,
  /** Shared hazards ('hazards' kind). */
  hazards: 4,
  /** Place arrival / departure notifications ('arrival' kind). */
  arrivals: 8,
  /** Per-crew sharing policies (coarse presence, stripped fields). */
  sharingPolicy: 16,
  /** Drive-along sessions ('drive-along', 'presence-live', 'route-share'; protocol 3). */
  driveAlong: 32,
  /** "Ask for location" ('loc-request'; protocol 3). */
  locate: 64,
  /** Live, auto-updating ETA share ('eta-share'; protocol 3). */
  etaShare: 128,
  /** Viewer demand ('watch'; protocol 4): peers slow background presence while nobody has the app open. */
  viewerDemand: 256,
  /** Group drive ('drive-along' invites with a destination, 'dest' and 'arrive' ops; protocol 5). Builds with only driveAlong read a group invite as a plain one. */
  groupDrive: 512,
  /** Location asks ('where-ask': "where do you want me?" and one-time share requests; protocol 6, D47). */
  askWhere: 1024,
  /** Custom quips ('quip' + 'quip-blob'; protocol 7, D49). Older builds get the voice clip as a plain custom emote. */
  quips: 2048,
  /** Per-friend sharing overrides ('tier-key' + 'presence-tier'; protocol 8, D52). Older builds see the crew broadcast only. */
  userShare: 4096,
  /** Leaderboard aggregates ('stats-agg'; protocol 9, D56): counts and totals per period, no places. */
  statsAgg: 8192,
  /** Trip memories ('memory', 'memory-photo', 'memory-blob', 'memory-react'; protocol 10, D68). Older builds ignore them. */
  memories: 16384,
} as const;

export type Capability = keyof typeof CAPS;

/** What a protocol-1 build (no `pv` / `cp` on the wire) is known to do. */
export const BASELINE_CAPS: Capability[] = ['precisePresence', 'hazards', 'arrivals'];

export const LOCAL_CAPS: Capability[] = ['precisePresence', 'chat', 'hazards', 'arrivals', 'sharingPolicy', 'driveAlong', 'locate', 'etaShare', 'viewerDemand', 'groupDrive', 'askWhere', 'quips', 'userShare', 'statsAgg', 'memories'];

export function capMask(caps: Capability[]): number {
  return caps.reduce((m, c) => m | CAPS[c], 0);
}

export const LOCAL_CAP_MASK = capMask(LOCAL_CAPS);

/** Fields every presence message carries. */
export const protocolStamp = (): { pv: number; cp: number } => ({ pv: PROTOCOL_VERSION, cp: LOCAL_CAP_MASK });

export interface PeerProtocol {
  pv?: number;
  cp?: number;
}

export function protocolOf(p: PeerProtocol | null | undefined): { version: number; known: boolean; caps: Set<Capability> } {
  if (!p) return { version: 0, known: false, caps: new Set() };
  if (typeof p.cp !== 'number') return { version: 1, known: true, caps: new Set(BASELINE_CAPS) };
  const caps = new Set<Capability>();
  for (const [name, bit] of Object.entries(CAPS) as [Capability, number][]) if (p.cp & bit) caps.add(name);
  return { version: typeof p.pv === 'number' ? p.pv : 2, known: true, caps };
}

/**
 * Whether a peer supports a capability. `null` = not known yet (we have heard no presence from it): callers that
 * must not fail should treat that as "try", callers that want to hide a feature as "unavailable".
 */
export function peerSupports(p: PeerProtocol | null | undefined, cap: Capability): boolean | null {
  const info = protocolOf(p);
  return info.known ? info.caps.has(cap) : null;
}
