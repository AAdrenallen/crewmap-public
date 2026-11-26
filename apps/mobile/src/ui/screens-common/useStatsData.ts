import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, type Period, type Stats, type StatsInput } from '@crewmap/shared/stats';
import * as db from '../../core/db';
import { useApp } from '../../core/store';

let cache: StatsInput | null = null;

export interface MyStats {
  input: StatsInput | null;
  stats: Record<Period, Stats> | null;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  tz: number;
}

/**
 * My own stats from the local db: loads with cancellation, shows the last result while reloading, and reloads when a
 * drive ends (the store clears `tripStartedAt` right after the trip is saved) or on pull-to-refresh.
 */
export function useMyStats(): MyStats {
  const tripStartedAt = useApp((s) => s.tripStartedAt);
  const [input, setInput] = useState<StatsInput | null>(cache);
  const [loading, setLoading] = useState(cache === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const waiters = useRef<(() => void)[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = { trips: await db.tripSummaries(), walks: await db.walks(), visits: await db.visits() };
        cache = next;
        if (cancelled) return;
        setInput(next);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
        const w = waiters.current;
        waiters.current = [];
        w.forEach((f) => f());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripStartedAt, nonce]);

  const tz = -new Date().getTimezoneOffset();
  const stats = useMemo(() => {
    if (!input) return null;
    const now = Date.now();
    return { week: computeStats(input, 'week', now, tz), month: computeStats(input, 'month', now, tz), all: computeStats(input, 'all', now, tz) };
  }, [input, tz]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNonce((n) => n + 1);
    return new Promise<void>((res) => waiters.current.push(res));
  }, []);

  return { input, stats, loading, refreshing, error, refresh, tz };
}
