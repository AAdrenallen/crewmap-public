import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { platform } from '@crewmap/platform';
import { BearingSelector, CompassFilter, FRIEND_MOTION, MotionSmoother, SELF_MOTION, type Pose } from '@crewmap/shared/motion';
import { replayRate } from '../../core/replayClock';
import { useApp } from '../../core/store';

/** Smoothed pose tick rates: self feeds the native location provider (camera) and the sprite; friends only sprites. */
const SELF_TICK_MS = 100;
const FRIEND_TICK_MS = 250;
/** The self clock resyncs to the fix time when it runs further ahead than this (fix latency is well below it). */
const RESYNC_MS = 2000;

/**
 * Own smoothed pose: one source for the follow camera (via CustomLocationProvider), the sprite and anything else
 * drawn at "me". `bearing` is the heading-up map bearing: GPS course while moving, compass while stopped (cross-faded).
 * Out of the app store so a 10 Hz tick re-renders only its two tiny subscribers.
 */
export const useSelfPose = create<{ pose: Pose | null; bearing: number | null }>(() => ({ pose: null, bearing: null }));

/**
 * Runs the self smoother while mounted: fix stream in, 10 Hz pose out while moving/blending, idle otherwise.
 * While `headingUp` and the app is in the foreground it also listens to the compass (unsubscribed otherwise).
 */
export function useSelfMotion(headingUp: boolean): void {
  const compass = useRef<{ filter: CompassFilter; onReading: (() => void) | null }>({ filter: new CompassFilter(), onReading: null });
  const activeRef = useRef(AppState.currentState === 'active');
  const [active, setActive] = useState(activeRef.current);

  useEffect(() => {
    const m = new MotionSmoother(SELF_MOTION);
    const sel = new BearingSelector();
    let timer: ReturnType<typeof setInterval> | null = null;
    // The smoother runs on fix time. Real GPS: fix time ≈ wall clock. Replays: fix time runs `replayRate()`× faster
    // and starts anywhere, so the clock is anchored at each fix and advanced at that rate.
    let anchor: { c: number; w: number } | null = null;
    const clock = () => (anchor ? anchor.c + (Date.now() - anchor.w) * replayRate() : Date.now());
    const stopTimer = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const publish = () => {
      const now = clock();
      const pose = m.sample(now);
      const wall = Date.now();
      const bearing = sel.bearing(useApp.getState().fix?.speed ?? null, pose?.heading ?? null, compass.current.filter.value, wall);
      useSelfPose.setState({ pose, bearing });
      if (!activeRef.current || (!m.animating(now) && !sel.blending(wall))) {
        stopTimer();
      }
    };
    const kick = () => {
      if (!activeRef.current) return;
      if (!timer && (m.animating(clock()) || sel.blending(Date.now()))) timer = setInterval(publish, SELF_TICK_MS);
    };
    compass.current.onReading = () => {
      publish();
      kick();
    };
    const onFix = (s: ReturnType<typeof useApp.getState>) => {
      m.setTrack(s.nav?.active ? s.nav.route : null);
      const f = s.fix;
      if (!f || f.t === m.last?.t) return;
      // Continue the clock across fixes (blend from where the pose was shown); resync when it drifted off the fix
      // stream (first fix, gaps, a new replay).
      let now = clock();
      if (!anchor || now < f.t || now > f.t + RESYNC_MS * replayRate()) now = f.t;
      anchor = { c: now, w: Date.now() };
      m.push({ t: f.t, lat: f.lat, lng: f.lng, speed: f.speed, heading: f.heading }, now);
      if (activeRef.current) {
        publish();
        kick();
      }
    };
    onFix(useApp.getState());
    const unsub = useApp.subscribe((s, prev) => {
      if (s.fix !== prev.fix || s.nav?.route !== prev.nav?.route || s.nav?.active !== prev.nav?.active) onFix(s);
    });
    const appSub = AppState.addEventListener('change', (st) => {
      const fg = st === 'active';
      activeRef.current = fg;
      setActive(fg);
      if (!fg) stopTimer();
      else {
        publish();
        kick();
      }
    });
    return () => {
      unsub();
      appSub.remove();
      compass.current.onReading = null;
      stopTimer();
    };
  }, []);

  // Compass only while heading-up and in the foreground (it keeps the magnetometer on).
  useEffect(() => {
    if (!headingUp || !active) return;
    const c = compass.current;
    return platform.location.watchHeading((r) => {
      if (c.filter.push(r.deg, r.t) !== null) c.onReading?.();
    });
  }, [headingUp, active]);
}

export interface FriendSample {
  /** Receipt-time stamp (sender clocks are not trusted for extrapolation). */
  key: number;
  lat: number;
  lng: number;
  spd: number | null;
  hdg: number | null;
}

/** A friend's pose tweened between presence updates at FRIEND_TICK_MS; paused while backgrounded. */
export function useFriendPose(p: FriendSample): Pose {
  const m = useRef<MotionSmoother | null>(null);
  if (!m.current) m.current = new MotionSmoother(FRIEND_MOTION);
  const [pose, setPose] = useState<Pose>({ lat: p.lat, lng: p.lng, heading: p.hdg });
  useEffect(() => {
    const sm = m.current!;
    const now = Date.now();
    sm.push({ t: now, lat: p.lat, lng: p.lng, speed: p.spd, heading: p.hdg }, now);
    let id: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const tick = () => {
      const t = Date.now();
      const s = sm.sample(t);
      if (s) {
        setPose((prev) =>
          Math.abs(s.lat - prev.lat) < 1e-7 && Math.abs(s.lng - prev.lng) < 1e-7 && s.heading === prev.heading ? prev : s,
        );
      }
      return sm.animating(t);
    };
    const start = () => {
      if (AppState.currentState !== 'active') return;
      if (!tick()) {
        stop();
        return;
      }
      if (!id) {
        id = setInterval(() => {
          if (AppState.currentState !== 'active' || !tick()) stop();
        }, FRIEND_TICK_MS);
      }
    };
    start();
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') start();
      else stop();
    });
    return () => {
      appSub.remove();
      stop();
    };
  }, [p.key, p.lat, p.lng, p.spd, p.hdg]);
  return pose;
}
