import Constants from 'expo-constants';
import { platform } from '@crewmap/platform';
import {
  ANON,
  AnonHazardStore,
  AnonRateLimit,
  anonFilter,
  applySignedConfig,
  buildAnonReport,
  buildAnonVote,
  geohashEncode,
  geohashesAlong,
  withConditionalGet,
  type AnonEvent,
  canonicalConfig,
  DEFAULT_HAZARD_CONFIG,
  hazardsFromReports,
  hazardsFromRoute,
  HazardService,
  MontrealSource,
  OsmCameraSource,
  QuebecSource,
  reportAlive,
  WazeLiveMapSource,
  WazePaidSource,
  type FriendReport,
  type FriendReportType,
  type Hazard,
  type MergedHazard,
  type HazardConfig,
  type HttpGet,
  type OsmSnapshot,
  type SpendLedger,
} from '@crewmap/hazards';
import { b64, DEFAULT_PUBLIC_RELAYS, fromUtf8, sodium, unb64, utf8, type DeviceIdentity, type NostrEvent, type NostrFilter } from '@crewmap/p2p';
import { bboxOf, cumulativeDistances, projectOnPolyline, type BBox } from '@crewmap/shared/geo';
import { lang, t, type I18nKey } from '@crewmap/shared/i18n';
import { formatDistance } from '@crewmap/shared/units';
import { countRequest } from './apiBudget';
import { kvGet, kvSet } from './db';
import type { Crews } from './crews';
import { isMuted } from './friendPrefs';
import { notify } from './notify';
import { Pois } from './pois';
import { useApp } from './store';
import { roadWeather } from './roadWeather';

const http: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers: headers ?? {} });
  return { status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text() };
};
/** Official feeds go through conditional GET (ETag / Last-Modified; D44). */
const feedHttp = withConditionalGet(http);

/** Paid-fallback spend persisted per calendar month. */
class KvLedger implements SpendLedger {
  private cache: Record<string, number> = {};
  async load(): Promise<void> {
    this.cache = await kvGet<Record<string, number>>('wazePaidSpend', {});
  }
  spent(now: number): number {
    return this.cache[new Date(now).toISOString().slice(0, 7)] ?? 0;
  }
  add(now: number, usd: number): void {
    const k = new Date(now).toISOString().slice(0, 7);
    this.cache[k] = (this.cache[k] ?? 0) + usd;
    void kvSet('wazePaidSpend', this.cache);
  }
}

/** A friend's new hazard is announced when it lies this far ahead on the route, and at most this often. */
const NOTIFY_AHEAD_M = 2000;
const NOTIFY_OFF_ROUTE_M = 150;
const NOTIFY_EVERY_MS = 60_000;
const HZ_KEYS = new Set(['police', 'speedTrap', 'camera', 'accident', 'hazard', 'closure', 'construction', 'jam', 'pothole']);

const WAZE_EVERY_MS = 2 * 60_000;
/** Cycle period while nobody drives and the map is closed (battery). */
const IDLE_CYCLE_MS = 5 * 60_000;

/** Who this device is and when it last reported, so the announcer never reads our own reports back to us. */
export const ownReports: { selfId: string | undefined; lastAt: number | null; anonIds: Set<string> } = { selfId: undefined, lastAt: null, anonIds: new Set() };

/** Anonymous network topic cells: along the active route, else around the position / viewport (gh4 ≈ 40 × 20 km). */
function anonTopics(): string[] {
  const s = useApp.getState();
  if (s.nav?.route) return geohashesAlong(s.nav.route.geometry, ANON.topicPrecision).slice(0, 12);
  return s.fix ? [geohashEncode(s.fix, ANON.topicPrecision)] : [];
}

/** Map points are only listed for a drive-sized area (a zoomed-out province view would mean thousands of pins). */
const poiArea = (b: BBox | null): boolean => !!b && b.north - b.south <= 1 && b.east - b.west <= 1.5;

export class Hazards {
  readonly service: HazardService;
  private readonly ledger = new KvLedger();
  private local: Hazard[] = [];
  private lastWaze = 0;
  private readonly osm = new OsmCameraSource(http, undefined, () => countRequest('overpass'));
  readonly pois: Pois;
  private readonly anon = new AnonHazardStore();
  private readonly anonLimit = new AnonRateLimit();
  private anonSub: { close(): void } | null = null;
  private anonKey = '';
  private lastIdleCycle = 0;
  private readonly mapboxFirstSeen = new Map<string, number>();
  private readonly notified = new Set<string>();
  private notifyPrimed = false;
  private lastNotifyAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: (() => void)[] = [];
  /** Visible map bounds, set by the map screen while it's open. */
  viewport: BBox | null = null;

  constructor(
    private readonly net: Crews,
    private readonly me: DeviceIdentity,
  ) {
    ownReports.selfId = me.deviceId;
    this.pois = new Pois(http, net);
    const extra = (Constants.expoConfig?.extra ?? {}) as { wazePaidKey?: string; wazePaidCapUsd?: number };
    this.service = new HazardService({
      waze: new WazeLiveMapSource(http),
      paid: new WazePaidSource(http, extra.wazePaidKey ?? '', extra.wazePaidCapUsd ?? 0, this.ledger),
      quebec: new QuebecSource(feedHttp),
      montreal: new MontrealSource(feedHttp),
      osm: this.osm,
    });
  }

  async start(): Promise<void> {
    await this.ledger.load();
    this.osm.restore(await kvGet<OsmSnapshot | null>('osmCameras', null), Date.now());
    await this.pois.start();
    await roadWeather.start();
    this.applyConfigFromDoc();
    const router = this.net.router;
    if (router) {
      this.offs.push(
        router.on('hazards', (m) => {
          try {
            this.service.ingestShared(JSON.parse(fromUtf8(m.payload)) as Hazard[], Date.now());
            this.publish();
          } catch {
            // ignore malformed
          }
        }),
      );
    }
    this.offs.push(this.net.doc.onChange(() => {
      this.applyConfigFromDoc();
      this.publish();
    }));
    this.timer = setInterval(() => void this.cycle(), 30_000);
    void this.cycle();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.anonSub?.close();
    this.anonSub = null;
    this.anonKey = '';
    for (const o of this.offs) o();
    this.offs = [];
  }

  /** One-tap friend report while driving (no typing). */
  report(type: FriendReportType): string | null {
    const fix = useApp.getState().fix;
    if (!fix) return null;
    const r: FriendReport = {
      id: `${this.me.deviceId.slice(0, 8)}-${Date.now().toString(36)}`,
      by: this.me.deviceId,
      type,
      lat: fix.lat,
      lng: fix.lng,
      heading: fix.heading,
      street: null,
      at: Date.now(),
      votes: { [this.me.deviceId]: 1 },
    };
    ownReports.lastAt = r.at;
    this.net.doc.reports.set(r.id, r);
    this.publishAnon(r);
    // Show it on our own map right away, independent of doc-update timing.
    this.publish();
    platform.haptics.play('success');
    return r.id;
  }

  /** Rebuild the published hazard list now (e.g. the preview route changed, so its Mapbox incidents must show). */
  refresh(): void {
    this.publish();
  }

  private ownReportIds(memberIds: string[]): string[] {
    return memberIds
      .filter((m) => m.startsWith('friends:'))
      .map((m) => m.slice('friends:'.length))
      .filter((id) => this.net.doc.reports.get(id)?.by === this.me.deviceId);
  }

  /** Remove reports from every crew doc (the shared map entry is deleted, so peers drop it on sync). */
  private removeReports(ids: string[]): void {
    this.net.doc.pruneReports((r) => !ids.includes(r.id));
  }

  /** True when this hazard is (or merges) a report we made ourselves. */
  isOwn(memberIds: string[]): boolean {
    return this.ownReportIds(memberIds).length > 0;
  }

  /** Mark our own report(s) gone for the crew: the shared entry is removed, so it disappears on every device. */
  clear(memberIds: string[]): boolean {
    const ids = this.ownReportIds(memberIds);
    if (ids.length) {
      this.removeReports(ids);
      this.publish();
    }
    return ids.length > 0;
  }

  /** "Still there?" answers and up/down votes. Merged hazards may carry a friend report id among members. */
  vote(hazardMemberIds: string[], up: boolean): () => void {
    const me = this.me.deviceId;
    const undos: (() => void)[] = [];
    for (const mid of hazardMemberIds) {
      if (!mid.startsWith('friends:')) continue;
      const id = mid.slice('friends:'.length);
      const r = this.net.doc.reports.get(id);
      if (!r) continue;
      const prev = r.votes[me];
      this.net.doc.reports.set(id, { ...r, votes: { ...r.votes, [me]: up ? 1 : -1 } });
      undos.push(() => {
        const cur = this.net.doc.reports.get(id);
        if (!cur) return;
        const votes = { ...cur.votes };
        if (prev === undefined) delete votes[me];
        else votes[me] = prev;
        this.net.doc.reports.set(id, { ...cur, votes });
      });
    }
    this.voteAnon(hazardMemberIds, up);
    // A confirmation of a Waze/official hazard without a friend report becomes a report, so it propagates.
    if (up && !hazardMemberIds.some((m) => m.startsWith('friends:'))) {
      const h = useApp.getState().hazards.find((x) => x.memberIds.some((m) => hazardMemberIds.includes(m)));
      if (h && (['police', 'speedTrap', 'hazard', 'accident', 'pothole', 'construction'] as string[]).includes(h.type)) {
        const created = this.report(h.type as FriendReportType);
        if (created) undos.push(() => this.removeReports([created]));
      }
    }
    this.publish();
    return () => {
      for (const u of undos) u();
      this.publish();
    };
  }

  /**
   * Opt-in (settings.anonPublish): the report also goes to the public anonymous network as a one-shot-key event with
   * a ~150 m cell (D41). Proof of work runs after the tap; the crew copy records the event id so nobody counts it twice.
   */
  private publishAnon(r: FriendReport): void {
    if (!useApp.getState().settings.anonPublish || !(ANON.types as string[]).includes(r.type) || !this.anonLimit.canReport(r.at)) return;
    this.anonLimit.noteReport(r.at);
    setTimeout(() => {
      const ev = buildAnonReport(r, r.at);
      this.anon.markOwn(ev.id);
      ownReports.anonIds.add(`anon:${ev.id}`);
      const cur = this.net.doc.reports.get(r.id);
      if (cur) this.net.doc.reports.set(r.id, { ...cur, anonId: ev.id });
      void Promise.allSettled(this.net.pool.publish(DEFAULT_PUBLIC_RELAYS, ev as NostrEvent));
    }, 0);
  }

  /** "Still there?" on an anonymous report, propagated anonymously when the user publishes to the network. */
  private voteAnon(memberIds: string[], up: boolean): void {
    if (!useApp.getState().settings.anonPublish) return;
    const now = Date.now();
    for (const m of memberIds) {
      if (!m.startsWith('anon:') || this.anon.own.has(m) || !this.anonLimit.canVote(now)) continue;
      const target = this.anon.get(m.slice('anon:'.length));
      if (!target) continue;
      this.anonLimit.noteVote(now);
      setTimeout(() => {
        const ev = buildAnonVote(target, up, now);
        this.anon.ingest(ev, Date.now());
        void Promise.allSettled(this.net.pool.publish(DEFAULT_PUBLIC_RELAYS, ev as NostrEvent));
      }, 0);
    }
  }

  /** Receive (default on) the anonymous reports for the cells around us / along the route; re-subscribes when they change. */
  private syncAnonSubscription(active: boolean): void {
    const want = active && useApp.getState().settings.anonReceive ? anonTopics() : [];
    const key = want.join(',');
    if (key === this.anonKey) return;
    this.anonKey = key;
    this.anonSub?.close();
    this.anonSub = null;
    if (want.length === 0) return;
    const filter = anonFilter(want, Math.floor(Date.now() / 1000) - 6 * 3600) as unknown as NostrFilter;
    this.anonSub = this.net.pool.subscribe(DEFAULT_PUBLIC_RELAYS, filter, {
      onevent: (e) => {
        if (this.anon.ingest(e as AnonEvent, Date.now())) this.publish();
      },
    });
  }

  /** Owner-only: sign and publish the hazard config (kill switch for the Waze adapter). */
  setConfig(c: Omit<HazardConfig, 'version'>): void {
    const st = this.net.circle.state;
    if (!st || st.ownerId !== this.me.deviceId) return;
    const config: HazardConfig = { ...c, version: Date.now() };
    const sig = b64(sodium().crypto_sign_detached(utf8(canonicalConfig(config)), this.me.signSk));
    this.net.doc.config.set('hazards', { config, by: this.me.deviceId, sig });
  }

  private applyConfigFromDoc(): void {
    const st = this.net.circle.state;
    const signed = this.net.doc.config.get('hazards');
    if (!st || !signed) return;
    const next = applySignedConfig(this.service.getConfig(), signed, st.ownerId, (msg, sig, by) => {
      const m = st.members.get(by);
      return !!m && sodium().crypto_sign_verify_detached(unb64(sig), utf8(msg), unb64(m.signPk));
    });
    if (next.version !== this.service.getConfig().version) this.service.setConfig(next, Date.now());
  }

  get config(): HazardConfig {
    return this.service.getConfig() ?? DEFAULT_HAZARD_CONFIG;
  }

  private async cycle(): Promise<void> {
    const s = useApp.getState();
    const now = Date.now();
    const anyoneDriving = s.driving || Object.values(s.friends).some((f) => f.presence?.act === 'automotive' && now - f.presence.t < 10 * 60_000);
    const mapOpen = this.viewport !== null;
    // Nobody driving, map closed: nothing to fetch for Waze and the chore-peer check (two native calls) is rarely
    // useful, so run the whole cycle every IDLE_CYCLE_MS instead of every 30 s.
    if (!anyoneDriving && !mapOpen && !s.nav?.active && now - this.lastIdleCycle < IDLE_CYCLE_MS) return;
    if (!anyoneDriving && !mapOpen) this.lastIdleCycle = now;
    // Waze: only while someone in the circle drives or the map is open; ≤ 1 req / 2 min / area.
    if ((anyoneDriving || mapOpen) && now - this.lastWaze >= WAZE_EVERY_MS) {
      const bbox = s.nav?.route ? bboxOf(s.nav.route.geometry, 500) : this.viewport ?? (s.fix ? bboxOf([s.fix], 5000) : null);
      if (bbox) {
        this.lastWaze = now;
        const got = await this.service.fetchWaze({ bbox, now, reason: s.driving ? 'driving' : 'mapOpen' });
        if (got.length) void this.net.router?.broadcast('hazards', utf8(JSON.stringify(got.slice(0, 150))));
        this.local = got;
      }
    }
    // Road-weather alerts for the route being navigated (D70): this phone only, it alone has the route.
    if (s.nav?.active && s.online) await roadWeather.refresh(s.nav.route, now);
    this.syncAnonSubscription(anyoneDriving || mapOpen || !!s.nav?.active);
    // Official feeds: on the elected chore peer, only while someone drives or has the map open (none while idle; D44).
    if ((anyoneDriving || mapOpen) && (await this.isChorePeer())) {
      const pts = [s.fix, ...Object.values(s.friends).map((f) => f.presence)].filter((p): p is NonNullable<typeof p> => !!p);
      if (pts.length) {
        const bbox = s.nav?.route ? bboxOf(s.nav.route.geometry, 2000) : this.viewport ?? bboxOf(pts, 30_000);
        const qc = await this.service.fetchOfficial(bbox, now, anyoneDriving);
        if (this.osm.health().lastOkAt === now) void kvSet('osmCameras', this.osm.snapshot());
        if (qc.length) void this.net.router?.broadcast('hazards', utf8(JSON.stringify(qc.slice(0, 200))));
        await this.pois.choreRefresh(bbox, s.fix ?? pts[0]!, now);
      }
    }
    this.net.doc.pruneReports((r) => reportAlive(r, now));
    this.publish();
  }

  /** Chore peer: charging + on Wi-Fi, and the lowest daily hash among circle members currently charging. */
  private async isChorePeer(): Promise<boolean> {
    const [bat, netw] = await Promise.all([platform.power.battery(), platform.power.network()]);
    if (!bat.charging || !netw.wifi) return false;
    const s = useApp.getState();
    const day = Math.floor(Date.now() / 86_400_000);
    const score = (id: string) => b64(sodium().crypto_generichash(8, utf8(`${id}|${day}`)));
    const candidates = [this.me.deviceId, ...Object.values(s.friends).filter((f) => f.presence?.chg && Date.now() - f.presence.t < 30 * 60_000).map((f) => f.profile.deviceId)];
    return candidates.sort((a, b) => score(a).localeCompare(score(b)))[0] === this.me.deviceId;
  }

  private publish(): void {
    const now = Date.now();
    const s = useApp.getState();
    // Mapbox incidents carry no report time: keep when we first saw each one, so the detail screen's age is real.
    const fromRoute = (s.nav?.route ? hazardsFromRoute(s.nav.route, now) : []).map((h) => {
      const first = this.mapboxFirstSeen.get(h.id) ?? now;
      this.mapboxFirstSeen.set(h.id, first);
      return { ...h, reportedAt: first };
    });
    for (const [id, t] of this.mapboxFirstSeen) if (now - t > 24 * 3600_000) this.mapboxFirstSeen.delete(id);
    const fromFriends = hazardsFromReports(this.net.doc.allReports(), now);
    const osmArea = s.nav?.route ? bboxOf(s.nav.route.geometry, 2000) : this.viewport;
    const osm = osmArea ? this.osm.cached(osmArea, now) : [];
    const merged = this.service.merged([...this.local, ...fromRoute, ...fromFriends, ...osm, ...this.anon.hazards(now)], now);
    useApp.getState().set({ hazards: merged, hazardHealth: [...this.service.health(), ...this.pois.health(), ...roadWeather.health()], pois: poiArea(osmArea) ? this.pois.within(osmArea!, now) : [] });
    this.notifyAhead(merged, now);
  }

  /** Local notification for a hazard a friend just reported on the road ahead while navigating (voice/alerts settings and mute respected). */
  private notifyAhead(merged: MergedHazard[], now: number): void {
    const seen = this.notified;
    const fresh = merged.filter((h) => !seen.has(h.id));
    for (const h of fresh) seen.add(h.id);
    if (!this.notifyPrimed) {
      this.notifyPrimed = true; // hazards already known at startup are not new
      return;
    }
    const s = useApp.getState();
    const nav = s.nav;
    if (!nav?.active || !nav.progress || !s.settings.hazardAlerts || s.settings.voice === 'off') return;
    if (now - this.lastNotifyAt < NOTIFY_EVERY_MS) return;
    const line = nav.route.geometry;
    if (line.length < 2) return;
    const cum = cumulativeDistances(line);
    for (const h of fresh) {
      const by = h.reporters.filter((r) => r !== this.me.deviceId);
      if (by.length === 0 || by.every((r) => isMuted(r))) continue;
      const pr = projectOnPolyline(h, line, cum);
      const ahead = pr.alongM - nav.progress.alongM;
      if (pr.distanceM > NOTIFY_OFF_ROUTE_M || ahead < 0 || ahead > NOTIFY_AHEAD_M) continue;
      this.lastNotifyAt = now;
      const type = HZ_KEYS.has(h.type) ? t(`hz.${h.type}` as I18nKey) : t('hz.hazard');
      void notify(t('notif.hazardAhead', { type, dist: formatDistance(ahead, lang()) }), '', { channel: 'alerts', data: { type: 'hazard', hazardId: h.id } });
      return;
    }
  }
}
