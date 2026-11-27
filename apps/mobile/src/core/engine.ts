import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { platform } from '@crewmap/platform';
import { b64, concat, fromUtf8, sodium, splitLegacySharing, unb64, utf8, type DeviceIdentity, type LegacySharingSettings, type RelayPool } from '@crewmap/p2p';
import { setLang } from '@crewmap/shared/i18n';
import { ALL_VISIBLE, aggregateFor, computeStats, shareableStats } from '@crewmap/shared/stats';
import { needsMigration, normalizePlace, type Place, type RawPlace } from '@crewmap/shared/places';
import { deleteIdentity, loadOrCreateIdentity } from './circle';
import { Chat } from './chat';
import { useAsks } from './asksStore';
import { Asks } from './asks';
import { Memories, wipeMemoryPhotos } from './memories';
import { Companions, useDriveAlong } from './companions';
import { Crews } from './crews';
import { createRelayPool } from './relayPool';
import * as db from './db';
import { Emotes } from './emotes';
import { Hazards } from './hazards';
import { Navigator } from './nav';
import { useApp, type Profile, type Settings } from './store';
import { Tracking } from './tracking';
import { startCheckInReceiver } from './checkIn';
import { loadLastCenter } from './lastCenter';
import { loadApiBudget } from './apiBudget';

/** Radio governor: linger before closing (late acks, a quick re-open of the app), and a wake window's length. */
const RADIO_LINGER_MS = 180_000;
const RADIO_WINDOW_MS = 45_000;

/** Montréal offset for stats day boundaries, from the device's current offset. */
const tzOffsetMin = () => -new Date().getTimezoneOffset();

class Engine {
  me!: DeviceIdentity;
  crews!: Crews;
  /** All crews behind one network-shaped facade (policy-enforced per crew). */
  get net(): Crews {
    return this.crews;
  }
  tracking!: Tracking;
  nav!: Navigator;
  hazards!: Hazards;
  emotes!: Emotes;
  chat!: Chat;
  companions!: Companions;
  asks!: Asks;
  memories!: Memories;
  private places: Place[] = [];
  private booted: Promise<void> | null = null;
  private running = false;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private pool!: RelayPool;
  /** Radio governor: relays + direct links close when backgrounded and still (docs/BATTERY.md). */
  private radioUntil = 0;
  private radioTimer: ReturnType<typeof setTimeout> | null = null;
  private radioOffs: (() => void)[] = [];

  boot(): Promise<void> {
    this.booted ??= this.doBoot();
    return this.booted;
  }

  private async doBoot(): Promise<void> {
    await db.openDb();
    this.me = await loadOrCreateIdentity();
    await loadLastCenter();
    void loadApiBudget();
    // D52: the old global stats visibility / per-friend precision move into the crews (crews.load), then leave settings.
    const { settings, legacy: legacySharing } = splitLegacySharing(await db.kvGet<Partial<Settings> & LegacySharingSettings>('settings', {}));
    useApp.getState().patchSettings(settings);
    setLang(useApp.getState().settings.lang);
    if (__DEV__) {
      void platform.audio.voices().then((v) => console.log('[tts] installed voices', v.map((x) => `${x.name} ${x.locale} q${x.quality} ${x.network ? 'network' : 'local'}`)));
    }
    const profile = await db.kvGet<Profile | null>('profile', null);
    const pool = createRelayPool();
    this.pool = pool;
    this.crews = new Crews(this.me, pool);
    this.crews.onPolicyChange = () => void this.reapplySharing();
    await this.crews.load(legacySharing);
    if (legacySharing) await db.kvSet('settings', useApp.getState().settings);
    this.places = await this.migratePlaces((await db.myPlaces()) as RawPlace[]);
    this.tracking = new Tracking(this.net, () => this.places);
    this.nav = new Navigator(this.tracking);
    this.hazards = new Hazards(this.net, this.me);
    this.emotes = new Emotes(this.net);
    this.chat = new Chat(this.crews, this.me);
    this.asks = new Asks(this.crews, this.me);
    this.memories = new Memories(this.crews, () => this.me.deviceId);
    this.companions = new Companions(
      this.crews,
      this.me,
      () => this.tracking.publishNow(),
      async (dest) => {
        try {
          if (useApp.getState().nav?.active) this.nav.end();
          await this.nav.preview(dest);
          this.nav.start();
          return true;
        } catch {
          return false;
        }
      },
      // Convoy (D65): drive a route already fetched (the leader's line), replacing any current navigation.
      (dest, route) => {
        if (useApp.getState().nav?.active) this.nav.end();
        useApp.getState().set({ nav: { route, candidates: [{ route, source: 'base', label: { kind: 'letter', letter: '' } }], destination: dest, progress: null, active: false, rerouting: false } });
        this.nav.start();
      },
    );
    useApp.getState().set({
      me: profile,
      places: this.allPlaces(),
      onboarded: !!profile && this.crews.count > 0 && (await db.kvGet('onboarded', false)),
      ready: true,
    });
    platform.wake.registerHeadlessSync((reason) => this.headlessSync(reason));
  }

  /** Bring everything online (after onboarding, or at launch if already onboarded). */
  async run(): Promise<void> {
    await this.boot();
    if (this.running || this.crews.count === 0) return;
    this.running = true;
    // Tracking first: the user's own position, trips and safety features never wait on network or feeds.
    await this.tracking.start();
    await this.crews.start();
    const me = useApp.getState().me;
    if (me) this.net.publishProfile({ ...me, wake: platform.wake.endpoint() });
    platform.wake.onEndpoint((ep) => this.net.publishProfile({ wake: ep }));
    this.emotes.start();
    this.chat.start();
    this.companions.start();
    this.asks.start();
    this.memories.start();
    startCheckInReceiver(this.crews, this.me);
    this.net.doc.onChange(() => useApp.getState().set({ places: this.allPlaces() }));
    void this.hazards.start().catch((e: unknown) => {
      if (__DEV__) console.warn('hazards start failed', e);
    });
    void platform.wake.register().catch(() => false);
    await this.crews.rotateIfStale();
    await this.maintenance();
    this.purgeTimer = setInterval(() => void this.maintenance(), 6 * 3600_000);
    // A saved drive (the store clears tripStartedAt after saving) refreshes the stats; senders skip unchanged ones.
    this.radioOffs.push(useApp.subscribe((st, prev) => {
      if (prev.tripStartedAt !== null && st.tripStartedAt === null) void this.publishStats();
    }));
    this.tracking.onProfileChange = () => this.governRadio();
    this.tracking.beforeSend = () => this.radioWindow();
    const sub = AppState.addEventListener('change', () => this.governRadio());
    this.radioOffs.push(
      () => sub.remove(),
      // While the relays are closed this is the only listener for pushes from a live JS context.
      platform.wake.onPing(() => {
        if (!this.crews.started) void this.radioWindow();
      }),
    );
    this.governRadio();
  }

  /**
   * Background + still + no drive-along + nothing awaiting an ack, for RADIO_LINGER_MS: close every relay socket and
   * WebRTC link (no keep-alives, no ICE consent checks, no radio tail). Friends reach us with an ntfy wake ping (acked
   * kinds after their first retry) or the 15-min WorkManager sync, exactly like a dozing phone; we reopen on
   * foreground, on moving, on a ping or before sending. Replay on reopen starts from the crew's last-online stamp,
   * which stops advancing while closed, so durable events are never skipped.
   */
  private governRadio(): void {
    if (!this.running) return;
    const active = AppState.currentState === 'active';
    this.crews.setForeground(active);
    const idle = !active && this.tracking.currentProfile === 'still' && !useDriveAlong.getState().session && Date.now() >= this.radioUntil;
    if (this.radioTimer) clearTimeout(this.radioTimer);
    this.radioTimer = null;
    if (!idle) {
      if (!this.crews.started) void this.reopenRadio();
      return;
    }
    if (!this.crews.started) return;
    this.radioTimer = setTimeout(() => {
      this.radioTimer = null;
      if (this.crews.connectivity().queued > 0) return this.governRadio();
      if (AppState.currentState === 'active' || this.tracking.currentProfile !== 'still') return;
      this.crews.stop();
      const urls = [...(this.pool.listConnectionStatus?.().keys() ?? [])];
      if (urls.length) this.pool.close?.(urls);
    }, RADIO_LINGER_MS);
  }

  private reopening: Promise<void> | null = null;
  private reopenRadio(): Promise<void> {
    this.reopening ??= (async () => {
      await this.crews.start();
      this.crews.setForeground(AppState.currentState === 'active');
      // Friends' views went stale while we were closed: one fresh position (normal policy path).
      await this.tracking.publishNow().catch(() => undefined);
    })().finally(() => (this.reopening = null));
    return this.reopening;
  }

  /** Keep the radio open for a short window (push ping, periodic sync, an outgoing alert). */
  async radioWindow(ms = RADIO_WINDOW_MS): Promise<void> {
    this.radioUntil = Math.max(this.radioUntil, Date.now() + ms);
    const wasClosed = !this.crews.started;
    if (wasClosed) await this.reopenRadio();
    if (wasClosed) await this.crews.catchUp();
    setTimeout(() => this.governRadio(), ms + 1000);
  }

  /** Stop and restart every service (benchmark phase changes, transport switches). */
  async restartForBenchmark(): Promise<void> {
    for (const o of this.radioOffs) o();
    this.radioOffs = [];
    if (this.radioTimer) clearTimeout(this.radioTimer);
    this.radioTimer = null;
    this.hazards.stop();
    this.emotes.stop();
    this.chat.stop();
    this.companions.stop();
    this.asks.stop();
    this.memories.stop();
    this.crews.stop();
    await this.tracking.stop().catch(() => undefined);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.running = false;
    await this.run();
  }

  /** Retention purge + publish the stats summary (every crew narrows it to its own visibility, D52). */
  async maintenance(): Promise<void> {
    const s = useApp.getState().settings;
    await db.purgeOlderThan(s.retentionDays, Date.now());
    await this.chat.refreshUnread();
    await this.publishStats();
    void this.memories.maintenance();
  }

  /** Stats summary into the crew docs, plus the leaderboard aggregate sealed per friend (D57). */
  private async publishStats(): Promise<void> {
    const me = useApp.getState().me;
    if (!me || !this.net.router) return;
    const input = { trips: await db.tripSummaries(), walks: await db.walks(), visits: await db.visits() };
    const now = Date.now();
    const tz = tzOffsetMin();
    const periods = ['week', 'month', 'all'] as const;
    const stats = Object.fromEntries(periods.map((p) => [p, shareableStats(computeStats(input, p, now, tz), ALL_VISIBLE, now)]));
    this.net.publishProfile({ stats });
    const homes = new Set(this.places.filter((p) => p.type === 'home' && p.owner === me.deviceId).map((p) => p.id));
    this.net.publishStatsAgg(Object.fromEntries(periods.map((p) => [p, aggregateFor(input, p, now, tz, homes)])));
  }

  /** Runs headlessly after a push ping / periodic WorkManager job / boot: catch up, ack, notify. */
  private async headlessSync(reason: string): Promise<void> {
    await this.boot();
    if (this.crews.count === 0) return;
    if (reason === 'boot' && (await db.kvGet('onboarded', false))) {
      await this.run();
      return;
    }
    if (!this.running) {
      await this.crews.start();
      this.emotes.start();
      this.chat.start();
      startCheckInReceiver(this.crews, this.me);
    } else if (!this.crews.started) {
      // Relays closed by the radio governor: open them for this sync window only.
      await this.radioWindow();
      return void (await new Promise((r) => setTimeout(r, 15_000)));
    }
    await this.crews.catchUp();
    // Give relays time to deliver stored events and acks to go out.
    await new Promise((r) => setTimeout(r, 15_000));
  }

  async saveProfile(p: Omit<Profile, 'deviceId'>): Promise<void> {
    const profile: Profile = { ...p, deviceId: this.me.deviceId };
    await db.kvSet('profile', profile);
    useApp.getState().set({ me: profile });
    if (this.net.router) this.net.publishProfile(profile);
  }

  /** One-shot persisted flag: returns whether it was already set, and sets it. */
  async kvFlag(key: string): Promise<boolean> {
    const was = await db.kvGet<boolean>(key, false);
    if (!was) await db.kvSet(key, true);
    return was;
  }

  async saveSettings(p: Partial<Settings>): Promise<void> {
    useApp.getState().patchSettings(p);
    const s = useApp.getState().settings;
    await db.kvSet('settings', s);
    if (p.lang) setLang(p.lang);
    if (p.transport || p.pcRelayUrl !== undefined) this.net.applyTransportSettings();
    if (p.ghost !== undefined && this.net.router) {
      const fix = useApp.getState().fix;
      if (fix) await this.net.publishPresence({ lat: fix.lat, lng: fix.lng, acc: fix.accuracy, spd: fix.speed, hdg: fix.heading, act: useApp.getState().activity, ...(await currentBattery()), t: Date.now(), prec: 'p' });
    }
  }

  /** A crew's policy changed (or a crew was added): re-apply places, profile and presence under the new policy. */
  private async reapplySharing(): Promise<void> {
    for (const p of this.places) this.net.doc.putPlace(p);
    const me = useApp.getState().me;
    if (me) this.net.publishProfile({});
    useApp.getState().set({ places: this.allPlaces() });
    const fix = useApp.getState().fix;
    if (fix && this.net.router) await this.net.publishPresence({ lat: fix.lat, lng: fix.lng, acc: fix.accuracy, spd: fix.speed, hdg: fix.heading, act: useApp.getState().activity, ...(await currentBattery()), t: Date.now(), prec: 'p' });
  }

  async finishOnboarding(): Promise<void> {
    await db.kvSet('onboarded', true);
    useApp.getState().set({ onboarded: true });
    await this.run();
  }

  // --- places (F7) ------------------------------------------------------------------------------------------------

  allPlaces(): Place[] {
    const shared = this.net?.doc ? this.net.doc.sharedPlaces() : [];
    const mine = new Map(this.places.map((p) => [p.id, p]));
    return [...this.places, ...shared.filter((p) => !mine.has(p.id))];
  }

  /** One-time upgrade of stored places (legacy "shared" = every crew whose policy shares places). */
  private async migratePlaces(raw: RawPlace[]): Promise<Place[]> {
    const legacy = this.crews.ids.filter((id) => this.crews.policy(id).places);
    const out: Place[] = [];
    for (const r of raw) {
      const p = normalizePlace(r, legacy);
      if (needsMigration(r)) await db.savePlace(p);
      out.push(p);
    }
    return out;
  }

  async savePlace(input: Place): Promise<void> {
    const p = normalizePlace(input, this.crews.ids);
    await db.savePlace(p);
    this.places = [...this.places.filter((x) => x.id !== p.id), p];
    // Into the docs of crews it is shared with and whose policy shares places; removed from every other crew doc.
    this.net.doc.putPlace(p);
    useApp.getState().set({ places: this.allPlaces() });
    await this.tracking.registerGeofences();
  }

  async deletePlace(id: string): Promise<void> {
    await db.deletePlace(id);
    this.places = this.places.filter((p) => p.id !== id);
    this.net.doc.removePlace(id);
    useApp.getState().set({ places: this.allPlaces() });
    await this.tracking.registerGeofences();
  }

  // --- encrypted backup (owner's own Drive via the system share sheet) ---------------------------------------------

  /** Returns a file to save plus a recovery key the user must keep (shown once). */
  async exportBackup(): Promise<{ file: File; recoveryKey: string }> {
    const s = sodium();
    const payload = {
      v: 1,
      at: Date.now(),
      profile: useApp.getState().me,
      settings: useApp.getState().settings,
      places: this.places, // includes private places — only inside this encrypted file
      trips: await Promise.all((await db.tripSummaries()).map((t) => db.loadTrip(t.id))),
      walks: await db.walks(),
      visits: await db.visits(),
    };
    const key = s.randombytes_buf(32);
    const nonce = s.randombytes_buf(24);
    const box = s.crypto_secretbox_easy(utf8(JSON.stringify(payload)), nonce, key);
    const file = new File(Paths.cache, `crewmap-backup-${new Date().toISOString().slice(0, 10)}.cmb`);
    file.create({ overwrite: true });
    file.write(b64(concat(nonce, box)));
    return { file, recoveryKey: b64(key) };
  }

  async importBackup(file: File, recoveryKey: string): Promise<void> {
    const raw = unb64(await file.text());
    const plain = sodium().crypto_secretbox_open_easy(raw.subarray(24), raw.subarray(0, 24), unb64(recoveryKey.trim()));
    const data = JSON.parse(fromUtf8(plain)) as { places: Place[]; trips: (Parameters<typeof db.saveTrip>[0] | null)[]; walks: Parameters<typeof db.saveWalk>[0][]; settings: Settings };
    for (const p of data.places) await this.savePlace(normalizePlace(p as RawPlace, this.crews.ids));
    for (const t of data.trips) if (t) await db.saveTrip(t);
    for (const w of data.walks) await db.saveWalk(w);
    // Backups from before D52 carry the global sharing keys: sharing is per crew now, so they are dropped.
    await this.saveSettings(splitLegacySharing(data.settings).settings);
  }

  // --- account deletion (X2) ----------------------------------------------------------------------------------------

  async deleteAccount(): Promise<void> {
    for (const id of this.crews.ids) await this.crews.leave(id).catch(() => undefined);
    await this.tracking.stop().catch(() => undefined);
    this.hazards.stop();
    this.emotes.stop();
    this.chat.stop();
    this.crews.stop();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    platform.wake.unregister();
    await platform.geofence.clear().catch(() => undefined);
    this.asks.stop();
    this.memories.stop();
    useAsks.setState({ entries: [] });
    await db.wipeAll();
    wipeMemoryPhotos();
    await deleteIdentity();
    this.running = false;
    this.booted = null;
    useApp.getState().set({ me: null, circle: null, crews: [], crewFilter: null, sharing: {}, allFriends: {}, friends: {}, onboarded: false, places: [], hazards: [], emotes: [], emoteDigest: {}, chatUnread: {}, nav: null });
  }
}

export const engine = new Engine();

/** The current battery reading for an out-of-cadence presence, so it never resets a friend's battery to unknown. */
async function currentBattery(): Promise<{ bat: number | null; chg: boolean }> {
  const b = await platform.power.battery().catch(() => ({ level: null, charging: false }));
  return { bat: b.level, chg: b.charging };
}
