import type { Router } from './router';
import { fromUtf8, utf8 } from './crypto/sodium';
import { peerSupports, type PeerProtocol } from './protocol';

/** A viewer's "watching" claim lasts this long unless renewed; renewals come every WATCH_RENEW_MS while open. */
export const WATCH_TTL_MS = 150_000;
export const WATCH_RENEW_MS = 120_000;

/**
 * Viewer demand (protocol 4, `viewerDemand` cap): a phone with the app open tells its crew "watching until t", and a
 * phone that stops watching says so. Senders use `watched()` to pick their background presence cadence, and
 * `onDemand` to publish a fresh position the moment someone starts looking. Peers known to run an older build (their
 * presence lacks the cap) always count as watching, so they never see slower updates than before.
 */
export class ViewerDemand {
  private readonly until = new Map<string, number>();
  private readonly listeners = new Set<(viewer: string) => void>();
  private renew: ReturnType<typeof setInterval> | null = null;
  private open = false;

  constructor(
    private readonly router: Router,
    private readonly members: () => string[],
    private readonly protocolOf: (deviceId: string) => PeerProtocol | null,
    private readonly now: () => number = Date.now,
  ) {
    router.on('watch', (m) => {
      let u: number;
      try {
        u = Number((JSON.parse(fromUtf8(m.payload)) as { u?: unknown }).u) || 0;
      } catch {
        return;
      }
      const was = (this.until.get(m.sender) ?? 0) > this.now();
      // Clamp: a peer's clock (or a bad payload) can't keep us in the fast cadence for longer than one TTL.
      this.until.set(m.sender, Math.min(u, this.now() + WATCH_TTL_MS));
      if (!was && u > this.now()) for (const l of this.listeners) l(m.sender);
    });
  }

  /** Whether any crew member is looking (or might be: older builds). */
  watched(): boolean {
    const t = this.now();
    for (const id of this.members()) {
      if ((this.until.get(id) ?? 0) > t) return true;
      if (peerSupports(this.protocolOf(id), 'viewerDemand') === false) return true;
    }
    return false;
  }

  /** My app came to the foreground (true) or left it (false). */
  setForeground(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    void this.send(open);
    if (open) this.renew = setInterval(() => void this.send(true), WATCH_RENEW_MS);
  }

  onDemand(cb: (viewer: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stop(): void {
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    this.open = false;
  }

  private async send(open: boolean): Promise<void> {
    if (this.members().length === 0) return;
    await this.router.broadcast('watch', utf8(JSON.stringify({ u: open ? this.now() + WATCH_TTL_MS : 0 }))).catch(() => undefined);
  }
}
