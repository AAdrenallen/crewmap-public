import * as Y from 'yjs';
import type { Router } from './router';

export interface DocPersistence {
  /** Compacted state saved earlier, or null. */
  load(): Promise<Uint8Array | null>;
  /** Append an incremental update (cheap); compact occasionally. */
  append(update: Uint8Array): Promise<void>;
  compact(state: Uint8Array): Promise<void>;
}

export const REMOTE = 'remote';
const COMPACT_EVERY = 200;
/** Relays commonly cap events around 64 KB; leave room for base64 + envelope overhead. */
export const MAX_UPDATE_BYTES = 40_000;

/**
 * Keeps one Y.Doc per circle in sync over the router: local edits broadcast as durable 'sync-update' events (offline
 * peers catch up from relays within 7 days); on (re)connect peers exchange state vectors and send each other diffs.
 */
export class CircleSync {
  private appended = 0;
  private offUpdate: (() => void) | null = null;
  private readonly offs: (() => void)[] = [];
  readonly stats = { sent: 0, applied: 0, diffsSent: 0, oversized: 0 };

  constructor(
    readonly doc: Y.Doc,
    private readonly router: Router,
    private readonly persist: DocPersistence,
  ) {}

  async start(): Promise<void> {
    const saved = await this.persist.load();
    if (saved) Y.applyUpdate(this.doc, saved, REMOTE);
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      void this.persist.append(update).then(() => this.maybeCompact());
      if (origin === REMOTE) return;
      if (update.length > MAX_UPDATE_BYTES) {
        // Too big for one relay event: peers will fetch it as a diff during the next state-vector exchange.
        this.stats.oversized++;
        void this.announce();
        return;
      }
      this.stats.sent++;
      void this.router.broadcast('sync-update', update);
    };
    this.doc.on('update', onUpdate);
    this.offUpdate = () => this.doc.off('update', onUpdate);
    this.offs.push(
      this.router.on('sync-update', (m) => this.apply(m.payload)),
      this.router.on('sync-diff', (m) => this.apply(m.payload)),
      this.router.on('sync-sv', (m) => {
        const diff = Y.encodeStateAsUpdate(this.doc, m.payload);
        // An empty diff encodes to 2 bytes.
        if (diff.length > 2) {
          this.stats.diffsSent++;
          void this.router.sendTo(m.sender, 'sync-diff', diff);
        }
      }),
    );
    await this.announce();
  }

  /** Broadcast our state vector so peers send what we're missing (on start, reconnect, wake). */
  async announce(): Promise<void> {
    await this.router.broadcast('sync-sv', Y.encodeStateVector(this.doc));
  }

  stop(): void {
    this.offUpdate?.();
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  private apply(update: Uint8Array): void {
    try {
      Y.applyUpdate(this.doc, update, REMOTE);
      this.stats.applied++;
    } catch {
      // Malformed update from a (verified) member: ignore.
    }
  }

  private async maybeCompact(): Promise<void> {
    if (++this.appended < COMPACT_EVERY) return;
    this.appended = 0;
    await this.persist.compact(Y.encodeStateAsUpdate(this.doc));
  }
}

export class MemoryPersistence implements DocPersistence {
  private state: Uint8Array | null = null;
  private log: Uint8Array[] = [];
  async load(): Promise<Uint8Array | null> {
    if (!this.state && this.log.length === 0) return null;
    return Y.mergeUpdates([...(this.state ? [this.state] : []), ...this.log]);
  }
  async append(u: Uint8Array): Promise<void> {
    this.log.push(u);
  }
  async compact(s: Uint8Array): Promise<void> {
    this.state = s;
    this.log = [];
  }
}
