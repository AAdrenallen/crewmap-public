import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE_OPTIONS, directionsUrl, discoverRoutes, excludeList, normalizePlaces, normalizeRouteOptions, pushRecent, queryToRequest, RECENT_MAX, RequestSeq, toggleFavourite, type SavedPlace } from '../src/navigation';

const p = (id: string, lat = 45.5, lng = -73.5): SavedPlace => ({ id, name: `Place ${id}`, address: '', lat, lng });

describe('recent searches', () => {
  it('puts the newest first and collapses duplicates', () => {
    const l = pushRecent(pushRecent([], p('a')), p('b'));
    expect(pushRecent(l, p('a')).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('caps at 15', () => {
    let l: SavedPlace[] = [];
    for (let i = 0; i < 20; i++) l = pushRecent(l, p(String(i), 45 + i / 10));
    expect(l).toHaveLength(RECENT_MAX);
    expect(l[0]!.id).toBe('19');
  });
});

describe('favourites', () => {
  it('toggles', () => {
    const on = toggleFavourite([], p('a'));
    expect(on).toHaveLength(1);
    expect(toggleFavourite(on, p('a'))).toEqual([]);
  });
  it('drops malformed stored entries', () => {
    expect(normalizePlaces([p('a'), { id: 1 }, null])).toEqual([p('a')]);
    expect(normalizePlaces('x')).toEqual([]);
  });
});

describe('RequestSeq', () => {
  it('ignores out-of-order responses', () => {
    const s = new RequestSeq();
    const first = s.next();
    const second = s.next();
    expect(s.isCurrent(first)).toBe(false);
    expect(s.isCurrent(second)).toBe(true);
    s.cancel();
    expect(s.isCurrent(second)).toBe(false);
  });
});

describe('route options', () => {
  it('maps to Mapbox exclude', () => {
    expect(excludeList(DEFAULT_ROUTE_OPTIONS)).toEqual([]);
    expect(excludeList({ avoidTolls: true, avoidHighways: true, avoidFerries: true })).toEqual(['toll', 'motorway', 'ferry']);
    expect(normalizeRouteOptions({ avoidTolls: true, junk: 1 })).toEqual({ avoidTolls: true, avoidHighways: false, avoidFerries: false });
    expect(normalizeRouteOptions(null)).toEqual(DEFAULT_ROUTE_OPTIONS);
  });
  it('reaches the Directions URL for every discovery query', async () => {
    const seen: (string | undefined)[] = [];
    const from = { lat: 45.5, lng: -73.6 };
    const to = { lat: 45.6, lng: -73.5 };
    await discoverRoutes({ from, to, heading: null, learned: [], cachedVias: [], exclude: ['toll', 'ferry'] }, async (q) => {
      seen.push(new URL(directionsUrl(queryToRequest(q, 'en'), 'pk.x')).searchParams.get('exclude') ?? undefined);
      return [];
    }, null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x === 'toll,ferry')).toBe(true);
  });
});
