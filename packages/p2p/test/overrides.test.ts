import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { open } from '../src/crypto/envelope';
import { fromUtf8, unb64 } from '../src/crypto/sodium';
import { Router } from '../src/router';
import { PresenceBook, PresencePublisher, type Presence } from '../src/presence';
import { companionKindAllowed } from '../src/companions';
import { CAPS, LOCAL_CAP_MASK, PROTOCOL_VERSION } from '../src/protocol';
import {
  DEFAULT_SHARING,
  cleanOverride,
  migrateCrewStorage,
  migrateSharingGlobals,
  normalizePolicy,
  planPresence,
  profileForPolicy,
  resolveShare,
  splitLegacySharing,
  SHARING_STORAGE_VER,
  type SharingPolicy,
} from '../src/sharing';
import { TestNet, tick } from './net';

const here: Presence = { lat: 45.508888, lng: -73.561668, acc: 5, spd: 22.2, hdg: 45, act: 'automotive', bat: 64, chg: true, t: Date.now(), prec: 'p', eta: 987654321 };

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function phone(net: TestNet, id: DeviceIdentity, log: CircleOp[]) {
  const st = replay(log, id);
  const router = new Router({ self: id, circle: () => st, pool: net.pool(id.deviceId), publicRelays: ['wss://t'], retryMs: [50, 100] });
  router.start(Math.floor(Date.now() / 1000) - 60);
  return { id, st, router };
}

describe('per-friend overrides: resolution (D52)', () => {
  it('override ?? crew policy', () => {
    const crewPol: SharingPolicy = { ...DEFAULT_SHARING, location: 'city', battery: false };
    expect(resolveShare(crewPol, null)).toBe(crewPol);
    const r = resolveShare(crewPol, { location: 'exact', speed: false });
    expect(r.location).toBe('exact');
    expect(r.speed).toBe(false);
    expect(r.battery).toBe(false);
    expect(r.stats).toBe(crewPol.stats);
  });
  it('cleanOverride drops unset fields; empty = crew default', () => {
    expect(cleanOverride({})).toBeNull();
    expect(cleanOverride({ location: undefined, battery: true })).toEqual({ battery: true });
  });
  it('drive-along: override wins, else exact location only', () => {
    const city = { ...DEFAULT_SHARING, location: 'city' as const };
    expect(companionKindAllowed('drive-along', city)).toBe(false);
    expect(companionKindAllowed('drive-along', resolveShare(city, { driveAlong: true }))).toBe(true);
    expect(companionKindAllowed('presence-live', resolveShare(DEFAULT_SHARING, { driveAlong: false }))).toBe(false);
  });
});

describe('per-recipient presence planning (D52)', () => {
  const m = ['a', 'b', 'c'];
  it('no overrides: exactly the crew policy, no tiers (one broadcast)', () => {
    const plan = planPresence(m, DEFAULT_SHARING, {});
    expect(plan.tiers).toEqual([]);
    expect(plan.base).toEqual({ location: 'exact', speed: true, battery: true });
    // An override equal to the crew policy changes nothing either.
    expect(planPresence(m, DEFAULT_SHARING, { a: { location: 'exact' } }).tiers).toEqual([]);
  });
  it('a grant adds one tier for that friend only', () => {
    const plan = planPresence(m, { ...DEFAULT_SHARING, location: 'city' }, { b: { location: 'exact' } });
    expect(plan.base.location).toBe('city');
    expect(plan.tiers).toEqual([{ key: 'exact|1|1', view: { location: 'exact', speed: true, battery: true }, members: ['b'] }]);
  });
  it('a restriction lowers the broadcast and lifts everyone else into one tier', () => {
    const plan = planPresence(m, DEFAULT_SHARING, { a: { location: 'hidden', battery: false } });
    expect(plan.base).toEqual({ location: 'hidden', speed: true, battery: false });
    expect(plan.tiers).toHaveLength(1);
    expect(plan.tiers[0]!.members).toEqual(['b', 'c']);
  });
  it('older builds (no tier support) stay on the broadcast and are never offered more than the crew', () => {
    const plan = planPresence(m, { ...DEFAULT_SHARING, location: 'approx' }, { a: { location: 'exact' } }, (id) => id !== 'a');
    expect(plan.tiers).toEqual([]);
    expect(plan.base.location).toBe('approx');
    // A restriction on an older build still holds (it only reads the broadcast).
    const r = planPresence(m, DEFAULT_SHARING, { a: { location: 'city' } }, (id) => id !== 'a');
    expect(r.base.location).toBe('city');
    expect(r.tiers[0]!.members).toEqual(['b', 'c']);
  });
});

describe('per-friend overrides on the wire (3 peers)', () => {
  it('grant: only the granted friend can read exact; others stay at the crew level', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [me, granted, other] = ids.map((id) => phone(net, id, log));
    const pks = new Map([granted!, other!].map((x) => [x.id.deviceId, x.id.boxPk]));
    const pub = new PresencePublisher(me!.router, () => [granted!.id.deviceId, other!.id.deviceId]);
    const bookG = new PresenceBook(granted!.router, granted!.id);
    const bookO = new PresenceBook(other!.router, other!.id);
    const s = { ghost: false, policy: { ...DEFAULT_SHARING, location: 'city' as const }, overrides: { [granted!.id.deviceId]: { location: 'exact' as const } }, boxPkOf: (id: string) => pks.get(id) ?? null };
    await pub.publish(here, s);
    await tick();
    await pub.publish({ ...here, t: here.t + 1 }, s);
    await tick();
    expect(bookG.get(me!.id.deviceId)!.prec).toBe('p');
    expect(bookG.get(me!.id.deviceId)!.lat).toBeCloseTo(here.lat, 6);
    expect(bookO.get(me!.id.deviceId)!.prec).toBe('c');
    // Everything a crew member can open with the epoch key holds no exact position: the tier key is box-sealed.
    const crewReadable = net.published.flatMap((ev) => {
      try {
        return [fromUtf8(open(other!.st, unb64(ev.content)).payload)];
      } catch {
        return [];
      }
    });
    expect(crewReadable.join('\n')).not.toContain('45.508888');
  });

  it('restrict: the restricted friend sees no position or battery, the rest see everything', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [me, limited, full] = ids.map((id) => phone(net, id, log));
    const pks = new Map([limited!, full!].map((x) => [x.id.deviceId, x.id.boxPk]));
    const pub = new PresencePublisher(me!.router, () => [limited!.id.deviceId, full!.id.deviceId]);
    const bookL = new PresenceBook(limited!.router, limited!.id);
    const bookF = new PresenceBook(full!.router, full!.id);
    const s = { ghost: false, policy: DEFAULT_SHARING, overrides: { [limited!.id.deviceId]: { location: 'hidden' as const, battery: false } }, boxPkOf: (id: string) => pks.get(id) ?? null };
    await pub.publish(here, s);
    await tick();
    expect(bookL.get(me!.id.deviceId)).toBeNull();
    expect(bookL.isPaused(me!.id.deviceId)).toBe(true);
    const f = bookF.get(me!.id.deviceId)!;
    expect(f.prec).toBe('p');
    expect(f.bat).toBe(64);
    expect(bookF.isPaused(me!.id.deviceId)).toBe(false);
  });

  it('broadcast and tier of one fix merge instead of the later one wiping fields', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [me, a, b] = ids.map((id) => phone(net, id, log));
    const pks = new Map([a!, b!].map((x) => [x.id.deviceId, x.id.boxPk]));
    const pub = new PresencePublisher(me!.router, () => [a!.id.deviceId, b!.id.deviceId]);
    const bookA = new PresenceBook(a!.router, a!.id);
    // Same precision in both, only battery differs: base (no battery) and tier (battery) carry the same t / prec.
    await pub.publish(here, { ghost: false, policy: { ...DEFAULT_SHARING, battery: false }, overrides: { [a!.id.deviceId]: { battery: true } }, boxPkOf: (id) => pks.get(id) ?? null });
    await tick();
    expect(bookA.get(me!.id.deviceId)!.bat).toBe(64);
  });
});

describe('global sharing settings migration (D52)', () => {
  const legacy = { statsVisibility: { score: false, distance: true, topSpeed: true, events: false, trips: false, places: false, streaks: true, badges: true }, precision: { f1: 'approx' as const, f2: 'precise' as const } };

  it('old global stats visibility becomes each crew default; precise=false becomes a location override', () => {
    const v2 = migrateCrewStorage({ circleId: 'c1' }, null);
    const st = migrateSharingGlobals({ ...v2, circles: ['c1', 'c2'], sharing: { ...v2.sharing, c2: { ...DEFAULT_SHARING, statsVis: { ...DEFAULT_SHARING.statsVis, score: true } } } }, legacy);
    expect(st.ver).toBe(SHARING_STORAGE_VER);
    expect(st.sharing.c1!.statsVis.score).toBe(false);
    expect(st.sharing.c1!.statsVis.topSpeed).toBe(true);
    expect(st.sharing.c1!.trips).toBe(false);
    // c2 had an explicit per-crew value: kept.
    expect(st.sharing.c2!.statsVis.score).toBe(true);
    expect(st.sharing.c2!.trips).toBe(true);
    expect(st.overrides).toEqual({ f1: { location: 'approx', speed: false } });
  });

  it('runs once (version flag), and without legacy values keeps the defaults', () => {
    const once = migrateSharingGlobals({ circles: ['c'], invites: {}, sharing: { c: DEFAULT_SHARING } }, legacy);
    expect(migrateSharingGlobals(once, { statsVisibility: { ...legacy.statsVisibility, score: true } })).toBe(once);
    const none = migrateSharingGlobals(migrateCrewStorage({ circleId: 'c' }, null), null);
    expect(none.sharing.c).toEqual(normalizePolicy(null));
  });

  it('splits the legacy keys off persisted settings', () => {
    const { settings, legacy: l } = splitLegacySharing({ ghost: true, ...legacy });
    expect(settings).toEqual({ ghost: true });
    expect(l).toEqual(legacy);
    expect(splitLegacySharing({ ghost: false }).legacy).toBeNull();
  });

  it('per-crew stats visibility narrows the profile', () => {
    const profile = { deviceId: 'x', stats: { week: { period: 'week' as const, updatedAt: 1, avgScore: 80, topSpeedKph: 140, trips: 3 } } };
    const pol = normalizePolicy({ statsVis: { ...DEFAULT_SHARING.statsVis, score: false, topSpeed: false } });
    const w = profileForPolicy(profile, pol).stats!.week!;
    expect(w.avgScore).toBeUndefined();
    expect(w.topSpeedKph).toBeUndefined();
    expect(w.trips).toBe(3);
  });
});

describe('protocol 8', () => {
  it('advertises per-friend sharing', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(8);
    expect(LOCAL_CAP_MASK & CAPS.userShare).toBe(CAPS.userShare);
  });
});
