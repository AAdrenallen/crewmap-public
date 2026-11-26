import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity } from '../src/crypto/identity';
import { Router } from '../src/router';
import { ViewerDemand, WATCH_TTL_MS } from '../src/demand';
import { CAPS, LOCAL_CAP_MASK, PROTOCOL_VERSION, type PeerProtocol } from '../src/protocol';
import { TestNet, tick } from './net';

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function setup(protoOfPeer: PeerProtocol | null = { pv: PROTOCOL_VERSION, cp: LOCAL_CAP_MASK }) {
  const net = new TestNet();
  const { ids, log } = crew(2);
  let now = Date.now();
  const mk = (i: number) => {
    const st = replay(log, ids[i]!);
    const router = new Router({ self: ids[i]!, circle: () => st, pool: net.pool(ids[i]!.deviceId), publicRelays: ['wss://t'] });
    router.start(Math.floor(Date.now() / 1000) - 60);
    const other = ids[1 - i]!.deviceId;
    return new ViewerDemand(router, () => [other], () => protoOfPeer, () => now);
  };
  return { sender: mk(0), viewer: mk(1), advance: (ms: number) => (now += ms) };
}

describe('viewer demand', () => {
  it('is unwatched until a viewer opens the app, fires once on demand, and expires after the TTL', async () => {
    const { sender, viewer, advance } = setup();
    const demanded: string[] = [];
    sender.onDemand((v) => demanded.push(v));
    expect(sender.watched()).toBe(false);
    viewer.setForeground(true);
    await tick();
    expect(sender.watched()).toBe(true);
    expect(demanded).toHaveLength(1);
    advance(WATCH_TTL_MS + 1);
    expect(sender.watched()).toBe(false);
    viewer.stop();
  });

  it('closing the app stops demand at once', async () => {
    const { sender, viewer } = setup();
    viewer.setForeground(true);
    await tick();
    viewer.setForeground(false);
    await tick();
    expect(sender.watched()).toBe(false);
  });

  it('a peer on an older build (no viewerDemand cap) always counts as watching', () => {
    const { sender } = setup({ pv: 3, cp: LOCAL_CAP_MASK & ~CAPS.viewerDemand });
    expect(sender.watched()).toBe(true);
  });

  it('a peer never heard from does not hold the fast cadence', () => {
    expect(setup(null).sender.watched()).toBe(false);
  });
});
