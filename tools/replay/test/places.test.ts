import { describe, expect, it } from 'vitest';
import { destination } from '@crewmap/shared/geo';
import { ArrivalDetector, ProximityMoments, subscribersFor, type Place } from '@crewmap/shared/places';
import { straight, PLACES, T0 } from '../src/fixtures';
import { synthesize, mulberry32 } from '../src/synth';

const work: Place = { id: 'work', owner: 'alex', name: 'Work', type: 'work', icon: 'work', sharedWith: ['c1'], color: '#5B6CFF', ...PLACES.work, radiusM: 150, visibility: 'shared', createdAt: 0 };
const friendHome: Place = { id: 'home-sam', owner: 'sam', name: 'Home', type: 'home', icon: 'home', sharedWith: [], color: '#FF6B6B', ...PLACES.friendHome, radiusM: 120, visibility: 'shared', createdAt: 0 };

describe('F6 arrival / leave notifications (replay)', () => {
  it('arriving at a saved place → one arrive; leaving → one leave; no flapping at the edge', () => {
    // Drive in from 3 km south, park inside, sit 20 min with GPS jitter, walk out 400 m.
    const approach = straight(destination(PLACES.work, 180, 3000), 0, 3000, 25);
    const d = synthesize({
      path: approach,
      startAt: T0,
      phases: [
        { kind: 'ramp', toKph: 50, mps2: 2 },
        { kind: 'cruise', seconds: 200, kph: 50 },
        { kind: 'ramp', toKph: 0, mps2: 2 },
        { kind: 'stop', seconds: 1200 },
      ],
      jitterM: 25,
    });
    const det = new ArrivalDetector([work]);
    const events = d.locations.flatMap((l) => det.onFix({ ...l }));
    expect(events.map((e) => e.kind)).toEqual(['arrive']);

    // Edge jitter: hovering ±60 m around the radius for 10 min must not flap.
    const rnd = mulberry32(11);
    const t1 = d.locations[d.locations.length - 1]!.t;
    const edge = Array.from({ length: 600 }, (_, i) => {
      const p = destination(PLACES.work, 90, work.radiusM + (rnd() - 0.5) * 120);
      return det.onFix({ ...p, t: t1 + (i + 1) * 1000, accuracy: 15 });
    }).flat();
    expect(edge).toEqual([]);

    // Walk away 400 m.
    const out = straight(PLACES.work, 90, 400, 5);
    const leave = out.flatMap((p, i) => det.onFix({ ...p, t: t1 + 700_000 + i * 4000, accuracy: 10 }));
    const after = Array.from({ length: 60 }, (_, i) => det.onFix({ ...out[out.length - 1]!, t: t1 + 1_000_000 + i * 2000, accuracy: 10 })).flat();
    expect([...leave, ...after].map((e) => e.kind)).toEqual(['leave']);
  });

  it('a drive-by through the radius does not count as arriving', () => {
    const path = straight(destination(PLACES.work, 270, 1500), 90, 3000, 20);
    const d = synthesize({ path, startAt: T0, phases: [{ kind: 'ramp', toKph: 60, mps2: 3 }, { kind: 'cruise', seconds: 170, kph: 60 }] });
    const det = new ArrivalDetector([work]);
    expect(d.locations.flatMap((l) => det.onFix(l))).toEqual([]);
  });

  it('routes events only to subscribers of that friend + place + kind', () => {
    const subs = [
      { id: 's1', subscriber: 'me', target: 'alex', placeId: 'work', arrive: true, leave: false },
      { id: 's2', subscriber: 'kim', target: 'alex', placeId: 'work', arrive: true, leave: true },
      { id: 's3', subscriber: 'me', target: 'sam', placeId: 'work', arrive: true, leave: true },
    ];
    expect(subscribersFor(subs, 'alex', { placeId: 'work', kind: 'arrive', t: 0 }).sort()).toEqual(['kim', 'me']);
    expect(subscribersFor(subs, 'alex', { placeId: 'work', kind: 'leave', t: 0 })).toEqual(['kim']);
  });
});

describe('F4b proximity moments (replay)', () => {
  it("pop-up once when driving past a friend's shared Home, never my own, debounced", () => {
    const path = straight(destination(PLACES.friendHome, 0, 2000), 180, 4000, 20);
    const d = synthesize({ path, startAt: T0, phases: [{ kind: 'ramp', toKph: 70, mps2: 3 }, { kind: 'cruise', seconds: 200, kph: 70 }] });
    const pm = new ProximityMoments();
    const mine: Place = { ...friendHome, id: 'mine', owner: 'me' };
    const moments = d.locations.flatMap((l) => pm.passPlaces('me', l, [friendHome, mine]));
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ kind: 'passPlace', placeId: 'home-sam', owner: 'sam' });
    // Driving back 10 min later: debounced.
    const back = d.locations.map((l) => ({ ...l, t: l.t + 600_000 })).reverse();
    expect(back.flatMap((l) => pm.passPlaces('me', l, [friendHome]))).toHaveLength(0);
  });

  it('two friends converging trigger one "nearby" moment; re-arms only after they separate', () => {
    const pm = new ProximityMoments({ friendsNearM: 500 });
    const a0 = destination(PLACES.valClair, 270, 3000);
    const b0 = destination(PLACES.valClair, 90, 3000);
    const out = [];
    for (let i = 0; i <= 60; i++) {
      const t = T0 + i * 10_000;
      const a = destination(a0, 90, i * 50);
      const b = destination(b0, 270, i * 50);
      out.push(...pm.friendsNear([{ id: 'alex', ...a }, { id: 'sam', ...b }, { id: 'kim', lat: 46.5, lng: -75 }], t));
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'friendsNear', a: 'alex', b: 'sam' });
    expect((out[0] as { distanceM: number }).distanceM).toBeLessThanOrEqual(500);
  });
});
