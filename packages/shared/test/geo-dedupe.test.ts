import { describe, expect, it } from 'vitest';
import { dedupeNearby } from '../src/geo';

describe('dedupeNearby', () => {
  it('drops same-name hits at the same spot, keeps distinct ones', () => {
    const r = dedupeNearby([
      { name: 'Megastore', lat: 45.6519, lng: -74.3369 },
      { name: 'MEGASTORE ', lat: 45.6520, lng: -74.3370 },
      { name: 'Megastore Sans fil', lat: 45.6519, lng: -74.3369 },
      { name: 'Megastore', lat: 45.78, lng: -74.0 },
      { name: 'Érable', lat: 1, lng: 1 },
      { name: 'erable', lat: 1, lng: 1 },
    ]);
    expect(r.map((x) => x.name)).toEqual(['Megastore', 'Megastore Sans fil', 'Megastore', 'Érable']);
  });
});
