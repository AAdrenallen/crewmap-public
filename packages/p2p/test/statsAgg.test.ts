import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity } from '../src/crypto/identity';
import { unb64 } from '../src/crypto/sodium';
import { Router } from '../src/router';
import { parseStatsAgg, StatsAggChannel } from '../src/statsAgg';
import { CAPS, LOCAL_CAP_MASK, PROTOCOL_VERSION, type PeerProtocol } from '../src/protocol';
import type { AggSet } from '@crewmap/shared/stats';
import { TestNet, tick } from './net';

describe('parseStatsAgg', () => {
  it('keeps only whitelisted bounded numbers', () => {
    const r = parseStatsAgg({ a: { month: { k: 1000, drives: 3, drivenKm: 12.5, score: 88, lat: 45.5, route: [1, 2], places: -1, homeLeaves: 1.5 } } });
    expect(r).toEqual({ month: { k: 1000, drives: 3, drivenKm: 12.5, score: 88 } });
  });
  it('drops a period without a key and rejects junk', () => {
    expect(parseStatsAgg({ a: { week: { drives: 3 } } })).toBeNull();
    expect(parseStatsAgg(null)).toBeNull();
    expect(parseStatsAgg({ a: 'x' })).toBeNull();
    expect(parseStatsAgg({ a: { all: { k: 0, drivenKm: Infinity, score: null } } })).toEqual({ all: { k: 0, score: null } });
  });
  it('the protocol advertises the cap', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(9);
    expect(LOCAL_CAP_MASK & CAPS.statsAgg).toBeTruthy();
  });
});

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function setup(n: number, proto: (id: string) => PeerProtocol | null = () => ({ pv: PROTOCOL_VERSION, cp: LOCAL_CAP_MASK })) {
  const net = new TestNet();
  const { ids, log } = crew(n);
  const now = { t: Date.now() };
  const chans = ids.map((me) => {
    const st = replay(log, me);
    const router = new Router({ self: me, circle: () => st, pool: net.pool(me.deviceId), publicRelays: ['wss://t'] });
    router.start(Math.floor(Date.now() / 1000) - 60);
    const others = () => ids.filter((x) => x.deviceId !== me.deviceId).map((x) => x.deviceId);
    return new StatsAggChannel(router, me, others, (id) => unb64(st.members.get(id)!.boxPk), proto, () => now.t);
  });
  return { ids, chans, now };
}

describe('StatsAggChannel', () => {
  it('seals a different payload per recipient; each sees only its own', async () => {
    const { ids, chans } = setup(3);
    const got: Record<string, AggSet> = {};
    chans[1]!.onAgg((s, a) => (got.b = a));
    chans[2]!.onAgg((s, a) => (got.c = a));
    const b = ids[1]!.deviceId;
    chans[0]!.publish((peer) => (peer === b ? { month: { k: 1, drivenKm: 10, homeLeaves: 2 } } : { month: { k: 1, drivenKm: 10 } }));
    await tick();
    expect(got.b).toEqual({ month: { k: 1, drivenKm: 10, homeLeaves: 2 } });
    expect(got.c).toEqual({ month: { k: 1, drivenKm: 10 } });
  });

  it('a peer with stats off gets nothing; known old builds are skipped', async () => {
    const { ids, chans } = setup(3, (id) => (id === ids[2]!.deviceId ? { pv: 8, cp: LOCAL_CAP_MASK & ~CAPS.statsAgg } : { pv: PROTOCOL_VERSION, cp: LOCAL_CAP_MASK }));
    let b = 0;
    let c = 0;
    chans[1]!.onAgg(() => b++);
    chans[2]!.onAgg(() => c++);
    chans[0]!.publish((peer) => (peer === ids[1]!.deviceId ? null : { all: { k: 0, drives: 1 } }));
    await tick();
    expect(b).toBe(0);
    expect(c).toBe(0);
  });

  it('does not resend unchanged aggregates', async () => {
    const { chans, now } = setup(2);
    let n = 0;
    chans[1]!.onAgg(() => n++);
    const f = () => ({ all: { k: 0, drives: 2 } });
    chans[0]!.publish(f);
    await tick();
    now.t += 120_000;
    await chans[0]!.flush();
    await tick();
    expect(n).toBe(1);
    chans.forEach((c) => c.stop());
  });
});
