import * as SQLite from 'expo-sqlite';
import type { ChatPersistence, ChatStatus, CircleOp, StoredChat } from '@crewmap/p2p';
import { simplifyToCount, type Trip } from '@crewmap/shared/driving';
import { decodePolyline, encodePolyline, type LatLng } from '@crewmap/shared/geo';
import type { RouteTrace } from '@crewmap/shared/navigation';
import type { Place } from '@crewmap/shared/places';
import type { TripSummary, Visit, WalkSummary } from '@crewmap/shared/stats';

/**
 * On-device store. Raw location/trip history never leaves the phone (except inside the owner's encrypted backup).
 * Schema changes go through MIGRATIONS (append-only).
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS circle_ops (circle_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (circle_id, seq));
   CREATE TABLE IF NOT EXISTS ydoc (id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, kind TEXT NOT NULL, data BLOB NOT NULL);
   CREATE INDEX IF NOT EXISTS ydoc_circle ON ydoc(circle_id);
   CREATE TABLE IF NOT EXISTS trips (
     id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, distance_m REAL NOT NULL,
     duration_s REAL NOT NULL, top_kph INTEGER NOT NULL, avg_kph INTEGER NOT NULL, score INTEGER, passenger INTEGER NOT NULL DEFAULT 0,
     events TEXT NOT NULL, points TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS trips_started ON trips(started_at);
   CREATE TABLE IF NOT EXISTS walks (started_at INTEGER PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL, distance_m REAL NOT NULL, kind TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS visits (t INTEGER NOT NULL, place_key TEXT NOT NULL, city TEXT, lat REAL NOT NULL, lng REAL NOT NULL);
   CREATE INDEX IF NOT EXISTS visits_t ON visits(t);
   CREATE TABLE IF NOT EXISTS history (t INTEGER PRIMARY KEY NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, speed REAL);
   CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS hazards (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS geocache (key TEXT PRIMARY KEY NOT NULL, city TEXT, t INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS bench (t INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS route_traces (
     trip_id TEXT PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL, distance_m REAL NOT NULL, poly TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS route_traces_ended ON route_traces(ended_at);`,
  `CREATE TABLE IF NOT EXISTS chat (
     id TEXT PRIMARY KEY NOT NULL, thread TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, text TEXT NOT NULL, t INTEGER NOT NULL,
     mine INTEGER NOT NULL, status TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS chat_thread ON chat(thread, t);`,
  // Simplified polyline (~40 points, precision 5) so the drives list never loads full point arrays.
  `ALTER TABLE trips ADD COLUMN poly TEXT;`,
];

let db: SQLite.SQLiteDatabase | null = null;

export async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  const d = await SQLite.openDatabaseAsync('crewmap.db');
  await d.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await d.execAsync('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL);');
  const row = await d.getFirstAsync<{ v: number }>('SELECT v FROM schema_version LIMIT 1');
  let v = row?.v ?? 0;
  for (; v < MIGRATIONS.length; v++) await d.execAsync(MIGRATIONS[v]!);
  await d.execAsync('DELETE FROM schema_version;');
  await d.runAsync('INSERT INTO schema_version (v) VALUES (?)', v);
  db = d;
  return d;
}

/** expo-sqlite allows one transaction at a time per connection: serialise every transactional write. */
let txQueue: Promise<unknown> = Promise.resolve();
function tx(fn: () => Promise<void>): Promise<void> {
  const run = txQueue.then(() => the().withTransactionAsync(fn));
  txQueue = run.catch(() => undefined);
  return run;
}

function the(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('db not open');
  return db;
}

// --- kv -------------------------------------------------------------------------------------------------------------

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const r = await the().getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

// --- circle log -----------------------------------------------------------------------------------------------------

export async function loadCircleOps(circleId: string): Promise<CircleOp[]> {
  const rows = await the().getAllAsync<{ json: string }>('SELECT json FROM circle_ops WHERE circle_id = ? ORDER BY seq', circleId);
  return rows.map((r) => JSON.parse(r.json) as CircleOp);
}

export async function saveCircleOps(circleId: string, ops: CircleOp[]): Promise<void> {
  await tx(async () => {
    await the().runAsync('DELETE FROM circle_ops WHERE circle_id = ?', circleId);
    for (const op of ops) await the().runAsync('INSERT INTO circle_ops (circle_id, seq, json) VALUES (?, ?, ?)', circleId, op.seq, JSON.stringify(op));
  });
}

/** Leaving a crew: drop its log and its doc from this phone. */
export async function deleteCircleData(circleId: string): Promise<void> {
  await tx(async () => {
    await the().runAsync('DELETE FROM circle_ops WHERE circle_id = ?', circleId);
    await the().runAsync('DELETE FROM ydoc WHERE circle_id = ?', circleId);
  });
}

// --- Y.Doc persistence ----------------------------------------------------------------------------------------------

export const ydocStore = (circleId: string) => ({
  load: async (): Promise<Uint8Array | null> => {
    const rows = await the().getAllAsync<{ kind: string; data: Uint8Array }>('SELECT kind, data FROM ydoc WHERE circle_id = ? ORDER BY id', circleId);
    if (rows.length === 0) return null;
    const { mergeUpdates } = await import('yjs');
    const merged = mergeUpdates(rows.map((r) => r.data));
    // The per-session compaction counter resets on every launch, so a doc edited a little each session never
    // compacts and startup replays hundreds of rows; fold them into one state row here.
    if (rows.length > 40) {
      await tx(async () => {
        await the().runAsync('DELETE FROM ydoc WHERE circle_id = ?', circleId);
        await the().runAsync('INSERT INTO ydoc (circle_id, kind, data) VALUES (?, ?, ?)', circleId, 'state', merged);
      });
    }
    return merged;
  },
  append: async (u: Uint8Array) => {
    await the().runAsync('INSERT INTO ydoc (circle_id, kind, data) VALUES (?, ?, ?)', circleId, 'update', u);
  },
  compact: async (state: Uint8Array) => {
    await tx(async () => {
      await the().runAsync('DELETE FROM ydoc WHERE circle_id = ?', circleId);
      await the().runAsync('INSERT INTO ydoc (circle_id, kind, data) VALUES (?, ?, ?)', circleId, 'state', state);
    });
  },
});

// --- trips / walks / visits / history ------------------------------------------------------------------------------

export async function saveTrip(t: Trip): Promise<void> {
  const counts: Record<string, number> = {};
  for (const e of t.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  await the().runAsync(
    `INSERT OR REPLACE INTO trips (id, started_at, ended_at, distance_m, duration_s, top_kph, avg_kph, score, passenger, events, points, poly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id, t.startedAt, t.endedAt, t.distanceM, t.durationS, t.topSpeedKph, t.avgSpeedKph, t.score, t.passenger ? 1 : 0,
    JSON.stringify(t.events), JSON.stringify(t.points), encodePolyline(simplifyToCount(t.points), 5),
  );
}

export async function loadTrip(id: string): Promise<Trip | null> {
  const r = await the().getFirstAsync<{
    id: string; started_at: number; ended_at: number; distance_m: number; duration_s: number; top_kph: number;
    avg_kph: number; score: number | null; passenger: number; events: string; points: string;
  }>('SELECT * FROM trips WHERE id = ?', id);
  if (!r) return null;
  return {
    id: r.id, startedAt: r.started_at, endedAt: r.ended_at, distanceM: r.distance_m, durationS: r.duration_s,
    topSpeedKph: r.top_kph, avgSpeedKph: r.avg_kph, score: r.score, passenger: r.passenger === 1,
    events: JSON.parse(r.events), points: JSON.parse(r.points),
  };
}

export async function tripSummaries(since = 0): Promise<TripSummary[]> {
  const rows = await the().getAllAsync<{
    id: string; started_at: number; ended_at: number; distance_m: number; duration_s: number; top_kph: number;
    avg_kph: number; score: number | null; passenger: number; events: string;
  }>('SELECT id, started_at, ended_at, distance_m, duration_s, top_kph, avg_kph, score, passenger, events FROM trips WHERE started_at >= ? ORDER BY started_at DESC', since);
  return rows.map((r) => {
    const counts: TripSummary['events'] = {};
    for (const e of JSON.parse(r.events) as { kind: keyof TripSummary['events'] }[]) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return {
      id: r.id, startedAt: r.started_at, endedAt: r.ended_at, distanceM: r.distance_m, durationS: r.duration_s,
      topSpeedKph: r.top_kph, avgSpeedKph: r.avg_kph, score: r.score, passenger: r.passenger === 1, events: counts,
    };
  });
}

export type TripListItem = TripSummary & { thumb: LatLng[] };

/** Summaries plus the stored thumbnail polyline; never reads the full points column. */
export async function tripList(): Promise<TripListItem[]> {
  const [sums, polys] = await Promise.all([
    tripSummaries(),
    the().getAllAsync<{ id: string; poly: string | null }>('SELECT id, poly FROM trips'),
  ]);
  const byId = new Map(polys.map((r) => [r.id, r.poly]));
  return sums.map((s) => {
    const p = byId.get(s.id);
    return { ...s, thumb: p ? decodePolyline(p, 5) : [] };
  });
}

let backfilling: Promise<number> | null = null;
/** One-time lazy backfill of thumbnails for trips saved before the poly column; one row at a time to stay light. */
export function backfillTripPolys(): Promise<number> {
  backfilling ??= (async () => {
    let n = 0;
    const ids = await the().getAllAsync<{ id: string }>('SELECT id FROM trips WHERE poly IS NULL');
    for (const { id } of ids) {
      const r = await the().getFirstAsync<{ points: string }>('SELECT points FROM trips WHERE id = ?', id);
      const pts = r ? (JSON.parse(r.points) as LatLng[]) : [];
      await the().runAsync('UPDATE trips SET poly = ? WHERE id = ?', encodePolyline(simplifyToCount(pts), 5), id);
      n++;
      await new Promise((res) => setTimeout(res, 0));
    }
    return n;
  })().finally(() => {
    backfilling = null;
  });
  return backfilling;
}

interface TraceRow {
  trip_id: string;
  ended_at: number;
  distance_m: number;
  poly: string;
}
export interface DeletedTrip {
  trip: Trip;
  trace: TraceRow | null;
}

/** Removes the trip and its learned route trace; the result restores both via restoreTrip. */
export async function deleteTrip(id: string): Promise<DeletedTrip | null> {
  const trip = await loadTrip(id);
  if (!trip) return null;
  const trace = await the().getFirstAsync<TraceRow>('SELECT * FROM route_traces WHERE trip_id = ?', id);
  await tx(async () => {
    await the().runAsync('DELETE FROM trips WHERE id = ?', id);
    await the().runAsync('DELETE FROM route_traces WHERE trip_id = ?', id);
  });
  return { trip, trace: trace ?? null };
}

export async function restoreTrip(d: DeletedTrip): Promise<void> {
  await saveTrip(d.trip);
  if (d.trace) await the().runAsync('INSERT OR REPLACE INTO route_traces (trip_id, ended_at, distance_m, poly) VALUES (?, ?, ?, ?)', d.trace.trip_id, d.trace.ended_at, d.trace.distance_m, d.trace.poly);
}

export async function setPassenger(id: string, passenger: boolean, score: number | null): Promise<void> {
  await the().runAsync('UPDATE trips SET passenger = ?, score = ? WHERE id = ?', passenger ? 1 : 0, score, id);
}

export async function saveWalk(w: WalkSummary): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO walks (started_at, ended_at, distance_m, kind) VALUES (?, ?, ?, ?)', w.startedAt, w.endedAt, w.distanceM, w.kind);
}

export async function walks(): Promise<WalkSummary[]> {
  const rows = await the().getAllAsync<{ started_at: number; ended_at: number; distance_m: number; kind: 'walk' | 'run' }>('SELECT * FROM walks');
  return rows.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at, distanceM: r.distance_m, kind: r.kind }));
}

export async function saveVisit(v: Visit & { lat: number; lng: number }): Promise<void> {
  await the().runAsync('INSERT INTO visits (t, place_key, city, lat, lng) VALUES (?, ?, ?, ?, ?)', v.t, v.placeKey, v.city, v.lat, v.lng);
}

export async function visits(): Promise<Visit[]> {
  const rows = await the().getAllAsync<{ t: number; place_key: string; city: string | null }>('SELECT t, place_key, city FROM visits');
  return rows.map((r) => ({ t: r.t, placeKey: r.place_key, city: r.city }));
}

export async function appendHistory(points: { t: number; lat: number; lng: number; accuracy: number; speed: number | null }[]): Promise<void> {
  if (points.length === 0) return;
  await tx(async () => {
    for (const p of points) await the().runAsync('INSERT OR IGNORE INTO history (t, lat, lng, acc, speed) VALUES (?, ?, ?, ?, ?)', p.t, p.lat, p.lng, p.accuracy, p.speed);
  });
}

/** Retention purge (X2): drop raw history, trips, walks and visits older than `days`. */
export async function purgeOlderThan(days: number, now: number): Promise<{ history: number; trips: number }> {
  const cutoff = now - days * 86_400_000;
  const h = await the().runAsync('DELETE FROM history WHERE t < ?', cutoff);
  const t = await the().runAsync('DELETE FROM trips WHERE ended_at < ?', cutoff);
  await the().runAsync('DELETE FROM walks WHERE ended_at < ?', cutoff);
  await the().runAsync('DELETE FROM route_traces WHERE ended_at < ?', cutoff);
  await the().runAsync('DELETE FROM visits WHERE t < ?', cutoff);
  await the().runAsync('DELETE FROM hazards WHERE expires_at < ?', now);
  await the().runAsync('DELETE FROM chat WHERE t < ?', cutoff);
  return { history: h.changes, trips: t.changes };
}

// --- learned routes (simplified driver-trip polylines; never sent to peers) -----------------------------------------

export async function saveRouteTrace(r: RouteTrace): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO route_traces (trip_id, ended_at, distance_m, poly) VALUES (?, ?, ?, ?)', r.tripId, r.endedAt, r.distanceM, encodePolyline(r.line, 5));
}

export async function deleteRouteTrace(tripId: string): Promise<void> {
  await the().runAsync('DELETE FROM route_traces WHERE trip_id = ?', tripId);
}

export async function routeTraces(): Promise<RouteTrace[]> {
  const rows = await the().getAllAsync<{ trip_id: string; ended_at: number; distance_m: number; poly: string }>('SELECT * FROM route_traces');
  return rows.map((r) => ({ tripId: r.trip_id, endedAt: r.ended_at, distanceM: r.distance_m, line: decodePolyline(r.poly, 5) }));
}

// --- places -----------------------------------------------------------------------------------------------------------

export async function savePlace(p: Place): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO places (id, json) VALUES (?, ?)', p.id, JSON.stringify(p));
}

export async function deletePlace(id: string): Promise<void> {
  await the().runAsync('DELETE FROM places WHERE id = ?', id);
}

export async function myPlaces(): Promise<Place[]> {
  const rows = await the().getAllAsync<{ json: string }>('SELECT json FROM places');
  return rows.map((r) => JSON.parse(r.json) as Place);
}

// --- outbox (acked messages survive restarts) -------------------------------------------------------------------------

export async function outboxPut(id: string, to: string, kind: string, payload: Uint8Array, at: number): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO outbox (id, to_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)', id, to, kind, payload, at);
}

export async function outboxDelete(id: string): Promise<void> {
  await the().runAsync('DELETE FROM outbox WHERE id = ?', id);
}

export async function outboxAll(): Promise<{ id: string; to_id: string; kind: string; payload: Uint8Array; created_at: number }[]> {
  return the().getAllAsync('SELECT * FROM outbox ORDER BY created_at');
}

// --- chat (local history only; never sent to peers) ----------------------------------------------------------------

type ChatRow = { id: string; thread: string; from_id: string; to_id: string | null; text: string; t: number; mine: number; status: string; read: number };

export const chatDb: ChatPersistence = {
  put: async (m: StoredChat) => {
    await the().runAsync(
      'INSERT OR IGNORE INTO chat (id, thread, from_id, to_id, text, t, mine, status, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      m.id, m.thread, m.from, m.to, m.text, m.t, m.mine ? 1 : 0, m.status, m.read ? 1 : 0,
    );
  },
  setStatus: async (id: string, status: ChatStatus) => {
    await the().runAsync('UPDATE chat SET status = ? WHERE id = ?', status, id);
  },
  markRead: async (thread: string) => {
    await the().runAsync('UPDATE chat SET read = 1 WHERE thread = ? AND read = 0', thread);
  },
  thread: async (thread: string) => {
    const rows = await the().getAllAsync<ChatRow>('SELECT * FROM chat WHERE thread = ? ORDER BY t, rowid', thread);
    return rows.map((r) => ({ id: r.id, thread: r.thread, from: r.from_id, to: r.to_id, text: r.text, t: r.t, mine: r.mine === 1, status: r.status as ChatStatus, read: r.read === 1 }));
  },
  unread: async () => {
    const rows = await the().getAllAsync<{ thread: string; n: number }>('SELECT thread, COUNT(*) AS n FROM chat WHERE mine = 0 AND read = 0 GROUP BY thread');
    return Object.fromEntries(rows.map((r) => [r.thread, r.n]));
  },
  purgeBefore: async (t: number) => (await the().runAsync('DELETE FROM chat WHERE t < ?', t)).changes,
  deleteThread: async (thread: string) => {
    await the().runAsync('DELETE FROM chat WHERE thread = ?', thread);
  },
};

// --- caches ---------------------------------------------------------------------------------------------------------

export async function geocacheGet(key: string): Promise<string | null | undefined> {
  const r = await the().getFirstAsync<{ city: string | null }>('SELECT city FROM geocache WHERE key = ?', key);
  return r ? r.city : undefined;
}

export async function geocachePut(key: string, city: string | null, t: number): Promise<void> {
  await the().runAsync('INSERT OR REPLACE INTO geocache (key, city, t) VALUES (?, ?, ?)', key, city, t);
}

export async function benchAppend(kind: string, t: number, json: unknown): Promise<void> {
  await the().runAsync('INSERT INTO bench (t, kind, json) VALUES (?, ?, ?)', t, kind, JSON.stringify(json));
}

export async function benchRows(kind: string, since: number): Promise<{ t: number; json: string }[]> {
  return the().getAllAsync('SELECT t, json FROM bench WHERE kind = ? AND t >= ? ORDER BY t', kind, since);
}

/** Account + data deletion (X2): wipe every table. Keys are removed separately from secure storage. */
export async function wipeAll(): Promise<void> {
  const tables = ['kv', 'circle_ops', 'ydoc', 'trips', 'walks', 'visits', 'history', 'places', 'outbox', 'hazards', 'geocache', 'bench', 'route_traces', 'chat'];
  await tx(async () => {
    for (const t of tables) await the().execAsync(`DELETE FROM ${t};`);
  });
  await the().execAsync('VACUUM;');
}
