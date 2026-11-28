import { verifyEvent } from 'nostr-tools/pure';

/**
 * A minimal blind Nostr relay engine (NIP-01 + NIP-40 + ephemeral kinds). It never holds keys: it only checks
 * event signatures, stores regular events until they expire, and fans out ephemeral ones live.
 * Used by the optional central-PC relay (server.ts) and, in-process, by the multi-peer simulator.
 */

export interface Ev {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export interface EventStore {
  put(ev: Ev, expiresAt: number | null): void;
  query(filters: Filter[], now: number): Ev[];
  purgeExpired(now: number): number;
  count(): number;
}

export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function expirationOf(ev: Ev): number | null {
  const t = ev.tags.find((x) => x[0] === 'expiration');
  if (!t || t[1] === undefined) return null;
  const n = Number(t[1]);
  return Number.isFinite(n) ? n : null;
}

export function matches(ev: Ev, f: Filter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  for (const key of Object.keys(f)) {
    if (!key.startsWith('#')) continue;
    const want = f[key as `#${string}`];
    if (!want) continue;
    const name = key.slice(1);
    if (!ev.tags.some((t) => t[0] === name && t[1] !== undefined && want.includes(t[1]))) return false;
  }
  return true;
}

export class MemoryStore implements EventStore {
  private readonly events = new Map<string, { ev: Ev; exp: number | null }>();
  put(ev: Ev, expiresAt: number | null): void {
    this.events.set(ev.id, { ev, exp: expiresAt });
  }
  query(filters: Filter[], now: number): Ev[] {
    const out: Ev[] = [];
    for (const { ev, exp } of this.events.values()) {
      if (exp !== null && exp <= now) continue;
      if (filters.some((f) => matches(ev, f))) out.push(ev);
    }
    out.sort((a, b) => b.created_at - a.created_at);
    const limit = Math.min(...filters.map((f) => f.limit ?? 500));
    return out.slice(0, limit);
  }
  purgeExpired(now: number): number {
    let n = 0;
    for (const [id, { exp }] of this.events) {
      if (exp !== null && exp <= now) {
        this.events.delete(id);
        n++;
      }
    }
    return n;
  }
  count(): number {
    return this.events.size;
  }
}

export interface RelayOptions {
  /** Restrict to these kinds (the PC relay accepts only CrewMap kinds). */
  allowedKinds?: number[];
  /** Regular events must carry an expiration no later than this many seconds ahead. */
  maxTtlS?: number;
  maxEventBytes?: number;
  /** Skip signature checks (simulator speed). Never in production. */
  trustSignatures?: boolean;
  now?: () => number;
}

export type RelayOut = ['EVENT', string, Ev] | ['EOSE', string] | ['OK', string, boolean, string] | ['NOTICE', string] | ['CLOSED', string, string];

interface Sub {
  conn: string;
  id: string;
  filters: Filter[];
}

export class RelayCore {
  private readonly subs = new Map<string, Sub>();
  private readonly connSubs = new Map<string, Set<string>>();
  private readonly senders = new Map<string, (m: RelayOut) => void>();
  readonly stats = { accepted: 0, rejected: 0, delivered: 0 };

  private readonly store: EventStore;
  private readonly opts: RelayOptions;

  constructor(store: EventStore, opts: RelayOptions = {}) {
    this.store = store;
    this.opts = opts;
  }

  private nowS(): number {
    return Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
  }

  connect(conn: string, send: (m: RelayOut) => void): void {
    this.senders.set(conn, send);
  }

  disconnect(conn: string): void {
    this.senders.delete(conn);
    const keys = this.connSubs.get(conn);
    if (keys) {
      for (const k of keys) this.subs.delete(k);
      this.connSubs.delete(conn);
    }
  }

  /** Handle one client message (already JSON-parsed). */
  handle(conn: string, msg: unknown): void {
    const send = this.senders.get(conn);
    if (!send || !Array.isArray(msg)) return;
    const [type] = msg as [string];
    if (type === 'EVENT') this.onEvent(send, msg[1] as Ev);
    else if (type === 'REQ') this.onReq(conn, send, msg[1] as string, msg.slice(2) as Filter[]);
    else if (type === 'CLOSE') {
      const k = `${conn}:${msg[1] as string}`;
      this.subs.delete(k);
      this.connSubs.get(conn)?.delete(k);
    } else send(['NOTICE', 'unsupported message']);
  }

  private onEvent(send: (m: RelayOut) => void, ev: Ev): void {
    const reject = (why: string) => {
      this.stats.rejected++;
      send(['OK', ev?.id ?? '', false, why]);
    };
    if (!ev || typeof ev.id !== 'string') return reject('invalid: malformed');
    if (this.opts.allowedKinds && !this.opts.allowedKinds.includes(ev.kind)) return reject('blocked: kind not allowed');
    if (JSON.stringify(ev).length > (this.opts.maxEventBytes ?? 64 * 1024)) return reject('invalid: too large');
    if (!this.opts.trustSignatures && !verifyEvent({ ...ev })) return reject('invalid: bad signature');
    const now = this.nowS();
    const exp = expirationOf(ev);
    if (exp !== null && exp <= now) return reject('invalid: event is expired');
    if (!isEphemeral(ev.kind)) {
      if (this.opts.maxTtlS !== undefined && (exp === null || exp - now > this.opts.maxTtlS)) {
        return reject('blocked: expiration required within relay limit');
      }
      this.store.put(ev, exp);
    }
    this.stats.accepted++;
    send(['OK', ev.id, true, '']);
    for (const s of this.subs.values()) {
      if (s.filters.some((f) => matches(ev, f))) {
        this.stats.delivered++;
        this.senders.get(s.conn)?.(['EVENT', s.id, ev]);
      }
    }
  }

  private onReq(conn: string, send: (m: RelayOut) => void, id: string, filters: Filter[]): void {
    const k = `${conn}:${id}`;
    this.subs.set(k, { conn, id, filters });
    let set = this.connSubs.get(conn);
    if (!set) this.connSubs.set(conn, (set = new Set()));
    set.add(k);
    for (const ev of this.store.query(filters, this.nowS())) {
      this.stats.delivered++;
      send(['EVENT', id, ev]);
    }
    send(['EOSE', id]);
  }

  purge(): number {
    return this.store.purgeExpired(this.nowS());
  }
}
