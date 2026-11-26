import { describe, expect, it } from 'vitest';
import { destination } from '../src/geo';
import { displayEtaS, ETA_REFRESH, etaStaleMs, headingToMe, planEtaRefresh, type EtaBase, type EtaPlanInput } from '../src/etaRefresh';

// Public landmark: Place Ville Marie, Montréal.
const ME = { lat: 45.5017, lng: -73.5673 };
const at = (km: number) => destination(ME, 90, km * 1000);

const base = (friend = at(5), t = 0, etaS = 600): EtaBase => ({ at: t, etaS, straightM: 5000, me: ME, friend });

const plan = (o: Partial<EtaPlanInput>): string[] =>
  planEtaRefresh({ now: 10 * 60_000, view: 'map', me: ME, mySpd: 0, friends: [], base: new Map(), lastCallAt: 0, ...o });

describe('etaStaleMs', () => {
  it('never re-queries when both are still', () => {
    expect(etaStaleMs(5000, false, false, 'map')).toBe(Infinity);
  });
  it('scales with distance, clamped', () => {
    expect(etaStaleMs(500, true, false, 'map')).toBe(ETA_REFRESH.minStaleMs);
    expect(etaStaleMs(10_000, false, true, 'map')).toBe(5 * 60_000);
    expect(etaStaleMs(500_000, true, true, 'map')).toBe(ETA_REFRESH.maxStaleMs);
  });
  it('overlay is slower', () => {
    expect(etaStaleMs(500, true, false, 'overlay')).toBe(ETA_REFRESH.overlayMinStaleMs);
    expect(etaStaleMs(10_000, true, false, 'overlay')).toBe(10 * 60_000);
  });
});

describe('planEtaRefresh', () => {
  const f = { id: 'a', pos: at(5), spd: 0, shown: true };
  it('nothing when off', () => {
    expect(plan({ view: 'off', friends: [f] })).toEqual([]);
  });
  it('first sight queries', () => {
    expect(plan({ friends: [f] })).toEqual(['a']);
  });
  it('both still: keeps the old answer forever', () => {
    expect(plan({ now: 10 * 3600_000, friends: [f], base: new Map([['a', base()]]) })).toEqual([]);
  });
  it('friend driving: due after distance-scaled staleness', () => {
    const b = new Map([['a', base()]]);
    const drv = { ...f, spd: 15 };
    expect(plan({ now: 60_000, friends: [drv], base: b })).toEqual([]);
    expect(plan({ now: 151_000, friends: [drv], base: b })).toEqual(['a']);
  });
  it('movement beyond the threshold queries', () => {
    expect(plan({ friends: [{ ...f, pos: at(6) }], base: new Map([['a', base(at(5), 9 * 60_000)]]) })).toEqual(['a']);
  });
  it('skips friends whose nav ETA is to me', () => {
    expect(plan({ friends: [{ ...f, navEtaToMe: 1 }] })).toEqual([]);
  });
  it('overlay: only shown friends', () => {
    expect(plan({ view: 'overlay', friends: [f, { ...f, id: 'b', shown: false }] })).toEqual(['a']);
  });
  it('rate-limits batches unless a moving friend card is focused', () => {
    const b = new Map([['a', base(at(5), 9.5 * 60_000)]]);
    const drv = { ...f, spd: 15 };
    expect(plan({ friends: [{ ...f, id: 'n' }], lastCallAt: 10 * 60_000 - 5000 })).toEqual([]);
    expect(plan({ friends: [drv], base: b, focusId: 'a', lastCallAt: 10 * 60_000 - 5000 })).toEqual(['a']);
    expect(plan({ friends: [f], base: b, focusId: 'a' })).toEqual([]);
  });
});

describe('displayEtaS', () => {
  it('uses nav ETA when heading to me', () => {
    expect(displayEtaS(undefined, ME, at(1), 1000, 61_000)).toBe(60);
  });
  it('dead-reckons by straight-line change × routed factor', () => {
    expect(displayEtaS(base(), ME, at(5), 0)).toBe(600);
    expect(displayEtaS(base(), ME, at(2.5), 0)).toBe(300);
    expect(displayEtaS(base(), ME, ME, 0)).toBe(0);
  });
  it('null without a base', () => {
    expect(displayEtaS(undefined, ME, at(1), 0)).toBeNull();
  });
});

it('headingToMe', () => {
  expect(headingToMe(at(0.1), ME)).toBe(true);
  expect(headingToMe(at(1), ME)).toBe(false);
  expect(headingToMe(null, ME)).toBe(false);
});
