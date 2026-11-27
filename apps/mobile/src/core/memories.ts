import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { platform } from '@crewmap/platform';
import { LruBlobStore, MEMORY_LIMITS, MemoryChannel, fromUtf8, hashBytes, openJson, sodium, type MemoryKind, type ParsedPost, type PhotoWire, type ReactWire } from '@crewmap/p2p';
import { fromWire } from '@crewmap/shared/emotes';
import { haversineM } from '@crewmap/shared/geo';
import {
  MEMORY,
  MEMORY_REACTIONS,
  buildOutings,
  matchMemory,
  notableReasons,
  thinTrack,
  type MemoryDigest,
  type MemoryEvent,
  type MemoryPhoto,
  type MemoryReact,
  type Outing,
  type RemotePost,
  type TrackPt,
  type TripLite,
} from '@crewmap/shared/memories';
import type { Crews } from './crews';
import * as db from './db';
import { useDriveAlong } from './companions';
import { recordError } from './errorLog';
import { memoryHooks } from './memoryHooks';
import { useApp } from './store';

/**
 * Trip memories (D68), local-first. This phone records the crewmate fixes it already receives while I drive (exact
 * precision only) and the emotes exchanged meanwhile; at the end of a drive it groups my drives into outings
 * (packages/shared/memories) and keeps each as one self-contained row. Crewmates who were there get my recap post,
 * photos and reactions, sealed to each of them and narrowed by my sharing policy for them (p2p/memories.ts).
 */

export interface StoredMemory {
  id: string;
  outing: Outing;
  /** Remote mids that mean this memory on crewmates' phones. */
  aliases: string[];
  title?: string;
  myTrack: TrackPt[];
  friendTracks: Record<string, TrackPt[]>;
  posts: RemotePost[];
  events: MemoryEvent[];
  photos: (MemoryPhoto & { exp: number })[];
  reacts: (MemoryReact & { on?: boolean })[];
  /** Kept: tracks and photos survive retention / photo expiry. */
  kept: boolean;
  /** The recap card was opened or dismissed. */
  seen: boolean;
  /** My post went out to the members. */
  shared: boolean;
  /** What the last post carried (re-sent only when it changes). */
  sharedSig?: string;
  /** Built from a crewmate's post: I have no drive of my own in it. */
  remote?: boolean;
  /** Tracks dropped by retention (the summary stays for the season review). */
  stripped?: boolean;
}

export interface MemoryRow {
  id: string;
  start: number;
  end: number;
  title?: string;
  kind: Outing['kind'];
  distanceM: number;
  members: string[];
  places: string[];
  photos: number;
  emotes: number;
  thumb: { lat: number; lng: number }[];
  cover?: string;
  kept: boolean;
  remote: boolean;
}

interface MemoriesState {
  rows: MemoryRow[];
  loaded: boolean;
  /** Bumped on every change (open recap screens reload). */
  rev: number;
  /** The one dismissible recap card (a group outing that just ended). */
  card: string | null;
}

export const useMemories = create<MemoriesState>(() => ({ rows: [], loaded: false, rev: 0, card: null }));

// --- photo blobs -------------------------------------------------------------------------------------------------------

const photoDir = () => {
  const d = new Directory(Paths.document, 'memory-photos');
  if (!d.exists) d.create();
  return d;
};
const photoFile = (h: string) => new File(photoDir(), `${h}.jpg`);
const fromB64 = (s: string): Uint8Array => sodium().from_base64(s, sodium().base64_variants.ORIGINAL);
const toB64 = (b: Uint8Array): string => sodium().to_base64(b, sodium().base64_variants.ORIGINAL);

export const photoStore = new LruBlobStore(
  {
    read: async (h) => {
      const f = photoFile(h);
      return f.exists ? fromB64(await f.base64()) : null;
    },
    write: async (h, bytes) => {
      const f = photoFile(h);
      f.create({ overwrite: true });
      f.write(toB64(bytes), { encoding: 'base64' });
    },
    remove: async (h) => {
      const f = photoFile(h);
      if (f.exists) f.delete();
    },
  },
  { get: db.kvGet, set: db.kvSet },
  Date.now,
  MEMORY_LIMITS.storeCapBytes,
  'memories.blobs',
);

export const photoUri = (h: string): string | null => {
  const f = photoFile(h);
  return f.exists ? f.uri : null;
};

/** Account deletion: every stored memory photo (the SQL tables and kv are wiped by db.wipeAll). */
export function wipeMemoryPhotos(): void {
  try {
    const d = new Directory(Paths.document, 'memory-photos');
    if (d.exists) d.delete();
  } catch (e) {
    recordError('js', e);
  }
}

// --- rows ------------------------------------------------------------------------------------------------------------

async function sql() {
  return db.openDb();
}

async function loadAll(): Promise<StoredMemory[]> {
  const rows = await (await sql()).getAllAsync<{ json: string }>('SELECT json FROM memories ORDER BY start DESC');
  return rows.map((r) => JSON.parse(r.json) as StoredMemory);
}

export async function loadMemory(id: string): Promise<StoredMemory | null> {
  const r = await (await sql()).getFirstAsync<{ json: string }>('SELECT json FROM memories WHERE id = ?', id);
  return r ? (JSON.parse(r.json) as StoredMemory) : null;
}

async function save(m: StoredMemory): Promise<void> {
  await (await sql()).runAsync('INSERT OR REPLACE INTO memories (id, start, end_t, json) VALUES (?, ?, ?, ?)', m.id, m.outing.start, m.outing.end, JSON.stringify(m));
}

const rowOf = (m: StoredMemory): MemoryRow => {
  const cover = m.photos.find((p) => photoUri(p.h));
  return {
    id: m.id,
    start: m.outing.start,
    end: m.outing.end,
    ...(m.title ? { title: m.title } : {}),
    kind: m.outing.kind,
    distanceM: m.outing.distanceM,
    members: m.outing.members.map((x) => x.id),
    places: m.outing.stops.map((s) => s.name).filter((s): s is string => !!s),
    photos: m.photos.length,
    emotes: m.events.length,
    thumb: thinTrack(m.myTrack.length >= 2 ? m.myTrack : (m.posts.find((p) => p.route)?.route ?? []), 40),
    ...(cover ? { cover: photoUri(cover.h)! } : {}),
    kept: m.kept,
    remote: !!m.remote,
  };
};

export const digestOf = (r: MemoryRow): MemoryDigest => ({ id: r.id, start: r.start, end: r.end, kind: r.kind, distanceM: r.distanceM, members: r.members, places: r.places, photos: r.photos, emotes: r.emotes });

export async function refreshMemories(): Promise<void> {
  const all = await loadAll();
  useMemories.setState((s) => ({ rows: all.map(rowOf), loaded: true, rev: s.rev + 1 }));
}

const tzMin = () => -new Date().getTimezoneOffset();
export const memoryTz = tzMin;

const membersOf = (m: StoredMemory, me: string): string[] => [...new Set([...m.outing.members.map((x) => x.id), ...m.posts.map((p) => p.from)])].filter((x) => x !== me);

// --- service ---------------------------------------------------------------------------------------------------------

export class Memories {
  private channel: MemoryChannel | null = null;
  private offs: (() => void)[] = [];
  private lastFix = new Map<string, TrackPt>();
  private lastTripEnd = 0;
  private sessionSeen = new Map<string, { from: number; to: number }>();
  private rebuilding: Promise<void> | null = null;

  constructor(
    private readonly net: Crews,
    private readonly me: () => string,
  ) {}

  start(): void {
    this.stop();
    const r = this.net.router;
    if (!r) return;
    this.channel = new MemoryChannel({
      bus: {
        send: (to, kind, build) => this.net.companionSend(to, kind, build),
        on: (kind: MemoryKind, h) => r.on(kind, (m) => h(m.sender, openJson(this.net.me, m.payload))),
      },
      store: photoStore,
      reactions: MEMORY_REACTIONS,
      onPost: (from, p) => void this.onPost(from, p).catch((e: unknown) => recordError('js', e)),
      onPhoto: (from, p) => void this.onPhoto(from, p).catch((e: unknown) => recordError('js', e)),
      onPhotoGone: (from, p) => void this.onPhotoGone(from, p).catch((e: unknown) => recordError('js', e)),
      onReact: (from, x) => void this.onReact(from, x).catch((e: unknown) => recordError('js', e)),
    });
    this.channel.start();
    memoryHooks.sent = (to, preset) => this.noteSent(to, preset);
    this.offs.push(
      () => (memoryHooks.sent = () => undefined),
      r.on('emote', (m) => {
        try {
          const e = fromWire(JSON.parse(fromUtf8(m.payload)));
          if (e && this.recording()) void this.logEvent({ t: Date.now(), from: m.sender, to: this.me(), preset: e.preset });
        } catch {
          /* malformed: ignore */
        }
      }),
      useApp.subscribe((s, prev) => {
        if (s.allFriends !== prev.allFriends && this.recording()) void this.recordFixes();
        if (prev.tripStartedAt !== null && s.tripStartedAt === null) {
          this.lastTripEnd = Date.now();
          void this.rebuild();
        }
      }),
      useDriveAlong.subscribe((s) => this.noteSession(s.session)),
    );
    void refreshMemories();
    void this.maintenance();
  }

  stop(): void {
    for (const o of this.offs) o();
    this.offs = [];
    this.channel?.stop();
    this.channel = null;
  }

  /** Recording window: driving, in a drive-along, or a stop short enough to still be the same outing. */
  private recording(): boolean {
    const s = useApp.getState();
    return s.tripStartedAt !== null || !!useDriveAlong.getState().session || Date.now() - this.lastTripEnd < MEMORY.chainGapMs;
  }

  private noteSession(s: ReturnType<typeof useDriveAlong.getState>['session']): void {
    if (!s) return;
    const me = this.me();
    for (const [id, m] of Object.entries(s.members)) {
      if (id === me || m.state !== 'joined') continue;
      const k = `${s.sid}:${id}`;
      const cur = this.sessionSeen.get(k);
      this.sessionSeen.set(k, { from: cur?.from ?? m.at, to: Date.now() });
    }
    if (s.owner !== me) {
      const k = `${s.sid}:${s.owner}`;
      const cur = this.sessionSeen.get(k);
      this.sessionSeen.set(k, { from: cur?.from ?? s.startedAt, to: Date.now() });
    }
    void db.kvSet('memories.sessions', [...this.sessionSeen]);
  }

  /** Emotes I send (Emotes.send) during the recording window. */
  noteSent(to: string, preset: MemoryEvent['preset']): void {
    if (this.recording()) void this.logEvent({ t: Date.now(), from: this.me(), to, preset });
  }

  private async logEvent(e: MemoryEvent): Promise<void> {
    await (await sql()).runAsync('INSERT INTO mem_events (t, from_id, to_id, preset) VALUES (?, ?, ?, ?)', e.t, e.from, e.to, e.preset);
  }

  /** Crewmates' fixes as they arrive (only exact ones: an approximate position cannot say who rode along). */
  private async recordFixes(): Promise<void> {
    const rows: [string, TrackPt][] = [];
    for (const [id, f] of Object.entries(useApp.getState().allFriends)) {
      const p = f.presence;
      if (!p || f.paused || p.prec !== 'p') continue;
      const last = this.lastFix.get(id);
      if (last && p.t <= last.t) continue;
      const pt: TrackPt = { t: p.t, lat: p.lat, lng: p.lng, spd: p.spd };
      if (last && haversineM(last, pt) < MEMORY.track.minMoveM && p.t - last.t < MEMORY.track.minIntervalMs) continue;
      this.lastFix.set(id, pt);
      rows.push([id, pt]);
    }
    if (!rows.length) return;
    const d = await sql();
    for (const [id, p] of rows) await d.runAsync('INSERT OR IGNORE INTO mem_tracks (who, t, lat, lng, spd) VALUES (?, ?, ?, ?, ?)', id, p.t, p.lat, p.lng, p.spd ?? null);
  }

  private async tripsSince(since: number): Promise<TripLite[]> {
    const out: TripLite[] = [];
    for (const s of await db.tripSummaries(since)) {
      const tr = await db.loadTrip(s.id);
      if (!tr || tr.points.length < 2) continue;
      out.push({ id: tr.id, startedAt: tr.startedAt, endedAt: tr.endedAt, distanceM: tr.distanceM, durationS: tr.durationS, topSpeedKph: tr.topSpeedKph, passenger: tr.passenger, line: thinTrack(tr.points.map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, spd: p.speed })), 400) });
    }
    return out;
  }

  /** Names for stops: my places first, else the city of a visit recorded there. */
  private async nameStops(o: Outing): Promise<(string | null)[]> {
    const places = useApp.getState().places;
    const d = await sql();
    const out: (string | null)[] = [];
    for (const s of o.stops) {
      const pl = places.find((p) => haversineM(p, s) <= Math.max(150, p.radiusM));
      if (pl) {
        s.name = pl.name;
        out.push(null);
        continue;
      }
      const v = await d.getFirstAsync<{ city: string | null }>('SELECT city FROM visits WHERE t BETWEEN ? AND ? AND city IS NOT NULL ORDER BY t LIMIT 1', s.start - 10 * 60_000, s.end);
      s.name = v?.city ?? null;
      out.push(v?.city ?? null);
    }
    return out;
  }

  /** Rebuild the outings of the last two days (a drive just ended, or at start). */
  rebuild(): Promise<void> {
    this.rebuilding ??= this.doRebuild()
      .catch((e: unknown) => recordError('js', e))
      .finally(() => (this.rebuilding = null));
    return this.rebuilding;
  }

  private async doRebuild(): Promise<void> {
    const now = Date.now();
    const since = now - 2 * 86_400_000;
    const trips = await this.tripsSince(since);
    if (!trips.length) return;
    const d = await sql();
    const trackRows = await d.getAllAsync<{ who: string; t: number; lat: number; lng: number; spd: number | null }>('SELECT * FROM mem_tracks WHERE t >= ? ORDER BY t', since - MEMORY.windowSlackMs);
    const friendTracks: Record<string, TrackPt[]> = {};
    for (const r of trackRows) (friendTracks[r.who] ??= []).push({ t: r.t, lat: r.lat, lng: r.lng, spd: r.spd });
    const saved = await db.kvGet<[string, { from: number; to: number }][]>('memories.sessions', []);
    for (const [k, v] of saved) if (!this.sessionSeen.has(k)) this.sessionSeen.set(k, v);
    const sessions = [...this.sessionSeen].map(([k, v]) => ({ who: k.split(':')[1]!, ...v })).filter((x) => x.to >= since);
    const history = (await db.tripSummaries(now - 40 * 86_400_000)).map((t) => ({ end: t.endedAt, distanceM: t.distanceM }));
    const cityRows = await d.getAllAsync<{ city: string; t: number }>('SELECT city, MIN(t) AS t FROM visits WHERE city IS NOT NULL GROUP BY city');
    const recentVisits = await d.getAllAsync<{ city: string; t: number }>('SELECT city, t FROM visits WHERE t >= ? AND city IS NOT NULL ORDER BY t', since - 3600_000);
    const cityAt = (s: { start: number; end: number }) => recentVisits.find((v) => v.t >= s.start - 10 * 60_000 && v.t <= s.end)?.city ?? null;
    const outs = buildOutings({
      trips,
      friendTracks,
      sessions,
      notable: (o) => notableReasons(o, { history, knownCities: new Set(cityRows.filter((c) => c.t < o.start).map((c) => c.city)), stopCities: o.stops.map(cityAt) }),
    });
    const existing = await loadAll();
    for (const o of outs) {
      await this.nameStops(o);
      const myTrack = thinTrack(trips.filter((t) => o.tripIds.includes(t.id)).flatMap((t) => t.line), 600);
      const ft: Record<string, TrackPt[]> = {};
      for (const m of o.members) ft[m.id] = thinTrack((friendTracks[m.id] ?? []).filter((p) => p.t >= o.start - MEMORY.windowSlackMs && p.t <= o.end + MEMORY.windowSlackMs), 400);
      const prev = existing.find((x) => x.id === o.id) ?? existing.find((x) => x.remote && matchMemory([{ id: x.id, start: x.outing.start, end: x.outing.end }], '', [o.start, o.end]));
      const events = (await d.getAllAsync<{ t: number; from_id: string; to_id: string; preset: string }>('SELECT * FROM mem_events WHERE t BETWEEN ? AND ? ORDER BY t', o.start - MEMORY.windowSlackMs, o.end + MEMORY.windowSlackMs)).map(
        (e) => ({ t: e.t, from: e.from_id, to: e.to_id, preset: e.preset as MemoryEvent['preset'] }),
      );
      // A crewmate who posted about this outing was there even if their fixes were sparse.
      for (const p of prev?.posts ?? []) if (!o.members.some((m) => m.id === p.from)) o.members.push({ id: p.from, joinedAt: Math.max(o.start, p.window[0]), leftAt: Math.min(o.end, p.window[1]), togetherMs: 0 });
      if (o.members.length && o.kind === 'notable') o.kind = 'group';
      const next: StoredMemory = {
        id: o.id,
        outing: o,
        aliases: [...new Set([...(prev?.aliases ?? []), ...(prev && prev.id !== o.id ? [prev.id] : [])])],
        ...(prev?.title ? { title: prev.title } : {}),
        myTrack,
        friendTracks: ft,
        posts: prev?.posts ?? [],
        events,
        photos: prev?.photos ?? [],
        reacts: prev?.reacts ?? [],
        kept: prev?.kept ?? false,
        seen: prev?.seen ?? false,
        shared: prev?.shared ?? false,
        ...(prev?.sharedSig ? { sharedSig: prev.sharedSig } : {}),
      };
      if (prev && prev.id !== o.id) await (await sql()).runAsync('DELETE FROM memories WHERE id = ?', prev.id);
      await save(next);
      // Ended group outing: one recap card, and my recap goes to whoever was there.
      const ended = useApp.getState().tripStartedAt === null;
      if (ended && o.kind === 'group' && !next.seen && now - o.end < MEMORY.recapCardMs && useMemories.getState().card !== o.id) {
        useMemories.setState({ card: o.id });
        platform.haptics.play('success');
      }
      if (ended && o.kind === 'group') await this.shareRecap(next);
    }
    // Outings whose drives were deleted or merged: drop rows that are mine, unkept and have nothing from crewmates.
    for (const x of existing) {
      if (x.remote || x.kept || x.outing.start < since || outs.some((o) => o.id === x.id)) continue;
      if (!x.photos.length && !x.posts.length) await (await sql()).runAsync('DELETE FROM memories WHERE id = ?', x.id);
    }
    await refreshMemories();
  }

  /** Sends my recap to the members when it changed since the last send (end, crew or title). */
  private async shareRecap(m: StoredMemory): Promise<void> {
    // Ghost mode hides where I drove too: no recap (route, distance) goes out while it is on.
    if (!this.channel || useApp.getState().settings.ghost) return;
    const members = membersOf(m, this.me());
    const sig = `${m.outing.end}|${members.join(',')}|${m.title ?? ''}`;
    if (!members.length || m.sharedSig === sig) return;
    const n = await this.channel.share(members, {
      mid: m.id,
      window: [m.outing.start, m.outing.end],
      ...(m.title ? { title: m.title } : {}),
      route: m.myTrack,
      km: m.outing.distanceM / 1000,
      min: (m.outing.end - m.outing.start) / 60_000,
      topKph: m.outing.topSpeedKph,
    });
    if (n > 0) {
      m.shared = true;
      m.sharedSig = sig;
      await save(m);
    }
  }

  // --- incoming ----------------------------------------------------------------------------------------------------

  /** The local memory a crewmate's message is about; a remote-only one is created when none matches. */
  private async resolve(from: string, mid: string, window: [number, number]): Promise<StoredMemory> {
    const all = await loadAll();
    const id = matchMemory(all.map((m) => ({ id: m.id, start: m.outing.start, end: m.outing.end, aliases: m.aliases })), mid, window);
    const hit = id ? all.find((m) => m.id === id) : undefined;
    if (hit) {
      if (!hit.aliases.includes(mid) && mid !== hit.id) hit.aliases.push(mid);
      return hit;
    }
    return {
      id: `r-${from.slice(0, 12)}-${mid}`.slice(0, 80),
      outing: { id: mid, start: window[0], end: window[1], tripIds: [], distanceM: 0, drivingS: 0, topSpeedKph: 0, members: [{ id: from, joinedAt: window[0], leftAt: window[1], togetherMs: window[1] - window[0] }], stops: [], kind: 'group', notable: [] },
      aliases: [mid],
      myTrack: [],
      friendTracks: {},
      posts: [],
      events: [],
      photos: [],
      reacts: [],
      kept: false,
      seen: false,
      shared: false,
      remote: true,
    };
  }

  /** A crewmate's window must be plausible: not in the future,. */
  private async plausible(w: [number, number]): Promise<boolean> {
    if (w[1] > Date.now() + 3600_000) return false;
    return true;
  }

  private async onPost(from: string, p: ParsedPost): Promise<void> {
    if (!(await this.plausible(p.window))) return;
    const m = await this.resolve(from, p.mid, p.window);
    const post: RemotePost = { from, mid: p.mid, window: p.window, at: Date.now(), ...(p.title ? { title: p.title } : {}), ...(p.route ? { route: p.route } : {}), ...(p.km !== undefined ? { km: p.km } : {}), ...(p.min !== undefined ? { min: p.min } : {}), ...(p.topKph !== undefined ? { topKph: p.topKph } : {}) };
    m.posts = [...m.posts.filter((x) => x.from !== from), post];
    if (!m.outing.members.some((x) => x.id === from)) m.outing.members.push({ id: from, joinedAt: Math.max(m.outing.start, p.window[0]), leftAt: Math.min(m.outing.end, p.window[1]), togetherMs: 0 });
    if (m.remote) {
      m.outing.distanceM = Math.max(m.outing.distanceM, (p.km ?? 0) * 1000);
      if (p.title && !m.title) m.title = p.title;
    }
    await save(m);
    await refreshMemories();
  }

  private async onPhoto(from: string, p: PhotoWire): Promise<void> {
    if (!(await this.plausible(p.w))) return;
    const gone = await db.kvGet<string[]>('memories.withdrawn', []);
    if (gone.includes(`${from}:${p.h}`)) return;
    const m = await this.resolve(from, p.mid, p.w);
    if (m.photos.some((x) => x.h === p.h)) return;
    if (m.photos.filter((x) => x.from === from).length >= MEMORY_LIMITS.photosPerMemberPerMemory) return;
    m.photos.push({ h: p.h, from, at: p.at, w: p.pw, hgt: p.ph, exp: p.exp, ...(p.cap ? { cap: p.cap } : {}) });
    await photoStore.pin(p.h, m.kept);
    await save(m);
    await refreshMemories();
  }

  private async onPhotoGone(from: string, p: PhotoWire): Promise<void> {
    const gone = await db.kvGet<string[]>('memories.withdrawn', []);
    await db.kvSet('memories.withdrawn', [...gone.filter((x) => x !== `${from}:${p.h}`), `${from}:${p.h}`].slice(-500));
    const m = await this.resolve(from, p.mid, p.w);
    if (!m.photos.some((x) => x.h === p.h && x.from === from)) return;
    m.photos = m.photos.filter((x) => !(x.h === p.h && x.from === from));
    await photoStore.delete(p.h);
    await save(m);
    await refreshMemories();
  }

  private async onReact(from: string, r: ReactWire): Promise<void> {
    if (!(await this.plausible(r.w))) return;
    const m = await this.resolve(from, r.mid, r.w);
    // A replayed reaction (same sender, target, emoji and time) changes nothing; one sender keeps at most 60 entries.
    if (m.reacts.some((x) => x.from === from && x.target === r.target && x.e === r.e && x.at === r.at)) return;
    m.reacts.push({ from, target: r.target, e: r.e, at: Math.min(r.at, Date.now()), on: r.on });
    const mine = m.reacts.filter((x) => x.from === from);
    if (mine.length > 60) m.reacts = m.reacts.filter((x) => x.from !== from || mine.slice(-60).includes(x));
    if (m.reacts.length > 400) m.reacts = m.reacts.slice(-400);
    await save(m);
    useMemories.setState((s) => ({ rev: s.rev + 1 }));
  }

  // --- my actions --------------------------------------------------------------------------------------------------

  /** Pick from the gallery or take with the camera (uri from the camera screen); compress, store, send. */
  async addPhoto(id: string, source: { camera: string } | 'gallery', cap?: string): Promise<'ok' | 'canceled' | 'unreadable' | 'limit' | 'failed'> {
    const m = await loadMemory(id);
    if (!m) return 'failed';
    const me = this.me();
    if (m.photos.filter((p) => p.from === me).length >= MEMORY_LIMITS.photosPerMemberPerMemory) return 'limit';
    let uri: string;
    if (source === 'gallery') {
      const res = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true });
      const a = res.canceled ? null : res.assets[0];
      if (!a) return 'canceled';
      uri = a.uri;
    } else uri = source.camera;
    const c = await platform.photos.compress(uri, MEMORY_LIMITS.maxEdge, MEMORY_LIMITS.maxPhotoBytes).catch(() => null);
    if (!c) return 'unreadable';
    const tmp = new File(c.uri);
    const bytes = fromB64(await tmp.base64());
    if (tmp.exists) tmp.delete();
    if (bytes.length > MEMORY_LIMITS.maxPhotoBytes) return 'unreadable';
    const h = hashBytes(bytes);
    await photoStore.put(h, bytes);
    await photoStore.pin(h, true);
    const at = Date.now();
    const exp = m.outing.end + MEMORY.photoKeepDays * 86_400_000;
    const capT = cap?.trim().slice(0, MEMORY_LIMITS.maxCaption);
    if (!m.photos.some((p) => p.h === h)) m.photos.push({ h, from: me, at, w: c.width, hgt: c.height, exp, ...(capT ? { cap: capT } : {}) });
    await save(m);
    await refreshMemories();
    await this.channel?.sendPhoto(membersOf(m, me), { mid: m.id, window: [m.outing.start, m.outing.end] }, bytes, { pw: c.width, ph: c.height, at, exp, ...(capT ? { cap: capT } : {}) });
    platform.haptics.play('success');
    return 'ok';
  }

  async removePhoto(id: string, h: string): Promise<void> {
    const m = await loadMemory(id);
    if (!m) return;
    const mine = m.photos.find((p) => p.h === h)?.from === this.me();
    m.photos = m.photos.filter((p) => p.h !== h);
    await photoStore.delete(h);
    await save(m);
    await refreshMemories();
    if (mine) await this.channel?.unsharePhoto(membersOf(m, this.me()), { mid: m.id, window: [m.outing.start, m.outing.end] }, h);
  }

  /** Toggle my reaction `e` on the memory or a photo. */
  async react(id: string, target: string, e: string): Promise<void> {
    const m = await loadMemory(id);
    if (!m) return;
    const me = this.me();
    const latest = [...m.reacts].reverse().find((r) => r.from === me && r.target === target && r.e === e);
    const on = !(latest && latest.on !== false);
    m.reacts.push({ from: me, target, e, at: Date.now(), on });
    await save(m);
    useMemories.setState((s) => ({ rev: s.rev + 1 }));
    platform.haptics.play(on ? 'bounce' : 'tap');
    await this.channel?.react(membersOf(m, me), { mid: m.id, window: [m.outing.start, m.outing.end] }, target, e, on);
  }

  async setKept(id: string, kept: boolean): Promise<void> {
    const m = await loadMemory(id);
    if (!m) return;
    m.kept = kept;
    for (const p of m.photos) await photoStore.pin(p.h, kept || p.from === this.me());
    await save(m);
    await refreshMemories();
  }

  async rename(id: string, title: string): Promise<void> {
    const m = await loadMemory(id);
    if (!m) return;
    const t = title.trim().slice(0, MEMORY_LIMITS.maxTitle);
    if (t) m.title = t;
    else delete m.title;
    await save(m);
    await refreshMemories();
    if (m.shared && !m.remote) await this.shareRecap(m);
  }

  /** Delete on this phone only (crewmates keep theirs). */
  async remove(id: string): Promise<void> {
    const m = await loadMemory(id);
    if (!m) return;
    for (const p of m.photos) if (!(await this.photoUsedElsewhere(p.h, id))) await photoStore.delete(p.h);
    await (await sql()).runAsync('DELETE FROM memories WHERE id = ?', id);
    if (useMemories.getState().card === id) useMemories.setState({ card: null });
    await refreshMemories();
  }

  private async photoUsedElsewhere(h: string, except: string): Promise<boolean> {
    return (await loadAll()).some((m) => m.id !== except && m.photos.some((p) => p.h === h));
  }

  async markSeen(id: string): Promise<void> {
    if (useMemories.getState().card === id) useMemories.setState({ card: null });
    const m = await loadMemory(id);
    if (!m || m.seen) return;
    m.seen = true;
    await save(m);
  }

  /** Photo expiry and retention: expired photos go; unkept memories older than retention lose their tracks. */
  async maintenance(): Promise<void> {
    try {
      const now = Date.now();
      const cutoff = now - useApp.getState().settings.retentionDays * 86_400_000;
      for (const m of await loadAll()) {
        let dirty = false;
        if (!m.kept) {
          const gone = m.photos.filter((p) => p.exp <= now);
          for (const p of gone) await photoStore.delete(p.h);
          if (gone.length) {
            m.photos = m.photos.filter((p) => p.exp > now);
            dirty = true;
          }
          if (!m.stripped && m.outing.end < cutoff) {
            m.myTrack = [];
            m.friendTracks = {};
            m.posts = m.posts.map(({ route: _r, ...rest }) => rest);
            m.stripped = true;
            dirty = true;
          }
        }
        if (dirty) await save(m);
      }
      this.channel?.expire();
      await this.rebuild();
    } catch (e) {
      recordError('js', e);
    }
  }
}
