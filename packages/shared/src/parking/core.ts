import { bearingDeg, haversineM, type LatLng } from '../geo';
import type { Place } from '../places/core';
import type { ParkingContext } from './context';
import { PARKING, RESIDENTIAL_BUILDINGS, STREET_HIGHWAYS, type ParkingThresholds } from './thresholds';

/**
 * "Where did I park" (D67): when a drive ends, remember where the car is so it can be found later. Pure logic; the
 * app feeds it the trip detector's trips, the OSM context around the spot and the user's fixes. The spot is private:
 * it lives on the phone only and is never written to a crew doc or presence (shared only by an explicit tap).
 */

export type ParkingKind = 'street' | 'lot' | 'unknown';
export type SkipReason = 'home' | 'driveway' | 'private' | 'passenger';

export interface ParkedSpot {
  tripId: string;
  lat: number;
  lng: number;
  /** Car heading when it stopped (deg from north), null when unknown. */
  heading: number | null;
  /** When the car stopped (epoch ms). */
  at: number;
  kind: ParkingKind;
  /** Street (or lot) name from OSM, null when unknown. */
  street: string | null;
  note: string;
}

/** The part of a finished trip that places the car. */
export interface ParkTrip {
  id: string;
  endedAt: number;
  passenger: boolean;
  points: readonly { t: number; lat: number; lng: number; speed: number; heading: number | null }[];
}

export interface ParkCandidate {
  tripId: string;
  lat: number;
  lng: number;
  heading: number | null;
  at: number;
}

/**
 * Where the car stopped: the trip's last point (the detector keeps up to the first stopped fix), heading from the
 * last moving fix, or the bearing of the final metres when the fixes carry none. Null for passenger trips.
 */
export function parkCandidate(trip: ParkTrip): ParkCandidate | null {
  if (trip.passenger || trip.points.length === 0) return null;
  const last = trip.points[trip.points.length - 1]!;
  let heading: number | null = null;
  for (let i = trip.points.length - 1; i >= 0; i--) {
    const p = trip.points[i]!;
    if (p.heading !== null && Number.isFinite(p.heading) && p.speed >= 1.5) {
      heading = p.heading;
      break;
    }
  }
  if (heading === null) {
    for (let i = trip.points.length - 2; i >= 0; i--) {
      if (haversineM(trip.points[i]!, last) >= 5) {
        heading = Math.round(bearingDeg(trip.points[i]!, last));
        break;
      }
    }
  }
  return { tripId: trip.id, lat: last.lat, lng: last.lng, heading, at: trip.endedAt };
}

export type ParkDecision = { save: true; kind: ParkingKind; street: string | null } | { save: false; reason: SkipReason };

const isDriveway = (r: ParkingContext['roads'][number]) =>
  r.highway === 'service' && (r.service === 'driveway' || r.access === 'private' || r.access === 'no');
const isStreet = (r: ParkingContext['roads'][number]) =>
  STREET_HIGHWAYS.includes(r.highway) && !isDriveway(r) && r.service !== 'parking_aisle';

/**
 * Save or skip. Skipped: own Home / second home (radius + margin), a driveway or private service way nearer than any
 * street, a house right there with no street, a private lot by a house. Saved: inside / at a parking area (lot), next
 * to a street (street), anything else when OSM has nothing to say (unknown: better a spot too many than a lost car).
 */
export function classifyParking(
  c: LatLng,
  places: readonly Pick<Place, 'type' | 'lat' | 'lng' | 'radiusM'>[],
  ctx: ParkingContext | null,
  th: ParkingThresholds = PARKING,
): ParkDecision {
  for (const p of places)
    if (th.skipPlaceTypes.includes(p.type) && haversineM(c, p) <= p.radiusM + th.placeMarginM) return { save: false, reason: 'home' };
  if (!ctx) return { save: true, kind: 'unknown', street: null };
  const street = ctx.roads.find(isStreet) ?? null;
  const namedStreet = ctx.roads.find((r) => isStreet(r) && r.name !== null)?.name ?? null;
  const streetM = street?.distM ?? Infinity;
  const house = ctx.buildings.find((b) => RESIDENTIAL_BUILDINGS.includes(b.building)) ?? null;
  const houseNear = house !== null && house.distM <= th.houseNearM;
  const lot = ctx.lots.find((l) => l.inside || l.distM <= th.lotNearM) ?? null;
  if (lot) {
    if (lot.access === 'private' && houseNear) return { save: false, reason: 'private' };
    return { save: true, kind: 'lot', street: lot.name ?? namedStreet };
  }
  const driveway = ctx.roads.find(isDriveway) ?? null;
  if (driveway && driveway.distM <= th.drivewayMaxM && driveway.distM < streetM) return { save: false, reason: 'driveway' };
  if (streetM <= th.streetMaxM) return { save: true, kind: 'street', street: street?.name ?? namedStreet };
  if (houseNear || house?.inside) return { save: false, reason: 'private' };
  return { save: true, kind: street ? 'street' : 'unknown', street: namedStreet };
}

export function makeSpot(c: ParkCandidate, d: Extract<ParkDecision, { save: true }>): ParkedSpot {
  return { tripId: c.tripId, lat: c.lat, lng: c.lng, heading: c.heading, at: c.at, kind: d.kind, street: d.street, note: '' };
}

/** Note text as stored: one line, trimmed, capped. */
export function cleanNote(text: string, th: ParkingThresholds = PARKING): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, th.noteMax);
}

/** Past the user's "forget after" (hours; 0 = never by time). */
export function spotExpired(s: ParkedSpot, now: number, forgetAfterH: number): boolean {
  return forgetAfterH > 0 && now - s.at >= forgetAfterH * 3600_000;
}

/** A drive that starts by the car means the car left: the spot is cleared. */
export function droveAway(s: ParkedSpot, start: LatLng, th: ParkingThresholds = PARKING): boolean {
  return haversineM(s, start) <= th.driveAwayM;
}

/** First time the user is `walkAwayM` from the car soon after parking: time for the "Parked on …" notice. */
export function walkedAway(s: ParkedSpot, fix: LatLng & { t: number }, th: ParkingThresholds = PARKING): boolean {
  return fix.t - s.at <= th.walkAwayWindowMs && haversineM(s, fix) >= th.walkAwayM;
}

export function reachedCar(s: ParkedSpot, fix: LatLng, th: ParkingThresholds = PARKING): boolean {
  return haversineM(s, fix) <= th.arrivedM;
}

/** Session state the app persists on the phone. */
export interface ParkingState {
  spot: ParkedSpot | null;
  /** The walk-away notice for the current spot was shown. */
  noticed: boolean;
}

export const NO_PARKING: ParkingState = { spot: null, noticed: false };

export type ParkingInput =
  | { type: 'tripStarted'; t: number; lat: number; lng: number }
  | { type: 'parked'; candidate: ParkCandidate; decision: ParkDecision }
  | { type: 'fix'; t: number; lat: number; lng: number }
  | { type: 'tick'; now: number; forgetAfterH: number }
  | { type: 'note'; text: string }
  | { type: 'forget' };

export type ParkingEffect = { type: 'saved'; spot: ParkedSpot } | { type: 'skipped'; reason: SkipReason } | { type: 'cleared'; why: 'droveAway' | 'expired' | 'forgot' } | { type: 'walkedAway'; spot: ParkedSpot };

/** One step of the parking session: deterministic, so the replay harness drives the same code as the phone. */
export function parkingStep(
  st: ParkingState,
  input: ParkingInput,
  th: ParkingThresholds = PARKING,
): { state: ParkingState; effects: ParkingEffect[] } {
  switch (input.type) {
    case 'tripStarted':
      if (st.spot && droveAway(st.spot, input, th)) return { state: NO_PARKING, effects: [{ type: 'cleared', why: 'droveAway' }] };
      return { state: st, effects: [] };
    case 'parked': {
      const d = input.decision;
      if (!d.save) return { state: st, effects: [{ type: 'skipped', reason: d.reason }] };
      const spot = makeSpot(input.candidate, d);
      return { state: { spot, noticed: false }, effects: [{ type: 'saved', spot }] };
    }
    case 'fix':
      if (!st.spot || st.noticed || !walkedAway(st.spot, input, th)) return { state: st, effects: [] };
      return { state: { ...st, noticed: true }, effects: [{ type: 'walkedAway', spot: st.spot }] };
    case 'tick':
      if (st.spot && spotExpired(st.spot, input.now, input.forgetAfterH)) return { state: NO_PARKING, effects: [{ type: 'cleared', why: 'expired' }] };
      return { state: st, effects: [] };
    case 'note':
      if (!st.spot) return { state: st, effects: [] };
      return { state: { ...st, spot: { ...st.spot, note: cleanNote(input.text, th) } }, effects: [] };
    case 'forget':
      return st.spot ? { state: NO_PARKING, effects: [{ type: 'cleared', why: 'forgot' }] } : { state: st, effects: [] };
  }
}

/** Restores a persisted state; anything malformed is dropped (never a crash on a bad kv value). */
export function readParkingState(raw: unknown): ParkingState {
  const r = raw as { spot?: Partial<ParkedSpot> | null; noticed?: unknown } | null;
  const s = r?.spot;
  if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number' || typeof s.at !== 'number' || !Number.isFinite(s.lat) || !Number.isFinite(s.lng))
    return NO_PARKING;
  const kind: ParkingKind = s.kind === 'street' || s.kind === 'lot' ? s.kind : 'unknown';
  return {
    spot: {
      tripId: typeof s.tripId === 'string' ? s.tripId : '',
      lat: s.lat,
      lng: s.lng,
      heading: typeof s.heading === 'number' && Number.isFinite(s.heading) ? s.heading : null,
      at: s.at,
      kind,
      street: typeof s.street === 'string' ? s.street : null,
      note: typeof s.note === 'string' ? cleanNote(s.note) : '',
    },
    noticed: r.noticed === true,
  };
}
