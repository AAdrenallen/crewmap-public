import { angleDiffDeg, bearingDeg, destination, EARTH_RADIUS_M, haversineM, normalizeDeg, pointAlong, projectOnPolyline, toLocalXY, type LatLng } from './geo';

/**
 * Dead reckoning + correction blending for map markers and the follow camera. GPS (and presence) arrives at
 * 1 Hz or slower; between fixes the pose is predicted from speed, acceleration, course and turn rate (or along the
 * route polyline when navigating), capped in time. A new fix never snaps: the error between the shown pose and the
 * new prediction is blended out over `blendMs`.
 */
export interface MotionConfig {
  /** Stop extrapolating this long after the last fix. */
  maxExtrapolateMs: number;
  /** Below this speed (m/s) the pose holds the fix. */
  minSpeedMps: number;
  /** Correction blend duration. */
  blendMs: number;
  /** Turn rate clamp (deg/s) and acceleration clamp (m/s²) used by the predictor. */
  maxTurnDegPerS: number;
  maxAccelMps2: number;
  /** Fixes further than this from the route are not map-matched. */
  routeSnapM: number;
  /** A correction larger than this (teleport, first fix after a gap) snaps instead of blending. */
  snapAboveM: number;
}

export const SELF_MOTION: MotionConfig = { maxExtrapolateMs: 1500, minSpeedMps: 1, blendMs: 450, maxTurnDegPerS: 35, maxAccelMps2: 4, routeSnapM: 30, snapAboveM: 150 };
/** Friends report every few seconds: extrapolate across the whole gap and blend slower. */
export const FRIEND_MOTION: MotionConfig = { ...SELF_MOTION, maxExtrapolateMs: 6000, blendMs: 900, snapAboveM: 400 };

export interface MotionFix {
  t: number;
  lat: number;
  lng: number;
  /** m/s */
  speed: number | null;
  /** Course over ground, degrees. */
  heading: number | null;
}

export interface Pose extends LatLng {
  /** Degrees, or null when never known. */
  heading: number | null;
}

/** A route to map-match onto: geometry + cumulative distances (NavRoute has both). */
export interface MotionTrack {
  geometry: LatLng[];
  cum: number[];
}

interface State {
  fix: MotionFix;
  speed: number;
  accel: number;
  heading: number | null;
  turnRate: number;
  /** Along-route distance of the fix when matched to the track. */
  alongM: number | null;
}

const RAD = Math.PI / 180;
/** Track-match search window around the previous match (segments behind / ahead), before a full scan. */
const MATCH_BACK_SEGS = 20;
const MATCH_AHEAD_SEGS = 200;
const CTRV_STEP_S = 0.25;

function shift(p: LatLng, dx: number, dy: number): LatLng {
  return { lat: p.lat + dy / EARTH_RADIUS_M / RAD, lng: p.lng + dx / (EARTH_RADIUS_M * Math.cos(p.lat * RAD)) / RAD };
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** Predicted pose `atMs` from a state (pure). */
function predictState(s: State, atMs: number, cfg: MotionConfig, track: MotionTrack | null): Pose {
  const dtS = Math.min(Math.max(0, atMs - s.fix.t), cfg.maxExtrapolateMs) / 1000;
  const here = { lat: s.fix.lat, lng: s.fix.lng };
  const matched = track !== null && s.alongM !== null;
  if (dtS === 0 || s.speed < cfg.minSpeedMps || (s.heading === null && !matched)) return { ...here, heading: s.heading };
  // Distance with clamped acceleration, never backwards (a car braking to a stop stays stopped).
  const tStop = s.accel < 0 ? -s.speed / s.accel : Infinity;
  const tt = Math.min(dtS, tStop);
  const dist = Math.max(0, s.speed * tt + 0.5 * s.accel * tt * tt);
  if (matched) {
    const a = s.alongM! + dist;
    const p = pointAlong(track.geometry, track.cum, a);
    const ahead = pointAlong(track.geometry, track.cum, a + 5);
    const hdg = haversineM(p, ahead) > 0.5 ? bearingDeg(p, ahead) : s.heading;
    return { ...p, heading: hdg };
  }
  // Straight-line fast path avoids per-step spherical trig when not turning.
  if (Math.abs(s.turnRate) < 1e-4) {
    const p = dist > 1e-6 ? destination(here, s.heading!, dist) : here;
    return { ...p, heading: s.heading! };
  }
  // Constant turn rate and velocity, integrated in short steps.
  let p: LatLng = here;
  let h = s.heading!;
  let left = dist;
  const stepM = Math.max(0.5, (dist / Math.max(tt, 1e-3)) * CTRV_STEP_S);
  while (left > 1e-6) {
    const d = Math.min(stepM, left);
    const dtStep = d / Math.max(s.speed, 1e-3);
    h = normalizeDeg(h + s.turnRate * dtStep * 0.5);
    p = destination(p, h, d);
    h = normalizeDeg(h + s.turnRate * dtStep * 0.5);
    left -= d;
  }
  return { ...p, heading: h };
}

/**
 * One moving thing (self or a friend). `push` a fix, `sample` any time. Not tied to a clock: callers pass `now`.
 */
export class MotionSmoother {
  private s: State | null = null;
  private track: MotionTrack | null = null;
  /** Correction still being blended out: local offset (m) and heading offset (deg), started at `blendAt`. */
  private off = { dx: 0, dy: 0, dh: 0 };
  private blendAt = 0;
  /** Segment of the last track match: the next fix is first searched near it (no full-route scan per fix). */
  private seg = -1;

  constructor(private readonly cfg: MotionConfig = SELF_MOTION) {}

  /** Route to map-match onto while navigating (null to stop). */
  setTrack(track: MotionTrack | null): void {
    if (track === this.track) return;
    this.track = track && track.geometry.length >= 2 ? track : null;
    this.seg = -1;
    if (this.s) this.s.alongM = this.match(this.s.fix);
  }

  get last(): MotionFix | null {
    return this.s?.fix ?? null;
  }

  private match(f: MotionFix): number | null {
    if (!this.track) return null;
    const { geometry, cum } = this.track;
    let pr = this.seg >= 0 ? projectOnPolyline(f, geometry, cum, this.seg - MATCH_BACK_SEGS, this.seg + MATCH_AHEAD_SEGS) : null;
    if (!pr || pr.distanceM > this.cfg.routeSnapM) pr = projectOnPolyline(f, geometry, cum);
    if (pr.distanceM > this.cfg.routeSnapM) {
      this.seg = -1;
      return null;
    }
    this.seg = pr.segmentIndex;
    // A reported course must agree with the route direction (no matching onto the opposite carriageway of a loop).
    if (f.heading !== null) {
      const ahead = pointAlong(this.track.geometry, this.track.cum, pr.alongM + 5);
      if (haversineM(pr.point, ahead) > 0.5 && Math.abs(angleDiffDeg(f.heading, bearingDeg(pr.point, ahead))) > 60) return null;
    }
    return pr.alongM;
  }

  push(f: MotionFix, now = f.t): void {
    if (this.s && f.t <= this.s.fix.t) return;
    const shown = this.s ? this.sample(now) : null;
    const old = this.s;
    let heading = f.heading;
    let speed = f.speed;
    if (old) {
      const dt = (f.t - old.fix.t) / 1000;
      const moved = haversineM(old.fix, f);
      if (heading === null && moved > 2) heading = bearingDeg(old.fix, f);
      if (speed === null && dt > 0) speed = moved / dt;
      if (heading === null) heading = old.heading;
    }
    const v = speed ?? 0;
    let accel = 0;
    let turnRate = 0;
    if (old && f.t - old.fix.t <= 3000) {
      const dt = (f.t - old.fix.t) / 1000;
      accel = Math.max(-this.cfg.maxAccelMps2, Math.min(this.cfg.maxAccelMps2, (v - old.speed) / dt));
      if (heading !== null && old.heading !== null && v > 2 && old.speed > 2) {
        turnRate = Math.max(-this.cfg.maxTurnDegPerS, Math.min(this.cfg.maxTurnDegPerS, angleDiffDeg(old.heading, heading) / dt));
      }
    }
    this.s = { fix: f, speed: v, accel, heading, turnRate, alongM: null };
    // Only a reported course gates matching: one derived from two fixes cuts corners.
    this.s.alongM = this.match(f);
    if (!shown) return;
    const next = predictState(this.s, now, this.cfg, this.track);
    const o = toLocalXY(next, shown);
    if (Math.hypot(o.x, o.y) > this.cfg.snapAboveM) {
      this.off = { dx: 0, dy: 0, dh: 0 };
      return;
    }
    const dh = shown.heading !== null && next.heading !== null ? angleDiffDeg(next.heading, shown.heading) : 0;
    this.off = { dx: o.x, dy: o.y, dh };
    this.blendAt = now;
  }

  /** Pure prediction from the last fix (no blending): what the next fix is compared against. */
  predict(atMs: number): Pose | null {
    return this.s ? predictState(this.s, atMs, this.cfg, this.track) : null;
  }

  /** Shown pose at `now`: prediction plus the remaining correction offset. */
  sample(now: number): Pose | null {
    if (!this.s) return null;
    const p = predictState(this.s, now, this.cfg, this.track);
    const k = this.cfg.blendMs > 0 ? Math.min(1, Math.max(0, (now - this.blendAt) / this.cfg.blendMs)) : 1;
    if (k >= 1) return p;
    const r = 1 - easeOut(k);
    const q = shift(p, this.off.dx * r, this.off.dy * r);
    return { ...q, heading: p.heading === null ? null : normalizeDeg(p.heading + this.off.dh * r) };
  }

  /** True while the shown pose still changes (extrapolating or blending): callers tick only then. */
  animating(now: number): boolean {
    if (!this.s) return false;
    const blending = now - this.blendAt < this.cfg.blendMs && (this.off.dx !== 0 || this.off.dy !== 0 || this.off.dh !== 0);
    const extrapolating = this.s.speed >= this.cfg.minSpeedMps && (this.s.heading !== null || this.s.alongM !== null) && now - this.s.fix.t < this.cfg.maxExtrapolateMs;
    return blending || extrapolating;
  }
}

/** Compass smoothing and course/compass selection for heading-up maps. */
export const COMPASS = {
  /** Low-pass time constant. */
  tauMs: 300,
  /** Emit at most this often, and only when the smoothed value moved at least `minStepDeg`. */
  minIntervalMs: 100,
  minStepDeg: 2,
  /** Course is used above `onMps`, compass again below `offMps` (hysteresis). */
  onMps: 3,
  offMps: 1.5,
  /** Cross-fade between the two sources. */
  blendMs: 600,
} as const;

/** Shortest-angle exponential low-pass over compass readings, throttled. */
export class CompassFilter {
  private v: number | null = null;
  private t = 0;
  private emitted: number | null = null;
  private emittedAt = -Infinity;

  /** Feeds a reading; returns the smoothed heading when it should be published, else null. */
  push(deg: number, t: number): number | null {
    if (this.v === null) this.v = normalizeDeg(deg);
    else {
      const a = 1 - Math.exp(-Math.max(0, t - this.t) / COMPASS.tauMs);
      this.v = normalizeDeg(this.v + angleDiffDeg(this.v, deg) * a);
    }
    this.t = t;
    if (t - this.emittedAt < COMPASS.minIntervalMs) return null;
    if (this.emitted !== null && Math.abs(angleDiffDeg(this.emitted, this.v)) < COMPASS.minStepDeg) return null;
    this.emitted = this.v;
    this.emittedAt = t;
    return this.v;
  }

  get value(): number | null {
    return this.v;
  }
}

/**
 * Picks the map bearing source: GPS course while moving, compass while stopped (course is noise at walking pace),
 * with speed hysteresis and a cross-fade at each switch so the map never jumps.
 */
export class BearingSelector {
  private src: 'compass' | 'course' = 'compass';
  private switchedAt = -Infinity;
  /** Bearing shown at the switch: the fade starts from it. */
  private from: number | null = null;
  private last: number | null = null;

  get source(): 'compass' | 'course' {
    return this.src;
  }

  bearing(speed: number | null, course: number | null, compass: number | null, now: number): number | null {
    const v = speed ?? 0;
    const want = this.src === 'course' ? (v >= COMPASS.offMps && course !== null ? 'course' : 'compass') : v > COMPASS.onMps && course !== null ? 'course' : 'compass';
    if (want !== this.src) {
      this.src = want;
      this.switchedAt = now;
      this.from = this.last;
    }
    const target = (this.src === 'course' ? course : compass) ?? course ?? compass ?? this.last;
    if (target === null) return null;
    const k = Math.min(1, Math.max(0, (now - this.switchedAt) / COMPASS.blendMs));
    const out = this.from !== null && k < 1 ? normalizeDeg(this.from + angleDiffDeg(this.from, target) * easeOut(k)) : target;
    this.last = out;
    return out;
  }

  /** True while a cross-fade runs (callers keep ticking). */
  blending(now: number): boolean {
    return now - this.switchedAt < COMPASS.blendMs;
  }
}
