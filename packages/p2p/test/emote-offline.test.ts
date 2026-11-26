import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity } from '../src/crypto/identity';
import { fromUtf8, utf8 } from '../src/crypto/sodium';
import { Router, type Incoming } from '../src/router';
import { TestNet, tick } from './net';

describe('emotes while the recipient is offline', () => {
  it('are stored on the relay for 72 h and all arrive (rapid repeats included) when the friend comes back', async () => {
    const net = new TestNet();
    const [a, b] = [generateIdentity(), generateIdentity()];
    const admin = new CircleAdmin(a);
    let log: CircleOp[] = admin.create('Crew', 'A', Date.now());
    log = [...log, ...admin.add(replay(log, a), publicIdentity(b), 'B', Date.now())];
    const mk = (id: typeof a) => {
      const st = replay(log, id);
      const pool = net.pool(id.deviceId);
      const router = new Router({ self: id, circle: () => st, pool, publicRelays: ['wss://t'], retryMs: [50, 100] });
      router.start(Math.floor(Date.now() / 1000) - 60);
      return { router, pool };
    };
    net.online.set(b.deviceId, false);
    const pa = mk(a);
    const pb = mk(b);
    const got: Incoming[] = [];
    pb.router.on('emote', (m) => got.push(m));
    for (let i = 0; i < 14; i++) await pa.router.sendTo(b.deviceId, 'emote', utf8(JSON.stringify({ preset: 'honkHonk', k: `k${i}` })));
    await tick();
    expect(got).toHaveLength(0);
    const exp = net.published.find((e) => e.tags.some((t) => t[0] === 'expiration'))!.tags.find((t) => t[0] === 'expiration')![1]!;
    expect(Number(exp) - Math.floor(Date.now() / 1000)).toBeGreaterThan(71 * 3600);

    net.online.set(b.deviceId, true);
    pb.pool.reconnect();
    await tick();
    expect(got.length).toBe(14);
    expect(new Set(got.map((m) => (JSON.parse(fromUtf8(m.payload)) as { k: string }).k)).size).toBe(14);
    pa.router.stop();
    pb.router.stop();
  });
});
