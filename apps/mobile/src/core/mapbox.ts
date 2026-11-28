import Constants from 'expo-constants';
import { apiKindOf, apiUnitsOf } from '@crewmap/shared/apiBudget';
import { dedupeNearby, type LatLng } from '@crewmap/shared/geo';
import { parseMatchLimits, type MatchResponse } from '@crewmap/shared/speedLimits';
import { parseWalk, walkingUrl, type WalkRoute } from '@crewmap/shared/parking';
import { TtlCache } from '@crewmap/shared/ttlCache';
import {
  directionsUrl,
  parseMapboxRoute,
  parseSnap,
  queryToRequest,
  snapUrl,
  type MbDirectionsResponse,
  type NavRoute,
  type RouteExclude,
  type RouteQuery,
  type Snapped,
} from '@crewmap/shared/navigation';
import { countRequest, countSaved } from './apiBudget';

export const MAPBOX_TOKEN: string = (Constants.expoConfig?.extra?.mapboxPublicToken as string | undefined) ?? '';
export const hasMapboxToken = (): boolean => MAPBOX_TOKEN.startsWith('pk.');

const API = 'https://api.mapbox.com';

const HTTP_TIMEOUT_MS = 12_000;

/** Every Mapbox request goes through here: one daily counter per API (D60, Settings → Help → Diagnostics). */
async function getJson<T>(url: string): Promise<T> {
  const kind = apiKindOf(url);
  if (kind) countRequest(kind, apiUnitsOf(url));
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Mapbox ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

/** Directions `driving-traffic` with alternatives, banner/voice instructions and maxspeed/congestion annotations. */
export async function directions(from: LatLng, to: LatLng, bearing: number | null, lang: 'en' | 'fr' | 'ru', exclude: RouteExclude[] = []): Promise<NavRoute[]> {
  const url = directionsUrl({ coordinates: [from, to], alternatives: true, bearing, language: lang, exclude }, MAPBOX_TOKEN);
  const res = await getJson<MbDirectionsResponse>(url);
  if (res.code !== 'Ok') throw new Error(res.message ?? res.code);
  return res.routes.map((r, i) => parseMapboxRoute(r, `${res.uuid ?? Date.now()}-${i}`));
}

let queryN = 0;

/** One discovery Directions call (silent vias with radiuses/bearings), parsed like `directions`. */
export async function directionsQuery(q: RouteQuery, lang: 'en' | 'fr' | 'ru'): Promise<NavRoute[]> {
  const n = queryN++;
  const res = await getJson<MbDirectionsResponse>(directionsUrl(queryToRequest(q, lang), MAPBOX_TOKEN));
  if (res.code !== 'Ok') return [];
  return res.routes.map((r, i) => parseMapboxRoute(r, `${res.uuid ?? Date.now()}-q${n}-${i}`));
}

/** Snaps probe points onto the road network in one Matrix call (road name + snap distance per point). */
export async function snapToRoads(points: LatLng[]): Promise<(Snapped | null)[]> {
  return parseSnap(await getJson<Parameters<typeof parseSnap>[0]>(snapUrl(points, MAPBOX_TOKEN))).slice(0, points.length);
}

/**
 * Routed ETA + distance from me to each friend (Matrix API, driving-traffic, 1 source × N destinations).
 * ≤ 24 destinations per call; callers throttle (only friends who moved > 300 m or every 5 min).
 */
export async function matrixFrom(me: LatLng, friends: LatLng[]): Promise<{ durationS: (number | null)[]; distanceM: (number | null)[] }> {
  if (friends.length === 0) return { durationS: [], distanceM: [] };
  const coords = [me, ...friends.slice(0, 24)].map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const url = `${API}/directions-matrix/v1/mapbox/driving-traffic/${coords}?sources=0&annotations=duration,distance&access_token=${MAPBOX_TOKEN}`;
  const res = await getJson<{ code: string; durations?: (number | null)[][]; distances?: (number | null)[][] }>(url);
  return { durationS: res.durations?.[0]?.slice(1) ?? [], distanceM: res.distances?.[0]?.slice(1) ?? [] };
}

export interface SearchResult {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category?: string;
}

/**
 * Search Box `/forward` — billed per request (25k/month free), unlike /suggest sessions (2.5k free). Debounced by
 * the caller (350 ms, ≥ 3 characters). Biased to the user's position, limited to Canada.
 */
const searchCache = new TtlCache<SearchResult[]>(24 * 3600_000, 60);

export async function searchForward(q: string, near: LatLng | null, lang: 'en' | 'fr' | 'ru'): Promise<SearchResult[]> {
  // The same text near the same place (~2 km cells) today: the answer has not changed (typing back, re-opening search).
  const cell = near ? `${Math.round(near.lat * 50)},${Math.round(near.lng * 35)}` : '-';
  const key = `${q.trim().toLowerCase()}|${cell}|${lang}`;
  const hit = searchCache.get(key, Date.now());
  if (hit) {
    countSaved('search');
    return hit;
  }
  const out = await searchForwardNet(q, near, lang);
  searchCache.set(key, out, Date.now());
  return out;
}

async function searchForwardNet(q: string, near: LatLng | null, lang: 'en' | 'fr' | 'ru'): Promise<SearchResult[]> {
  // Proximity bias ranks local results first without blocking US/cross-border destinations.
  const p = new URLSearchParams({ q, access_token: MAPBOX_TOKEN, language: lang, limit: '8' });
  if (near) p.set('proximity', `${near.lng},${near.lat}`);
  const res = await getJson<{
    features: { id?: string; properties: { mapbox_id: string; name: string; full_address?: string; place_formatted?: string; poi_category?: string[] }; geometry: { coordinates: [number, number] } }[];
  }>(`${API}/search/searchbox/v1/forward?${p.toString()}`);
  return dedupeNearby(res.features.map((f) => {
    const r: SearchResult = {
      id: f.properties.mapbox_id,
      name: f.properties.name,
      address: f.properties.full_address ?? f.properties.place_formatted ?? '',
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    };
    if (f.properties.poi_category?.[0]) r.category = f.properties.poi_category[0];
    return r;
  }));
}

/** Walking route to the parked car (D67): Directions `walking`, one route, overview geometry only. */
export async function walkingRoute(from: LatLng, to: LatLng, lang: 'en' | 'fr' | 'ru'): Promise<WalkRoute | null> {
  return parseWalk(await getJson<unknown>(walkingUrl(from, to, MAPBOX_TOKEN, lang)));
}

/** City name for a coordinate (Geocoding v6 reverse, temporary API — 100k/month free). Cached by the caller. */
export async function reverseCity(p: LatLng): Promise<string | null> {
  const url = `${API}/search/geocode/v6/reverse?longitude=${p.lng}&latitude=${p.lat}&types=place&limit=1&access_token=${MAPBOX_TOKEN}`;
  const res = await getJson<{ features: { properties: { name: string } }[] }>(url);
  return res.features[0]?.properties.name ?? null;
}

/**
 * Posted speed limits when not navigating: Map Matching on the last ~10 fixes with `annotations=maxspeed`
 * (100k/month free). Returns the limit at each of those fixes (the caller caches them per road cell, D60) and at
 * the newest one.
 */
export async function matchLimits(fixes: { lat: number; lng: number; t: number; heading?: number | null }[]): Promise<{ last: number | null; points: { lat: number; lng: number; heading: number | null; kph: number | null }[] }> {
  if (fixes.length < 2) return { last: null, points: [] };
  const pts = fixes.slice(-10);
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const ts = pts.map((p) => Math.floor(p.t / 1000)).join(';');
  const url = `${API}/matching/v5/mapbox/driving/${coords}?annotations=maxspeed&overview=false&timestamps=${ts}&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const res = await getJson<MatchResponse>(url);
  const per = parseMatchLimits(res, pts.length);
  return { last: per[per.length - 1] ?? null, points: pts.map((p, i) => ({ lat: p.lat, lng: p.lng, heading: p.heading ?? null, kph: per[i] ?? null })) };
}
