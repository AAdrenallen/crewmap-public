/**
 * Trip memories on the wire (D68). Everything is box-sealed to one recipient (only crewmates who were on the outing
 * get it, not the whole crew) and narrowed by the sender's sharing policy for that recipient before sealing:
 *
 * - 'memory'       the sender's recap post: outing window, an optional title, their thinned route (exact location +
 *                  trip history allowed), distance / duration (trip history) and top speed (stats + speed).
 * - 'memory-photo' a photo manifest (content hash, size, dimensions, caption, expiry) or its withdrawal.
 * - 'memory-blob'  ≤ 16 KB chunks of the compressed JPEG (quips' chunker and reassembler, hash-verified).
 * - 'memory-react' a reaction on the memory or one photo (toggle).
 *
 * Raw history never travels: the route is the sender's own thinned drive line, and only when their policy allows.
 */
import { QUIP_LIMITS, Reassembler, hashBytes, splitBlob, type BlobStore, type ChunkWire } from './quips';
import type { SharingPolicy } from './sharing';

export const MEMORY_KINDS = ['memory', 'memory-photo', 'memory-blob', 'memory-react'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const isMemoryKind = (k: string): k is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(k);

export const MEMORY_LIMITS = {
  maxTitle: 48,
  maxCaption: 80,
  maxRoutePts: 160,
  /** Compressed JPEG: the app re-encodes to ≤ maxEdge px and lowers quality until it fits. Reassembler caps 250 KB. */
  maxPhotoBytes: 220_000,
  maxEdge: 1600,
  photosPerMemberPerMemory: 6,
  /** Sender side. */
  photosPerMin: 6,
  postsPerMin: 12,
  reactsPerMin: 30,
  /** Receiver side, per sender. */
  manifestsPerMin: 12,
  chunksPerMin: 240,
  maxWaiting: 24,
  /** Completed blobs whose manifest has not arrived yet (held in memory during newest-first catch-up replay). */
  maxOrphans: 24,
  /** A photo expires on every phone at most this long after it was shared (the sender may choose less). */
  maxKeepDays: 365,
  /** Relay copies of every memory kind (router KINDS). */
  relayTtlS: 7 * 86_400,
  /** Blob store cap for memory photos (app documents dir). */
  storeCapBytes: 120 * 1024 * 1024,
} as const;

export const PHOTO_MIME = 'image/jpeg';

const HASH_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[\w.:-]{1,80}$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isWindow = (w: unknown): w is [number, number] => Array.isArray(w) && w.length === 2 && isNum(w[0]) && isNum(w[1]) && w[0] <= w[1] && w[1] - w[0] <= 7 * 86_400_000;
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// --- what the sender shares ----------------------------------------------------------------------------------------

/** The sender's local view of an outing, before the policy narrows it per recipient. */
export interface LocalMemory {
  mid: string;
  window: [number, number];
  title?: string;
  /** Thinned own drive line. */
  route: { t: number; lat: number; lng: number }[];
  km: number;
  min: number;
  topKph: number;
}

export interface MemoryPostWire {
  v: 1;
  mid: string;
  w: [number, number];
  title?: string;
  route?: [number, number, number][];
  km?: number;
  min?: number;
  topKph?: number;
}

/** Narrow a memory to what `pol` lets this recipient see. null = trip history is not shared with them: send nothing. */
export function postFor(m: LocalMemory, pol: SharingPolicy): MemoryPostWire | null {
  if (!pol.trips) return null;
  const out: MemoryPostWire = { v: 1, mid: m.mid, w: m.window, km: Math.round(m.km * 10) / 10, min: Math.round(m.min) };
  if (m.title) out.title = m.title.slice(0, MEMORY_LIMITS.maxTitle);
  if (pol.location === 'exact' && m.route.length >= 2) {
    const step = Math.max(1, Math.ceil(m.route.length / MEMORY_LIMITS.maxRoutePts));
    const pts = m.route.filter((_, i) => i % step === 0 || i === m.route.length - 1);
    out.route = pts.map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5, Math.round(p.t / 1000)]);
  }
  if (pol.stats && pol.speed) out.topKph = Math.round(m.topKph);
  return out;
}

/** Photos and reactions are social content: they follow the emotes switch. */
export const memorySocialAllowed = (pol: SharingPolicy): boolean => pol.emotes;

/** Which crews may carry a memory kind (sender side) and accept it (receiver side). */
export function memoryKindAllowed(kind: MemoryKind, pol: SharingPolicy): boolean {
  return kind === 'memory' ? pol.trips : memorySocialAllowed(pol);
}

export interface ParsedPost {
  mid: string;
  window: [number, number];
  title?: string;
  route?: { t: number; lat: number; lng: number }[];
  km?: number;
  min?: number;
  topKph?: number;
}

export function parsePost(raw: unknown): ParsedPost | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.mid !== 'string' || !ID_RE.test(o.mid) || !isWindow(o.w)) return null;
  const out: ParsedPost = { mid: o.mid, window: [o.w[0], o.w[1]] };
  const title = text(o.title, MEMORY_LIMITS.maxTitle);
  if (title) out.title = title;
  if (Array.isArray(o.route) && o.route.length <= MEMORY_LIMITS.maxRoutePts + 1) {
    const pts = o.route
      .filter((p): p is [number, number, number] => Array.isArray(p) && p.length === 3 && p.every(isNum) && Math.abs(p[0] as number) <= 90 && Math.abs(p[1] as number) <= 180)
      .map(([lat, lng, t]) => ({ lat, lng, t: t * 1000 }))
      .sort((a, b) => a.t - b.t);
    if (pts.length >= 2) out.route = pts;
  }
  if (isNum(o.km) && o.km >= 0 && o.km < 5000) out.km = o.km;
  if (isNum(o.min) && o.min >= 0 && o.min < 3000) out.min = o.min;
  if (isNum(o.topKph) && o.topKph >= 0 && o.topKph < 400) out.topKph = o.topKph;
  return out;
}

// --- photos ----------------------------------------------------------------------------------------------------------

export interface PhotoWire {
  v: 1;
  mid: string;
  w: [number, number];
  h: string;
  n: number;
  pw: number;
  ph: number;
  cap?: string;
  at: number;
  /** Expiry (ms epoch): every phone deletes the photo then. */
  exp: number;
  /** Withdrawn by its sender: delete it. */
  del?: true;
}

export function parsePhoto(raw: unknown, now: number): PhotoWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.mid !== 'string' || !ID_RE.test(o.mid) || !isWindow(o.w) || typeof o.h !== 'string' || !HASH_RE.test(o.h)) return null;
  if (o.del === true) return { v: 1, mid: o.mid, w: o.w, h: o.h, n: 0, pw: 0, ph: 0, at: isNum(o.at) ? o.at : now, exp: now, del: true };
  if (!isNum(o.n) || !Number.isInteger(o.n) || o.n <= 0 || o.n > MEMORY_LIMITS.maxPhotoBytes) return null;
  if (!isNum(o.pw) || !isNum(o.ph) || o.pw <= 0 || o.ph <= 0 || o.pw > MEMORY_LIMITS.maxEdge || o.ph > MEMORY_LIMITS.maxEdge) return null;
  if (!isNum(o.at) || !isNum(o.exp)) return null;
  // A sender cannot pin a photo on my phone longer than the cap, whatever clock or `at` it claims.
  const at = Math.min(o.at, now);
  const exp = Math.min(o.exp, at + MEMORY_LIMITS.maxKeepDays * 86_400_000);
  if (exp <= now) return null;
  const out: PhotoWire = { v: 1, mid: o.mid, w: o.w, h: o.h, n: o.n, pw: o.pw, ph: o.ph, at, exp };
  const cap = text(o.cap, MEMORY_LIMITS.maxCaption);
  if (cap) out.cap = cap;
  return out;
}

// --- reactions -------------------------------------------------------------------------------------------------------

export interface ReactWire {
  v: 1;
  mid: string;
  w: [number, number];
  /** 'memory' or a photo hash. */
  target: string;
  e: string;
  on: boolean;
  at: number;
}

export function parseReact(raw: unknown, allowed: readonly string[]): ReactWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.mid !== 'string' || !ID_RE.test(o.mid) || !isWindow(o.w) || !isNum(o.at)) return null;
  if (typeof o.target !== 'string' || (o.target !== 'memory' && !HASH_RE.test(o.target))) return null;
  if (typeof o.e !== 'string' || !allowed.includes(o.e) || typeof o.on !== 'boolean') return null;
  return { v: 1, mid: o.mid, w: o.w, target: o.target, e: o.e, on: o.on, at: o.at };
}

// --- channel ---------------------------------------------------------------------------------------------------------

/**
 * Sealed one-recipient transport. `build` gets the policy that applies to that recipient (crew policy with their
 * override) and returns the value to seal, or null to send nothing.
 */
export interface MemoryBus {
  send(to: string, kind: MemoryKind, build: (pol: SharingPolicy) => unknown): Promise<boolean>;
  on(kind: MemoryKind, h: (from: string, value: unknown) => void): () => void;
}

export interface MemoryRef {
  mid: string;
  window: [number, number];
}

export interface MemoryChannelOptions {
  bus: MemoryBus;
  store: BlobStore;
  reactions: readonly string[];
  onPost: (from: string, p: ParsedPost) => void;
  /** Called once per photo, when its bytes are held. */
  onPhoto: (from: string, p: PhotoWire) => void;
  onPhotoGone: (from: string, p: PhotoWire) => void;
  onReact: (from: string, r: ReactWire) => void;
  now?: () => number;
}

export type PhotoSendResult = { ok: true; sent: number } | { ok: false; reason: 'tooBig' | 'rateLimited' | 'mismatch' | 'nobody' };

export class MemoryChannel {
  private readonly asm = new Reassembler();
  private readonly waiting: { from: string; p: PhotoWire }[] = [];
  private readonly logs = new Map<string, number[]>();
  private readonly perMemory = new Map<string, Set<string>>();
  private readonly orphans = new Map<string, { bytes: Uint8Array; at: number }>();
  /** Withdrawn photos (sender:hash): a replayed or relayed older manifest must not bring one back. */
  private readonly withdrawn = new Set<string>();
  private offs: (() => void)[] = [];

  constructor(private readonly o: MemoryChannelOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Sliding one-minute budget per key. */
  private budget(key: string, max: number): boolean {
    const t = this.now();
    let l = this.logs.get(key);
    if (!l) this.logs.set(key, (l = []));
    while (l.length && t - l[0]! > 60_000) l.shift();
    if (l.length >= max) return false;
    l.push(t);
    return true;
  }

  start(): void {
    this.stop();
    const safe = (f: (from: string, v: unknown) => Promise<void> | void) => (from: string, v: unknown) => void Promise.resolve(f(from, v)).catch(() => undefined);
    this.offs.push(
      this.o.bus.on('memory', safe((from, v) => {
        const p = parsePost(v);
        if (p && this.budget(`post:${from}`, MEMORY_LIMITS.postsPerMin)) this.o.onPost(from, p);
      })),
      this.o.bus.on('memory-photo', safe((from, v) => this.onManifest(from, v))),
      this.o.bus.on('memory-blob', safe((from, v) => this.onChunk(from, v))),
      this.o.bus.on('memory-react', safe((from, v) => {
        const r = parseReact(v, this.o.reactions);
        if (r && this.budget(`react-in:${from}`, MEMORY_LIMITS.reactsPerMin)) this.o.onReact(from, r);
      })),
    );
  }

  stop(): void {
    for (const f of this.offs) f();
    this.offs = [];
  }

  /** Recap post to each member, narrowed per recipient. Returns how many were sent. */
  async share(members: readonly string[], m: LocalMemory): Promise<number> {
    if (!this.budget('post-out', MEMORY_LIMITS.postsPerMin)) return 0;
    let n = 0;
    for (const to of members) if (await this.o.bus.send(to, 'memory', (pol) => postFor(m, pol))) n++;
    return n;
  }

  /** Manifest then chunks, sealed to each member. Bytes must already be the compressed JPEG. */
  async sendPhoto(members: readonly string[], ref: MemoryRef, bytes: Uint8Array, meta: { pw: number; ph: number; cap?: string; at: number; exp: number }): Promise<PhotoSendResult> {
    if (bytes.length === 0 || bytes.length > MEMORY_LIMITS.maxPhotoBytes) return { ok: false, reason: 'tooBig' };
    if (meta.pw > MEMORY_LIMITS.maxEdge || meta.ph > MEMORY_LIMITS.maxEdge) return { ok: false, reason: 'mismatch' };
    if (!members.length) return { ok: false, reason: 'nobody' };
    if (!this.budget('photo-out', MEMORY_LIMITS.photosPerMin)) return { ok: false, reason: 'rateLimited' };
    const h = hashBytes(bytes);
    const wire: PhotoWire = { v: 1, mid: ref.mid, w: ref.window, h, n: bytes.length, pw: Math.round(meta.pw), ph: Math.round(meta.ph), at: meta.at, exp: meta.exp };
    const cap = text(meta.cap, MEMORY_LIMITS.maxCaption);
    if (cap) wire.cap = cap;
    const chunks = splitBlob(bytes, h);
    let sent = 0;
    for (const to of members) {
      if (!(await this.o.bus.send(to, 'memory-photo', (pol) => (memorySocialAllowed(pol) ? wire : null)))) continue;
      for (const c of chunks) await this.o.bus.send(to, 'memory-blob', (pol) => (memorySocialAllowed(pol) ? c : null));
      sent++;
    }
    return { ok: true, sent };
  }

  async unsharePhoto(members: readonly string[], ref: MemoryRef, h: string): Promise<void> {
    const wire = { v: 1, mid: ref.mid, w: ref.window, h, del: true, at: this.now() };
    for (const to of members) await this.o.bus.send(to, 'memory-photo', (pol) => (memorySocialAllowed(pol) ? wire : null));
  }

  async react(members: readonly string[], ref: MemoryRef, target: string, e: string, on: boolean): Promise<number> {
    if (!this.o.reactions.includes(e) || !this.budget('react-out', MEMORY_LIMITS.reactsPerMin)) return 0;
    const wire: ReactWire = { v: 1, mid: ref.mid, w: ref.window, target, e, on, at: this.now() };
    let n = 0;
    for (const to of members) if (await this.o.bus.send(to, 'memory-react', (pol) => (memorySocialAllowed(pol) ? wire : null))) n++;
    return n;
  }

  private async onManifest(from: string, v: unknown): Promise<void> {
    const p = parsePhoto(v, this.now());
    if (!p) return;
    const tomb = `${from}:${p.h}`;
    if (p.del) {
      this.withdrawn.add(tomb);
      if (this.withdrawn.size > 500) this.withdrawn.delete(this.withdrawn.values().next().value as string);
      this.perMemory.get(`${from}:${p.mid}`)?.delete(p.h);
      this.o.onPhotoGone(from, p);
      return;
    }
    if (this.withdrawn.has(tomb) || !this.budget(`manifest:${from}`, MEMORY_LIMITS.manifestsPerMin)) return;
    const key = `${from}:${p.mid}`;
    const seen = this.perMemory.get(key) ?? this.perMemory.set(key, new Set()).get(key)!;
    if (!seen.has(p.h) && seen.size >= MEMORY_LIMITS.photosPerMemberPerMemory) return;
    seen.add(p.h);
    if (await this.o.store.has(p.h)) return this.o.onPhoto(from, p);
    const early = this.orphans.get(p.h);
    if (early && early.bytes.length === p.n) {
      this.orphans.delete(p.h);
      await this.o.store.put(p.h, early.bytes);
      return this.o.onPhoto(from, p);
    }
    if (this.waiting.some((x) => x.from === from && x.p.h === p.h)) return;
    this.waiting.push({ from, p });
    if (this.waiting.length > MEMORY_LIMITS.maxWaiting) this.waiting.shift();
  }

  private async onChunk(from: string, v: unknown): Promise<void> {
    const c = v as ChunkWire | null;
    if (!c || typeof c !== 'object' || typeof c.h !== 'string') return;
    if (this.orphans.has(c.h) || (await this.o.store.has(c.h))) return;
    if (!this.budget(`chunk:${from}`, MEMORY_LIMITS.chunksPerMin)) return;
    const bytes = this.asm.add(c, this.now());
    if (!bytes || bytes.length > MEMORY_LIMITS.maxPhotoBytes) return;
    const ready = this.waiting.filter((x) => x.p.h === c.h && x.p.n === bytes.length);
    if (!ready.length) {
      // Chunks overtook their manifest (relay catch-up order): hold the verified bytes briefly, never store them.
      this.orphans.set(c.h, { bytes, at: this.now() });
      while (this.orphans.size > MEMORY_LIMITS.maxOrphans) this.orphans.delete(this.orphans.keys().next().value as string);
      return;
    }
    await this.o.store.put(c.h, bytes);
    for (const w of ready) {
      this.waiting.splice(this.waiting.indexOf(w), 1);
      this.o.onPhoto(w.from, w.p);
    }
  }

  expire(): void {
    const t = this.now();
    this.asm.expire(t);
    for (const [h, o] of this.orphans) if (t - o.at > QUIP_LIMITS.pendingMs) this.orphans.delete(h);
  }
}
