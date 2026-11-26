import { describe, expect, it } from 'vitest';
import { foldText, normalizePlace, placeForWire, placeFromWire, searchPlaces, validPlaceName, type Place } from '../src/places';

const mk = (name: string, type: Place['type'], id = name): Place => normalizePlace({ id, owner: 'me', name, type, lat: 0, lng: 0, sharedWith: [] });

describe('place search', () => {
  const places = [mk('Maison de Maman', 'family'), mk('Montée Est chalet', 'home2'), mk('Office', 'work'), mk('Home', 'home'), mk('Gym Nord', 'gym'), mk('Épicerie', 'shop')];
  const names = (q: string) => searchPlaces(q, places).map((p) => p.name);

  it('matches name prefix, word prefix and substring, accent/case-insensitive', () => {
    expect(names('mai')[0]).toBe('Maison de Maman');
    expect(names('est')).toContain('Montée Est chalet');
    expect(names('MONTEE')).toEqual(['Montée Est chalet']);
    expect(names('epic')).toEqual(['Épicerie']);
    expect(names('nord')).toEqual(['Gym Nord']);
    expect(names('ffic')).toEqual(['Office']);
  });
  it('matches type names in en, fr and ru', () => {
    expect(names('wo')).toEqual(['Office']);
    expect(names('travail')).toEqual(['Office']);
    expect(names('maison')).toEqual(['Maison de Maman', 'Home']);
    expect(names('дом')).toEqual(expect.arrayContaining(['Home', 'Montée Est chalet']));
  });
  it('ranks name hits above type hits and ignores empty queries', () => {
    expect(names('ho')).toEqual(['Home', 'Montée Est chalet']);
    expect(names('  ')).toEqual([]);
    expect(names('zz')).toEqual([]);
  });
  it('folds text', () => expect(foldText(' Été’S ')).toBe("ete's"));
});

describe('place model', () => {
  it('migrates legacy places without data loss', () => {
    const shared = normalizePlace(
      { id: 'a', owner: 'me', name: 'A very long legacy name that exceeds forty chars', icon: 'food', color: '#123456', lat: 1, lng: 2, radiusM: 300, visibility: 'shared', createdAt: 5 },
      ['c1', 'c2'],
    );
    expect(shared).toMatchObject({ type: 'restaurant', color: '#123456', radiusM: 300, sharedWith: ['c1', 'c2'], visibility: 'shared', createdAt: 5 });
    expect(shared.name.length).toBeGreaterThan(40);
    const priv = normalizePlace({ id: 'b', owner: 'me', name: 'B', icon: 'home', lat: 0, lng: 0, visibility: 'private' }, ['c1']);
    expect(priv).toMatchObject({ type: 'home', sharedWith: [], visibility: 'private' });
  });
  it('keeps sharedWith off the wire and reads friends places as shared', () => {
    const p = normalizePlace({ id: 'a', owner: 'me', name: 'Work', type: 'work', lat: 0, lng: 0, sharedWith: ['c1', 'secret-crew'] });
    const wire = placeForWire(p);
    expect('sharedWith' in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain('secret-crew');
    expect(placeFromWire(wire)).toMatchObject({ type: 'work', visibility: 'shared', sharedWith: [] });
  });
  it('validates names', () => {
    expect(validPlaceName('  ')).toBe(false);
    expect(validPlaceName('x'.repeat(40))).toBe(true);
    expect(validPlaceName('x'.repeat(41))).toBe(false);
  });
});
