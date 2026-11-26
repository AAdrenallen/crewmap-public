import { angleDiffDeg, bearingDeg, haversineM } from '../geo';
import { DRIVING_THRESHOLDS } from './thresholds';
import type { ImuSample, InteractionSample, RiskyEvent, RiskyEventKind, Severity, TripPoint } from './types';

type EvTh = (typeof DRIVING_THRESHOLDS)['events'];

const MPS_TO_KPH = 3.6;

function severityFor(ratio: number, th: EvTh): Severity {
  if (ratio >= th.severitySevere) return 2;
  if (ratio >= th.severityModerate) return 1;
  return 0;
}

/**
 * Detects risky driving events from trip points (GPS), IMU magnitude and screen interactions.
 * Streaming: call `onPoint`/`onImu`/`onInteraction` in time order during a trip; `finish()` closes open episodes.
 * Longitudinal and lateral accelerations come from GPS speed/heading over a short window, which is
 * orientation-independent (the phone can sit anywhere in the car). The IMU is used only for crash spikes.
 */
export class RiskyEventDetector {
  private readonly events: RiskyEvent[] = [];
  private readonly window: TripPoint[] = [];
  private readonly lastOf = new Map<RiskyEventKind, number>();
  private speeding: { start: number; lastOver: number; maxOver: number; at: TripPoint; limit: number } | null = null;
  private phone: { start: number; last: number; at: TripPoint } | null = null;
  private lateNightMs = 0;
  private lateNightFirst: TripPoint | null = null;
  private prevPoint: TripPoint | null = null;
  private crashCandidate: { t: number; magnitude: number; at: TripPoint } | null = null;
  private cornerSince: { t: number; max: number } | null = null;
  private seq = 0;

  constructor(
    private readonly tripId: string,
    private readonly th: EvTh = DRIVING_THRESHOLDS.events,
    /** Returns local hour (0–23) for an epoch ms. Injected so tests are timezone-independent. */
    private readonly localHour: (t: number) => number = (t) => new Date(t).getHours(),
  ) {}

  onPoint(p: TripPoint): RiskyEvent[] {
    const emitted: RiskyEvent[] = [];
    this.window.push(p);
    const keepS = Math.max(this.th.longitudinalWindowS, this.th.corneringWindowS) + 1;
    while (this.window.length > 2 && (p.t - this.window[0]!.t) / 1000 > keepS) this.window.shift();

    emitted.push(...this.longitudinal(p));
    emitted.push(...this.cornering(p));
    emitted.push(...this.speedingStep(p));
    this.phoneStep(p);
    this.lateNightStep(p);
    emitted.push(...this.crashStep(p));
    this.prevPoint = p;
    return emitted;
  }

  onImu(s: ImuSample): void {
    if (s.magnitude < this.th.crash.spikeMps2 || !this.prevPoint) return;
    if (this.prevPoint.speed < this.th.crash.minSpeedBeforeMps) return;
    if (!this.crashCandidate || s.magnitude > this.crashCandidate.magnitude) {
      this.crashCandidate = { t: s.t, magnitude: s.magnitude, at: this.prevPoint };
    }
  }

  onInteraction(i: InteractionSample): void {
    if (i.kind !== 'touch' || !this.prevPoint) return;
    if (this.prevPoint.speed < this.th.phone.minSpeedMps) return;
    if (this.phone && (i.t - this.phone.last) / 1000 <= this.th.phone.mergeGapS) {
      this.phone.last = i.t;
    } else {
      this.closePhone();
      this.phone = { start: i.t, last: i.t, at: this.prevPoint };
    }
  }

  finish(): RiskyEvent[] {
    const before = this.events.length;
    this.closeSpeeding();
    this.closePhone();
    const minutes = this.lateNightMs / 60_000;
    if (this.lateNightFirst && minutes >= this.th.lateNight.minMinutes) {
      this.add('lateNight', 0, this.lateNightFirst, Math.round(minutes), this.lateNightFirst.t);
    }
    return this.events.slice(before);
  }

  all(): RiskyEvent[] {
    return [...this.events];
  }

  private add(
    kind: RiskyEventKind,
    severity: Severity,
    at: TripPoint,
    value: number,
    t: number,
    tEnd?: number,
    limitKph?: number,
  ): RiskyEvent {
    const e: RiskyEvent = {
      id: `${this.tripId}:${kind}:${this.seq++}`,
      kind,
      severity,
      t,
      lat: at.lat,
      lng: at.lng,
      value: Math.round(value * 100) / 100,
      speedKph: Math.round(at.speed * MPS_TO_KPH),
    };
    if (tEnd !== undefined) e.tEnd = tEnd;
    if (limitKph !== undefined) e.limitKph = limitKph;
    this.events.push(e);
    this.lastOf.set(kind, t);
    return e;
  }

  private cooling(kind: RiskyEventKind, t: number): boolean {
    const last = this.lastOf.get(kind);
    return last !== undefined && (t - last) / 1000 < this.th.cooldownS;
  }

  /** Oldest point in the window that is at least `s` seconds before p. */
  private ref(p: TripPoint, s: number): TripPoint | null {
    let best: TripPoint | null = null;
    for (const q of this.window) {
      if ((p.t - q.t) / 1000 >= s) best = q;
      else break;
    }
    return best;
  }

  private longitudinal(p: TripPoint): RiskyEvent[] {
    const q = this.ref(p, this.th.longitudinalWindowS);
    if (!q) return [];
    const dt = (p.t - q.t) / 1000;
    if (dt > this.th.longitudinalWindowS * 2.5) return []; // GPS gap, not a real acceleration
    const a = (p.speed - q.speed) / dt;
    const out: RiskyEvent[] = [];
    if (a <= this.th.hardBrakeMps2 && q.speed >= this.th.minSpeedForLongitudinalMps && !this.cooling('hardBrake', p.t)) {
      out.push(this.add('hardBrake', severityFor(a / this.th.hardBrakeMps2, this.th), q, a, p.t));
    }
    if (a >= this.th.rapidAccelMps2 && p.speed >= this.th.minSpeedForLongitudinalMps && !this.cooling('rapidAccel', p.t)) {
      out.push(this.add('rapidAccel', severityFor(a / this.th.rapidAccelMps2, this.th), p, a, p.t));
    }
    return out;
  }

  private headingOf(a: TripPoint, b: TripPoint): number | null {
    if (b.heading !== null && b.speed > 2) return b.heading;
    if (haversineM(a, b) < 3) return null;
    return bearingDeg(a, b);
  }

  private cornering(p: TripPoint): RiskyEvent[] {
    const q = this.ref(p, this.th.corneringWindowS);
    if (!q || p.speed < this.th.minSpeedForCorneringMps) return [];
    const idx = this.window.indexOf(q);
    const qPrev = this.window[idx - 1] ?? null;
    const pPrev = this.window[this.window.length - 2] ?? null;
    const hq = qPrev ? this.headingOf(qPrev, q) : q.heading;
    const hp = pPrev ? this.headingOf(pPrev, p) : p.heading;
    if (hq === null || hp === null) return [];
    const dt = (p.t - q.t) / 1000;
    if (dt > this.th.corneringWindowS * 2.5) return [];
    const yawRate = Math.abs(angleDiffDeg(hq, hp)) * (Math.PI / 180) / dt;
    const v = (p.speed + q.speed) / 2;
    const lateral = v * yawRate;
    if (lateral < this.th.corneringLateralMps2) {
      this.cornerSince = null;
      return [];
    }
    this.cornerSince ??= { t: p.t, max: lateral };
    this.cornerSince.max = Math.max(this.cornerSince.max, lateral);
    const held = (p.t - this.cornerSince.t) / 1000 >= this.th.corneringSustainS;
    if (held && !this.cooling('cornering', p.t)) {
      const max = this.cornerSince.max;
      return [this.add('cornering', severityFor(max / this.th.corneringLateralMps2, this.th), p, max, p.t)];
    }
    return [];
  }

  private speedingStep(p: TripPoint): RiskyEvent[] {
    const s = this.th.speeding;
    const over = p.limitKph === null ? -Infinity : p.speed * MPS_TO_KPH - p.limitKph;
    if (over >= s.minorKph && p.limitKph !== null) {
      if (!this.speeding) this.speeding = { start: p.t, lastOver: p.t, maxOver: over, at: p, limit: p.limitKph };
      else {
        this.speeding.lastOver = p.t;
        if (over > this.speeding.maxOver) {
          this.speeding.maxOver = over;
          this.speeding.limit = p.limitKph;
        }
      }
      return [];
    }
    if (this.speeding && (p.t - this.speeding.lastOver) / 1000 > s.graceS) {
      return this.closeSpeeding();
    }
    return [];
  }

  private closeSpeeding(): RiskyEvent[] {
    const sp = this.speeding;
    this.speeding = null;
    if (!sp) return [];
    const s = this.th.speeding;
    const dur = (sp.lastOver - sp.start) / 1000;
    if (dur < s.minDurationS) return [];
    const grade: Severity = sp.maxOver >= s.severeKph ? 2 : sp.maxOver >= s.moderateKph ? 1 : 0;
    return [this.add('speeding', grade, sp.at, Math.round(sp.maxOver), sp.start, sp.lastOver, sp.limit)];
  }

  private phoneStep(p: TripPoint): void {
    if (this.phone && (p.t - this.phone.last) / 1000 > this.th.phone.mergeGapS) this.closePhone();
  }

  private closePhone(): void {
    const ph = this.phone;
    this.phone = null;
    if (!ph) return;
    const seconds = Math.max(1, (ph.last - ph.start) / 1000);
    const severity: Severity = seconds >= 30 ? 2 : seconds >= 10 ? 1 : 0;
    this.add('phoneHandling', severity, ph.at, Math.round(seconds), ph.start, ph.last);
  }

  private lateNightStep(p: TripPoint): void {
    const prev = this.prevPoint;
    if (!prev) return;
    const h = this.localHour(p.t);
    const ln = this.th.lateNight;
    if (h >= ln.startHour && h < ln.endHour) {
      this.lateNightMs += Math.min(p.t - prev.t, 60_000);
      this.lateNightFirst ??= p;
    }
  }

  private crashStep(p: TripPoint): RiskyEvent[] {
    const c = this.crashCandidate;
    if (!c) return [];
    const since = (p.t - c.t) / 1000;
    if (since > this.th.crash.confirmWithinS) {
      this.crashCandidate = null;
      return [];
    }
    if (p.speed <= this.th.crash.stoppedSpeedMps) {
      this.crashCandidate = null;
      return [this.add('crash', 2, c.at, c.magnitude, c.t)];
    }
    return [];
  }
}
