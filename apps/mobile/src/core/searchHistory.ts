import { normalizePlaces, pushRecent, removePlace, toggleFavourite, type SavedPlace } from '@crewmap/shared/navigation';
import { kvGet, kvSet } from './db';

const RECENT_KEY = 'search:recent';
const FAV_KEY = 'search:favourites';

/** Recent searches and starred results. Device-local (kv), never shared with the crew. */
export async function loadRecent(): Promise<SavedPlace[]> {
  return normalizePlaces(await kvGet<unknown>(RECENT_KEY, []));
}

export async function loadFavourites(): Promise<SavedPlace[]> {
  return normalizePlaces(await kvGet<unknown>(FAV_KEY, []));
}

/** Record a chosen destination (newest first, last 15, de-duplicated). Returns the new list. */
export async function addRecent(p: SavedPlace): Promise<SavedPlace[]> {
  const next = pushRecent(await loadRecent(), p);
  await kvSet(RECENT_KEY, next);
  return next;
}

export async function removeRecent(p: SavedPlace): Promise<SavedPlace[]> {
  const next = removePlace(await loadRecent(), p);
  await kvSet(RECENT_KEY, next);
  return next;
}

export async function clearRecent(): Promise<SavedPlace[]> {
  await kvSet(RECENT_KEY, []);
  return [];
}

/** Star / unstar a result. Returns the new list. */
export async function toggleFav(p: SavedPlace): Promise<SavedPlace[]> {
  const next = toggleFavourite(await loadFavourites(), p);
  await kvSet(FAV_KEY, next);
  return next;
}
