import { create } from 'zustand';
import { activeOnceShares, type AskEntry } from '@crewmap/shared/companions';
import type { FriendView } from './store';

/** Location asks (D47) in both directions, including one-time positions received (wiped at expiry). */
export const useAsks = create<{ entries: AskEntry[] }>(() => ({ entries: [] }));

/**
 * Lays one-time shares over the friend map: a friend whose crew policy gives me nothing (or something coarser / older)
 * shows at the shared spot, precise, with `once.until` for the "shared once" badge. Expired shares are never applied.
 */
export function withOnceShares(all: Record<string, FriendView>, entries: readonly AskEntry[], now: number): Record<string, FriendView> {
  const shares = activeOnceShares(entries, now);
  if (shares.length === 0) return all;
  const out = { ...all };
  for (const s of shares) {
    const f = out[s.peer];
    if (!f) continue;
    const p = f.presence;
    // A fresher precise position from the crew itself already shows them: nothing to overlay.
    if (p && p.prec === 'p' && p.t >= s.t) continue;
    const { pv, cp } = p ?? {};
    out[s.peer] = {
      ...f,
      once: { until: s.until },
      paused: false,
      presence: { lat: s.lat, lng: s.lng, acc: s.acc, spd: null, hdg: null, act: 'unknown', bat: p?.bat ?? null, chg: p?.chg ?? false, t: s.t, prec: 'p', deviceId: s.peer, receivedAt: s.t, via: p?.via ?? 'nostr', ...(pv !== undefined ? { pv } : {}), ...(cp !== undefined ? { cp } : {}) },
    };
  }
  return out;
}
