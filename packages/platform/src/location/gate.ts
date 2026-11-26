import type { SamplingProfile } from '../contracts';

/**
 * Pure helpers that keep the OS location request steady (the status-bar location icon flicks on every re-request:
 * expo-location's startLocationUpdatesAsync tears down and re-creates the request and its foreground service).
 */

const RANK: Record<SamplingProfile, number> = { still: 0, walking: 1, driving: 2, navigating: 3 };

export interface ProfileHysteresis {
  /** still → walking: the candidate must hold this long (activity classifier flaps still/walking/tilting). */
  upMs: number;
  /** Any downgrade (driving → walking/still, walking → still): candidate must hold this long. */
  downMs: number;
  /** Minimum time a profile stays applied before a non-urgent change. */
  minHoldMs: number;
}

export const PROFILE_HYSTERESIS: ProfileHysteresis = { upMs: 30_000, downMs: 60_000, minHoldMs: 60_000 };

/**
 * Debounces sampling-profile changes. Urgent changes apply at once: entering or leaving navigation (explicit user
 * action) and any upgrade to driving (a trip needs GNSS now). Everything else must be proposed continuously for the
 * dwell time and respect the minimum hold, so rapid still ↔ walking flaps never reach the OS.
 */
export class ProfileGovernor {
  private applied: SamplingProfile | null = null;
  private appliedAt = 0;
  private candidate: SamplingProfile | null = null;
  private candidateSince = 0;

  constructor(private readonly h: ProfileHysteresis = PROFILE_HYSTERESIS) {}

  get current(): SamplingProfile | null {
    return this.applied;
  }

  /** Records an applied profile (initial start, forced retry). */
  set(p: SamplingProfile, now: number): void {
    if (p !== this.applied) this.appliedAt = now;
    this.applied = p;
    this.candidate = null;
  }

  /**
   * Proposes the profile the current signals ask for. Returns the profile to apply now, or null to keep the current
   * one; `dueAt` (when non-null) is when to propose again for a pending candidate to take effect.
   */
  propose(p: SamplingProfile, now: number): { apply: SamplingProfile | null; dueAt: number | null } {
    const cur = this.applied;
    if (cur === null || p === cur) {
      this.candidate = null;
      if (cur === null) this.set(p, now);
      return { apply: cur === null ? p : null, dueAt: null };
    }
    const urgent = p === 'navigating' || cur === 'navigating' || (p === 'driving' && RANK[p] > RANK[cur]);
    if (urgent) {
      this.set(p, now);
      return { apply: p, dueAt: null };
    }
    if (this.candidate !== p) {
      this.candidate = p;
      this.candidateSince = now;
    }
    const dwell = RANK[p] > RANK[cur] ? this.h.upMs : this.h.downMs;
    const dueAt = Math.max(this.candidateSince + dwell, this.appliedAt + this.h.minHoldMs);
    if (now >= dueAt) {
      this.set(p, now);
      return { apply: p, dueAt: null };
    }
    return { apply: null, dueAt };
  }
}

/**
 * Single owner of the OS location request: starts only when the effective options differ from the applied ones and
 * counts starts/stops so diagnostics can flag a restart loop.
 */
export class LocationRequestGate {
  private appliedKey: string | null = null;
  private events: { t: number; kind: 'start' | 'stop' }[] = [];

  /** True when `options` differ from what is applied (or nothing is running): the caller should (re)start. */
  needsStart(options: unknown, running: boolean): boolean {
    if (!running) this.appliedKey = null;
    return this.appliedKey !== stableKey(options);
  }

  started(options: unknown, now: number): void {
    this.appliedKey = stableKey(options);
    this.push('start', now);
  }

  stopped(now: number): void {
    if (this.appliedKey !== null) this.push('stop', now);
    this.appliedKey = null;
  }

  /** Starts + stops within the last `windowMs`. */
  churn(now: number, windowMs = 60_000): { starts: number; stops: number } {
    let starts = 0;
    let stops = 0;
    for (const e of this.events)
      if (now - e.t <= windowMs) {
        if (e.kind === 'start') starts++;
        else stops++;
      }
    return { starts, stops };
  }

  private push(kind: 'start' | 'stop', now: number): void {
    this.events.push({ t: now, kind });
    this.events = this.events.filter((e) => now - e.t <= 600_000).slice(-200);
  }
}

function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}
