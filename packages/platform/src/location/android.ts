import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { Fix, HeadingReading, LocationService, PermissionState, SamplingProfile } from '../contracts';
import { LocationRequestGate } from './gate';

export const LOCATION_TASK = 'crewmap-location';

const listeners = new Set<(fixes: Fix[]) => void>();
/** Fixes that arrive before any listener is attached (headless start) are held briefly. */
let pending: Fix[] = [];

function toFix(l: Location.LocationObject): Fix {
  return {
    t: l.timestamp,
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    accuracy: l.coords.accuracy ?? 999,
    speed: l.coords.speed !== null && l.coords.speed >= 0 ? l.coords.speed : null,
    heading: l.coords.heading !== null && l.coords.heading >= 0 ? l.coords.heading : null,
    altitude: l.coords.altitude ?? null,
  };
}

function deliver(fixes: Fix[]): void {
  if (fixes.length === 0) return;
  if (listeners.size === 0) {
    pending = [...pending, ...fixes].slice(-500);
    return;
  }
  for (const l of listeners) l(fixes);
}

// Must run at module load (global scope) so the OS can deliver background fixes to a headless JS context.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  deliver(data.locations.map(toFix));
});

/**
 * Adaptive sampling (docs/BATTERY.md). expo-location maps Lowest → PRIORITY_LOW_POWER (Wi-Fi/cell, no GNSS),
 * Balanced/Low → BALANCED, High+ → HIGH_ACCURACY; it sets maxUpdateDelay = interval, and `deferredUpdatesInterval`
 * only batches JS delivery while backgrounded. Still: no GNSS at all — movement is detected by activity transitions
 * and a re-armed "here" geofence (tracking.ts), this request only keeps the foreground service and a coarse heartbeat.
 */
export const PROFILES: Record<SamplingProfile, Location.LocationTaskOptions> = {
  navigating: { accuracy: Location.LocationAccuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
  driving: { accuracy: Location.LocationAccuracy.High, timeInterval: 2000, distanceInterval: 5 },
  walking: { accuracy: Location.LocationAccuracy.Balanced, timeInterval: 30_000, distanceInterval: 30, deferredUpdatesInterval: 60_000 },
  still: { accuracy: Location.LocationAccuracy.Lowest, timeInterval: 300_000, distanceInterval: 100, deferredUpdatesInterval: 900_000 },
};

const perm = (s: Location.PermissionStatus): PermissionState =>
  s === Location.PermissionStatus.GRANTED ? 'granted' : s === Location.PermissionStatus.DENIED ? 'denied' : 'undetermined';

/** Single owner of the OS request: re-requests only when the effective options change. */
const gate = new LocationRequestGate();
/** Serializes start/stop so overlapping calls can't interleave a stop+start. */
let chain: Promise<void> = Promise.resolve();
const serial = (fn: () => Promise<void>): Promise<void> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

export const androidLocation: LocationService = {
  foregroundPermission: async () => perm((await Location.getForegroundPermissionsAsync()).status),
  requestForeground: async () => perm((await Location.requestForegroundPermissionsAsync()).status),
  backgroundPermission: async () => perm((await Location.getBackgroundPermissionsAsync()).status),
  requestBackground: async () => perm((await Location.requestBackgroundPermissionsAsync()).status),
  current: async () => {
    try {
      return toFix(await Location.getCurrentPositionAsync({ accuracy: Location.LocationAccuracy.High }));
    } catch {
      const last = await Location.getLastKnownPositionAsync();
      return last ? toFix(last) : null;
    }
  },
  startBackground: (profile, notification) =>
    serial(async () => {
      const options: Location.LocationTaskOptions = {
        ...PROFILES[profile],
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: notification.title,
          notificationBody: notification.body,
          notificationColor: '#5B6CFF',
          killServiceOnDestroy: false,
        },
      };
      const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      // Identical options: nothing to do (expo re-creates the request and foreground service on every call).
      if (!gate.needsStart(options, running)) return;
      await Location.startLocationUpdatesAsync(LOCATION_TASK, options);
      gate.started(options, Date.now());
    }),
  stopBackground: () =>
    serial(async () => {
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      }
      gate.stopped(Date.now());
    }),
  isBackgroundRunning: () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false),
  requestChurn: (windowMs) => gate.churn(Date.now(), windowMs),
  onFixes: (cb) => {
    listeners.add(cb);
    if (pending.length > 0) {
      const p = pending;
      pending = [];
      cb(p);
    }
    return () => listeners.delete(cb);
  },
  watchHeading: (cb: (r: HeadingReading) => void) => {
    let sub: Location.LocationSubscription | null = null;
    let stopped = false;
    Location.watchHeadingAsync((h) => {
      // Android accuracy is the sensor status 0–3: drop 0 (unreliable) and 1 (low). iOS (degrees of error): CONTRACT.md.
      if (h.accuracy < 2) return;
      const isTrue = h.trueHeading >= 0;
      const deg = isTrue ? h.trueHeading : h.magHeading;
      if (!(deg >= 0)) return;
      cb({ t: Date.now(), deg, isTrue });
    })
      .then((s) => {
        if (stopped) s.remove();
        else sub = s;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      sub?.remove();
    };
  },
};
