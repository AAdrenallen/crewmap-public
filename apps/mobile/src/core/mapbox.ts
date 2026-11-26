import Constants from 'expo-constants';
import { dedupeNearby, type LatLng } from '@crewmap/shared/geo';
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

export const MAPBOX_TOKEN: string = (Constants.expoConfig?.extra?.mapboxPublicToken as string | undefined) ?? '';
export const hasMapboxToken = (): boolean => MAPBOX_TOKEN.startsWith('pk.');

const API = 'https://api.mapbox.com';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox ${res.status}`);
  return (await res.json()) as T;
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
export async function searchForward(q: string, near: LatLng | null, lang: 'en' | 'fr' | 'ru'): Promise<SearchResult[]> {
  const p = new URLSearchParams({ q, access_token: MAPBOX_TOKEN, language: lang, limit: '8', country: 'ca' });
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

/** City name for a coordinate (Geocoding v6 reverse, temporary API — 100k/month free). Cached by the caller. */
export async function reverseCity(p: LatLng): Promise<string | null> {
  const url = `${API}/search/geocode/v6/reverse?longitude=${p.lng}&latitude=${p.lat}&types=place&limit=1&access_token=${MAPBOX_TOKEN}`;
  const res = await getJson<{ features: { properties: { name: string } }[] }>(url);
  return res.features[0]?.properties.name ?? null;
}

/**
 * Posted speed limit when not navigating: Map Matching on the last ~10 fixes with `annotations=maxspeed`
 * (100k/month free; called at most every 30 s while driving and only when the road may have changed).
 */
export async function matchMaxspeed(fixes: { lat: number; lng: number; t: number }[]): Promise<number | null> {
  if (fixes.length < 2) return null;
  const pts = fixes.slice(-10);
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const ts = pts.map((p) => Math.floor(p.t / 1000)).join(';');
  const url = `${API}/matching/v5/mapbox/driving/${coords}?annotations=maxspeed&overview=false&timestamps=${ts}&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const res = await getJson<{ matchings?: { legs: { annotation?: { maxspeed?: ({ speed: number; unit: string } | { unknown: true } | { none: true })[] } }[] }[] }>(url);
  const legs = res.matchings?.[0]?.legs ?? [];
  const last = legs[legs.length - 1]?.annotation?.maxspeed ?? [];
  for (let i = last.length - 1; i >= 0; i--) {
    const m = last[i]!;
    if ('speed' in m) return m.unit === 'mph' ? Math.round(m.speed * 1.609344) : m.speed;
  }
  return null;
}
