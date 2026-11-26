import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyPlaceSharing, arrivalCrews, normalizePlace, type WirePlace } from '@crewmap/shared/places';

/** Two crews' Yjs docs; what a member of each crew receives is the encoded doc state. */
function crews(policy: { a: boolean; b: boolean }) {
  const docs = { a: new Y.Doc(), b: new Y.Doc() };
  const targets = [
    { id: 'a', allowsPlaces: policy.a, places: docs.a.getMap<WirePlace>('places'), isMember: (id: string) => id === 'alex' },
    { id: 'b', allowsPlaces: policy.b, places: docs.b.getMap<WirePlace>('places'), isMember: (id: string) => id === 'sam' || id === 'alex' },
  ];
  /** What a remote peer decodes from the outgoing update. */
  const received = (k: 'a' | 'b') => {
    const peer = new Y.Doc();
    const update = Y.encodeStateAsUpdate(docs[k]);
    Y.applyUpdate(peer, update);
    return { places: [...peer.getMap<WirePlace>('places').values()], bytes: new TextDecoder().decode(update) };
  };
  return { docs, targets, received };
}

const place = (sharedWith: string[]) => normalizePlace({ id: 'p1', owner: 'me', name: 'Clinique Secrète', type: 'other', lat: 45.1, lng: -74.6, sharedWith });

describe('per-place, per-crew sharing (sender side)', () => {
  it('an unshared place never reaches a crew', () => {
    const c = crews({ a: true, b: true });
    expect(applyPlaceSharing(place(['a']), c.targets)).toEqual(['a']);
    expect(c.received('a').places.map((p) => p.name)).toEqual(['Clinique Secrète']);
    expect(c.received('b').places).toEqual([]);
    expect(c.received('b').bytes).not.toContain('Clinique');
  });
  it('the crew policy is the master switch', () => {
    const c = crews({ a: true, b: false });
    expect(applyPlaceSharing(place(['a', 'b']), c.targets)).toEqual(['a']);
    expect(c.received('b').places).toEqual([]);
  });
  it('un-sharing removes the place from that crew doc', () => {
    const c = crews({ a: true, b: true });
    applyPlaceSharing(place(['a', 'b']), c.targets);
    expect(c.received('b').places).toHaveLength(1);
    applyPlaceSharing(place(['a']), c.targets);
    expect(c.received('b').places).toEqual([]);
    expect(c.received('a').places).toHaveLength(1);
  });
  it('never writes sharedWith (our other crew ids) into a doc', () => {
    const c = crews({ a: true, b: true });
    applyPlaceSharing(place(['a', 'b']), c.targets);
    for (const k of ['a', 'b'] as const) {
      expect(c.received(k).places[0]).not.toHaveProperty('sharedWith');
      expect(c.received(k).bytes).not.toContain('sharedWith');
    }
  });
  it('does not rewrite an unchanged place', () => {
    const c = crews({ a: true, b: true });
    applyPlaceSharing(place(['a']), c.targets);
    const sv = Y.encodeStateVector(c.docs.a);
    applyPlaceSharing(place(['a']), c.targets);
    expect(Y.encodeStateVector(c.docs.a)).toEqual(sv);
  });
  it('arrivals go only through crews the place is shared with', () => {
    const c = crews({ a: true, b: true });
    applyPlaceSharing(place(['a']), c.targets);
    expect(arrivalCrews('p1', 'alex', c.targets)).toEqual(['a']);
    expect(arrivalCrews('p1', 'sam', c.targets)).toEqual([]);
    const off = crews({ a: false, b: true });
    applyPlaceSharing(place(['a', 'b']), off.targets);
    expect(arrivalCrews('p1', 'alex', off.targets)).toEqual(['b']);
  });
});
