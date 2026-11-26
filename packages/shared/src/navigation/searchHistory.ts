/** A searched / starred destination. */
export interface SavedPlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export const RECENT_MAX = 15;

const same = (a: SavedPlace, b: SavedPlace): boolean => a.id === b.id || (a.name === b.name && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4);

/** Most-recent-first list with duplicates collapsed, capped at `max`. */
export function pushRecent(list: readonly SavedPlace[], p: SavedPlace, max = RECENT_MAX): SavedPlace[] {
  return [p, ...list.filter((x) => !same(x, p))].slice(0, max);
}

export function removePlace(list: readonly SavedPlace[], p: SavedPlace): SavedPlace[] {
  return list.filter((x) => !same(x, p));
}

export function hasPlace(list: readonly SavedPlace[], p: SavedPlace): boolean {
  return list.some((x) => same(x, p));
}

/** Add when absent, remove when present. */
export function toggleFavourite(list: readonly SavedPlace[], p: SavedPlace): SavedPlace[] {
  return hasPlace(list, p) ? removePlace(list, p) : [p, ...list];
}

/** Stored value to a clean list (drops malformed entries). */
export function normalizePlaces(v: unknown): SavedPlace[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is SavedPlace => !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.address === 'string' && Number.isFinite(x.lat) && Number.isFinite(x.lng));
}

/** Keeps only the newest response: `next()` issues a ticket, `isCurrent(ticket)` is false once a newer one was issued. */
export class RequestSeq {
  private n = 0;
  next(): number {
    return ++this.n;
  }
  isCurrent(ticket: number): boolean {
    return ticket === this.n;
  }
  /** Invalidate everything in flight. */
  cancel(): void {
    this.n++;
  }
}
