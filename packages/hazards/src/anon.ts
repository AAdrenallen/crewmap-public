import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getPow, minePow } from 'nostr-tools/nip13';
import { haversineM, type LatLng } from '@crewmap/shared/geo';
import { FRIEND_REPORT_TYPES, type FriendReportType } from './sources/friends';
import { TYPE_FAMILY } from './confidence';
import { geohashDecode, geohashEncode } from './geohash';
import { DEFAULT_TTL_MS, type Hazard } from './types';

/**
 * Opt-in anonymous public hazard network (D41). A report is a Nostr event signed by a fresh key used once, carrying
 * only: a report type, a ~150 m grid cell, a heading sector and a time rounded to 2 min. No device, crew, profile or
 * exact position. It is published under a coarse ~40 km topic cell so subscribing to the cells along a route tells
 * relays little more than the region. Abuse resistance: NIP-13 proof of work on every event, per-cell and per-topic
 * acceptance caps, expiry, "still there?" votes (also one-shot keys + PoW), and anonymous-only clusters capped at
 * medium confidence until corroborated (confidence.ts).
 */
export const ANON = {
  /** Wire version, in the content (`v`) and the capability tag. Readers ignore other versions. */
  version: 1,
  capability: 'crewmap-hz/1',
  /** Regular kind (relays store it until its NIP-40 expiration), distinct from the crew carrier kinds. */
  kind: 1421,
  topicTag: 'crewmap-hz',
  topicPrecision: 4,
  cellPrecision: 7,
  timeQuantumS: 120,
  headingSectors: 8,
  powBits: 16,
  /** Clock skew tolerated on created_at. */
  futureSkewS: 300,
  /** Most reports accepted per (cell, type family) per window, and per topic cell per window. */
  perCellMax: 3,
  perTopicMax: 60,
  windowMs: 10 * 60_000,
  /** Votes counted per report. */
  maxVotesPerReport: 20,
  /** Report TTL is the type's default, never more than this (police leave). */
  maxTtlMs: 6 * 3600_000,
  /** Long-lived types (cameras, potholes) are not useful as anonymous reports: they would live for weeks. */
  types: FRIEND_REPORT_TYPES.filter((t) => t !== 'pothole') as FriendReportType[],
  publish: { minGapMs: 60_000, maxPerHour: 10, votesPerHour: 30 },
  /** Base reliability (0–10) of one anonymous report; votes move it. */
  baseReliability: 4,
};

export interface AnonEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface AnonReportInput {
  type: FriendReportType;
  lat: number;
  lng: number;
  heading: number | null;
}

export function anonTtlMs(type: FriendReportType): number {
  return Math.min(ANON.maxTtlMs, DEFAULT_TTL_MS[type]);
}

const sectorOf = (heading: number | null): number | null =>
  heading === null || !Number.isFinite(heading) ? null : Math.round((((heading % 360) + 360) % 360) / (360 / ANON.headingSectors)) % ANON.headingSectors;

const quantS = (now: number): number => Math.floor(now / 1000 / ANON.timeQuantumS) * ANON.timeQuantumS;

/** Fresh one-shot key → template → proof of work → signature. Nothing about the device goes in. */
function sealed(content: object, cell: string, created: number, ttlMs: number, extra: string[][], bits: number): AnonEvent {
  const sk = generateSecretKey();
  const tmpl = {
    kind: ANON.kind,
    created_at: created,
    pubkey: getPublicKey(sk),
    tags: [['t', ANON.topicTag], ['g', cell.slice(0, ANON.topicPrecision)], ['cap', ANON.capability], ['expiration', String(created + Math.round(ttlMs / 1000))], ...extra],
    content: JSON.stringify(content),
  };
  const mined = minePow(tmpl, bits, { keepCreatedAt: true });
  const ev = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, sk) as AnonEvent;
  sk.fill(0);
  return ev;
}

export function buildAnonReport(r: AnonReportInput, now: number, bits = ANON.powBits): AnonEvent {
  const cell = geohashEncode(r, ANON.cellPrecision);
  return sealed({ v: ANON.version, t: r.type, c: cell, h: sectorOf(r.heading) }, cell, quantS(now), anonTtlMs(r.type), [], bits);
}

/** "Still there?" answer for an anonymous report (+1 yes, −1 gone). */
export function buildAnonVote(report: Pick<ParsedAnonReport, 'eventId' | 'cell' | 'expiresAt'>, up: boolean, now: number, bits = ANON.powBits): AnonEvent {
  const created = quantS(now);
  return sealed({ v: ANON.version, vote: up ? 1 : -1 }, report.cell, created, Math.max(60_000, report.expiresAt - created * 1000), [['e', report.eventId]], bits);
}

export interface ParsedAnonReport {
  eventId: string;
  pubkey: string;
  type: FriendReportType;
  cell: string;
  center: LatLng;
  uncertaintyM: number;
  heading: number | null;
  at: number;
  expiresAt: number;
}

export interface ParsedAnonVote {
  eventId: string;
  pubkey: string;
  target: string;
  up: boolean;
}

/** Verifies id + signature on a clean copy (nostr-tools caches a verified flag on the object, which copies carry). */
const verifyFresh = (e: AnonEvent): boolean =>
  verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

const tag = (ev: AnonEvent, k: string): string | undefined => ev.tags.find((t) => t[0] === k)?.[1];

/** Envelope checks shared by reports and votes: kind, topic, capability, PoW, signature, expiry, clock. */
function envelopeOk(ev: AnonEvent, nowS: number, bits: number, verify: (e: AnonEvent) => boolean): boolean {
  if (ev.kind !== ANON.kind || tag(ev, 't') !== ANON.topicTag || tag(ev, 'cap') !== ANON.capability) return false;
  if (getPow(ev.id) < bits) return false;
  const exp = Number(tag(ev, 'expiration'));
  if (!Number.isFinite(exp) || exp <= nowS || ev.created_at > nowS + ANON.futureSkewS) return false;
  return verify(ev);
}

/**
 * Validates an incoming event. Unknown versions, missing PoW, bad signatures, a topic that does not contain the cell,
 * an expiry longer than the type allows, or extra identifying fields are all rejected.
 */
export function parseAnonEvent(ev: AnonEvent, now: number, bits = ANON.powBits, verify: (e: AnonEvent) => boolean = verifyFresh): ParsedAnonReport | ParsedAnonVote | null {
  const nowS = Math.floor(now / 1000);
  if (!envelopeOk(ev, nowS, bits, verify)) return null;
  let c: unknown;
  try {
    c = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  if (o.v !== ANON.version) return null;
  const allowed = 'vote' in o ? ['v', 'vote'] : ['v', 't', 'c', 'h'];
  if (Object.keys(o).some((k) => !allowed.includes(k))) return null;
  if ('vote' in o) {
    const target = tag(ev, 'e');
    if ((o.vote !== 1 && o.vote !== -1) || !target || !/^[0-9a-f]{64}$/.test(target)) return null;
    return { eventId: ev.id, pubkey: ev.pubkey, target, up: o.vote === 1 };
  }
  const type = o.t as FriendReportType;
  if (!ANON.types.includes(type)) return null;
  const cell = typeof o.c === 'string' ? o.c : '';
  if (cell.length !== ANON.cellPrecision || cell.slice(0, ANON.topicPrecision) !== tag(ev, 'g')) return null;
  const box = geohashDecode(cell);
  if (!box) return null;
  const h = o.h;
  if (h !== null && (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h >= ANON.headingSectors)) return null;
  const exp = Number(tag(ev, 'expiration')) * 1000;
  const at = ev.created_at * 1000;
  if (exp - at > anonTtlMs(type) + 1000) return null;
  return {
    eventId: ev.id,
    pubkey: ev.pubkey,
    type,
    cell,
    center: box.center,
    uncertaintyM: Math.round(haversineM({ lat: box.south, lng: box.west }, { lat: box.north, lng: box.east }) / 2),
    heading: h === null ? null : (h as number) * (360 / ANON.headingSectors),
    at,
    expiresAt: exp,
  };
}

export const isAnonVote = (p: ParsedAnonReport | ParsedAnonVote): p is ParsedAnonVote => 'target' in p;

/**
 * Received anonymous reports and votes (in memory; nothing is persisted or re-shared). Applies the acceptance caps
 * and turns live reports into hazards. Reports this device published are remembered in `own` so the announcer and
 * corroboration never count them.
 */
export class AnonHazardStore {
  private readonly reports = new Map<string, ParsedAnonReport>();
  private readonly votes = new Map<string, Map<string, boolean>>();
  private readonly pendingVotes = new Map<string, Map<string, boolean>>();
  readonly own = new Set<string>();

  /** Returns true when the event was new and accepted. */
  ingest(ev: AnonEvent, now: number, bits = ANON.powBits, verify?: (e: AnonEvent) => boolean): boolean {
    if (this.reports.has(ev.id)) return false;
    const p = parseAnonEvent(ev, now, bits, verify);
    if (!p) return false;
    this.prune(now);
    if (isAnonVote(p)) {
      // Relays replay newest-first, so votes can arrive before their target report: buffer briefly instead of dropping.
      if (!this.reports.has(p.target)) {
        let pv = this.pendingVotes.get(p.target);
        if (!pv) {
          if (this.pendingVotes.size >= 200) {
            const oldest = this.pendingVotes.keys().next().value;
            if (oldest !== undefined) this.pendingVotes.delete(oldest);
          }
          pv = new Map<string, boolean>();
          this.pendingVotes.set(p.target, pv);
        }
        if (pv.has(p.pubkey) || pv.size >= ANON.maxVotesPerReport) return false;
        pv.set(p.pubkey, p.up);
        return true;
      }
      const v = this.votes.get(p.target) ?? new Map<string, boolean>();
      if (v.has(p.pubkey) || v.size >= ANON.maxVotesPerReport) return false;
      v.set(p.pubkey, p.up);
      this.votes.set(p.target, v);
      return true;
    }
    const fam = TYPE_FAMILY[p.type];
    const topic = p.cell.slice(0, ANON.topicPrecision);
    let cellCount = 0;
    let topicCount = 0;
    for (const r of this.reports.values()) {
      if (r.at < p.at - ANON.windowMs || r.at > p.at + ANON.windowMs) continue;
      if (r.cell === p.cell && TYPE_FAMILY[r.type] === fam) {
        if (++cellCount >= ANON.perCellMax) return false;
      }
      if (r.cell.slice(0, ANON.topicPrecision) === topic) {
        if (++topicCount >= ANON.perTopicMax) return false;
      }
    }
    this.reports.set(p.eventId, p);
    const buffered = this.pendingVotes.get(p.eventId);
    if (buffered) {
      this.pendingVotes.delete(p.eventId);
      this.votes.set(p.eventId, buffered);
    }
    return true;
  }

  markOwn(eventId: string): void {
    this.own.add(`anon:${eventId}`);
    if (this.own.size > 500) {
      const oldest = this.own.values().next().value;
      if (oldest !== undefined) this.own.delete(oldest);
    }
  }

  get(eventId: string): ParsedAnonReport | undefined {
    return this.reports.get(eventId);
  }

  prune(now: number): void {
    for (const [id, r] of this.reports) {
      if (this.expiresAt(r, this.score(id)) <= now) {
        this.reports.delete(id);
        this.votes.delete(id);
      }
    }
  }

  private score(id: string): { up: number; down: number } {
    const v = this.votes.get(id);
    if (!v) return { up: 0, down: 0 };
    let up = 0;
    let down = 0;
    for (const ok of v.values()) {
      if (ok) up++;
      else down++;
    }
    return { up, down };
  }

  /** "Still there?" yes extends the report by half its TTL (at most twice its TTL in total), like crew reports. */
  private expiresAt(r: ParsedAnonReport, sc: { up: number; down: number }): number {
    const ttl = r.expiresAt - r.at;
    if (sc.down >= sc.up + 2) return 0;
    return Math.min(r.at + 2 * ttl, r.expiresAt + (sc.up * ttl) / 2);
  }

  hazards(now: number): Hazard[] {
    const out: Hazard[] = [];
    for (const r of this.reports.values()) {
      const sc = this.score(r.eventId);
      const exp = this.expiresAt(r, sc);
      if (exp <= now) continue;
      out.push({
        id: `anon:${r.eventId}`,
        source: 'anon',
        type: r.type,
        subtype: null,
        lat: r.center.lat,
        lng: r.center.lng,
        heading: r.heading,
        street: null,
        reportedAt: r.at,
        expiresAt: exp,
        reliability: Math.max(0, Math.min(10, ANON.baseReliability + sc.up - 2 * sc.down)),
        confirmations: sc.up,
        uncertaintyM: r.uncertaintyM,
      });
    }
    return out;
  }
}

/** Local publish limiter (the network-side caps protect others; this keeps an honest client well inside them). */
export class AnonRateLimit {
  private reports: number[] = [];
  private votes: number[] = [];

  canReport(now: number): boolean {
    this.reports = this.reports.filter((t) => now - t < 3600_000);
    const last = this.reports[this.reports.length - 1];
    return this.reports.length < ANON.publish.maxPerHour && (last === undefined || now - last >= ANON.publish.minGapMs);
  }

  noteReport(now: number): void {
    this.reports.push(now);
  }

  canVote(now: number): boolean {
    this.votes = this.votes.filter((t) => now - t < 3600_000);
    return this.votes.length < ANON.publish.votesPerHour;
  }

  noteVote(now: number): void {
    this.votes.push(now);
  }
}

/** Nostr subscription filter for the topic cells along a route (or around a position). */
export function anonFilter(topics: string[], sinceS: number): { kinds: number[]; '#t': string[]; '#g': string[]; since: number } {
  return { kinds: [ANON.kind], '#t': [ANON.topicTag], '#g': topics, since: sinceS };
}
