import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import sodiumImpl from 'libsodium-wrappers-sumo';
import {
  CircleAdmin,
  generateIdentity,
  initSodium,
  publicIdentity,
  replay,
  Router,
  utf8,
  fromUtf8,
  type RelayPool,
  type Sodium,
} from '@crewmap/p2p';

const PORT = 17447;
const URL_ = `ws://127.0.0.1:${PORT}`;
let proc: ChildProcess;

beforeAll(async () => {
  await initSodium(sodiumImpl as unknown as Sodium);
  const server = fileURLToPath(new URL('../src/server.ts', import.meta.url));
  proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', server], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [chunk] = (await once(proc.stdout!, 'data')) as [Buffer];
  expect(chunk.toString()).toMatch(/listening/);
});

afterAll(() => {
  proc?.kill();
});

describe('X7 central-PC relay', () => {
  it('serves NIP-11 and /health', async () => {
    const info = await fetch(`http://127.0.0.1:${PORT}`, { headers: { accept: 'application/nostr+json' } }).then((r) => r.json() as Promise<{ supported_nips: number[]; ok: boolean }>);
    expect(info.supported_nips).toContain(40);
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json() as Promise<{ supported_nips: number[]; ok: boolean }>);
    expect(health.ok).toBe(true);
  });

  it('rejects non-CrewMap kinds and durable events without expiration', async () => {
    const pool = new SimplePool();
    const sk = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const bad = finalizeEvent({ kind: 1, created_at: now, tags: [], content: 'hello' }, sk);
    await expect(Promise.any(pool.publish([URL_], bad))).rejects.toBeTruthy();
    const noExp = finalizeEvent({ kind: 1420, created_at: now, tags: [], content: 'x' }, sk);
    await expect(Promise.any(pool.publish([URL_], noExp))).rejects.toBeTruthy();
    pool.destroy();
  });

  it('the app routes every function through the relay when configured, and only through it', async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const admin = new CircleAdmin(a);
    let log = admin.create('Crew', 'A', Date.now());
    log = [...log, ...admin.add(replay(log, a), publicIdentity(b), 'B', Date.now())];
    const relayOnly = { presence: 'relay', emotes: 'relay', arrivals: 'relay', sync: 'relay', chores: 'relay', wake: 'relay' } as const;
    const mk = (id: typeof a) => {
      const pool = new SimplePool();
      const published: string[] = [];
      const wrapped: RelayPool = {
        publish: (relays, ev) => {
          published.push(...relays);
          return pool.publish(relays, ev as never);
        },
        subscribe: (relays, filter, params) => pool.subscribe(relays, filter as never, params as never),
      };
      const st = replay(log, id);
      const r = new Router({ self: id, circle: () => st, pool: wrapped, publicRelays: ['wss://must-not-be-used.invalid'], pcRelays: [URL_], config: { ...relayOnly } });
      return { r, pool, published };
    };
    const A = mk(a);
    const B = mk(b);
    const got: string[] = [];
    B.r.on('emote', (m) => got.push(fromUtf8(m.payload)));
    const delivered = new Promise<boolean>((res) => A.r.onDelivery((d) => res(d.ok)));
    A.r.start(Math.floor(Date.now() / 1000) - 60);
    B.r.start(Math.floor(Date.now() / 1000) - 60);
    await new Promise((r) => setTimeout(r, 300));
    await A.r.sendTo(b.deviceId, 'emote', utf8('Honk honk'));
    expect(await delivered).toBe(true);
    expect(got).toEqual(['Honk honk']);
    expect(new Set([...A.published, ...B.published])).toEqual(new Set([URL_]));
    A.r.stop();
    B.r.stop();
    A.pool.destroy();
    B.pool.destroy();
  });
});
