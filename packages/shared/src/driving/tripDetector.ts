import { haversineM } from '../geo';
import { DRIVING_THRESHOLDS } from './thresholds';
import type { ActivitySample, LocationSample, TripPoint } from './types';

type TripTh = (typeof DRIVING_THRESHOLDS)['trip'];

export type TripDetectorEvent =
  | { type: 'started'; startedAt: number; points: TripPoint[] }
  | { type: 'point'; point: TripPoint }
  | { type: 'ended'; startedAt: number; endedAt: number; points: TripPoint[]; distanceM: number }
  | { type: 'discarded'; reason: 'tooShort' };

export type TripState = 'idle' | 'candidate' | 'driving';

/**
 * Automatic trip start/stop from location fixes + activity recognition. No manual start.
 * Pure and deterministic: feed samples in time order, collect the emitted events. Call `tick(now)` from a timer so
 * a trip still ends when the OS stops delivering fixes while parked.
 */
export class TripDetector {
  private state: TripState = 'idle';
  private activity: ActivitySample | null = null;
  private prev: LocationSample | null = null;
  /** Last ~60 s of fixes while idle, so a trip can be back-dated to when movement began. */
  private preBuffer: TripPoint[] = [];
  private candidateStart = 0;
  private candidateSlowSince: number | null = null;
  private points: TripPoint[] = [];
  private startedAt = 0;
  private lastMovingAt = 0;
  private lastMovingIdx = 0;
  private walkAwaySince: number | null = null;

  constructor(private readonly th: TripTh = DRIVING_THRESHOLDS.trip) {}

  get currentState(): TripState {
    return this.state;
  }

  onActivity(a: ActivitySample): void {
    this.activity = a;
  }

  onLocation(s: LocationSample, limitKph: number | null = null): TripDetectorEvent[] {
    if (s.accuracy > this.th.maxAccuracyM) return [];
    const out: TripDetectorEvent[] = [];
    if (this.prev && s.t <= this.prev.t) return [];
    if (this.state === 'driving' && this.prev && (s.t - this.prev.t) / 1000 > this.th.maxGapS) {
      out.push(...this.end(this.lastMovingAt));
    }
    const speed = this.speedOf(s);
    const point: TripPoint = { t: s.t, lat: s.lat, lng: s.lng, speed, heading: s.heading, limitKph };
    this.prev = s;

    const automotive = this.isAutomotive(s.t);
    switch (this.state) {
      case 'idle': {
        this.pushPre(point);
        const fast = speed >= this.th.startSpeedMps || (automotive && speed >= this.th.automotiveStartSpeedMps);
        if (fast) {
          this.state = 'candidate';
          this.candidateStart = s.t;
          this.candidateSlowSince = null;
        }
        break;
      }
      case 'candidate': {
        this.pushPre(point);
        if (speed < this.th.stopSpeedMps && !automotive) {
          this.candidateSlowSince ??= s.t;
          if ((s.t - this.candidateSlowSince) / 1000 > 10) {
            this.state = 'idle';
            break;
          }
        } else {
          this.candidateSlowSince = null;
        }
        const sustained = (s.t - this.candidateStart) / 1000 >= this.th.startSustainS;
        const fastNow = speed >= this.th.startSpeedMps || (automotive && speed >= this.th.automotiveStartSpeedMps);
        if (sustained && fastNow) {
          // Back-date to the first fix that was moving.
          const firstMoving = this.preBuffer.findIndex(
            (p) => p.t >= this.candidateStart - 60_000 && p.speed >= this.th.stopSpeedMps,
          );
          this.points = this.preBuffer.slice(Math.max(0, firstMoving - 1));
          this.preBuffer = [];
          this.startedAt = this.points[0]?.t ?? s.t;
          this.state = 'driving';
          this.lastMovingAt = s.t;
          this.lastMovingIdx = this.points.length - 1;
          this.walkAwaySince = null;
          out.push({ type: 'started', startedAt: this.startedAt, points: [...this.points] });
        }
        break;
      }
      case 'driving': {
        this.points.push(point);
        out.push({ type: 'point', point });
        if (speed >= this.th.stopSpeedMps) {
          this.lastMovingAt = s.t;
          this.lastMovingIdx = this.points.length - 1;
        }
        const a = this.activity;
        const onFoot =
          a !== null &&
          (a.activity === 'walking' || a.activity === 'running' || a.activity === 'still') &&
          a.confidence >= this.th.automotiveConfidence &&
          s.t - a.t < 120_000;
        if (onFoot && speed < this.th.walkAwaySpeedMps) {
          this.walkAwaySince ??= s.t;
          if ((s.t - this.walkAwaySince) / 1000 >= this.th.walkAwayDwellS) out.push(...this.end(this.lastMovingAt));
        } else {
          this.walkAwaySince = null;
        }
        if (this.state === 'driving' && (s.t - this.lastMovingAt) / 1000 >= this.th.stopDwellS) {
          out.push(...this.end(this.lastMovingAt));
        }
        break;
      }
    }
    return out;
  }

  /** Call periodically (e.g. every 30 s) with the current time. */
  tick(now: number): TripDetectorEvent[] {
    if (this.state !== 'driving') return [];
    if ((now - this.lastMovingAt) / 1000 >= this.th.stopDwellS) return this.end(this.lastMovingAt);
    if (this.prev && (now - this.prev.t) / 1000 > this.th.maxGapS) return this.end(this.lastMovingAt);
    return [];
  }

  /** Force-end (e.g. user stops sharing / app shutting down). */
  flush(): TripDetectorEvent[] {
    return this.state === 'driving' ? this.end(this.lastMovingAt) : [];
  }

  private end(endedAt: number): TripDetectorEvent[] {
    // Keep points up to the last moving fix plus the first stopped fix after it.
    const pts = this.points.slice(0, Math.min(this.points.length, this.lastMovingIdx + 2));
    let distanceM = 0;
    for (let i = 1; i < pts.length; i++) distanceM += haversineM(pts[i - 1]!, pts[i]!);
    const startedAt = this.startedAt;
    this.state = 'idle';
    this.points = [];
    this.preBuffer = [];
    this.walkAwaySince = null;
    const durationS = (endedAt - startedAt) / 1000;
    if (distanceM < this.th.minDistanceM || durationS < this.th.minDurationS) {
      return [{ type: 'discarded', reason: 'tooShort' }];
    }
    return [{ type: 'ended', startedAt, endedAt, points: pts, distanceM }];
  }

  private pushPre(p: TripPoint): void {
    this.preBuffer.push(p);
    const cutoff = p.t - 90_000;
    while (this.preBuffer.length > 0 && this.preBuffer[0]!.t < cutoff) this.preBuffer.shift();
  }

  private isAutomotive(t: number): boolean {
    const a = this.activity;
    return (
      a !== null && a.activity === 'automotive' && a.confidence >= this.th.automotiveConfidence && t - a.t < 120_000
    );
  }

  private speedOf(s: LocationSample): number {
    if (s.speed !== null && s.speed >= 0) return s.speed;
    if (!this.prev) return 0;
    const dt = (s.t - this.prev.t) / 1000;
    return dt > 0 ? haversineM(this.prev, s) / dt : 0;
  }
}
