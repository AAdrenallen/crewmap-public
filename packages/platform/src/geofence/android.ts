import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { GeofenceService } from '../contracts';

export const GEOFENCE_TASK = 'crewmap-geofence';

type GeofenceEvent = { id: string; kind: 'enter' | 'exit'; t: number };
const listeners = new Set<(e: GeofenceEvent) => void>();
let pending: GeofenceEvent[] = [];

TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(
  GEOFENCE_TASK,
  async ({ data, error }) => {
    if (error || !data?.region.identifier) return;
    const e: GeofenceEvent = {
      id: data.region.identifier,
      kind: data.eventType === Location.GeofencingEventType.Enter ? 'enter' : 'exit',
      t: Date.now(),
    };
    if (listeners.size === 0) pending = [...pending, e].slice(-100);
    for (const l of listeners) l(e);
  },
);

/** Android allows 100 geofences per app; we register at most the 90 nearest (places + friends' subscribed places). */
export const MAX_GEOFENCES = 90;

/**
 * Last registered set. Re-registering is not free: expo re-creates the request with INITIAL_TRIGGER_ENTER, so every
 * fence we're inside fires "enter" again (and tracking then asks for a fix). Identical sets are skipped.
 */
let appliedKey: string | null = null;

export const androidGeofence: GeofenceService = {
  set: async (regions) => {
    if (regions.length === 0) {
      await androidGeofence.clear();
      return;
    }
    const list = regions.slice(0, MAX_GEOFENCES);
    const key = list.map((r) => `${r.id}:${r.lat.toFixed(5)}:${r.lng.toFixed(5)}:${Math.round(r.radiusM)}`).join('|');
    if (key === appliedKey && (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false))) return;
    appliedKey = null;
    await Location.startGeofencingAsync(
      GEOFENCE_TASK,
      list.map((r) => ({
        identifier: r.id,
        latitude: r.lat,
        longitude: r.lng,
        radius: Math.max(100, r.radiusM),
        notifyOnEnter: true,
        notifyOnExit: true,
      })),
    );
    appliedKey = key;
  },
  clear: async () => {
    appliedKey = null;
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  },
  onEvent: (cb) => {
    listeners.add(cb);
    if (pending.length) {
      const p = pending;
      pending = [];
      p.forEach(cb);
    }
    return () => listeners.delete(cb);
  },
};
