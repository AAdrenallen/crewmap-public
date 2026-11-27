/**
 * Custom quips (D49): a voice line and/or emoji and/or small image/GIF plus a short caption, created by any crewmate,
 * sent to one friend or the whole crew, and savable by recipients into their own collection.
 *
 * Transport: content-addressed blobs (BLAKE2b-128 hex). Small quips travel inline in the sealed `quip` message; bigger
 * ones are split into ≤ 16 KB chunks (`quip-blob`) so every relay event stays far below the ~64 KB limit many Nostr
 * relays enforce. Receivers verify every blob hash, skip chunks for blobs they already hold and never re-download a
 * saved quip. Everything rides the crew's sealed envelopes (E2E) and the relay copy expires after 72 h.
 */
import { b64, fromUtf8, hex, sodium, unb64, utf8 } from './crypto/sodium';
import { peerSupports, type PeerProtocol } from './protocol';
import type { Kind } from './router';

export const QUIP_LIMITS = {
  maxCaption: 32,
  maxName: 32,
  maxAudioBytes: 60_000,
  maxAudioMs: 6000,
  maxImageBytes: 80_000,
  maxGifBytes: 250_000,
  /** Whole quip, all blobs. */
  maxTotalBytes: 330_000,
  /** Raw bytes sent inline in the manifest (≈ 27 KB base64). */
  inlineBytes: 20_000,
  /** Raw bytes per chunk (≈ 22 KB base64, ≈ 30 KB sealed event). */
  chunkBytes: 16_384,
  /** Sends per minute (sender side) and accepted quips per minute per sender (receiver side). */
  sendPerMin: 3,
  receivePerMin: 6,
  chunksPerMinPerSender: 90,
  /** A partly received blob is dropped after this long without a new chunk. */
  pendingMs: 10 * 60_000,
  maxPendingBlobs: 16,
  /** Blob store cap (app documents dir). */
  storeCapBytes: 30 * 1024 * 1024,
  maxSaved: 200,
  /** Relay expiry for quip events (router KINDS). */
  relayTtlS: 72 * 3600,
} as const;

export const IMAGE_MIMES = ['image/webp', 'image/jpeg', 'image/png', 'image/gif'] as const;
export const AUDIO_MIMES = ['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'] as const;

export interface QuipBlobRef {
  /** Content hash (32 hex). */
  h: string;
  /** Size in bytes. */
  n: number;
  mime: string;
  /** Duration for audio. */
  ms?: number;
}

export interface QuipMeta {
  cap?: string;
  emoji?: string;
  a?: QuipBlobRef;
  i?: QuipBlobRef;
  /** Creator display name ("by <creator>"). */
  by: string;
}

export interface SavedQuip extends QuipMeta {
  /** Content id: identical content is one quip however many people send it. */
  id: string;
  mine: boolean;
  savedAt: number;
}

export const hashBytes = (bytes: Uint8Array): string => hex(sodium().crypto_generichash(16, bytes));

export const quipId = (m: QuipMeta): string =>
  hex(sodium().crypto_generichash(16, utf8(`${m.cap ?? ''}\u0000${m.emoji ?? ''}\u0000${m.a?.h ?? ''}\u0000${m.i?.h ?? ''}`)));

const HASH_RE = /^[0-9a-f]{32}$/;

function checkRef(r: QuipBlobRef | undefined, kind: 'a' | 'i'): string | null {
  if (!r) return null;
  if (!HASH_RE.test(r.h) || !Number.isInteger(r.n) || r.n <= 0) return 'bad blob ref';
  if (kind === 'a') {
    if (!(AUDIO_MIMES as readonly string[]).includes(r.mime)) return 'bad audio type';
    if (r.n > QUIP_LIMITS.maxAudioBytes) return 'audio too large';
    if ((r.ms ?? 0) > QUIP_LIMITS.maxAudioMs + 250) return 'audio too long';
  } else {
    if (!(IMAGE_MIMES as readonly string[]).includes(r.mime)) return 'bad image type';
    if (r.n > (r.mime === 'image/gif' ? QUIP_LIMITS.maxGifBytes : QUIP_LIMITS.maxImageBytes)) return 'image too large';
  }
  return null;
}

export function validateQuip(m: QuipMeta): string | null {
  if (!m || typeof m !== 'object') return 'bad quip';
  if (m.cap !== undefined && (typeof m.cap !== 'string' || m.cap.length > QUIP_LIMITS.maxCaption)) return 'caption too long';
  if (m.emoji !== undefined && (typeof m.emoji !== 'string' || Array.from(m.emoji).length > 4 || m.emoji.length > 16)) return 'bad emoji';
  if (typeof m.by !== 'string' || m.by.length > QUIP_LIMITS.maxName) return 'bad creator';
  if (!m.cap && !m.emoji && !m.a && !m.i) return 'empty quip';
  const e = checkRef(m.a, 'a') ?? checkRef(m.i, 'i');
  if (e) return e;
  if ((m.a?.n ?? 0) + (m.i?.n ?? 0) > QUIP_LIMITS.maxTotalBytes) return 'quip too large';
  return null;
}

// --- Chunking ------------------------------------------------------------------------------------------------------

export interface ChunkWire {
  /** Blob hash. */
  h: string;
  /** Index and count. */
  i: number;
  n: number;
  /** base64url data. */
  d: string;
}

export function splitBlob(bytes: Uint8Array, h = hashBytes(bytes), size: number = QUIP_LIMITS.chunkBytes): ChunkWire[] {
  const n = Math.max(1, Math.ceil(bytes.length / size));
  return Array.from({ length: n }, (_, i) => ({ h, i, n, d: b64(bytes.subarray(i * size, (i + 1) * size)) }));
}

/** Reassembles chunked blobs in any order; a blob is released only when its hash verifies. */
export class Reassembler {
  private readonly pending = new Map<string, { n: number; parts: Map<number, Uint8Array>; bytes: number; at: number }>();

  /** Returns the verified bytes when `c` completed its blob, null otherwise (incomplete, invalid or corrupt). */
  add(c: ChunkWire, now: number): Uint8Array | null {
    if (!HASH_RE.test(c.h) || !Number.isInteger(c.i) || !Number.isInteger(c.n) || c.n < 1 || c.i < 0 || c.i >= c.n) return null;
    if (c.n > Math.ceil(QUIP_LIMITS.maxGifBytes / QUIP_LIMITS.chunkBytes) + 1 || typeof c.d !== 'string') return null;
    if (c.d.length > Math.ceil((QUIP_LIMITS.chunkBytes * 4) / 3) + 8) return null;
    let p = this.pending.get(c.h);
    if (p && p.n !== c.n) return null;
    if (!p) {
      this.expire(now);
      if (this.pending.size >= QUIP_LIMITS.maxPendingBlobs) return null;
      p = { n: c.n, parts: new Map(), bytes: 0, at: now };
      this.pending.set(c.h, p);
    }
    p.at = now;
    if (!p.parts.has(c.i)) {
      let raw: Uint8Array;
      try {
        raw = unb64(c.d);
      } catch {
        return null;
      }
      p.parts.set(c.i, raw);
      p.bytes += raw.length;
      if (p.bytes > QUIP_LIMITS.maxGifBytes) {
        this.pending.delete(c.h);
        return null;
      }
    }
    if (p.parts.size < p.n) return null;
    this.pending.delete(c.h);
    const out = new Uint8Array(p.bytes);
    let o = 0;
    for (let i = 0; i < p.n; i++) {
      const part = p.parts.get(i)!;
      out.set(part, o);
      o += part.length;
    }
    return hashBytes(out) === c.h ? out : null;
  }

  expire(now: number): void {
    for (const [h, p] of this.pending) if (now - p.at > QUIP_LIMITS.pendingMs) this.pending.delete(h);
  }

  get size(): number {
    return this.pending.size;
  }
}

// --- Blob store LRU ------------------------------------------------------------------------------------------------

export interface BlobEntry {
  size: number;
  used: number;
  /** Blobs of saved quips: evicted only after every unpinned blob. */
  pinned: boolean;
}

export class BlobIndex {
  constructor(readonly entries = new Map<string, BlobEntry>()) {}

  get total(): number {
    let t = 0;
    for (const e of this.entries.values()) t += e.size;
    return t;
  }

  has(h: string): boolean {
    return this.entries.has(h);
  }

  touch(h: string, now: number): void {
    const e = this.entries.get(h);
    if (e) e.used = now;
  }

  add(h: string, size: number, now: number, pinned = false): void {
    const e = this.entries.get(h);
    this.entries.set(h, { size, used: now, pinned: pinned || !!e?.pinned });
  }

  pin(h: string, pinned: boolean): void {
    const e = this.entries.get(h);
    if (e) e.pinned = pinned;
  }

  remove(h: string): void {
    this.entries.delete(h);
  }

  /** Least-recently-used first (unpinned before pinned) until under `cap`; `keep` is never evicted. */
  evict(cap: number, keep: ReadonlySet<string> = new Set()): string[] {
    const out: string[] = [];
    let total = this.total;
    const order = [...this.entries]
      .filter(([h]) => !keep.has(h))
      .sort((a, b) => Number(a[1].pinned) - Number(b[1].pinned) || a[1].used - b[1].used);
    for (const [h, e] of order) {
      if (total <= cap) break;
      this.entries.delete(h);
      total -= e.size;
      out.push(h);
    }
    return out;
  }

  toJSON(): Record<string, BlobEntry> {
    return Object.fromEntries(this.entries);
  }

  static from(o: Record<string, BlobEntry> | null | undefined): BlobIndex {
    return new BlobIndex(new Map(Object.entries(o ?? {})));
  }
}

export interface BlobStore {
  has(h: string): Promise<boolean>;
  get(h: string): Promise<Uint8Array | null>;
  put(h: string, bytes: Uint8Array): Promise<void>;
  delete(h: string): Promise<void>;
  pin(h: string, pinned: boolean): Promise<void>;
}

/** Bytes live in `io` (files in the app), the LRU index in `kv`. */
export interface BlobIo {
  read(h: string): Promise<Uint8Array | null>;
  write(h: string, bytes: Uint8Array): Promise<void>;
  remove(h: string): Promise<void>;
}

export interface Kv {
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

export class LruBlobStore implements BlobStore {
  private index: BlobIndex | null = null;

  constructor(
    private readonly io: BlobIo,
    private readonly kv: Kv,
    private readonly now: () => number = Date.now,
    private readonly capBytes: number = QUIP_LIMITS.storeCapBytes,
    /** kv key of the LRU index: one per store (quips, memory photos). */
    private readonly indexKey: string = 'quips.blobs',
  ) {}

  private async idx(): Promise<BlobIndex> {
    return (this.index ??= BlobIndex.from(await this.kv.get<Record<string, BlobEntry> | null>(this.indexKey, null)));
  }

  private async persist(): Promise<void> {
    await this.kv.set(this.indexKey, (await this.idx()).toJSON());
  }

  async has(h: string): Promise<boolean> {
    const i = await this.idx();
    if (!i.has(h)) return false;
    i.touch(h, this.now());
    return true;
  }

  async get(h: string): Promise<Uint8Array | null> {
    const i = await this.idx();
    if (!i.has(h)) return null;
    const b = await this.io.read(h);
    if (!b) {
      i.remove(h);
      return null;
    }
    i.touch(h, this.now());
    return b;
  }

  async put(h: string, bytes: Uint8Array): Promise<void> {
    const i = await this.idx();
    await this.io.write(h, bytes);
    i.add(h, bytes.length, this.now());
    for (const gone of i.evict(this.capBytes, new Set([h]))) await this.io.remove(gone);
    await this.persist();
  }

  async delete(h: string): Promise<void> {
    (await this.idx()).remove(h);
    await this.io.remove(h);
    await this.persist();
  }

  async pin(h: string, pinned: boolean): Promise<void> {
    (await this.idx()).pin(h, pinned);
    await this.persist();
  }
}

// --- Saved quips ---------------------------------------------------------------------------------------------------

/** The local "My quips" collection. Deleting a quip frees blobs no other quip references. */
export class QuipBook {
  private list: SavedQuip[] | null = null;

  constructor(
    private readonly kv: Kv,
    private readonly store: BlobStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<SavedQuip[]> {
    return (this.list ??= await this.kv.get<SavedQuip[]>('quips.saved', []));
  }

  async all(): Promise<SavedQuip[]> {
    return [...(await this.load())].sort((a, b) => b.savedAt - a.savedAt);
  }

  async get(id: string): Promise<SavedQuip | undefined> {
    return (await this.load()).find((q) => q.id === id);
  }

  /** 'exists' when identical content is already saved (nothing is duplicated or re-downloaded). */
  async save(m: QuipMeta, mine: boolean): Promise<'saved' | 'exists' | 'invalid' | 'full'> {
    if (validateQuip(m)) return 'invalid';
    const list = await this.load();
    const id = quipId(m);
    if (list.some((q) => q.id === id)) return 'exists';
    if (list.length >= QUIP_LIMITS.maxSaved) return 'full';
    for (const r of [m.a, m.i]) if (r && !(await this.store.has(r.h))) return 'invalid';
    list.push({ ...m, id, mine, savedAt: this.now() });
    for (const r of [m.a, m.i]) if (r) await this.store.pin(r.h, true);
    await this.kv.set('quips.saved', list);
    return 'saved';
  }

  /** The id follows content, so a rename re-keys the entry (and merges with an identical one). */
  async rename(id: string, cap: string): Promise<boolean> {
    const list = await this.load();
    const i = list.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const c = cap.trim().slice(0, QUIP_LIMITS.maxCaption);
    const cur = list[i]!;
    if (!c && !cur.a && !cur.i && !cur.emoji) return false;
    const next: SavedQuip = { ...cur };
    if (c) next.cap = c;
    else delete next.cap;
    next.id = quipId(next);
    list.splice(i, 1);
    if (!list.some((q) => q.id === next.id)) list.push(next);
    await this.kv.set('quips.saved', list);
    return true;
  }

  async remove(id: string): Promise<void> {
    const list = await this.load();
    const q = list.find((x) => x.id === id);
    if (!q) return;
    this.list = list.filter((x) => x.id !== id);
    for (const r of [q.a, q.i]) {
      if (!r || this.list.some((o) => o.a?.h === r.h || o.i?.h === r.h)) continue;
      await this.store.pin(r.h, false);
      await this.store.delete(r.h);
    }
    await this.kv.set('quips.saved', this.list);
  }
}

// --- Service -------------------------------------------------------------------------------------------------------

interface WireIn {
  k?: string;
  m: QuipMeta;
  in?: Record<string, string>;
}

export interface ReceivedQuip {
  from: string;
  /** Sender's client key (stable across re-sends). */
  k: string;
  meta: QuipMeta;
  id: string;
  sentAt: number;
}

export interface QuipBus {
  sendTo(peer: string, kind: Kind, payload: Uint8Array): Promise<string>;
  broadcast(kind: Kind, payload: Uint8Array): Promise<string>;
  on(kind: Kind, h: (m: { sender: string; id: string; payload: Uint8Array; sentAt: number }) => void): () => void;
}

export interface QuipServiceOptions {
  bus: QuipBus;
  store: BlobStore;
  /** Everyone we can send a crew broadcast to. */
  members: () => string[];
  /** Presence stamp of a peer (for the capability check). */
  protocolOf: (peer: string) => PeerProtocol | null;
  /** Called once per quip when all its blobs are held. */
  onQuip: (q: ReceivedQuip) => void;
  /** Legacy fallback: peers without the capability get the voice clip as a plain custom emote. */
  legacyEmote?: (peer: string, clip: { base64: string; ms: number; label?: string }) => Promise<void>;
  now?: () => number;
}

export type QuipSendResult = { ok: true; chunks: number; inline: boolean } | { ok: false; reason: string };

export class QuipService {
  private readonly asm = new Reassembler();
  private readonly waiting: (ReceivedQuip & { need: Set<string> })[] = [];
  private readonly seen = new Set<string>();
  private readonly sentLog: number[] = [];
  private readonly recvLog = new Map<string, number[]>();
  private readonly chunkLog = new Map<string, number[]>();
  /** Per peer, blobs already sent (friend sends skip them). */
  private readonly sentTo = new Map<string, Set<string>>();
  private offs: (() => void)[] = [];

  constructor(private readonly o: QuipServiceOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  start(): void {
    this.stop();
    this.offs.push(
      this.o.bus.on('quip', (m) => void this.onManifest(m.sender, m.id, m.payload, m.sentAt).catch(() => undefined)),
      this.o.bus.on('quip-blob', (m) => void this.onChunk(m.sender, m.payload).catch(() => undefined)),
    );
  }

  stop(): void {
    for (const f of this.offs) f();
    this.offs = [];
  }

  private budget(log: number[], max: number): boolean {
    const t = this.now();
    while (log.length && t - log[0]! > 60_000) log.shift();
    if (log.length >= max) return false;
    log.push(t);
    return true;
  }

  private logOf(m: Map<string, number[]>, k: string): number[] {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    return l;
  }

  /** Sender side. `to` = a friend's device id or 'crew'. `blobs` must contain the bytes of every blob in `meta`. */
  async send(to: string, meta: QuipMeta, blobs: ReadonlyMap<string, Uint8Array>): Promise<QuipSendResult> {
    const bad = validateQuip(meta);
    if (bad) return { ok: false, reason: bad };
    const refs = [meta.a, meta.i].filter((r): r is QuipBlobRef => !!r);
    for (const r of refs) {
      const b = blobs.get(r.h);
      if (!b || b.length !== r.n || hashBytes(b) !== r.h) return { ok: false, reason: 'blob mismatch' };
    }
    if (!this.budget(this.sentLog, QUIP_LIMITS.sendPerMin)) return { ok: false, reason: 'rate limited' };
    const k = `${this.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const crew = to === 'crew';
    const targets = crew ? this.o.members() : [to];
    const modern = targets.filter((p) => peerSupports(this.o.protocolOf(p), 'quips') !== false);
    const legacy = targets.filter((p) => !modern.includes(p));
    const total = refs.reduce((n, r) => n + r.n, 0);
    const inline = total <= QUIP_LIMITS.inlineBytes;
    const wire: WireIn = { k, m: meta, ...(inline ? { in: Object.fromEntries(refs.map((r) => [r.h, b64(blobs.get(r.h)!)])) } : {}) };
    let chunks = 0;
    const out = (kind: Kind, payload: Uint8Array) => (crew ? this.o.bus.broadcast(kind, payload) : this.o.bus.sendTo(to, kind, payload));
    if (modern.length) {
      await out('quip', utf8(JSON.stringify(wire)));
      if (!inline) {
        const sent = crew ? new Set<string>() : (this.sentTo.get(to) ?? this.sentTo.set(to, new Set()).get(to)!);
        for (const r of refs) {
          if (sent.has(r.h)) continue;
          for (const c of splitBlob(blobs.get(r.h)!, r.h)) {
            await out('quip-blob', utf8(JSON.stringify(c)));
            chunks++;
          }
          sent.add(r.h);
        }
      }
    }
    // Older builds: the voice clip as a plain custom emote (quips without voice have no equivalent: nothing is sent).
    if (legacy.length && meta.a && this.o.legacyEmote) {
      const s = sodium();
      const base64 = s.to_base64(blobs.get(meta.a.h)!, s.base64_variants.ORIGINAL);
      for (const p of legacy) await this.o.legacyEmote(p, { base64, ms: meta.a.ms ?? 0, ...(meta.cap ? { label: meta.cap.slice(0, 24) } : {}) });
    }
    if (!modern.length && !(legacy.length && meta.a && this.o.legacyEmote)) return { ok: false, reason: 'unsupported' };
    return { ok: true, chunks, inline };
  }

  private async onManifest(from: string, id: string, payload: Uint8Array, sentAt: number): Promise<void> {
    const w = JSON.parse(fromUtf8(payload)) as WireIn;
    if (!w || validateQuip(w.m)) return;
    const key = `${from}:${w.k ?? id}`;
    if (this.seen.has(key)) return;
    if (!this.budget(this.logOf(this.recvLog, from), QUIP_LIMITS.receivePerMin)) return;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    const refs = [w.m.a, w.m.i].filter((r): r is QuipBlobRef => !!r);
    for (const r of refs) {
      const raw = w.in?.[r.h];
      if (raw === undefined || (await this.o.store.has(r.h))) continue;
      const bytes = unb64(raw);
      if (bytes.length === r.n && hashBytes(bytes) === r.h) await this.o.store.put(r.h, bytes);
    }
    const need = new Set<string>();
    for (const r of refs) if (!(await this.o.store.has(r.h))) need.add(r.h);
    const q: ReceivedQuip = { from, k: w.k ?? id, meta: w.m, id: quipId(w.m), sentAt };
    if (need.size === 0) return this.o.onQuip(q);
    this.waiting.push({ ...q, need });
    if (this.waiting.length > 32) this.waiting.shift();
  }

  private async onChunk(from: string, payload: Uint8Array): Promise<void> {
    const c = JSON.parse(fromUtf8(payload)) as ChunkWire;
    if (!c || typeof c.h !== 'string') return;
    // Already held (saved or received earlier): never re-download.
    if (await this.o.store.has(c.h)) return;
    if (!this.budget(this.logOf(this.chunkLog, from), QUIP_LIMITS.chunksPerMinPerSender)) return;
    const bytes = this.asm.add(c, this.now());
    if (!bytes) return;
    await this.o.store.put(c.h, bytes);
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i]!;
      w.need.delete(c.h);
      if (w.need.size === 0) {
        this.waiting.splice(i, 1);
        this.o.onQuip({ from: w.from, k: w.k, meta: w.meta, id: w.id, sentAt: w.sentAt });
      }
    }
  }

  /** Drop partly received blobs that never finished. */
  expire(): void {
    this.asm.expire(this.now());
  }
}
