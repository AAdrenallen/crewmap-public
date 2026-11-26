import { angleDiffDeg, bearingDeg, haversineM, pointAlong, projectOnPolyline, slicePolyline, type LatLng } from '../geo';
import { t } from '../i18n';
import { laneStrip } from './lanes';
import type { Banner, Lane, NavRoute, NavStep } from './route';

export const NAV_THRESHOLDS = {
  /** Off-route when farther than max(this, 1.5 × accuracy) from the route… */
  offRouteM: 40,
  /** …for at least this long… */
  offRouteS: 5,
  /** …and heading differs from the route by more than this (when moving). */
  offRouteHeadingDeg: 60,
  /** Minimum time between reroute requests. */
  rerouteBackoffS: 10,
  /** Projection search window ahead of the last snapped position. */
  searchAheadM: 1500,
  searchBehindM: 100,
  /** Arrived within this distance of the destination. */
  arriveM: 30,
  /** F11: the following maneuver is emphasised when it is this close (≈150 m + tolerance) after the next one… */
  closeTurnM: 160,
  /** …or this close in time. */
  closeTurnS: 15,
  /** Highlight the upcoming ramp when it starts within this distance. */
  rampHighlightM: 2000,
} as const;

export interface ManeuverView {
  step: NavStep;
  /** Distance from the current position to this maneuver. */
  distanceM: number;
  banner: Banner | null;
  lanes: Lane[] | null;
}

export interface FollowingView extends ManeuverView {
  /** Distance between the next maneuver and this one. */
  gapM: number;
  gapS: number;
  /** F11: true when the two maneuvers are close together (size/colour/voice "then…"). */
  emphasized: boolean;
}

export interface ProgressState {
  alongM: number;
  snapped: LatLng;
  distanceFromRouteM: number;
  stepIndex: number;
  next: ManeuverView | null;
  following: FollowingView | null;
  remainingM: number;
  remainingS: number;
  /** Epoch ms. */
  eta: number;
  limitKph: number | null;
  offRoute: boolean;
  shouldReroute: boolean;
  arrived: boolean;
  /** Announcements that became due on this update, in order. */
  speak: string[];
  /** Upcoming ramp geometry (and its distance) to highlight on the map, if within range. */
  upcomingRamp: { line: LatLng[]; distanceM: number } | null;
}

export interface Fix {
  t: number;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  accuracy: number;
}

/**
 * Tracks progress along a route: snaps fixes, picks the next and following maneuvers (F11), decides when to speak
 * voice instructions, detects off-route with hysteresis, and exposes the current speed limit and ETA.
 */
export class RouteProgress {
  private lastAlong = 0;
  private offSince: number | null = null;
  private lastRerouteAt = -Infinity;
  private readonly spoken = new Set<string>();
  private arrived = false;

  constructor(
    readonly route: NavRoute,
    private readonly th: typeof NAV_THRESHOLDS = NAV_THRESHOLDS,
  ) {}

  /** Call when a reroute request is sent, to start the backoff window. */
  markRerouted(t: number): void {
    this.lastRerouteAt = t;
  }

  update(fix: Fix): ProgressState {
    const r = this.route;
    const fromIdx = this.segmentIndexAt(this.lastAlong - this.th.searchBehindM);
    const toIdx = this.segmentIndexAt(this.lastAlong + this.th.searchAheadM) + 1;
    const proj = projectOnPolyline(fix, r.geometry, r.cum, fromIdx, toIdx);
    // Never move backwards more than GPS noise allows.
    const alongM = proj.alongM < this.lastAlong - 30 ? proj.alongM : Math.max(proj.alongM, this.lastAlong - 5);

    // Off-route hysteresis.
    const tol = Math.max(this.th.offRouteM, fix.accuracy * 1.5);
    let headingOff = true;
    if (fix.heading !== null && (fix.speed ?? 0) > 2) {
      const segStart = r.geometry[proj.segmentIndex]!;
      const segEnd = r.geometry[proj.segmentIndex + 1] ?? segStart;
      headingOff = Math.abs(angleDiffDeg(bearingDeg(segStart, segEnd), fix.heading)) > this.th.offRouteHeadingDeg;
    }
    const far = proj.distanceM > tol;
    if (far && (headingOff || proj.distanceM > tol * 2)) this.offSince ??= fix.t;
    else this.offSince = null;
    const offRoute = this.offSince !== null && (fix.t - this.offSince) / 1000 >= this.th.offRouteS;
    const shouldReroute = offRoute && (fix.t - this.lastRerouteAt) / 1000 >= this.th.rerouteBackoffS;

    if (!offRoute) this.lastAlong = Math.max(0, alongM);
    const a = this.lastAlong;

    const stepIndex = this.stepIndexAt(a);
    const total = r.cum[r.cum.length - 1] ?? 0;
    const remainingM = Math.max(0, total - a);
    const remainingS = this.remainingDuration(a);
    const destination = r.geometry[r.geometry.length - 1]!;
    if (!this.arrived && (remainingM <= this.th.arriveM || haversineM(fix, destination) <= this.th.arriveM)) {
      this.arrived = true;
    }

    const nextStep = r.steps[stepIndex + 1] ?? null;
    const curStep = r.steps[stepIndex]!;
    const remainingInStep = curStep.endAlongM - a;
    let next: ManeuverView | null = null;
    let following: FollowingView | null = null;
    if (nextStep) {
      const banner = this.activeBanner(curStep, remainingInStep);
      next = { step: nextStep, distanceM: Math.max(0, remainingInStep), banner, lanes: laneStrip(banner?.lanes, banner?.primary.modifier ?? nextStep.maneuver.modifier, nextStep.maneuverLanes) };
      const followStep = r.steps[stepIndex + 2] ?? null;
      if (followStep) {
        const gapM = nextStep.endAlongM - nextStep.startAlongM;
        const gapS = nextStep.durationS;
        const fb = nextStep.banners[0] ?? null;
        following = {
          step: followStep,
          distanceM: Math.max(0, followStep.startAlongM - a),
          banner: fb,
          lanes: laneStrip(fb?.lanes, fb?.primary.modifier ?? followStep.maneuver.modifier, followStep.maneuverLanes),
          gapM,
          gapS,
          emphasized: gapM < this.th.closeTurnM || gapS < this.th.closeTurnS,
        };
      }
    }

    const speak = offRoute ? [] : this.dueAnnouncements(curStep, remainingInStep, following);
    const limitKph = r.maxspeedKph[this.segmentIndexAt(a)] ?? null;

    return {
      alongM: a,
      snapped: pointAlong(r.geometry, r.cum, a),
      distanceFromRouteM: proj.distanceM,
      stepIndex,
      next,
      following,
      remainingM,
      remainingS,
      eta: fix.t + remainingS * 1000,
      limitKph,
      offRoute,
      shouldReroute,
      arrived: this.arrived,
      speak,
      upcomingRamp: this.upcomingRamp(a),
    };
  }

  private activeBanner(step: NavStep, remainingInStep: number): Banner | null {
    // Banners are sorted by decreasing distanceAlongGeometry; the active one is the last whose threshold we passed.
    let active: Banner | null = step.banners[0] ?? null;
    for (const b of step.banners) if (remainingInStep <= b.distanceAlongGeometry) active = b;
    return active;
  }

  private dueAnnouncements(step: NavStep, remainingInStep: number, following: FollowingView | null): string[] {
    const out: string[] = [];
    const due = step.voice.filter((v) => remainingInStep <= v.distanceAlongGeometry);
    const latest = due[due.length - 1];
    if (!latest) return out;
    // Only the most recent due announcement is spoken (skipping stale ones after a GPS jump).
    for (const v of due) this.spoken.add(`${step.index}:${v.distanceAlongGeometry}`);
    const key = `${step.index}:${latest.distanceAlongGeometry}:said`;
    if (this.spoken.has(key)) return out;
    this.spoken.add(key);
    let text = latest.announcement;
    const isLast = latest === step.voice[step.voice.length - 1];
    if (isLast && following?.emphasized && !/\b(then|puis|ensuite)\b|затем/i.test(text)) {
      const fi = following.banner?.primary.text ?? following.step.maneuver.instruction;
      text = `${text}, ${t('nav.then').toLowerCase()} ${fi}`;
    }
    out.push(text);
    return out;
  }

  private upcomingRamp(a: number): ProgressState['upcomingRamp'] {
    for (const s of this.route.steps) {
      if (!s.isRamp || s.endAlongM < a) continue;
      const distanceM = Math.max(0, s.startAlongM - a);
      if (distanceM > this.th.rampHighlightM) return null;
      const line = slicePolyline(this.route.geometry, this.route.cum, Math.max(a, s.startAlongM), s.endAlongM);
      return { line, distanceM };
    }
    return null;
  }

  private remainingDuration(a: number): number {
    let s = 0;
    for (const st of this.route.steps) {
      if (st.endAlongM <= a) continue;
      const len = st.endAlongM - st.startAlongM;
      const frac = len > 0 ? Math.min(1, (st.endAlongM - Math.max(a, st.startAlongM)) / len) : 0;
      s += st.durationS * frac;
    }
    return s;
  }

  private stepIndexAt(a: number): number {
    const steps = this.route.steps;
    for (let i = 0; i < steps.length; i++) if (a < steps[i]!.endAlongM) return i;
    return steps.length - 1;
  }

  private segmentIndexAt(a: number): number {
    const cum = this.route.cum;
    if (a <= 0) return 0;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= a) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}
