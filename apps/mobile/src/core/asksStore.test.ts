import { describe, expect, it } from 'vitest';
import type { AskEntry } from '@crewmap/shared/companions';
import { withOnceShares } from './asksStore';
import type { FriendView } from './store';

const NOW = 5_000_000;
const view = (presence: FriendView['presence']): FriendView => ({
  profile: { deviceId: 'bob', name: 'Bob' } as FriendView['profile'],
  presence,
  paused: false,
  etaS: null,
  routeM: null,
  isOwner: false,
  crews: ['c'],
});
const shared = (until: number): AskEntry => ({ id: 'a', dir: 'out', peer: 'bob', ask: 'once', state: 'shared', t: NOW - 1000, until, loc: { lat: 45.5, lng: -73.6, acc: 9, t: NOW - 500 } });

describe('one-time share overlay', () => {
  it('a crewmate who shares nothing shows at the shared spot with a badge', () => {
    const out = withOnceShares({ bob: view(null) }, [shared(NOW + 600_000)], NOW);
    expect(out.bob!.presence).toMatchObject({ lat: 45.5, lng: -73.6, prec: 'p' });
    expect(out.bob!.once).toEqual({ until: NOW + 600_000 });
  });
  it('an expired share is never applied', () => {
    const all = { bob: view(null) };
    expect(withOnceShares(all, [shared(NOW)], NOW)).toBe(all);
  });
  it('a fresher precise crew position wins and gets no badge; a coarse one is replaced', () => {
    const base = { lat: 1, lng: 2, acc: 5, spd: null, hdg: null, act: 'still', bat: 50, chg: false, deviceId: 'bob', receivedAt: NOW, via: 'nostr' } as const;
    const fresh = withOnceShares({ bob: view({ ...base, t: NOW, prec: 'p' }) }, [shared(NOW + 1000)], NOW);
    expect(fresh.bob!.once).toBeUndefined();
    const coarse = withOnceShares({ bob: view({ ...base, t: NOW, prec: 'c' }) }, [shared(NOW + 1000)], NOW);
    expect(coarse.bob!.presence).toMatchObject({ lat: 45.5, prec: 'p', bat: 50 });
    expect(coarse.bob!.once).toBeDefined();
  });
});
