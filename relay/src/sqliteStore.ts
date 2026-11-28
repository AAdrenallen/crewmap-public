import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { matches, type EventStore, type Ev, type Filter } from './core.ts';

/** Persistent store on Node's built-in SQLite (no native dependency), with indexed `#t` tag lookup. */
export class SqliteStore implements EventStore {
  private readonly db: DatabaseSync;
  private readonly stmtPut: StatementSync;
  private readonly stmtPutTag: StatementSync;
  private readonly stmtQueryAll: StatementSync;
  private readonly stmtPurge: StatementSync;
  private readonly stmtPurgeTags: StatementSync;
  private readonly stmtCount: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, kind INTEGER NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS events_expires ON events(expires_at);
      CREATE INDEX IF NOT EXISTS events_kind_created ON events(kind, created_at);
      CREATE TABLE IF NOT EXISTS event_tags (
        tag TEXT NOT NULL, val TEXT NOT NULL, event_id TEXT NOT NULL,
        PRIMARY KEY (tag, val, event_id)
      );
      CREATE INDEX IF NOT EXISTS event_tags_event ON event_tags(event_id);
    `);
    this.stmtPut = this.db.prepare('INSERT OR IGNORE INTO events (id, kind, created_at, expires_at, json) VALUES (?, ?, ?, ?, ?)');
    this.stmtPutTag = this.db.prepare('INSERT OR IGNORE INTO event_tags (tag, val, event_id) VALUES (?, ?, ?)');
    this.stmtQueryAll = this.db.prepare(
      'SELECT json FROM events WHERE created_at >= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
    );
    this.stmtPurgeTags = this.db.prepare(
      'DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?)',
    );
    this.stmtPurge = this.db.prepare('DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?');
    this.stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM events');
  }

  put(ev: Ev, expiresAt: number | null): void {
    const res = this.stmtPut.run(ev.id, ev.kind, ev.created_at, expiresAt, JSON.stringify(ev));
    if (Number(res.changes) > 0) {
      for (const t of ev.tags) {
        if (t[0] && t[0].length === 1 && t[1] !== undefined) this.stmtPutTag.run(t[0], t[1], ev.id);
      }
    }
  }

  query(filters: Filter[], now: number): Ev[] {
    if (filters.length === 0) return [];
    const since = Math.min(...filters.map((f) => f.since ?? 0));
    const limit = Math.min(...filters.map((f) => f.limit ?? 500));
    // Fast indexed path when every filter constrains `#t` (all CrewMap subscriptions).
    const allHaveT = filters.every((f) => Array.isArray(f['#t']) && f['#t'].length > 0);
    let rows: { json: string }[];
    if (allHaveT) {
      const vals = [...new Set(filters.flatMap((f) => f['#t']!))];
      const ph = vals.map(() => '?').join(',');
      rows = this.db
        .prepare(
          `SELECT DISTINCT e.json, e.created_at FROM events e JOIN event_tags et ON et.event_id = e.id ` +
            `WHERE et.tag = 't' AND et.val IN (${ph}) AND e.created_at >= ? AND (e.expires_at IS NULL OR e.expires_at > ?) ` +
            `ORDER BY e.created_at DESC`,
        )
        .all(...vals, since, now) as { json: string }[];
    } else {
      rows = this.stmtQueryAll.all(since, now) as { json: string }[];
    }
    const out: Ev[] = [];
    for (const r of rows) {
      const ev = JSON.parse(r.json) as Ev;
      if (filters.some((f) => matches(ev, f))) out.push(ev);
      if (out.length >= limit) break;
    }
    return out;
  }

  purgeExpired(now: number): number {
    this.stmtPurgeTags.run(now);
    return Number(this.stmtPurge.run(now).changes);
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n;
  }
}
