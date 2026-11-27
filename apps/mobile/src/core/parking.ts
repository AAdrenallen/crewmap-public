import { AppState } from 'react-native';
import { create } from 'zustand';
import { OSM_OVERPASS_ENDPOINTS } from '@crewmap/hazards';
import type { Trip } from '@crewmap/shared/driving';
import { lang } from '@crewmap/shared/i18n';
import {
  classifyParking,
  NO_PARKING,
  PARKING,
  parkCandidate,
  parkedNoticeTitle,
  parkingQuery,
  parkingShareText,
  parkingStep,
  parseParkingContext,
  readParkingState,
  reachedCar,
  straightWalk,
  type ParkingContext,
  type ParkingEffect,
  type ParkingInput,
  type ParkingState,
  type WalkRoute,
} from '@crewmap/shared/parking';
import type { Place } from '@crewmap/shared/places';
import * as db from './db';
import { hasMapboxToken, walkingRoute } from './mapbox';
import { notify } from './notify';
import { recordError } from './errorLog';

/**
 * "Where did I park" (D67), app side. The spot, its note and the settings live in the local kv table only: nothing
 * here touches a crew doc, presence or the router. The one way out is `shareParked` (an explicit tap, a crew chat
 * message). Pure decisions are in packages/shared/src/parking.
 */

const STATE_KEY = 'parking.v1';
const PREFS_KEY = 'parking.prefs.v1';
const OSM_CACHE_KEY = 'parking.osm.v1';
/** Overpass answers kept per ~11 m cell: parking at the same office or shop again needs no request. */
const OSM_CACHE_MAX = 40;
const OSM_CACHE_AGE_MS = 30 * 86_400_000;
const OSM_TIMEOUT_MS = 12_000;
const OSM_HEADERS = { 'User-Agent': 'CrewMap/1 (private crew navigation app; occasional parked-car street lookup)' };

export interface ParkingPrefs {
  enabled: boolean;
  /** Hours; 0 = keep until the next drive. */
  forgetAfterH: number;
}

interface ParkingStore {
  loaded: boolean;
  state: ParkingState;
  prefs: ParkingPrefs;
  /** "Walk there" line on the map, until the car is reached or the walk is stopped. */
  walk: WalkRoute | null;
}

export const useParking = create<ParkingStore>(() => ({
  loaded: false,
  state: NO_PARKING,
  prefs: { enabled: true, forgetAfterH: PARKING.defaultForgetAfterH },
  walk: null,
}));

let loading: Promise<void> | null = null;

/** Reads the saved spot and prefs once (tracking calls this before the first event). */
export function loadParking(): Promise<void> {
  loading ??= (async () => {
    const [st, prefs] = await Promise.all([db.kvGet<unknown>(STATE_KEY, null).catch(() => null), db.kvGet<Partial<ParkingPrefs> | null>(PREFS_KEY, null).catch(() => null)]);
    const p = useParking.getState().prefs;
    useParking.setState({
      loaded: true,
      state: readParkingState(st),
      prefs: {
        enabled: typeof prefs?.enabled === 'boolean' ? prefs.enabled : p.enabled,
        forgetAfterH: typeof prefs?.forgetAfterH === 'number' && PARKING.forgetAfterOptionsH.includes(prefs.forgetAfterH) ? prefs.forgetAfterH : p.forgetAfterH,
      },
    });
  })();
  return loading;
}

export async function setParkingPrefs(p: Partial<ParkingPrefs>): Promise<void> {
  await loadParking();
  const prefs = { ...useParking.getState().prefs, ...p };
  useParking.setState({ prefs });
  if (!prefs.enabled) await apply({ type: 'forget' });
  await db.kvSet(PREFS_KEY, prefs).catch(() => undefined);
}

async function apply(input: ParkingInput): Promise<ParkingEffect[]> {
  await loadParking();
  const before = useParking.getState().state;
  const { state, effects } = parkingStep(before, input);
  if (state !== before) {
    useParking.setState({ state, ...(state.spot ? {} : { walk: null }) });
    await db.kvSet(STATE_KEY, state).catch(() => undefined);
  }
  for (const e of effects) {
    if (e.type === 'walkedAway' && AppState.currentState !== 'active')
      void notify(parkedNoticeTitle(e.spot), e.spot.note, { channel: 'circle', silent: true, identifier: 'parked', data: { type: 'parked' } }).catch(() => undefined);
  }
  return effects;
}

const cellKey = (p: { lat: number; lng: number }) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

/** OSM around the spot: the cached answer for this cell, else one small Overpass query; null when offline. */
async function osmContext(p: { lat: number; lng: number }): Promise<ParkingContext | null> {
  const key = cellKey(p);
  const now = Date.now();
  const cache = await db.kvGet<Record<string, { at: number; json: unknown }>>(OSM_CACHE_KEY, {}).catch(() => ({}) as Record<string, { at: number; json: unknown }>);
  const hit = cache[key];
  if (hit && now - hit.at < OSM_CACHE_AGE_MS) return parseParkingContext(hit.json, p);
  const body = `data=${encodeURIComponent(parkingQuery(p))}`;
  for (const endpoint of OSM_OVERPASS_ENDPOINTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), OSM_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { ...OSM_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      const next = { ...cache, [key]: { at: now, json } };
      const keys = Object.keys(next).sort((a, b) => next[a]!.at - next[b]!.at);
      for (const k of keys.slice(0, Math.max(0, keys.length - OSM_CACHE_MAX))) delete next[k];
      await db.kvSet(OSM_CACHE_KEY, next).catch(() => undefined);
      return parseParkingContext(json, p);
    } catch {
      // next endpoint
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Tracking hook: a drive started here. */
export function parkingTripStarted(t: number, at: { lat: number; lng: number } | null): void {
  if (!at) return;
  void apply({ type: 'tripStarted', t, lat: at.lat, lng: at.lng }).catch(() => undefined);
}

/** Tracking hook: a drive ended (trip detector stop + walk-away / dwell). */
export async function parkingTripEnded(trip: Trip, myPlaces: readonly Place[]): Promise<void> {
  await loadParking();
  if (!useParking.getState().prefs.enabled) return;
  const c = parkCandidate(trip);
  if (!c) return;
  const ownPlaces = myPlaces.filter((p) => PARKING.skipPlaceTypes.includes(p.type));
  // Home first: no network request at all for the most common stop.
  const quick = classifyParking(c, ownPlaces, null);
  const ctx = quick.save
    ? await osmContext(c).catch((e: unknown) => {
        recordError('js', e instanceof Error ? e : new Error(String(e)));
        return null;
      })
    : null;
  await apply({ type: 'parked', candidate: c, decision: quick.save ? classifyParking(c, ownPlaces, ctx) : quick });
}

/** Tracking hook: newest fix of a batch (walk-away notice, walk-there arrival). */
export function parkingFix(f: { t: number; lat: number; lng: number }): void {
  const { state, walk } = useParking.getState();
  if (!state.spot) return;
  if (walk && reachedCar(state.spot, f)) useParking.setState({ walk: null });
  if (!state.noticed) void apply({ type: 'fix', ...f }).catch(() => undefined);
}

/** Tracking hook: housekeeping tick ("forget after"). */
export function parkingTick(now: number): void {
  const { state, prefs } = useParking.getState();
  if (state.spot) void apply({ type: 'tick', now, forgetAfterH: prefs.forgetAfterH }).catch(() => undefined);
}

export function forgetParked(): Promise<unknown> {
  return apply({ type: 'forget' });
}

/** The trip turned out to be a passenger ride: the car it found is not ours. */
export function forgetParkedFromTrip(tripId: string): void {
  if (useParking.getState().state.spot?.tripId === tripId) void forgetParked();
}

export function noteParked(text: string): Promise<unknown> {
  return apply({ type: 'note', text });
}

/** "Walk there": a walking route (Mapbox Directions, counted in Diagnostics), else a straight line. */
export async function walkToParked(from: { lat: number; lng: number }): Promise<WalkRoute | null> {
  const spot = useParking.getState().state.spot;
  if (!spot) return null;
  let route: WalkRoute | null = null;
  if (hasMapboxToken()) route = await walkingRoute(from, spot, lang()).catch(() => null);
  route ??= straightWalk(from, spot);
  useParking.setState({ walk: route });
  return route;
}

export function stopWalk(): void {
  useParking.setState({ walk: null });
}

/** Explicit "Share with crew": one crew chat message; returns whether a crew could carry it. */
export async function shareParked(send: (thread: string, text: string) => Promise<boolean>, crewId: string): Promise<boolean> {
  const spot = useParking.getState().state.spot;
  return spot ? send(`crew:${crewId}`, parkingShareText(spot)) : false;
}
