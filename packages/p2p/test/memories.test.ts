import { describe, expect, it } from 'vitest';
import { generateIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { openJson, sealJson } from '../src/companions';
import { CAPS, LOCAL_CAP_MASK, PROTOCOL_VERSION } from '../src/protocol';
import { KINDS } from '../src/router';
import { LruBlobStore, hashBytes, splitBlob, type Kv } from '../src/quips';
import { DEFAULT_SHARING, normalizePolicy, type SharingPolicy } from '../src/sharing';
import {
  MEMORY_KINDS,
  MEMORY_LIMITS,
  MemoryChannel,
  memoryKindAllowed,
  parsePhoto,
  parsePost,
  parseReact,
  postFor,
  type LocalMemory,
  type MemoryBus,
  type MemoryKind,
  type ParsedPost,
  type PhotoWire,
  type ReactWire,
} from '../src/memories';

const REACTIONS = ['❤️', '🔥'];
const T0 = Date.UTC(2026, 6, 4, 14, 0);
const local: LocalMemory = {
  mid: 'o-trip1',
  window: [T0, T0 + 3600_000],
  title: 'Mont Royal loop',
  route: Array.from({ length: 400 }, (_, i) => ({ t: T0 + i * 9000, lat: 45.5075 - i * 0.00001, lng: -73.5524 - i * 0.0001 })),
  km: 23.46,
  min: 61.2,
  topKph: 88.4,
};

class MemKv implements Kv {
  m = new Map<string, unknown>();
  async get<T>(k: string, f: T): Promise<T> {
    return (this.m.has(k) ? JSON.parse(JSON.stringify(this.m.get(k))) : f) as T;
  }
  async set(k: string, v: unknown): Promise<void> {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
}
const memStore = () => {
  const files = new Map<string, Uint8Array>();
  return new LruBlobStore({ read: async (h) => files.get(h) ?? null, write: async (h, b) => void files.set(h, b), remove: async (h) => void files.delete(h) }, new MemKv(), Date.now, 10_000_000, 'memories.blobs');
};

/** In-memory sealed bus: each payload is box-sealed to its recipient and opened by them, as in the app. */
class Hub {
  peers = new Map<string, { me: DeviceIdentity; handlers: Map<MemoryKind, Set<(from: string, v: unknown) => void>> }>();
  policy: (from: string, to: string) => SharingPolicy = () => DEFAULT_SHARING;
  /** Reorder: deliver chunks before manifests. */
  chunksFirst = false;
  queue: (() => void)[] = [];

  join(me: DeviceIdentity): MemoryBus {
    const handlers = new Map<MemoryKind, Set<(from: string, v: unknown) => void>>();
    this.peers.set(me.deviceId, { me, handlers });
    return {
      send: async (to, kind, build) => {
        const peer = this.peers.get(to);
        const v = build(this.policy(me.deviceId, to));
        if (!peer || v === null || v === undefined) return false;
        const sealed = sealJson(peer.me.boxPk, v);
        const deliver = () => {
          for (const h of peer.handlers.get(kind) ?? []) h(me.deviceId, openJson(peer.me, sealed));
        };
        if (this.chunksFirst && kind === 'memory-photo') this.queue.push(deliver);
        else deliver();
        return true;
      },
      on: (kind, h) => {
        const s = handlers.get(kind) ?? handlers.set(kind, new Set()).get(kind)!;
        s.add(h);
        return () => s.delete(h);
      },
    };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function pair() {
  const hub = new Hub();
  const a = generateIdentity();
  const b = generateIdentity();
  const got = { posts: [] as ParsedPost[], photos: [] as PhotoWire[], gone: [] as PhotoWire[], reacts: [] as ReactWire[] };
  const storeB = memStore();
  const chanA = new MemoryChannel({ bus: hub.join(a), store: memStore(), reactions: REACTIONS, onPost: () => undefined, onPhoto: () => undefined, onPhotoGone: () => undefined, onReact: () => undefined, now: () => T0 + 1000 });
  const chanB = new MemoryChannel({
    bus: hub.join(b),
    store: storeB,
    reactions: REACTIONS,
    onPost: (_f, p) => got.posts.push(p),
    onPhoto: (_f, p) => got.photos.push(p),
    onPhotoGone: (_f, p) => got.gone.push(p),
    onReact: (_f, r) => got.reacts.push(r),
    now: () => T0 + 1000,
  });
  chanA.start();
  chanB.start();
  return { hub, a, b, chanA, chanB, got, storeB };
}

const jpeg = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);

describe('memory wire', () => {
  it('advertises the capability and router kinds', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
    expect(LOCAL_CAP_MASK & CAPS.memories).toBeTruthy();
    for (const k of MEMORY_KINDS) expect(KINDS[k].ttlS).toBe(MEMORY_LIMITS.relayTtlS);
  });

  it('narrows the post by the recipient policy', () => {
    const full = postFor(local, DEFAULT_SHARING)!;
    expect(full.route!.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxRoutePts + 1);
    expect(full).toMatchObject({ km: 23.5, min: 61, topKph: 88, title: 'Mont Royal loop' });
    const approx = postFor(local, normalizePolicy({ location: 'approx' }))!;
    expect(approx.route).toBeUndefined();
    expect(postFor(local, normalizePolicy({ stats: false }))!.topKph).toBeUndefined();
    expect(postFor(local, normalizePolicy({ speed: false }))!.topKph).toBeUndefined();
    expect(postFor(local, normalizePolicy({ trips: false }))).toBeNull();
    expect(memoryKindAllowed('memory', normalizePolicy({ trips: false }))).toBe(false);
    expect(memoryKindAllowed('memory-photo', normalizePolicy({ emotes: false }))).toBe(false);
    expect(memoryKindAllowed('memory-react', DEFAULT_SHARING)).toBe(true);
  });

  it('parses defensively', () => {
    const p = parsePost(postFor(local, DEFAULT_SHARING))!;
    expect(p.route![0]!.t).toBe(Math.round(T0 / 1000) * 1000);
    expect(parsePost({ v: 1, mid: 'x', w: [2, 1] })).toBeNull();
    expect(parsePost({ v: 1, mid: 'bad id!', w: [1, 2] })).toBeNull();
    expect(parsePost({ v: 1, mid: 'x', w: [1, 2], km: -1, topKph: 9999, route: [[200, 0, 1], [1, 1, 1]] })).toEqual({ mid: 'x', window: [1, 2] });
    const ok = { v: 1, mid: 'x', w: [1, 2], h: 'a'.repeat(32), n: 1000, pw: 1200, ph: 900, at: T0, exp: T0 + 10 * 86_400_000 };
    expect(parsePhoto(ok, T0)).toMatchObject({ n: 1000 });
    expect(parsePhoto({ ...ok, n: MEMORY_LIMITS.maxPhotoBytes + 1 }, T0)).toBeNull();
    expect(parsePhoto({ ...ok, pw: 5000 }, T0)).toBeNull();
    expect(parsePhoto(ok, T0 + 11 * 86_400_000)).toBeNull();
    expect(parsePhoto({ ...ok, exp: T0 + 9999 * 86_400_000 }, T0)!.exp).toBe(T0 + MEMORY_LIMITS.maxKeepDays * 86_400_000);
    expect(parseReact({ v: 1, mid: 'x', w: [1, 2], target: 'memory', e: '🔥', on: true, at: 1 }, REACTIONS)).not.toBeNull();
    expect(parseReact({ v: 1, mid: 'x', w: [1, 2], target: 'memory', e: '💩', on: true, at: 1 }, REACTIONS)).toBeNull();
    expect(parseReact({ v: 1, mid: 'x', w: [1, 2], target: 'nope', e: '🔥', on: true, at: 1 }, REACTIONS)).toBeNull();
  });
});

describe('MemoryChannel', () => {
  it('delivers a sealed post, photo and reaction', async () => {
    const { b, chanA, got, storeB } = pair();
    expect(await chanA.share([b.deviceId], local)).toBe(1);
    const bytes = jpeg(50_000);
    const r = await chanA.sendPhoto([b.deviceId], { mid: local.mid, window: local.window }, bytes, { pw: 1200, ph: 900, cap: 'Lookout', at: T0, exp: T0 + 90 * 86_400_000 });
    expect(r).toEqual({ ok: true, sent: 1 });
    await chanA.react([b.deviceId], { mid: local.mid, window: local.window }, 'memory', '🔥', true);
    await tick();
    expect(got.posts[0]).toMatchObject({ mid: 'o-trip1', title: 'Mont Royal loop' });
    expect(got.photos).toHaveLength(1);
    expect(got.photos[0]).toMatchObject({ cap: 'Lookout', h: hashBytes(bytes) });
    expect(await storeB.get(hashBytes(bytes))).toEqual(bytes);
    expect(got.reacts[0]).toMatchObject({ target: 'memory', e: '🔥', on: true });
  });

  it('sends nothing the policy forbids', async () => {
    const { hub, b, chanA, got } = pair();
    hub.policy = () => normalizePolicy({ trips: false, emotes: false });
    expect(await chanA.share([b.deviceId], local)).toBe(0);
    const r = await chanA.sendPhoto([b.deviceId], { mid: local.mid, window: local.window }, jpeg(1000), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 });
    expect(r).toEqual({ ok: true, sent: 0 });
    await tick();
    expect(got.posts).toHaveLength(0);
    expect(got.photos).toHaveLength(0);
  });

  it('refuses oversized photos and limits photos per member per memory', async () => {
    const { b, chanA, chanB, got } = pair();
    const ref = { mid: local.mid, window: local.window };
    expect(await chanA.sendPhoto([b.deviceId], ref, jpeg(MEMORY_LIMITS.maxPhotoBytes + 1), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 })).toEqual({ ok: false, reason: 'tooBig' });
    expect(await chanA.sendPhoto([], ref, jpeg(10), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 })).toEqual({ ok: false, reason: 'nobody' });
    void chanB;
    for (let i = 0; i < MEMORY_LIMITS.photosPerMin; i++) await chanA.sendPhoto([b.deviceId], ref, jpeg(100 + i), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 });
    expect((await chanA.sendPhoto([b.deviceId], ref, jpeg(999), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 })).ok).toBe(false);
    await tick();
    expect(got.photos.length).toBeLessThanOrEqual(MEMORY_LIMITS.photosPerMemberPerMemory);
  });

  it('chunks that overtake their manifest are held, then released', async () => {
    const { hub, b, chanA, got } = pair();
    hub.chunksFirst = true;
    const bytes = jpeg(40_000);
    await chanA.sendPhoto([b.deviceId], { mid: local.mid, window: local.window }, bytes, { pw: 800, ph: 600, at: T0, exp: T0 + 86_400_000 });
    await tick();
    expect(got.photos).toHaveLength(0);
    for (const d of hub.queue) d();
    await tick();
    expect(got.photos).toHaveLength(1);
  });

  it('a corrupted blob is never released, a withdrawal is', async () => {
    const { b, a, hub, got } = pair();
    const bus = hub.join(a); // a second handle for the same sender, to send raw wires
    const bytes = jpeg(20_000);
    const h = hashBytes(bytes);
    await bus.send(b.deviceId, 'memory-photo', () => ({ v: 1, mid: 'o-x', w: [T0, T0 + 1], h, n: bytes.length, pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 }));
    const chunks = splitBlob(bytes, h);
    chunks[0]!.d = chunks[1]!.d;
    for (const c of chunks) await bus.send(b.deviceId, 'memory-blob', () => c);
    await tick();
    expect(got.photos).toHaveLength(0);
    await bus.send(b.deviceId, 'memory-photo', () => ({ v: 1, mid: 'o-x', w: [T0, T0 + 1], h, del: true, at: T0 }));
    await tick();
    expect(got.gone).toHaveLength(1);
  });
});

describe('memory hardening', () => {
  it('a withdrawn photo cannot be replayed back in', async () => {
    const { a, b, hub, got } = pair();
    const bus = hub.join(a);
    const bytes = jpeg(5_000);
    const h = hashBytes(bytes);
    const man = { v: 1, mid: 'o-y', w: [T0, T0 + 1], h, n: bytes.length, pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 };
    await bus.send(b.deviceId, 'memory-photo', () => ({ v: 1, mid: 'o-y', w: [T0, T0 + 1], h, del: true, at: T0 }));
    await bus.send(b.deviceId, 'memory-photo', () => man);
    for (const c of splitBlob(bytes, h)) await bus.send(b.deviceId, 'memory-blob', () => c);
    await tick();
    expect(got.photos).toHaveLength(0);
  });

  it('caps a claimed expiry and ignores a future timestamp', () => {
    const w = { v: 1, mid: 'o-z', w: [T0, T0 + 1], h: 'a'.repeat(32), n: 10, pw: 10, ph: 10 };
    const p = parsePhoto({ ...w, at: T0 + 10 * 365 * 86_400_000, exp: T0 + 20 * 365 * 86_400_000 }, T0)!;
    expect(p.at).toBe(T0);
    expect(p.exp).toBe(T0 + MEMORY_LIMITS.maxKeepDays * 86_400_000);
    expect(parsePhoto({ ...w, at: T0, exp: T0 - 1 }, T0)).toBeNull();
  });

  it('a removed member (no longer sendable) and an outsider get and can read nothing', async () => {
    const hub = new Hub();
    const a = generateIdentity();
    const member = generateIdentity();
    const removed = generateIdentity();
    const outsider = generateIdentity();
    const seen: string[] = [];
    const wire = (me: DeviceIdentity, name: string) => {
      const bus = hub.join(me);
      const ch = new MemoryChannel({ bus, store: memStore(), reactions: REACTIONS, onPost: () => seen.push(name), onPhoto: () => seen.push(name), onPhotoGone: () => undefined, onReact: () => seen.push(name), now: () => T0 + 1000 });
      ch.start();
      return { bus, ch };
    };
    const sender = wire(a, 'a');
    wire(member, 'member');
    wire(removed, 'removed');
    wire(outsider, 'outsider');
    // The app's companionSend returns false for a device that left the circle; model it by not addressing them.
    const crew = new Set([member.deviceId]);
    const gated: MemoryBus = { ...sender.bus, send: async (to, k, b) => (crew.has(to) ? sender.bus.send(to, k, b) : false) };
    const ch = new MemoryChannel({ bus: gated, store: memStore(), reactions: REACTIONS, onPost: () => undefined, onPhoto: () => undefined, onPhotoGone: () => undefined, onReact: () => undefined, now: () => T0 + 1000 });
    expect(await ch.share([member.deviceId, removed.deviceId, outsider.deviceId], local)).toBe(1);
    expect((await ch.sendPhoto([member.deviceId, removed.deviceId], { mid: local.mid, window: local.window }, jpeg(3000), { pw: 10, ph: 10, at: T0, exp: T0 + 86_400_000 }))).toEqual({ ok: true, sent: 1 });
    await tick();
    expect(seen).toEqual(['member', 'member']);
    // Even a captured sealed payload is useless to anyone but its recipient.
    const sealed = sealJson(member.boxPk, { v: 1, mid: 'o-q' });
    expect(openJson(outsider, sealed)).toBeNull();
    expect(openJson(removed, sealed)).toBeNull();
  });
});
