import { coarsen, haversineM, type LatLng } from '../geo';
import type { LocationSample } from '../driving/types';
import { CHECK_IN, checkInWaitS, type CheckInThresholds } from './thresholds';

/**
 * Ambient safety check-in (D66). A long stop while travelling, somewhere with nothing around (rural road, highway
 * shoulder, off-road), makes the phone ask its owner once whether they are OK. Unanswered after a grace period, the
 * opted-in crewmates are told where the car stopped. Never calls anyone. Pure: the app feeds fixes, activity, a
 * crash flag and the surroundings; every time is the caller's (replay runs ahead of the wall clock).
 */

/** What the app knows about the spot around the stop (null fields = unknown). */
export interface Surroundings {
  /** Buildings (any kind) within the lookup radius. */
  buildings: number;
  /** Residential landuse or a driveway / private service road. */
  residential: boolean;
  /** Rest area, service area, parking, fuel, food, toilets, shop, tourism point, signals / stop sign. */
  restStop: boolean;
}

export interface KnownPlace extends LatLng {
  radiusM: number;
  home: boolean;
}

export interface StopContext {
  /** My saved places and the crew's shared ones. */
  places: readonly KnownPlace[];
  /** Active navigation destination. */
  navDest: LatLng | null;
  /** Learned typical wait at this spot (D63 stop delays), null when unknown. */
  knownStopS: number | null;
  /** Answered OK near here before. */
  okBefore: boolean;
  /** Jam / closure / accident report nearby. */
  trafficNearby: boolean;
  /** Fuel stations / chargers already cached on the phone near the stop. */
  poisNearby: number;
  /** Null: not looked up (offline, rate-limited): the driver is asked anyway. */
  surroundings: Surroundings | null;
}

export type StopExclusion = 'place' | 'home' | 'navDest' | 'knownStop' | 'okBefore' | 'jam' | 'restStop' | 'settled';
export type StopVerdict = { ask: true; reason: 'remote' | 'unknown' | 'crash' } | { ask: false; reason: StopExclusion };

export interface Stop extends LatLng {
  /** Epoch ms the car stopped. */
  since: number;
  acc: number;
  crash: boolean;
  /** Fixes of the few minutes before the stop (jam test). */
  approach: readonly LocationSample[];
}

/** Crawling queue or stop-and-go before the stop: a traffic jam, not a breakdown. */
export function looksLikeJam(stop: Stop, th: CheckInThresholds = CHECK_IN): boolean {
  const from = stop.since - th.jam.windowS * 1000;
  const w = stop.approach.filter((s) => s.t >= from && s.t <= stop.since).sort((a, b) => a.t - b.t);
  if (w.length < 2) return false;
  let moved = 0;
  let stopGo = 0;
  let wasStopped = false;
  for (let i = 1; i < w.length; i++) {
    moved += haversineM(w[i - 1]!, w[i]!);
    const stopped = (w[i]!.speed ?? 0) < th.stopSpeedMps;
    if (wasStopped && !stopped) stopGo++;
    wasStopped = stopped;
  }
  if (stopGo >= th.jam.stopGoCount) return true;
  const spanS = (w[w.length - 1]!.t - w[0]!.t) / 1000;
  // Only a window that covers most of the span says anything about the approach.
  if (spanS < th.jam.windowS / 2) return false;
  return moved >= th.jam.minMovedM && moved / spanS < th.jam.meanSpeedMps;
}

/** Should this stop make the phone ask? Exclusions first, so an ordinary stop never bothers anyone. */
export function assessStop(stop: Stop, ctx: StopContext, th: CheckInThresholds = CHECK_IN): StopVerdict {
  if (stop.crash) return { ask: true, reason: 'crash' };
  for (const p of ctx.places) {
    const d = haversineM(p, stop);
    if (p.home && d <= th.homeM) return { ask: false, reason: 'home' };
    if (d <= p.radiusM + th.placeMarginM) return { ask: false, reason: 'place' };
  }
  if (ctx.navDest && haversineM(ctx.navDest, stop) <= th.navDestM) return { ask: false, reason: 'navDest' };
  if (ctx.knownStopS !== null) return { ask: false, reason: 'knownStop' };
  if (ctx.okBefore) return { ask: false, reason: 'okBefore' };
  if (ctx.trafficNearby || looksLikeJam(stop, th)) return { ask: false, reason: 'jam' };
  if (ctx.poisNearby > 0) return { ask: false, reason: 'restStop' };
  const s = ctx.surroundings;
  if (!s) return { ask: true, reason: 'unknown' };
  if (s.restStop) return { ask: false, reason: 'restStop' };
  if (s.residential || s.buildings > 0) return { ask: false, reason: 'settled' };
  return { ask: true, reason: 'remote' };
}

/** Grid key of the "answered OK here" memory. */
export const okCellKey = (p: LatLng, th: CheckInThresholds = CHECK_IN): string => {
  const c = coarsen(p, th.okCellM);
  return `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
};

export type CheckInAction =
  /** Ask the driver (notification + in-app card). */
  | { kind: 'ask'; stop: Stop }
  /** Unanswered: tell the opted-in crewmates. */
  | { kind: 'alert'; stop: Stop; askedAt: number }
  /** Answered or moved before anyone was told: clear the prompt. */
  | { kind: 'dismiss'; how: 'ok' | 'moved' }
  /** Answered or moved after the crew was told: clear the prompt and tell them it's fine. */
  | { kind: 'resolve'; how: 'ok' | 'moved'; stop: Stop };

export type CheckInPhase = 'none' | 'stopped' | 'asked' | 'alerted' | 'done';

export interface CheckInSnapshot {
  phase: CheckInPhase;
  stop: Stop | null;
  askedAt: number | null;
}

const APPROACH_KEEP_S = 300;

export class CheckInMonitor {
  private phase: CheckInPhase = 'none';
  private stop: Stop | null = null;
  private askedAt: number | null = null;
  private lastTravelAt = -Infinity;
  private crashAt: number | null = null;
  private recent: LocationSample[] = [];

  constructor(
    private waitMin: number = CHECK_IN.defaultWaitMin,
    private readonly th: CheckInThresholds = CHECK_IN,
  ) {}

  setWait(min: number): void {
    this.waitMin = min;
  }

  snapshot(): CheckInSnapshot {
    return { phase: this.phase, stop: this.stop, askedAt: this.askedAt };
  }

  /** The current stop while it may still lead to an ask: the app looks up its surroundings once it is old enough. */
  candidate(now: number): Stop | null {
    if (this.phase !== 'stopped' || !this.stop) return null;
    return now - this.stop.since >= this.th.contextAtS * 1000 || this.stop.crash ? this.stop : null;
  }

  /** When `tick` should run next (epoch ms), null when nothing is pending. */
  dueAt(): number | null {
    if (this.phase === 'stopped' && this.stop) return this.stop.since + checkInWaitS(this.waitMin, this.stop.crash, this.th) * 1000;
    if (this.phase === 'asked' && this.askedAt !== null && this.stop) return this.askedAt + this.graceS(this.stop) * 1000;
    return null;
  }

  private graceS(s: Stop): number {
    return s.crash ? this.th.crash.graceS : this.th.graceS;
  }

  fix(f: LocationSample): CheckInAction[] {
    if (f.accuracy > this.th.maxAccuracyM) return [];
    this.recent.push(f);
    while (this.recent.length && f.t - this.recent[0]!.t > APPROACH_KEEP_S * 1000) this.recent.shift();
    const speed = f.speed ?? 0;
    if (this.stop) {
      const d = haversineM(this.stop, f);
      const moving = d > this.th.leaveM || (d > Math.max(this.th.stopRadiusM, f.accuracy) && speed >= this.th.stopSpeedMps);
      if (!moving) return [];
      const out = this.end('moved');
      if (speed >= this.th.travelSpeedMps) this.lastTravelAt = f.t;
      return out;
    }
    if (speed >= this.th.travelSpeedMps) {
      this.lastTravelAt = f.t;
      return [];
    }
    const crash = this.crashAt !== null && Math.abs(f.t - this.crashAt) <= this.th.crash.linkS * 1000;
    if (speed < this.th.stopSpeedMps && (crash || f.t - this.lastTravelAt <= this.th.travelWithinS * 1000)) {
      this.stop = { lat: f.lat, lng: f.lng, acc: f.accuracy, since: f.t, crash, approach: this.recent.slice() };
      this.phase = 'stopped';
      this.askedAt = null;
    }
    return [];
  }

  /** Crash-like spike (the trip pipeline's 'crash' event). */
  crash(t: number): void {
    this.crashAt = t;
    if (this.stop && this.phase === 'stopped' && Math.abs(this.stop.since - t) <= this.th.crash.linkS * 1000)
      this.stop = { ...this.stop, crash: true };
  }

  /** On foot after a stop: they got out and walked off (trailhead, a call of nature), not stranded. */
  walking(_t: number): CheckInAction[] {
    if (!this.stop || this.stop.crash) return [];
    if (this.phase !== 'stopped' && this.phase !== 'asked') return [];
    return this.end('moved');
  }

  /** "I'm OK". */
  answer(_t: number): CheckInAction[] {
    // 'stopped': answered from the crash notice before the ask came up.
    if (this.phase === 'asked' || this.phase === 'stopped') {
      this.phase = 'done';
      return [{ kind: 'dismiss', how: 'ok' }];
    }
    if (this.phase === 'alerted' && this.stop) {
      this.phase = 'done';
      return [{ kind: 'resolve', how: 'ok', stop: this.stop }];
    }
    return [];
  }

  /** Runs the clock: ask once the wait is over (if the spot calls for it), then alert after the grace period. */
  tick(now: number, assess: (stop: Stop) => StopVerdict): CheckInAction[] {
    const due = this.dueAt();
    if (due === null || now < due || !this.stop) return [];
    if (this.phase === 'stopped') {
      if (!assess(this.stop).ask) {
        this.phase = 'done';
        return [];
      }
      this.phase = 'asked';
      this.askedAt = now;
      return [{ kind: 'ask', stop: this.stop }];
    }
    this.phase = 'alerted';
    return [{ kind: 'alert', stop: this.stop, askedAt: this.askedAt ?? now }];
  }

  private end(how: 'moved'): CheckInAction[] {
    const s = this.stop;
    const was = this.phase;
    this.stop = null;
    this.askedAt = null;
    this.phase = 'none';
    this.crashAt = null;
    if (was === 'asked') return [{ kind: 'dismiss', how }];
    if (was === 'alerted' && s) return [{ kind: 'resolve', how, stop: s }];
    return [];
  }
}
