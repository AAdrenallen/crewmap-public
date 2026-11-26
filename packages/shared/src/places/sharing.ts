import { placeForWire, type Place, type WirePlace } from './core';

/** The part of a crew's shared doc map that place sharing touches (a Y.Map fits). */
export interface PlaceMapLike {
  get(id: string): unknown;
  set(id: string, p: WirePlace): unknown;
  delete(id: string): unknown;
  has(id: string): boolean;
}

export interface CrewPlaceTarget {
  id: string;
  /** The crew's "Places & arrivals" policy (D26): the master switch. */
  allowsPlaces: boolean;
  places: PlaceMapLike;
}

/** A place reaches a crew only if both the place and the crew's policy allow it. */
export function placeAllowedIn(p: Place, crew: { id: string; allowsPlaces: boolean }): boolean {
  return crew.allowsPlaces && p.sharedWith.includes(crew.id);
}

/**
 * Sender-side enforcement: write `p` (without `sharedWith`) into the docs of crews it may reach and delete it from
 * every other crew's doc. Unchanged entries are not rewritten (no needless CRDT updates). Returns the crews written.
 */
export function applyPlaceSharing(p: Place, crews: readonly CrewPlaceTarget[]): string[] {
  const out: string[] = [];
  const wire = placeForWire(p);
  const json = JSON.stringify(wire);
  for (const c of crews) {
    if (placeAllowedIn(p, c)) {
      if (JSON.stringify(c.places.get(p.id)) !== json) c.places.set(p.id, wire);
      out.push(c.id);
    } else if (c.places.has(p.id)) c.places.delete(p.id);
  }
  return out;
}

/** Crews that may carry an arrival/leave about `placeId` to `to`: the place is in that crew's doc, policy allows it. */
export function arrivalCrews(placeId: string, to: string, crews: readonly (CrewPlaceTarget & { isMember(id: string): boolean })[]): string[] {
  return crews.filter((c) => c.allowsPlaces && c.places.has(placeId) && c.isMember(to)).map((c) => c.id);
}
