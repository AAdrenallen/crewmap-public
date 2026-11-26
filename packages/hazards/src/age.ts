import type { LatLng } from '@crewmap/shared/geo';
import type { MergedHazard } from './merge';
import { incidentsAlong } from './route';
import type { HazardType } from './types';

export type AgeUnit = 'now' | 'min' | 'h' | 'd';

/** Age of a hazard as a unit + count; the UI formats it through i18n (no unit text here). */
export function hazardAge(h: Pick<MergedHazard, 'latestReportAt'>, now: number): { unit: AgeUnit; n: number } {
  const s = Math.max(0, (now - h.latestReportAt) / 1000);
  if (s < 60) return { unit: 'now', n: 0 };
  if (s < 3600) return { unit: 'min', n: Math.round(s / 60) };
  if (s < 86_400) return { unit: 'h', n: Math.round(s / 3600) };
  return { unit: 'd', n: Math.round(s / 86_400) };
}

export interface RouteHazardRow {
  id: string;
  type: HazardType;
  /** Distance from the route start (m). */
  alongM: number;
  age: { unit: AgeUnit; n: number };
}

/** Hazards lying on a route (all types, line hazards included), sorted along the route, for the preview list. */
export function routeHazardRows(geometry: LatLng[], hazards: MergedHazard[], now: number): RouteHazardRow[] {
  return incidentsAlong(geometry, hazards).items.map((i) => ({ id: i.hazard.id, type: i.hazard.type, alongM: i.alongM, age: hazardAge(i.hazard, now) }));
}
