import * as Y from 'yjs';
import { normalizeAvatar, normalizeCar } from '@crewmap/shared/avatar';
import type { FriendReport } from '@crewmap/hazards';
import type { SignedHazardConfig } from '@crewmap/hazards';
import { placeForWire, placeFromWire, type ArrivalSubscription, type Place, type WirePlace } from '@crewmap/shared/places';
import type { Profile } from './store';

/**
 * Typed access to the circle's CRDT document. Only shared data lives here: profiles, shared places, friend reports,
 * stats summaries the owner allowed, arrival subscriptions, and owner-signed config. Private places never do.
 */
export class CircleDoc {
  readonly doc = new Y.Doc();
  readonly profiles = this.doc.getMap<Profile>('profiles');
  readonly places = this.doc.getMap<WirePlace>('places');
  readonly reports = this.doc.getMap<FriendReport>('reports');
  readonly subscriptions = this.doc.getMap<ArrivalSubscription>('subscriptions');
  readonly config = this.doc.getMap<SignedHazardConfig>('config');

  setProfile(p: Profile): void {
    this.profiles.set(p.deviceId, p);
  }

  profile(id: string): Profile | null {
    const p = this.profiles.get(id);
    if (!p) return null;
    return { ...p, avatar: normalizeAvatar(p.avatar), car: normalizeCar(p.car) };
  }

  /** Places in this crew doc (normalized: friends may run older versions). */
  sharedPlaces(): Place[] {
    return [...this.places.values()].filter((p) => p.visibility !== 'private').map(placeFromWire);
  }

  /** Writes the wire form (no `sharedWith`). Per-crew sharing is decided by the caller (`applyPlaceSharing`). */
  putPlace(p: Place): void {
    this.places.set(p.id, placeForWire(p));
  }

  removePlace(id: string): void {
    this.places.delete(id);
  }

  allReports(): FriendReport[] {
    return [...this.reports.values()];
  }

  /** Drop reports past their life (keeps the doc small). */
  pruneReports(isAlive: (r: FriendReport) => boolean): void {
    this.doc.transact(() => {
      for (const [id, r] of this.reports) if (!isAlive(r)) this.reports.delete(id);
    });
  }

  onChange(cb: () => void): () => void {
    const h = () => cb();
    this.doc.on('update', h);
    return () => this.doc.off('update', h);
  }
}
