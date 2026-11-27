import { AppState } from 'react-native';
import { platform, ProfileGovernor, type Fix, type SamplingProfile } from '@crewmap/platform';
import {
  DrivingPipeline,
  markPassenger,
  type Activity,
  type RiskyEvent,
  type Trip,
} from '@crewmap/shared/driving';
import { haversineM } from '@crewmap/shared/geo';
import {
  addDriveSample,
  driveSample,
  traceOfTrip,
  type DriveSample,
  type PreviewRecord,
} from '@crewmap/shared/navigation';
import {
  ArrivalDetector,
  ProximityMoments,
  subscribersFor,
  type ArrivalEvent,
  type Place,
} from '@crewmap/shared/places';
import { cellKey, StayDetector, WalkTracker } from '@crewmap/shared/stats';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance, formatKm } from '@crewmap/shared/units';
import { BATTERY_PUBLISH_GAP_MS, batteryChanged, utf8, type Presence } from '@crewmap/p2p';
import * as db from './db';
import { hasMapboxToken, matchLimits, reverseCity } from './mapbox';
import { budgetLevel, countSaved } from './apiBudget';
import { LimitCache } from '@crewmap/shared/speedLimits';
import type { Crews } from './crews';
import { notify } from './notify';
import { externalEta } from './externalStatus';
import { useApp } from './store';
import { rememberCenter } from './lastCenter';
import { overlayShowing } from './overlay';
import { useDriveAlong } from './companions';
import { recordError } from './errorLog';
import { headingToMe, type EtaView } from '@crewmap/shared/etaRefresh';
import { checkInActivity, checkInCrash, checkInFix, startCheckIn } from './checkIn';
import { forgetParkedFromTrip, parkingFix, parkingTick, parkingTripEnded, parkingTripStarted } from './parking';

/** On-device route learning: drives of previewed routes (actual vs predicted) and the last preview. */
export const DRIVE_SAMPLES_KEY = 'routeDrives';
export const LAST_PREVIEW_KEY = 'routeLastPreview';
const LIMIT_CACHE_KEY = 'limitCache.v1';

/** Presence cadence by state while a friend has the app open (docs/BATTERY.md). */
const PRESENCE_EVERY_MS: Record<SamplingProfile, number> = {
  navigating: 4000,
  driving: 5000,
  walking: 30_000,
  still: 300_000,
};
/** ...and while nobody is watching (viewer demand, protocol 4): a friend opening the app gets a fresh one at once. */
const PRESENCE_UNWATCHED_MS: Record<SamplingProfile, number> = {
  navigating: 4000,
  driving: 15_000,
  walking: 120_000,
  still: 900_000,
};
const SIGNIFICANT_MOVE_M = 100;
/** Housekeeping tick (trip end, heartbeat presence, ETAs, friends near): slower while still. */
const TICK_MS: Record<SamplingProfile, number> = {
  navigating: 30_000,
  driving: 30_000,
  walking: 30_000,
  still: 120_000,
};
/** Activity Recognition sampling: transitions (enter vehicle/walking) still arrive at once while still. */
const ACTIVITY_MS: Record<SamplingProfile, number> = {
  navigating: 10_000,
  driving: 10_000,
  walking: 10_000,
  still: 120_000,
};
/** Still: an exit fence around where we stopped catches movement the activity classifier misses. */
const HERE_FENCE = { id: 'crewmap-here', radiusM: 150 };
const DEMAND_MIN_GAP_MS = 15_000;
/** More OS location (re)starts than this per minute is a restart loop (status-bar icon flicking): log it. */
const CHURN_STARTS_PER_MIN = 3;
const CHURN_LOG_GAP_MS = 10 * 60_000;

/**
 * Background pipeline: fixes + activity + IMU + screen → trips with risky events, walks, visits, arrivals, proximity
 * moments, speed limit, and presence publishing with adaptive sampling.
 */
export class Tracking {
  private pipeline: DrivingPipeline;
  private arrivals = new ArrivalDetector([]);
  private walks = new WalkTracker();
  private stays = new StayDetector();
  private moments = new ProximityMoments();
  private near = new ProximityMoments({ friendsNearM: 500 });
  private nearM = 500;
  private profile: SamplingProfile = 'still';
  private here: { lat: number; lng: number } | null = null;
  private lastDemandAt = 0;
  /** Hysteresis on profile changes: classifier flaps never restart the OS location request. */
  private gov = new ProfileGovernor();
  private govTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChurnLogAt = 0;
  /** Engine lifecycle hook (radio governor). */
  onProfileChange: (p: SamplingProfile) => void = () => undefined;
  /** Engine hook: make sure the radio is open before an outgoing alert. */
  beforeSend: () => Promise<void> = async () => undefined;
  private lastPresenceAt = 0;
  private lastPresencePos: { lat: number; lng: number } | null = null;
  private offlineTrail: [number, number, number][] = [];
  private recent: Fix[] = [];
  private lastLimitAt = 0;
  private limits: Promise<LimitCache> | null = null;
  private limitsSavedAt = 0;
  private stopImu: (() => void) | null = null;
  private offs: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Location start was refused (background start restriction); retried on the next foreground. */
  private locationPending = false;
  private retryArmed = false;

  private retryLocationWhenActive(): void {
    if (this.retryArmed) return;
    this.retryArmed = true;
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' || !this.locationPending) return;
      sub.remove();
      this.retryArmed = false;
      void this.applyProfile(this.profile, true);
    });
  }
  private tripStartFix: Fix | null = null;
  private drivingHomeSent = false;
  private battery = { level: null as number | null, charging: false };
  private lastPresenceBat: { level: number | null; charging: boolean } | null = null;
  /** Phone-handling: unlocked + interactive while moving counts as touches every 2 s. */
  private unlockedSince: number | null = null;

  constructor(
    private readonly net: Crews,
    private readonly myPlaces: () => Place[],
  ) {
    this.pipeline = new DrivingPipeline(
      { newId: () => `trip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}` },
      {
        onTripStarted: (startedAt) => this.onTripStarted(startedAt),
        onEvent: (e) => this.onEvent(e),
        onTripEnded: (trip) => void this.onTripEnded(trip),
      },
    );
  }

  async start(): Promise<void> {
    platform.wake.setSharingEnabled(true);
    this.offs.push(
      platform.location.onFixes((fixes) => void this.onFixes(fixes)),
      platform.motion.onActivity((a) => {
        this.pipeline.activity(a);
        checkInActivity(a);
        useApp.getState().set({ activity: a.activity });
        void this.adaptProfile();
      }),
      platform.screen.onChange((e) => {
        if (e.kind === 'unlocked' || (e.kind === 'screenOn' && !platform.screen.current().locked))
          this.unlockedSince ??= e.t;
        if (e.kind === 'screenOff') this.unlockedSince = null;
      }),
      platform.geofence.onEvent((e) => {
        // Registering fences fires an initial "enter" for every fence we're inside (INITIAL_TRIGGER_ENTER). For the
        // "here" fence that is always the case, and answering it with a GNSS fix + re-arm looped every few seconds
        // (status-bar location icon flicking). Only a real exit from "here" matters.
        if (e.id === HERE_FENCE.id && e.kind !== 'exit') return;
        void platform.location.current().then(async (f) => {
          if (f) await this.onFixes([f]);
          // Left the "here" fence but the classifier still says still: re-arm it where we are now.
          if (e.id === HERE_FENCE.id && this.profile === 'still') await this.armHere(true);
        });
      }),
      platform.power.onBattery((b) => (this.battery = b)),
      this.net.onDemand(() => this.onDemand()),
    );
    this.battery = await platform.power.battery();
    await startCheckIn(this.net, () => this.relevantPlaces(), () => this.beforeSend());
    this.gov.set('still', Date.now());
    await this.applyProfile('still', true);
    await this.registerGeofences();
    // Show our own marker right away; a still phone can go minutes without a new fix.
    if (!useApp.getState().fix) {
      const f = await platform.location.current().catch(() => null);
      if (f && !useApp.getState().fix) useApp.getState().set({ fix: f });
    }
  }

  async stop(): Promise<void> {
    for (const o of this.offs) o();
    this.offs = [];
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.govTimer) clearTimeout(this.govTimer);
    this.govTimer = null;
    this.stopImu?.();
    this.stopImu = null;
    for (const trip of this.pipeline.flush()) await this.onTripEnded(trip);
    await platform.location.stopBackground();
    await platform.motion.stopActivity().catch(() => undefined);
    platform.wake.setSharingEnabled(false);
  }

  /** OS geofences wake the app near places that matter (mine + friends' shared places I'm subscribed to as target). */
  async registerGeofences(): Promise<void> {
    const places = this.relevantPlaces();
    this.arrivals.setPlaces(places);
    const fences = places.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, radiusM: p.radiusM }));
    if (this.here)
      fences.unshift({
        id: HERE_FENCE.id,
        lat: this.here.lat,
        lng: this.here.lng,
        radiusM: HERE_FENCE.radiusM,
      });
    await platform.geofence.set(fences).catch(() => undefined);
  }

  get currentProfile(): SamplingProfile {
    return this.profile;
  }

  /** A friend opened the app while nobody was watching: send a fresh position now (rate-limited). */
  private onDemand(): void {
    const now = Date.now();
    if (now - this.lastDemandAt < DEMAND_MIN_GAP_MS) return;
    this.lastDemandAt = now;
    void this.publishNow();
  }

  /** Arm (still) or drop (moving) the exit fence around the current position. */
  private async armHere(on: boolean): Promise<void> {
    const fix = useApp.getState().fix;
    const next = on && fix ? { lat: fix.lat, lng: fix.lng } : null;
    if (!next && !this.here) return;
    // Already armed about here: re-registering would only fire the fences' initial triggers again.
    if (next && this.here && haversineM(next, this.here) < HERE_FENCE.radiusM / 3) return;
    this.here = next;
    await this.registerGeofences();
  }

  private relevantPlaces(): Place[] {
    const mine = this.myPlaces();
    const shared = this.net.doc.sharedPlaces();
    const byId = new Map<string, Place>();
    for (const p of [...mine, ...shared]) byId.set(p.id, p);
    return [...byId.values()];
  }

  setNavigating(on: boolean): void {
    // Explicit user action: applies at once (the governor treats entering/leaving navigation as urgent).
    const p: SamplingProfile = on ? 'navigating' : this.pipeline.state === 'driving' ? 'driving' : 'still';
    this.gov.set(p, Date.now());
    void this.applyProfile(p);
  }

  private async adaptProfile(): Promise<void> {
    const st = useApp.getState();
    const next: SamplingProfile = st.nav?.active
      ? 'navigating'
      : this.pipeline.state !== 'idle'
        ? 'driving'
        : st.activity === 'walking' || st.activity === 'running' || st.activity === 'cycling'
          ? 'walking'
          : st.activity === 'automotive'
            ? 'driving'
            : 'still';
    const r = this.gov.propose(next, Date.now());
    if (r.apply) {
      if (this.govTimer) clearTimeout(this.govTimer);
      this.govTimer = null;
      await this.applyProfile(r.apply);
    } else if (r.dueAt !== null && !this.govTimer) {
      // A pending change takes effect once it has held; re-check then even if no new signal arrives.
      this.govTimer = setTimeout(() => {
        this.govTimer = null;
        void this.adaptProfile();
      }, Math.max(1000, r.dueAt - Date.now()));
    }
  }

  private async applyProfile(p: SamplingProfile, force = false): Promise<void> {
    if (p === this.profile && !force) return;
    const prev = this.profile;
    this.profile = p;
    try {
      await platform.location.startBackground(p, { title: t('notif.sharing'), body: t('notif.sharingBody') });
      this.locationPending = false;
      this.checkLocationChurn();
    } catch (e) {
      // Android 12+ refuses to start a location foreground service while the app is in the background (cold start
      // with the screen off, boot, headless wake). Not fatal: keep going and retry as soon as we're in the foreground.
      this.locationPending = true;
      this.retryLocationWhenActive();
      if (__DEV__) console.warn('location start deferred until foreground', e);
    }
    if (force || TICK_MS[p] !== TICK_MS[prev] || !this.tickTimer) {
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), TICK_MS[p]);
    }
    // Same PendingIntent: re-requesting replaces the sampling interval; transitions stay registered.
    if (force || ACTIVITY_MS[p] !== ACTIVITY_MS[prev])
      await platform.motion.startActivity(ACTIVITY_MS[p]).catch(() => undefined);
    await this.armHere(p === 'still');
    this.onProfileChange(p);
    const driving = p === 'driving' || p === 'navigating';
    if (driving && !this.stopImu) {
      this.stopImu = platform.motion.startImu(20, (time, magnitude) =>
        this.pipeline.imu({ t: time, magnitude }),
      );
    } else if (!driving && this.stopImu) {
      this.stopImu();
      this.stopImu = null;
    }
  }

  /** Replay harness entry (dev builds): same path as OS fixes. */
  async injectFixes(fixes: Fix[]): Promise<void> {
    await this.onFixes(fixes);
  }

  /** Dev replay: timestamps run ahead of the wall clock, so advance the trip detector in replay time to close the trip. */
  async finishReplay(atT: number): Promise<void> {
    this.pipeline.activity({ t: atT, activity: 'still', confidence: 100 });
    for (const trip of this.pipeline.tick(atT)) await this.onTripEnded(trip);
    useApp.getState().set({ driving: this.pipeline.state === 'driving', activity: 'still' });
  }

  injectActivity(a: { t: number; activity: Activity; confidence: number }): void {
    this.pipeline.activity(a);
    useApp.getState().set({ activity: a.activity });
  }

  private async onFixes(fixes: Fix[]): Promise<void> {
    if (fixes.length === 0) return;
    await db.appendHistory(fixes);
    const st = useApp.getState();
    // Read the crew docs once per batch, not per fix.
    let shared: Place[] | null = null;
    for (const f of fixes) {
      this.recent.push(f);
      if (this.recent.length > 20) this.recent.shift();
      const limit = st.nav?.progress?.limitKph ?? st.limitKph;
      // Phone handling: emit a touch every 2 s while unlocked and moving.
      if (this.unlockedSince !== null && (f.speed ?? 0) >= 4.17 && !st.nav?.active)
        this.pipeline.interaction({ t: f.t, kind: 'touch' });
      for (const trip of this.pipeline.location(f, limit)) await this.onTripEnded(trip);
      checkInFix(f);
      for (const e of this.arrivals.onFix(f)) await this.onArrival(e);
      const walk = this.walks.onFix(f, st.activity === 'walking' || st.activity === 'running');
      if (walk) await db.saveWalk(walk);
      const stay = this.stays.onFix(f);
      if (stay) void this.recordVisit(stay);
      if (this.pipeline.state === 'driving' && st.settings.moments && st.me) {
        for (const m of this.moments.passPlaces(
          st.me.deviceId,
          f,
          (shared ??= this.net.doc.sharedPlaces()),
        )) {
          if (m.kind !== 'passPlace') continue;
          useApp.getState().set({ moments: [...useApp.getState().moments, m].slice(-5) });
          const place = this.net.doc.places.get(m.placeId);
          const owner = this.net.doc.profile(m.owner);
          if (place && owner)
            void notify(t('notif.passPlace', { name: owner.name, place: place.name }), '', {
              channel: 'circle',
              data: { type: 'moment', friendId: m.owner, placeId: m.placeId },
            });
        }
      }
      this.checkDrivingHome(f);
    }
    const last = fixes[fixes.length - 1]!;
    if (this.pipeline.state !== 'driving') parkingFix(last);
    rememberCenter(last);
    useApp.getState().set({ fix: last, driving: this.pipeline.state === 'driving' });
    if (this.profile === 'still' && !this.here && last.accuracy <= HERE_FENCE.radiusM)
      void this.armHere(true);
    await this.maybeLimit(last);
    await this.maybePresence(last);
    void this.adaptProfile();
  }

  private tick(): void {
    for (const trip of this.pipeline.tick(Date.now())) void this.onTripEnded(trip);
    parkingTick(Date.now());
    const fix = useApp.getState().fix;
    if (fix) void this.maybePresence(fix);
    void this.refreshEtas();
    this.checkFriendsNear();
    this.checkLocationChurn();
  }

  /** Diagnostics: a location request restart loop shows in Settings → Help → Diagnostics. */
  private checkLocationChurn(): void {
    const now = Date.now();
    const c = platform.location.requestChurn(60_000);
    if (c.starts <= CHURN_STARTS_PER_MIN || now - this.lastChurnLogAt < CHURN_LOG_GAP_MS) return;
    this.lastChurnLogAt = now;
    recordError('js', `location request churn: ${c.starts} starts, ${c.stops} stops in 60 s (profile ${this.profile})`);
  }

  /** Friend drive times (D45): only for a surface that shows them, nothing with the screen off. */
  refreshEtas(): Promise<void> {
    const screenOn = platform.screen.current().interactive;
    const view: EtaView = !screenOn ? 'off' : AppState.currentState === 'active' ? 'map' : overlayShowing() ? 'overlay' : 'off';
    const fix = useApp.getState().fix;
    const navEtaToMe = new Map<string, number>();
    if (fix)
      for (const [id, r] of Object.entries(useDriveAlong.getState().routes))
        if (r.eta != null && headingToMe(r.line[r.line.length - 1], fix)) navEtaToMe.set(id, r.eta);
    return this.net.refreshEtas({ view, navEtaToMe });
  }

  /** Posted limits per road cell (D60): filled by navigation routes and Map Matching, read before any request. */
  private async limitCache(): Promise<LimitCache> {
    this.limits ??= db.kvGet<unknown>(LIMIT_CACHE_KEY, []).then((v) => new LimitCache(v), () => new LimitCache());
    return this.limits;
  }

  private saveLimits(cache: LimitCache, now: number): void {
    if (now - this.limitsSavedAt < 5 * 60_000) return;
    this.limitsSavedAt = now;
    void db.kvSet(LIMIT_CACHE_KEY, cache.toJSON()).catch(() => undefined);
  }

  private async maybeLimit(f: Fix): Promise<void> {
    const st = useApp.getState();
    const cache = await this.limitCache();
    if (st.nav?.active) {
      // Every store set runs every subscriber: skip when unchanged (this runs per fix).
      const limitKph = st.nav.progress?.limitKph ?? null;
      if (limitKph !== st.limitKph) useApp.getState().set({ limitKph });
      // The route's limits are free: remember them for drives without navigation.
      cache.put(f, f.heading, limitKph, f.t);
      this.saveLimits(cache, f.t);
      return;
    }
    if (this.pipeline.state !== 'driving' || !hasMapboxToken()) return;
    const known = cache.get(f, f.heading, f.t);
    if (known !== null && known !== st.limitKph) useApp.getState().set({ limitKph: known });
    const level = budgetLevel('mapMatching');
    const gap = level === 'ok' ? 30_000 : 90_000;
    if (f.t - this.lastLimitAt < gap) return;
    this.lastLimitAt = f.t;
    if (known !== null || level === 'off') {
      if (known !== null) countSaved('mapMatching');
      return;
    }
    try {
      const m = await matchLimits(this.recent);
      for (const p of m.points) cache.put(p, p.heading, p.kph, f.t);
      this.saveLimits(cache, f.t);
      useApp.getState().set({ limitKph: m.last });
    } catch {
      // keep the previous limit
    }
  }

  /** Publish a fresh presence now, outside the normal cadence (a friend asked for my location, D31). */
  async publishNow(): Promise<void> {
    const fix = useApp.getState().fix;
    if (!fix) return;
    this.lastPresenceAt = 0;
    this.lastPresencePos = null;
    await this.maybePresence(fix);
  }

  private async maybePresence(f: Fix): Promise<void> {
    const now = Date.now();
    // A coarse (Wi-Fi/cell) fix jitters by its accuracy: only a move beyond it counts.
    const moved =
      !this.lastPresencePos || haversineM(this.lastPresencePos, f) > Math.max(SIGNIFICANT_MOVE_M, f.accuracy);
    const every = (this.net.watched() ? PRESENCE_EVERY_MS : PRESENCE_UNWATCHED_MS)[this.profile];
    // expo-battery's level listener only fires on BATTERY_LOW/OKAY on Android: read the level on each existing tick
    // (one cheap system call, no extra wake-up) so a charge shows up and every presence carries the current reading.
    this.battery = await platform.power.battery().catch(() => this.battery);
    const batChanged = batteryChanged(this.lastPresenceBat, this.battery);
    if (
      now - this.lastPresenceAt < every &&
      !(moved && now - this.lastPresenceAt > 15_000) &&
      !(batChanged && now - this.lastPresenceAt > BATTERY_PUBLISH_GAP_MS)
    )
      return;
    const st = useApp.getState();
    const p: Presence = {
      lat: f.lat,
      lng: f.lng,
      acc: Math.round(f.accuracy),
      spd: f.speed,
      hdg: f.heading,
      act: (this.pipeline.state === 'driving' ? 'automotive' : st.activity) as Activity,
      bat: this.battery.level,
      chg: this.battery.charging,
      t: f.t,
      prec: 'p',
    };
    if (st.nav?.active && st.nav.progress) p.eta = st.nav.progress.eta;
    const ext = externalEta();
    if (ext) {
      p.eta = ext.at;
      p.etaSrc = ext.app;
    }
    const online = (await platform.power.network()).online;
    useApp.getState().set({ online });
    if (!online) {
      this.offlineTrail.push([f.lat, f.lng, f.t]);
      if (this.offlineTrail.length > 60) this.offlineTrail.shift();
      return;
    }
    if (this.offlineTrail.length) {
      p.trail = this.offlineTrail.slice(-30);
      this.offlineTrail = [];
    }
    this.lastPresenceAt = now;
    this.lastPresencePos = f;
    this.lastPresenceBat = { ...this.battery };
    await this.net.publishPresence(p).catch(() => undefined);
  }

  private onTripStarted(startedAt: number): void {
    this.tripStartFix = useApp.getState().fix;
    parkingTripStarted(startedAt, this.tripStartFix);
    this.drivingHomeSent = false;
    useApp.getState().set({ tripStartedAt: startedAt, driving: true, liveEvents: [] });
    void this.adaptProfile();
  }

  private onEvent(e: RiskyEvent): void {
    useApp.getState().set({ liveEvents: [...useApp.getState().liveEvents, e] });
    if (e.kind === 'crash') {
      // Crash-like spikes alert only the owner of the phone; no auto-calling (F1). Same id as the check-in ask (D66),
      // which replaces it and tells the opted-in crew only if this stays unanswered.
      void notify(t('notif.crash'), '', { channel: 'alerts', data: { type: 'crash' }, identifier: 'checkin' });
      checkInCrash(e.t);
    }
  }

  private async onTripEnded(trip: Trip): Promise<void> {
    await db.saveTrip(trip);
    await this.learnRoute(trip);
    useApp
      .getState()
      .set({
        tripStartedAt: null,
        driving: false,
        limitKph: null,
        lastTripEnd: {
          id: trip.id,
          at: Date.now(),
          durationS: trip.durationS,
          events: trip.events.length,
          passenger: trip.passenger,
        },
      });
    this.tripStartFix = null;
    void this.adaptProfile();
    void parkingTripEnded(trip, this.myPlaces()).catch((e: unknown) => recordError('js', e));
    // Background only, and never while a new drive is already under way.
    if (AppState.currentState !== 'active' && this.pipeline.state !== 'driving' && trip.distanceM >= 200) {
      const dist = formatKm(trip.distanceM / 1000, lang());
      const body =
        trip.score !== null && !trip.passenger
          ? t('notif.tripSaved', { dist, score: Math.round(trip.score) })
          : t('notif.tripSavedNoScore', { dist });
      void notify(body, '', { channel: 'circle', silent: true, data: { type: 'trip', tripId: trip.id } });
    }
  }

  async setPassenger(trip: Trip, passenger: boolean): Promise<Trip> {
    const next = markPassenger(trip, passenger);
    await db.setPassenger(trip.id, passenger, next.score);
    if (passenger) await db.deleteRouteTrace(trip.id);
    if (passenger) forgetParkedFromTrip(trip.id);
    else await this.learnRoute(next);
    return next;
  }

  /** Driver trips feed route learning (simplified polyline, on-device only). */
  private async learnRoute(trip: Trip): Promise<void> {
    if (trip.passenger) return;
    const tr = traceOfTrip(trip);
    if (!tr) return;
    await db.saveRouteTrace(tr);
    // Actual vs predicted time when this trip drove a route of the preview that preceded it.
    const preview = await db.kvGet<PreviewRecord | null>(LAST_PREVIEW_KEY, null);
    const sample = driveSample(tr, trip.startedAt, preview, undefined, trip.points);
    if (!sample) return;
    await db.kvSet(
      DRIVE_SAMPLES_KEY,
      addDriveSample(await db.kvGet<DriveSample[]>(DRIVE_SAMPLES_KEY, []), sample),
    );
    await db.kvSet(LAST_PREVIEW_KEY, null);
  }

  /** F6: arrival/leave on my own phone → send to subscribers over P2P. */
  private async onArrival(e: ArrivalEvent): Promise<void> {
    await this.beforeSend().catch(() => undefined);
    const me = useApp.getState().me;
    const router = this.net.router;
    if (!me || !router) return;
    const subs = [...this.net.doc.subscriptions.values()];
    const place = this.relevantPlaces().find((p) => p.id === e.placeId);
    if (!place || place.visibility !== 'shared') return;
    for (const to of subscribersFor(subs, me.deviceId, e)) {
      const via = this.net.arrivalCrewsFor(e.placeId, to);
      if (via.length)
        await router.sendTo(
          to,
          'arrival',
          utf8(JSON.stringify({ placeId: e.placeId, placeName: place.name, kind: e.kind, t: e.t })),
          via,
        );
    }
  }

  /** "Starts driving home": within 5 min of a trip start, ≥ 1 km from Home and 400 m closer than at the start. */
  private checkDrivingHome(f: Fix): void {
    if (this.drivingHomeSent || this.pipeline.state !== 'driving' || !this.tripStartFix) return;
    const st = useApp.getState();
    if (!st.tripStartedAt || f.t - st.tripStartedAt > 5 * 60_000) return;
    const home =
      this.myPlaces().find((p) => p.type === 'home' && p.visibility === 'shared') ??
      this.net.doc.sharedPlaces().find((p) => p.type === 'home' && p.owner === st.me?.deviceId);
    if (!home) return;
    const d0 = haversineM(this.tripStartFix, home);
    const d1 = haversineM(f, home);
    if (d0 < 1000 || d0 - d1 < 400) return;
    this.drivingHomeSent = true;
    const subs = [...this.net.doc.subscriptions.values()].filter(
      (s) => s.target === st.me?.deviceId && s.drivingHome,
    );
    for (const s of subs) {
      const via = this.net.arrivalCrewsFor(home.id, s.subscriber);
      if (via.length)
        void this.net.router?.sendTo(
          s.subscriber,
          'arrival',
          utf8(JSON.stringify({ placeId: home.id, placeName: home.name, kind: 'drivingHome', t: f.t })),
          via,
        );
    }
  }

  private checkFriendsNear(): void {
    const st = useApp.getState();
    if (!st.settings.moments || !st.fix || !st.me) return;
    if (st.settings.friendsNearM !== this.nearM) {
      this.nearM = st.settings.friendsNearM;
      this.near = new ProximityMoments({ friendsNearM: this.nearM });
    }
    const positions = [
      { id: st.me.deviceId, lat: st.fix.lat, lng: st.fix.lng },
      ...Object.values(st.friends)
        .filter((f) => f.presence && f.presence.prec === 'p')
        .map((f) => ({ id: f.profile.deviceId, lat: f.presence!.lat, lng: f.presence!.lng })),
    ];
    for (const m of this.near.friendsNear(positions, Date.now())) {
      if (m.kind !== 'friendsNear') continue;
      const name = (id: string) =>
        id === st.me!.deviceId ? st.me!.name : (st.friends[id]?.profile.name ?? '');
      useApp.getState().set({ moments: [...useApp.getState().moments, m].slice(-5) });
      // Two other friends meeting: never a notification while I'm driving or navigating (it lives in their cards).
      const mine = m.a === st.me.deviceId || m.b === st.me.deviceId;
      if (!mine && (this.pipeline.state === 'driving' || st.nav?.active)) continue;
      void notify(
        t('notif.friendsNear', { a: name(m.a), b: name(m.b), dist: formatDistance(m.distanceM, lang()) }),
        '',
        { channel: 'circle', data: { type: 'moment', friendId: m.a === st.me!.deviceId ? m.b : m.a } },
      );
    }
  }

  private async recordVisit(stay: { lat: number; lng: number; t: number }): Promise<void> {
    const place = this.relevantPlaces().find((p) => haversineM(p, stay) <= p.radiusM);
    const key = place ? place.id : cellKey(stay.lat, stay.lng);
    const geoKey = cellKey(Math.round(stay.lat * 50) / 50, Math.round(stay.lng * 50) / 50);
    let city = await db.geocacheGet(geoKey);
    if (city === undefined && hasMapboxToken()) {
      city = await reverseCity(stay).catch(() => null);
      await db.geocachePut(geoKey, city ?? null, Date.now());
    }
    await db.saveVisit({ t: stay.t, placeKey: key, city: city ?? null, lat: stay.lat, lng: stay.lng });
  }
}
