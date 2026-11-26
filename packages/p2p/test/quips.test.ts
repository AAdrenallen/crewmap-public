import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { b64 } from '../src/crypto/sodium';
import { protocolStamp } from '../src/protocol';
import {
  BlobIndex,
  LruBlobStore,
  QUIP_LIMITS,
  QuipBook,
  QuipService,
  Reassembler,
  hashBytes,
  quipId,
  splitBlob,
  validateQuip,
  type Kv,
  type QuipBlobRef,
  type QuipMeta,
  type ReceivedQuip,
} from '../src/quips';
import { Router } from '../src/router';
import { TestNet, tick } from './net';

const bytesOf = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + (i >> 8)) & 255);
const refOf = (b: Uint8Array, mime: string, ms?: number): QuipBlobRef => ({ h: hashBytes(b), n: b.length, mime, ...(ms ? { ms } : {}) });

class MemKv implements Kv {
  m = new Map<string, unknown>();
  async get<T>(k: string, f: T): Promise<T> {
    return (this.m.has(k) ? JSON.parse(JSON.stringify(this.m.get(k))) : f) as T;
  }
  async set(k: string, v: unknown): Promise<void> {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
}
const memStore = (cap?: number, now: () => number = Date.now) => {
  const files = new Map<string, Uint8Array>();
  const store = new LruBlobStore(
    { read: async (h) => files.get(h) ?? null, write: async (h, b) => void files.set(h, b), remove: async (h) => void files.delete(h) },
    new MemKv(),
    now,
    cap,
  );
  return { store, files };
};

describe('quip model', () => {
  it('validates limits and content id follows content', () => {
    const a = bytesOf(1000);
    const ok: QuipMeta = { cap: 'Floor it!', emoji: '\u{1F525}', a: refOf(a, 'audio/mp4', 3000), by: 'Al' };
    expect(validateQuip(ok)).toBeNull();
    expect(validateQuip({ by: 'Al' })).toBe('empty quip');
    expect(validateQuip({ ...ok, cap: 'x'.repeat(33) })).toBe('caption too long');
    expect(validateQuip({ ...ok, a: refOf(a, 'audio/mp4', 7000) })).toBe('audio too long');
    expect(validateQuip({ ...ok, a: { ...refOf(a, 'audio/mp4'), n: 70_000 } })).toBe('audio too large');
    expect(validateQuip({ by: 'x', i: { ...refOf(a, 'image/jpeg'), n: 90_000 } })).toBe('image too large');
    expect(validateQuip({ by: 'x', i: { ...refOf(a, 'image/gif'), n: 200_000 } })).toBeNull();
    expect(validateQuip({ by: 'x', i: refOf(a, 'text/html') })).toBe('bad image type');
    expect(quipId(ok)).toBe(quipId({ ...ok, by: 'Someone else' }));
    expect(quipId(ok)).not.toBe(quipId({ ...ok, cap: 'Other' }));
  });
});

describe('chunking and reassembly', () => {
  it('reassembles out of order and verifies the hash', () => {
    const b = bytesOf(70_000);
    const cs = splitBlob(b);
    expect(cs.length).toBe(5);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const c of [...cs].reverse()) out = r.add(c, 0) ?? out;
    expect(out && hashBytes(out)).toBe(hashBytes(b));
  });
  it('rejects a corrupt blob, bad chunk metadata and expires stale partials', () => {
    const b = bytesOf(40_000);
    const cs = splitBlob(b);
    const bad = cs.map((c, i) => (i === 1 ? { ...c, d: b64(bytesOf(QUIP_LIMITS.chunkBytes, 9)) } : c));
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const c of bad) out = r.add(c, 0) ?? out;
    expect(out).toBeNull();
    expect(r.size).toBe(0);
    expect(r.add({ ...cs[0]!, i: 9 }, 0)).toBeNull();
    expect(r.add({ ...cs[0]!, h: 'zz' }, 0)).toBeNull();
    r.add(cs[0]!, 0);
    expect(r.size).toBe(1);
    r.expire(QUIP_LIMITS.pendingMs + 1);
    expect(r.size).toBe(0);
  });
});

describe('LRU', () => {
  it('evicts least recently used, unpinned first, never the newest', () => {
    const i = new BlobIndex();
    i.add('a', 10, 1, true);
    i.add('b', 10, 2);
    i.add('c', 10, 3);
    i.add('d', 10, 4);
    expect(i.evict(20, new Set(['d']))).toEqual(['b', 'c']);
    expect(i.evict(10, new Set(['d']))).toEqual(['a']);
  });
  it('store enforces its cap and keeps pinned blobs of saved quips', async () => {
    let t = 0;
    const { store, files } = memStore(2500, () => ++t);
    const b = [1, 2, 3].map((s) => bytesOf(1000, s));
    await store.put(hashBytes(b[0]!), b[0]!);
    await store.pin(hashBytes(b[0]!), true);
    await store.put(hashBytes(b[1]!), b[1]!);
    await store.put(hashBytes(b[2]!), b[2]!);
    expect(files.has(hashBytes(b[0]!))).toBe(true);
    expect(files.has(hashBytes(b[1]!))).toBe(false);
    expect(files.has(hashBytes(b[2]!))).toBe(true);
  });
});

describe('saved quips', () => {
  it('dedupes by content, renames, and frees unreferenced blobs on delete', async () => {
    const { store, files } = memStore();
    const b = bytesOf(900);
    const ref = refOf(b, 'audio/mp4', 2000);
    const book = new QuipBook(new MemKv(), store);
    const m: QuipMeta = { cap: 'Yo', a: ref, by: 'Al' };
    expect(await book.save(m, false)).toBe('invalid'); // blob not held
    await store.put(ref.h, b);
    expect(await book.save(m, false)).toBe('saved');
    expect(await book.save({ ...m, by: 'Bo' }, false)).toBe('exists');
    expect(await book.rename(quipId(m), 'Floor it')).toBe(true);
    expect((await book.all())[0]!.cap).toBe('Floor it');
    expect((await book.all())[0]!.by).toBe('Al');
    await book.remove((await book.all())[0]!.id);
    expect(await book.all()).toHaveLength(0);
    expect(files.size).toBe(0);
  });
});

// --- Multi-peer: create, broadcast, receive, save, re-send -----------------------------------------------------------

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function peer(net: TestNet, id: DeviceIdentity, log: CircleOp[], others: DeviceIdentity[], stamps: Record<string, { pv?: number; cp?: number }> = {}) {
  const st = replay(log, id);
  const router = new Router({ self: id, circle: () => st, pool: net.pool(id.deviceId), publicRelays: ['wss://t'], retryMs: [50, 100] });
  router.start(Math.floor(Date.now() / 1000) - 60);
  const { store, files } = memStore();
  const book = new QuipBook(new MemKv(), store);
  const got: ReceivedQuip[] = [];
  const legacy: { peer: string; ms: number; label?: string }[] = [];
  const svc = new QuipService({
    bus: router,
    store,
    members: () => others.map((o) => o.deviceId),
    protocolOf: (p) => stamps[p] ?? protocolStamp(),
    onQuip: (q) => got.push(q),
    legacyEmote: async (p, c) => void legacy.push({ peer: p, ms: c.ms, ...(c.label ? { label: c.label } : {}) }),
  });
  svc.start();
  return { router, store, files, book, got, legacy, svc, id };
}

describe('3-peer quip flow', () => {
  it('create, broadcast (chunked), receive, save, recipient re-sends; held blobs are not re-downloaded', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [a, b, c] = [ids[0]!, ids[1]!, ids[2]!];
    const pa = peer(net, a, log, [b, c]);
    const pb = peer(net, b, log, [a, c]);
    const pc = peer(net, c, log, [a, b]);

    const audio = bytesOf(30_000, 3);
    const image = bytesOf(60_000, 4);
    const meta: QuipMeta = { cap: 'Floor it!', emoji: '\u{1F525}', a: refOf(audio, 'audio/mp4', 4000), i: refOf(image, 'image/webp'), by: 'P0' };
    const blobs = new Map([
      [meta.a!.h, audio],
      [meta.i!.h, image],
    ]);
    expect(await pa.svc.send('crew', meta, blobs)).toMatchObject({ ok: true, inline: false });
    await tick();
    await tick();
    expect(pb.got).toHaveLength(1);
    expect(pc.got).toHaveLength(1);
    expect(await pb.store.get(meta.i!.h)).toEqual(image);
    expect(pb.got[0]!.meta.by).toBe('P0');
    // Every relay event stayed under 64 KB.
    expect(Math.max(...net.published.map((e) => e.content.length))).toBeLessThan(64_000);

    // B saves, then re-sends to C (attribution stays with the creator); C already holds the blobs.
    expect(await pb.book.save(pb.got[0]!.meta, false)).toBe('saved');
    expect(await pb.book.save(pb.got[0]!.meta, false)).toBe('exists');
    const saved = (await pb.book.all())[0]!;
    const blobsB = new Map([
      [saved.a!.h, (await pb.store.get(saved.a!.h))!],
      [saved.i!.h, (await pb.store.get(saved.i!.h))!],
    ]);
    expect(await pb.svc.send(c.deviceId, saved, blobsB)).toMatchObject({ ok: true });
    await tick();
    await tick();
    expect(pc.got).toHaveLength(2);
    expect(pc.got[1]!.meta.by).toBe('P0');
    expect(pc.got[1]!.from).toBe(b.deviceId);
    // A repeated send to the same friend does not re-send blobs: only the manifest goes out.
    const n1 = net.published.length;
    await pb.svc.send(c.deviceId, saved, blobsB);
    await tick();
    expect(net.published.length - n1).toBeLessThanOrEqual(2); // manifest (+ the ack), no chunks
    for (const p of [pa, pb, pc]) p.router.stop();
  });

  it('small quips ride inline; rate limit; legacy peers get the voice clip, voiceless quips nothing', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [a, b, c] = [ids[0]!, ids[1]!, ids[2]!];
    const pa = peer(net, a, log, [b, c], { [c.deviceId]: { pv: 6, cp: 1 } });
    const pb = peer(net, b, log, [a, c]);
    const pc = peer(net, c, log, [a, b]);
    const audio = bytesOf(5000, 5);
    const meta: QuipMeta = { cap: 'Beep', a: refOf(audio, 'audio/mp4', 1500), by: 'P0' };
    expect(await pa.svc.send('crew', meta, new Map([[meta.a!.h, audio]]))).toMatchObject({ ok: true, inline: true, chunks: 0 });
    await tick();
    expect(pb.got).toHaveLength(1);
    expect(pa.legacy).toEqual([{ peer: c.deviceId, ms: 1500, label: 'Beep' }]);
    expect(await pa.svc.send(c.deviceId, { emoji: '\u{1F354}', by: 'P0' }, new Map())).toEqual({ ok: false, reason: 'unsupported' });
    await pa.svc.send('crew', { emoji: '\u{1F354}', by: 'P0' }, new Map());
    expect(await pa.svc.send('crew', { emoji: '\u{1F355}', by: 'P0' }, new Map())).toEqual({ ok: false, reason: 'rate limited' });
    for (const p of [pa, pb, pc]) p.router.stop();
  });

  it('refuses mismatched blobs and ignores malformed manifests without throwing', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const pa = peer(net, ids[0]!, log, [ids[1]!]);
    const pb = peer(net, ids[1]!, log, [ids[0]!]);
    const real = bytesOf(30_000, 6);
    const meta: QuipMeta = { cap: 'x', a: refOf(real, 'audio/mp4', 1000), by: 'P0' };
    expect(await pa.svc.send('crew', meta, new Map([[meta.a!.h, bytesOf(30_000, 7)]]))).toEqual({ ok: false, reason: 'blob mismatch' });
    await pa.router.broadcast('quip', new TextEncoder().encode('{not json'));
    await tick();
    expect(pb.got).toHaveLength(0);
    for (const p of [pa, pb]) p.router.stop();
  });
});
