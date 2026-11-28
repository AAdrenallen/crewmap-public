import type { EmotePreset } from './emotes';

/** Build-up of emotes that arrived while the recipient was away: grouping, combo plan and silent summaries. */
export const EMOTE_COMBO = {
  /** Younger than this = a live emote (plays immediately); older = collected during catch-up. */
  freshMs: 30_000,
  /** Older than this = summarised silently, never blasted. */
  staleMs: 24 * 3_600_000,
  /** Un-acked emotes are re-sent for this long (matches the relay expiry). */
  outboxMs: 72 * 3_600_000,
  /** Wait for the relay replay to go quiet before playing the combined celebration. */
  quietMs: 1500,
  /** Live streak: finale this long after the last emote. */
  liveQuietMs: 1600,
  maxBursts: 12,
  maxWindowMs: 3000,
  /** Hard cap on simultaneous animated pieces. */
  maxParticles: 80,
  burstLifeMs: 1600,
  /** Dedupe memory for retried sends. */
  seenCap: 2000,
} as const;

export interface PendingEmote {
  /** Dedupe key: sender's client key when present, else the envelope id (never the emote type). */
  id: string;
  from: string;
  preset: EmotePreset | 'custom';
  label?: string;
  sentAt: number;
}

export interface ComboGroup {
  from: string;
  preset: EmotePreset | 'custom';
  label?: string;
  count: number;
  latestAt: number;
}

export interface StaleSummary {
  from: string;
  count: number;
  latestAt: number;
}

export interface EmoteSummary {
  /** Recent emotes, grouped per sender and emote type, biggest first. */
  groups: ComboGroup[];
  /** Older than staleMs, per sender. */
  stale: StaleSummary[];
}

export function dedupeEmotes<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export function aggregateEmotes(items: PendingEmote[], now: number): EmoteSummary {
  const groups = new Map<string, ComboGroup>();
  const stale = new Map<string, StaleSummary>();
  for (const e of dedupeEmotes(items)) {
    if (now - e.sentAt > EMOTE_COMBO.staleMs) {
      const s = stale.get(e.from) ?? { from: e.from, count: 0, latestAt: 0 };
      s.count++;
      s.latestAt = Math.max(s.latestAt, e.sentAt);
      stale.set(e.from, s);
      continue;
    }
    const key = `${e.from}|${e.preset}|${e.preset === 'custom' ? (e.label ?? '') : ''}`;
    const g = groups.get(key) ?? { from: e.from, preset: e.preset, ...(e.label ? { label: e.label } : {}), count: 0, latestAt: 0 };
    g.count++;
    g.latestAt = Math.max(g.latestAt, e.sentAt);
    groups.set(key, g);
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count || b.latestAt - a.latestAt),
    stale: [...stale.values()].sort((a, b) => b.latestAt - a.latestAt),
  };
}

export interface ComboPlan {
  bursts: number;
  /** Start of each burst, ms from the combo start; gaps shrink so it builds up. */
  offsetsMs: number[];
  /** Which bursts also pop a sound (every other one, plus the finale). */
  sound: boolean[];
  durationMs: number;
  /** 0..1, grows with count (log-scaled); drives size/height. */
  intensity: number;
  /** Whether to show the "×N" counter. */
  showCount: boolean;
}

/** Plan for `count` emotes: up to maxBursts bursts over at most maxWindowMs, then a ×N counter. */
export function comboPlan(count: number): ComboPlan {
  const n = Math.max(1, Math.min(EMOTE_COMBO.maxBursts, Math.floor(count)));
  const window = n === 1 ? 0 : Math.min(EMOTE_COMBO.maxWindowMs, 350 + n * 230);
  const offsetsMs = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(window * (1 - Math.pow(1 - i / (n - 1), 1.7)))));
  const sound = offsetsMs.map((_, i) => i % 2 === 0 || i === n - 1);
  return {
    bursts: n,
    offsetsMs,
    sound,
    durationMs: window + EMOTE_COMBO.burstLifeMs,
    intensity: Math.min(1, Math.log2(Math.max(1, count)) / 5),
    showCount: count > 1,
  };
}

/** Live spam: emotes from the same sender within this gap keep growing one running combo. */
export const LIVE_STREAK_MS = 1500;

export interface Streak {
  from: string;
  preset: EmotePreset | 'custom';
  count: number;
  lastAt: number;
  /** Id of the popup that carries the running counter. */
  id: string;
}

/** Next streak state for an emote arriving at `now`; `continued` = it extends the previous popup. */
export function nextStreak(prev: Streak | null, from: string, preset: EmotePreset | 'custom', now: number, id: string): Streak & { continued: boolean } {
  if (prev && prev.from === from && prev.preset === preset && now - prev.lastAt <= LIVE_STREAK_MS)
    return { ...prev, count: prev.count + 1, lastAt: now, continued: true };
  return { from, preset, count: 1, lastAt: now, id, continued: false };
}

/** Pop for the nth emote of a live streak: louder and bigger as it builds; sound thins out past the burst cap. */
export function streakPop(count: number): { volume: number; intensity: number; sound: boolean } {
  const n = Math.max(1, Math.floor(count));
  return {
    volume: Math.min(1, 0.72 + (n - 1) * 0.06),
    intensity: comboPlan(n).intensity,
    sound: n <= EMOTE_COMBO.maxBursts || n % 2 === 0,
  };
}
