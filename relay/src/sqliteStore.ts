import { DatabaseSync } from 'node:sqlite';
import { matches, type EventStore, type Ev, type Filter } from './core.ts';

/** Persistent store on Node's built-in SQLite (no native dependency). */
export class SqliteStore implements EventStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, kind INTEGER NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS events_expires ON events(expires_at);
    `);
  }

  put(ev: Ev, expiresAt: number | null): void {
    this.db
      .prepare('INSERT OR IGNORE INTO events (id, kind, created_at, expires_at, json) VALUES (?, ?, ?, ?, ?)')
      .run(ev.id, ev.kind, ev.created_at, expiresAt, JSON.stringify(ev));
  }

  query(filters: Filter[], now: number): Ev[] {
    const since = Math.min(...filters.map((f) => f.since ?? 0));
    const limit = Math.min(...filters.map((f) => f.limit ?? 500));
    const rows = this.db
      .prepare('SELECT json FROM events WHERE created_at >= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC')
      .all(since, now) as { json: string }[];
    const out: Ev[] = [];
    for (const r of rows) {
      const ev = JSON.parse(r.json) as Ev;
      if (filters.some((f) => matches(ev, f))) out.push(ev);
      if (out.length >= limit) break;
    }
    return out;
  }

  purgeExpired(now: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now).changes);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }
}
