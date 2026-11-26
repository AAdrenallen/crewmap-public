import { kvGet, kvSet } from './db';

/**
 * Where the map was last centred on this phone (device-local, never shared), so a cold start opens there instead of
 * a generic city until the first GPS fix arrives. Saved at most once a minute.
 */
export interface LastCenter {
  lat: number;
  lng: number;
  t: number;
}

const KEY = 'map.lastCenter';
const SAVE_EVERY_MS = 60_000;
let cached: LastCenter | null = null;
let lastSave = 0;

export async function loadLastCenter(): Promise<void> {
  cached = await kvGet<LastCenter | null>(KEY, null);
}

export function getLastCenter(): LastCenter | null {
  return cached;
}

export function rememberCenter(p: { lat: number; lng: number; t: number }, force = false): void {
  cached = { lat: p.lat, lng: p.lng, t: p.t };
  if (!force && p.t - lastSave < SAVE_EVERY_MS) return;
  lastSave = p.t;
  void kvSet(KEY, cached);
}
