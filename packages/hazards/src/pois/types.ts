/** Map points that are not hazards (D64): fuel stations, EV chargers, MTMD traffic cameras. */
export type PoiKind = 'fuel' | 'charging' | 'trafficCamera';
export type PoiSourceId = 'regie' | 'osm-poi' | 'mtmd-cam' | 'ocm' | 'crew';
export type FuelGrade = 'regular' | 'premium' | 'diesel';
export const FUEL_GRADES: readonly FuelGrade[] = ['regular', 'premium', 'diesel'];

export interface FuelPrice {
  /** Price in tenths of a cent per litre (166.4 ¢/L → 1664), integer so shared payloads stay small. */
  c10: number;
  /** When the source published this price (epoch ms). Régie: the feed's generation time, i.e. "as of", not "changed at". */
  at: number;
  source: PoiSourceId;
}

export interface Poi {
  /** `${source}:${sourceId}` */
  id: string;
  kind: PoiKind;
  source: PoiSourceId;
  lat: number;
  lng: number;
  name: string | null;
  brand?: string;
  address?: string;
  /** Fuel stations: latest known price per grade. A grade the station lists as unavailable is absent. */
  prices?: Partial<Record<FuelGrade, FuelPrice>>;
  /** Grades the station sells per OSM tags, when no price is known. */
  grades?: FuelGrade[];
  /** Chargers: socket count and max power (kW) if known. */
  sockets?: number;
  maxKw?: number;
  /** Traffic camera: official viewer page (opened in the browser, never hot-linked). */
  url?: string;
  /** Per-record data-provider credit and licence (Open Charge Map), shown on the sheet. */
  credit?: string;
  /** When this record was fetched or published (epoch ms). */
  at: number;
  /** Other sources merged into this point. */
  alsoFrom?: PoiSourceId[];
}

/** Attribution shown on the POI sheet and in Help → licences. */
export const POI_ATTRIBUTION: Record<PoiSourceId, string> = {
  regie: 'Régie de l’énergie du Québec — Régie essence Québec',
  'osm-poi': '© OpenStreetMap contributors, ODbL',
  'mtmd-cam': 'Gouvernement du Québec (MTMD), CC-BY 4.0',
  ocm: 'Open Charge Map contributors (open-licence records)',
  crew: 'Crew',
};
