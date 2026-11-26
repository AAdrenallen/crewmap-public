import { MemoryStore, RelayCore, type Ev, type Filter } from '@crewmap/relay';
import type { NostrEvent, RelayPool } from '../src/transport/types';

/**
 * Minimal synchronous in-memory relay network for unit tests (the multi-peer simulator in tools/replay adds
 * latency, loss and outages). `online[phone] = false` drops that phone's traffic; `reconnect()` replays stored events.
 */
export class TestNet {
  readonly core = new RelayCore(new MemoryStore(), { trustSignatures: true });
  readonly online = new Map<string, boolean>();
  readonly published: NostrEvent[] = [];
  private seq = 0;

  pool(phone: string): RelayPool & { reconnect(): void } {
    const subs: { filter: Filter; cb: (e: NostrEvent) => void; conn: string | null }[] = [];
    const attach = (s: (typeof subs)[number]) => {
      const conn = `${phone}:${this.seq++}`;
      s.conn = conn;
      this.core.connect(conn, (m) => {
        if (m[0] === 'EVENT' && this.online.get(phone) !== false) s.cb(m[2] as unknown as NostrEvent);
      });
      this.core.handle(conn, ['REQ', 's', s.filter]);
    };
    return {
      publish: (_relays, ev) => {
        if (this.online.get(phone) === false) return [Promise.reject(new Error('offline'))];
        this.published.push(ev);
        const conn = `pub:${this.seq++}`;
        this.core.connect(conn, () => undefined);
        this.core.handle(conn, ['EVENT', ev as unknown as Ev]);
        this.core.disconnect(conn);
        return [Promise.resolve('ok')];
      },
      subscribe: (_relays, filter, params) => {
        const s = { filter: filter as Filter, cb: params.onevent, conn: null as string | null };
        subs.push(s);
        attach(s);
        return { close: () => s.conn && this.core.disconnect(s.conn) };
      },
      reconnect: () => {
        for (const s of subs) {
          if (s.conn) this.core.disconnect(s.conn);
          attach(s);
        }
      },
    };
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
