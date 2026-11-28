import { z } from 'zod';
import { haversineM, type LatLng } from '@crewmap/shared/geo';
import { FUEL_GRADES, type FuelGrade, type FuelPrice, type Poi, type PoiKind, type PoiSourceId } from './types';

/** Tunables for map points and fuel search (D64). */
export const POI_TUNING = {
  /** Same-kind points closer than this are one place (Régie station vs OSM node of the same station). */
  mergeRadiusM: 60,
  /** Fuel points of the same brand merge up to this far (OSM node on the canopy vs Régie geocode; ~5 % of Montréal pairs). */
  sameBrandMergeM: 150,
  /** Prices older than this are shown greyed ("old"). */
  staleMs: 24 * 3600_000,
  /** Fuel search radius around the user. */
  searchRadiusM: 15_000,
  /** Shared payload budget per broadcast (UTF-8 bytes of JSON; sealed + base64 it stays under the ~64 kB relay cap, like sync). */
  shareMaxBytes: 30_000,
} as const;

const SOURCE_RANK: Record<PoiSourceId, number> = { regie: 5, 'mtmd-cam': 5, crew: 3, ocm: 2, 'osm-poi': 1 };

/** Newest price per grade wins. */
export function newerPrices(a: Poi['prices'], b: Poi['prices']): Poi['prices'] {
  const out: Partial<Record<FuelGrade, FuelPrice>> = { ...(a ?? {}) };
  for (const g of FUEL_GRADES) {
    const p = b?.[g];
    if (p && (!out[g] || p.at > out[g]!.at)) out[g] = p;
  }
  return out;
}

const sameBrand = (a: Poi, b: Poi) => !!a.brand && !!b.brand && a.brand.trim().toLowerCase() === b.brand.trim().toLowerCase();
const mergeRadius = (a: Poi, b: Poi) => (a.kind === 'fuel' && sameBrand(a, b) ? POI_TUNING.sameBrandMergeM : POI_TUNING.mergeRadiusM);

/** Merge points of the same kind within `mergeRadiusM`: highest-ranked source is the base, newest price per grade wins. */
export function mergePois(all: Poi[]): Poi[] {
  const sorted = [...all].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || b.at - a.at);
  const out: Poi[] = [];
  const byId = new Set<string>();
  const CELL = 0.002;
  const grid = new Map<string, Poi[]>();
  for (const p of sorted) {
    if (byId.has(p.id)) continue;
    byId.add(p.id);
    const cy = Math.floor(p.lat / CELL);
    const cx = Math.floor(p.lng / CELL);
    let near: Poi | undefined;
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const bucket = grid.get(`${p.kind}:${cy + dy}:${cx + dx}`);
        if (!bucket) continue;
        for (const q of bucket) {
          if (Math.abs(q.lat - p.lat) < CELL && Math.abs(q.lng - p.lng) < 0.003 && haversineM(q, p) <= mergeRadius(q, p)) {
            near = q;
            break;
          }
        }
      }
    }
    if (!near) {
      const copy = { ...p };
      out.push(copy);
      const gk = `${p.kind}:${cy}:${cx}`;
      let b = grid.get(gk);
      if (!b) grid.set(gk, (b = []));
      b.push(copy);
      continue;
    }
    if (p.source !== near.source) near.alsoFrom = [...new Set([...(near.alsoFrom ?? []), p.source])];
    if (p.prices) near.prices = newerPrices(near.prices, p.prices);
    near.grades ??= p.grades;
    near.name ??= p.name;
    near.brand ??= p.brand;
    near.address ??= p.address;
    near.sockets ??= p.sockets;
    near.maxKw ??= p.maxKw;
  }
  return out;
}

export type FuelSort = 'price' | 'distance';

export interface FuelHit {
  poi: Poi;
  distanceM: number;
  price: FuelPrice | null;
}

/** Fuel stations near `from` with the chosen grade, cheapest (or nearest) first; stations without a price go last. */
export function rankFuel(pois: Poi[], from: LatLng, grade: FuelGrade, sort: FuelSort, radiusM: number = POI_TUNING.searchRadiusM): FuelHit[] {
  const hits: FuelHit[] = [];
  for (const p of pois) {
    if (p.kind !== 'fuel') continue;
    const d = haversineM(from, p);
    if (d > radiusM) continue;
    hits.push({ poi: p, distanceM: d, price: p.prices?.[grade] ?? null });
  }
  return hits.sort((a, b) => {
    if (sort === 'distance') return a.distanceM - b.distanceM;
    if (!a.price !== !b.price) return a.price ? -1 : 1;
    if (a.price && b.price && a.price.c10 !== b.price.c10) return a.price.c10 - b.price.c10;
    return a.distanceM - b.distanceM;
  });
}

/** True when none of `nearby` has a price newer than `staleMs` (then fuel search fetches the official file itself). */
export function needsFuelFetch(nearby: Poi[], now: number, staleMs = 30 * 60_000): boolean {
  let newest = 0;
  for (const p of nearby) for (const g of FUEL_GRADES) newest = Math.max(newest, p.prices?.[g]?.at ?? 0);
  return now - newest >= staleMs;
}

/** Does a search query ask for fuel stations? (en / fr / ru words; brand names go to the normal search) */
export function isFuelQuery(q: string): boolean {
  const s = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s.length < 3) return false;
  return /^(gas|gas station|gasoline|petrol|fuel|diesel|essence|station d.?essence|station.service|poste d.?essence|carburant)(\s|$)/.test(s) || /^(азс|заправк|бензин|дизел|топлив)/.test(s);
}

/** "166.4" from 1664. */
export const formatC10 = (c10: number) => (c10 / 10).toFixed(1);

// ---- Shared wire format (compact; kept under POI_TUNING.shareMaxBytes) ----

const KINDS: PoiKind[] = ['fuel', 'charging', 'trafficCamera'];
const SOURCES: PoiSourceId[] = ['regie', 'osm-poi', 'mtmd-cam', 'ocm', 'crew'];

/** [id, kind#, source#, lat×1e5, lng×1e5, at(s), name, brand, address, [reg, prem, dsl] c10|0, pricesAt(s)|0, url, maxKw, credit] */
type Row = [string, number, number, number, number, number, string, string, string, [number, number, number], number, string, number, string];
const RowZ = z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number(), z.string(), z.string(), z.string(), z.tuple([z.number(), z.number(), z.number()]), z.number(), z.string(), z.number(), z.string()]);
const Wire = z.object({ v: z.literal(1), p: z.array(z.unknown()) });

function toRow(p: Poi): Row {
  const pr = FUEL_GRADES.map((g) => p.prices?.[g]?.c10 ?? 0) as [number, number, number];
  const pAt = Math.max(0, ...FUEL_GRADES.map((g) => p.prices?.[g]?.at ?? 0));
  return [p.id, KINDS.indexOf(p.kind), SOURCES.indexOf(p.source), Math.round(p.lat * 1e5), Math.round(p.lng * 1e5), Math.round(p.at / 1000), p.name ?? '', p.brand ?? '', p.address ?? '', pr, Math.round(pAt / 1000), p.url ?? '', p.maxKw ?? 0, p.credit ?? ''];
}

function fromRow(r: Row): Poi | null {
  const kind = KINDS[r[1]];
  const source = SOURCES[r[2]];
  if (!kind || !source) return null;
  const pricesAt = r[10] * 1000;
  const prices: Partial<Record<FuelGrade, FuelPrice>> = {};
  FUEL_GRADES.forEach((g, i) => {
    if (r[9][i]! > 0) prices[g] = { c10: r[9][i]!, at: pricesAt, source };
  });
  return {
    id: r[0],
    kind,
    source,
    lat: r[3] / 1e5,
    lng: r[4] / 1e5,
    at: r[5] * 1000,
    name: r[6] || null,
    ...(r[7] ? { brand: r[7] } : {}),
    ...(r[8] ? { address: r[8] } : {}),
    ...(Object.keys(prices).length ? { prices } : {}),
    ...(r[11] && /^https:\/\/(www\.)?quebec511\.info\//.test(r[11]) ? { url: r[11] } : {}),
    ...(r[12] > 0 ? { maxKw: r[12] } : {}),
    ...(r[13] ? { credit: r[13] } : {}),
  };
}

/** Share order: priced fuel, then cameras, then unpriced fuel, then chargers (many chargers must not crowd out prices). */
const shareGroup = (p: Poi) => (p.kind === 'fuel' && p.prices && Object.keys(p.prices).length ? 0 : p.kind === 'trafficCamera' ? 1 : p.kind === 'fuel' ? 2 : 3);
const enc = new TextEncoder();

/** Encode by share group, nearest to `centre` first within a group, stopping at the UTF-8 byte budget. */
export function encodePois(pois: Poi[], centre: LatLng, maxBytes: number = POI_TUNING.shareMaxBytes): string {
  const ranked = pois
    .map((p) => ({ p, g: shareGroup(p), d: haversineM(centre, p) }))
    .sort((a, b) => a.g - b.g || a.d - b.d);
  const out: Row[] = [];
  let bytes = 20;
  for (const { p } of ranked) {
    const r = toRow(p);
    const n = enc.encode(JSON.stringify(r)).length + 1;
    if (bytes + n > maxBytes) break;
    out.push(r);
    bytes += n;
  }
  return JSON.stringify({ v: 1, p: out });
}

export function decodePois(json: string): Poi[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const w = Wire.safeParse(raw);
  if (!w.success) return [];
  const out: Poi[] = [];
  for (const r of w.data.p) {
    const row = RowZ.safeParse(r);
    if (!row.success) continue;
    const p = fromRow(row.data as Row);
    if (p) out.push(p);
  }
  return out;
}
