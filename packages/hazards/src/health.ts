import type { HazardSourceId, HealthStatus, SourceHealth } from './types';

export interface HealthLogEntry {
  t: number;
  source: HazardSourceId;
  from: HealthStatus;
  to: HealthStatus;
  detail: string;
}

/** Tracks one source's health; status transitions are logged for the in-app admin screen. */
export class HealthTracker {
  private h: SourceHealth;
  private readonly listeners = new Set<(e: HealthLogEntry) => void>();

  constructor(source: HazardSourceId) {
    this.h = { source, status: 'ok', lastOkAt: null, lastAttemptAt: null, consecutiveFailures: 0, lastError: null, lastHttpStatus: null };
  }

  get(): SourceHealth {
    return { ...this.h };
  }

  onTransition(cb: (e: HealthLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  attempt(now: number): void {
    this.h.lastAttemptAt = now;
  }

  ok(now: number): void {
    this.set('ok', 'fetch ok', now);
    this.h.lastOkAt = now;
    this.h.consecutiveFailures = 0;
    this.h.lastError = null;
    this.h.lastHttpStatus = null;
  }

  fail(now: number, status: HealthStatus, error: string, httpStatus: number | null = null): void {
    this.h.consecutiveFailures++;
    this.h.lastError = error;
    this.h.lastHttpStatus = httpStatus;
    // A single network blip is 'degraded'; blocked/shape changes are immediate.
    this.set(status, error, now);
  }

  set(status: HealthStatus, detail: string, now: number): void {
    const from = this.h.status;
    this.h.status = status;
    if (from !== status) for (const l of this.listeners) l({ t: now, source: this.h.source, from, to: status, detail });
  }
}
