import { leaderboard, type LeaderboardMetric, type Period, type SharedStats } from './core';

export interface BoardEntry {
  id: string;
  /** null/undefined = this person shares nothing for the period. */
  stats?: SharedStats | null;
  /** Weekly points (oldest to newest, last = current week), used for week-over-week deltas. */
  trend?: { score: number | null; km: number }[] | null;
}

export interface BoardRow {
  id: string;
  /** null = not ranked (shares nothing, or not this metric). */
  rank: number | null;
  value: number | null;
  /** Week-over-week change of the metric (score / km only), null when unknown. */
  delta: number | null;
  /** Places gained (+) or lost (-) against the previous week; only computed for the weekly view. */
  rankChange: number | null;
  shares: boolean;
}

const TREND_FIELD: Partial<Record<LeaderboardMetric, 'score' | 'km'>> = { avgScore: 'score', drivenKm: 'km' };

function weekValue(trend: BoardEntry['trend'], metric: LeaderboardMetric, back: 0 | 1): number | null {
  const f = TREND_FIELD[metric];
  if (!f || !trend) return null;
  const p = trend[trend.length - 1 - back];
  if (!p) return null;
  return p[f];
}

/**
 * Ranked rows first (by value), then everyone who has no value for the metric, in input order.
 * Rank change compares against the previous calendar week and is only produced when `period === 'week'`,
 * because that is the only period whose ranking is built from the same week the trend ends on.
 */
export function buildBoard(entries: BoardEntry[], metric: LeaderboardMetric, period: Period): BoardRow[] {
  const ranked = leaderboard(
    entries.filter((e) => e.stats).map((e) => ({ id: e.id, stats: e.stats! })),
    metric,
  );
  const rankOf = new Map(ranked.map((r) => [r.id, r]));
  let prevRank: Map<string, number> | null = null;
  if (period === 'week' && TREND_FIELD[metric]) {
    const prevEntries = entries
      .map((e) => ({ id: e.id, v: weekValue(e.trend, metric, 1), cur: weekValue(e.trend, metric, 0) }))
      .filter((e) => e.v !== null && e.cur !== null)
      .map((e) => ({ id: e.id, stats: { period, updatedAt: 0, [metric]: e.v } as SharedStats }));
    prevRank = new Map(leaderboard(prevEntries, metric).map((r) => [r.id, r.rank]));
  }
  const rows: BoardRow[] = entries.map((e) => {
    const r = rankOf.get(e.id);
    const cur = weekValue(e.trend, metric, 0);
    const prev = weekValue(e.trend, metric, 1);
    const delta = cur !== null && prev !== null ? Math.round((cur - prev) * 10) / 10 : null;
    const pr = prevRank?.get(e.id);
    return {
      id: e.id,
      rank: r?.rank ?? null,
      value: r?.value ?? null,
      delta,
      rankChange: r && pr !== undefined ? pr - r.rank : null,
      shares: !!e.stats,
    };
  });
  return [...rows.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank! || a.id.localeCompare(b.id)), ...rows.filter((r) => r.rank === null)];
}

/** Best weekly series a person shares: the longest trend among their periods. */
export function bestTrend(stats: Partial<Record<Period, SharedStats>> | undefined): { score: number | null; km: number }[] | null {
  let best: { score: number | null; km: number }[] | null = null;
  for (const s of Object.values(stats ?? {})) if (s?.scoreTrend && (!best || s.scoreTrend.length > best.length)) best = s.scoreTrend;
  return best;
}
