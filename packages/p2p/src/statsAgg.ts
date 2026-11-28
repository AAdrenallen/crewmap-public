import { LEADER, type AggSet, type StatsAgg } from '@crewmap/shared/stats';
import { parseCrewBias, type CrewBias } from '@crewmap/shared/navigation';
import type { Router } from './router';
import type { DeviceIdentity } from './crypto/identity';
import { openJson, sealJson } from './companions';
import { peerSupports, type PeerProtocol } from './protocol';

/** Numeric fields a 'stats-agg' may carry, with their bound. Anything else is dropped on receipt. */
const FIELDS: Record<Exclude<keyof StatsAgg, 'k' | 'score'>, { max: number; int: boolean }> = {
  drives: { max: 100_000, int: true },
  drivenKm: { max: 5_000_000, int: false },
  walks: { max: 100_000, int: true },
  walkedKm: { max: 1_000_000, int: false },
  longestKm: { max: 20_000, int: false },
  scoredKm: { max: 5_000_000, int: false },
  eventsPer100: { max: 100_000, int: false },
  nightTrips: { max: 100_000, int: true },
  earlyTrips: { max: 100_000, int: true },
  places: { max: 100_000, int: true },
  homeLeaves: { max: 100_000, int: true },
  homeReturns: { max: 100_000, int: true },
  noBrakeStreak: { max: 100_000, int: true },
  topKph: { max: 500, int: true },
};
const PERIODS = ['week', 'month', 'all'] as const;

const ok = (x: unknown, max: number, int: boolean): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max && (!int || Number.isInteger(x));

/** Strict reader: only whitelisted, bounded numbers survive; a malformed period is dropped, not the whole message. */
export function parseStatsAgg(raw: unknown): AggSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = (raw as { a?: unknown }).a;
  if (!a || typeof a !== 'object') return null;
  const out: AggSet = {};
  for (const p of PERIODS) {
    const src = (a as Record<string, unknown>)[p];
    if (!src || typeof src !== 'object') continue;
    const s = src as Record<string, unknown>;
    if (!ok(s.k, 8.64e15, true)) continue;
    const agg: StatsAgg = { k: s.k };
    if (s.score === null || ok(s.score, 100, true)) agg.score = s.score as number | null;
    for (const [f, b] of Object.entries(FIELDS) as [keyof typeof FIELDS, { max: number; int: boolean }][]) if (ok(s[f], b.max, b.int)) agg[f] = s[f] as number;
    out[p] = agg;
  }
  return Object.keys(out).length ? out : null;
}


/**
 * Leaderboard aggregates (protocol 9, `statsAgg` cap, D56). Each payload is built for ONE recipient (`aggsFor`
 * applies that friend's crew policy and per-friend override) and box-sealed to them, so a crew member who sees the
 * relay event cannot read another's figures. Sends only what changed for that peer (or after a day), at most once a
 * minute, and answers a member heard from for the first time this session, so new or late members get ours without
 * polling. Known older builds (no cap) are skipped; they would ignore the kind anyway.
 * The payload may also carry `eb`: my road-group ETA multipliers (D60, no places or times), only to friends who may
 * see my stats; older builds ignore the field.
 */
export class StatsAggChannel {
  private readonly last = new Map<string, { json: string; at: number }>();
  private readonly heard = new Set<string>();
  private readonly listeners = new Set<(sender: string, aggs: AggSet, etaBias: CrewBias | null) => void>();
  private etaBias: CrewBias | null = null;
  private aggsFor: ((peer: string) => AggSet | null) | null = null;
  private lastRun = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly router: Router,
    private readonly me: DeviceIdentity,
    private readonly members: () => string[],
    private readonly boxPkOf: (peer: string) => Uint8Array | null,
    private readonly protocolOf: (peer: string) => PeerProtocol | null,
    private readonly now: () => number = Date.now,
  ) {
    router.on('stats-agg', (m) => {
      const raw = openJson(me, m.payload);
      const parsed = parseStatsAgg(raw);
      if (!parsed) return;
      const eb = raw && typeof raw === 'object' ? parseCrewBias((raw as { eb?: unknown }).eb) : null;
      for (const l of this.listeners) l(m.sender, parsed, eb);
      if (!this.heard.has(m.sender)) {
        this.heard.add(m.sender);
        this.last.delete(m.sender);
        this.schedule();
      }
    });
  }

  onAgg(cb: (sender: string, aggs: AggSet, etaBias: CrewBias | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Set (or refresh) my per-recipient aggregates; `null` for a peer = that peer may not see stats. */
  publish(aggsFor: (peer: string) => AggSet | null): void {
    this.aggsFor = aggsFor;
    this.schedule();
  }

  /** My road-group ETA multipliers, sent along with the aggregates (null: none yet). */
  setEtaBias(eb: CrewBias | null): void {
    if (JSON.stringify(eb) === JSON.stringify(this.etaBias)) return;
    this.etaBias = eb;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer || !this.aggsFor) return;
    const wait = this.lastRun + LEADER.minIntervalMs - this.now();
    if (wait <= 0) void this.flush();
    else
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, wait);
  }

  /** Visible for tests. */
  async flush(): Promise<void> {
    const f = this.aggsFor;
    if (!f) return;
    this.lastRun = this.now();
    for (const peer of this.members()) {
      if (peerSupports(this.protocolOf(peer), 'statsAgg') === false) continue;
      const aggs = f(peer);
      if (!aggs || Object.keys(aggs).length === 0) {
        this.last.delete(peer);
        continue;
      }
      const body = this.etaBias ? { a: aggs, eb: this.etaBias } : { a: aggs };
      const json = JSON.stringify(body);
      const prev = this.last.get(peer);
      if (prev?.json === json && this.now() - prev.at < LEADER.resendMs) continue;
      const pk = this.boxPkOf(peer);
      if (!pk) continue;
      this.last.set(peer, { json, at: this.now() });
      await this.router.sendTo(peer, 'stats-agg', sealJson(pk, body)).catch(() => undefined);
    }
  }
}
