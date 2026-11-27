import { platform } from '@crewmap/platform';
import { HazardAnnouncer, hazardsOnRoute, isRoadConditionHazard, routeHazardCostS, type FriendReportType, type HazardOnRoute } from '@crewmap/hazards';
import { DEFAULT_ROUTE_OPTIONS, excludeList, normalizeRouteOptions, type RouteOptions, RouteProgress, inQuebec, namesFromStep, segmentUtterance, singleVoice, type SpeechLang, discoverRoutes, learnedRoutes, nextViaCache, odKey, previewRecord, recommend, type DriveSample, type NavRoute, type RouteCandidate, type Via, currentRouteQuery, decideFaster, dismiss, emptyMemory, isBusy, jamAhead, matchCurrent, remainingLine, remainingS, shouldCheck, type LearnedRoute, type ReevalClock, type ReevalMemory, type ReevalTrigger, DISCOVERY, ROUTE_CACHE, discoveryMode, periodOf, routeCacheKey, timeBucket, type TimedTrace } from '@crewmap/shared/navigation';
import { TtlCache } from '@crewmap/shared/ttlCache';
import { formatDistance } from '@crewmap/shared/units';
import { tIn, withLang, type Lang } from '@crewmap/shared/i18n';
import * as db from './db';
import { directions, directionsQuery, snapToRoads } from './mapbox';
import { ownReports } from './hazards';
import { useApp } from './store';
import { DRIVE_SAMPLES_KEY, LAST_PREVIEW_KEY, type Tracking } from './tracking';
import { budgetLevel, countSaved } from './apiBudget';
import { crewBiases } from './etaTruth';
import { roadWeather } from './roadWeather';

/** Route searches of the last few minutes (preview re-opened, options toggled back): no new Directions calls. */
const routeResults = new TtlCache<{ candidates: RouteCandidate[]; calls: number }>(ROUTE_CACHE.ttlMs, ROUTE_CACHE.maxEntries);

/** Language of the navigation voice and of Mapbox instructions; falls back to English when its system voice is missing. */
export function voiceLang(): Lang {
  const s = useApp.getState().settings;
  const want = s.voiceLang ?? s.lang;
  return missingVoices.has(want) && !missingVoices.has('en') ? 'en' : want;
}
const missingVoices = new Set<Lang>();

const ROUTE_OPTIONS_KEY = 'routeOptions';
let routeOptions: RouteOptions = DEFAULT_ROUTE_OPTIONS;
let routeOptionsLoaded = false;

/** The user's route options (avoid tolls / highways / ferries), persisted on this device. */
export async function loadRouteOptions(): Promise<RouteOptions> {
  if (!routeOptionsLoaded) {
    routeOptions = normalizeRouteOptions(await db.kvGet<unknown>(ROUTE_OPTIONS_KEY, null));
    routeOptionsLoaded = true;
  }
  return routeOptions;
}

export function getRouteOptions(): RouteOptions {
  return routeOptions;
}

export async function setRouteOptions(o: RouteOptions): Promise<void> {
  routeOptions = o;
  routeOptionsLoaded = true;
  await db.kvSet(ROUTE_OPTIONS_KEY, o);
}

/** Re-check which system voices are installed (call at nav start; cheap). */
export async function refreshVoices(): Promise<void> {
  for (const l of ['en', 'fr', 'ru'] as const) {
    if ((await platform.audio.voiceStatus(l)) === 'missing') missingVoices.add(l);
    else missingVoices.delete(l);
  }
}

/**
 * Every spoken output goes through here so the HUD mute (settings.voice) is always respected. `names` are road /
 * place names that may appear in `text`; each is spoken in the language it is written in (D-voice).
 */
export function say(text: string, kind: 'guidance' | 'alert' | 'test', names: readonly string[] = []): void {  const v = useApp.getState().settings.voice;  if (kind !== 'test' && (v === 'off' || (v === 'alerts' && kind === 'guidance'))) return;
  const voice = voiceLang();
  const fix = useApp.getState().fix;
  const fallback: SpeechLang = fix && !inQuebec(fix.lat, fix.lng) ? 'en' : 'fr';
  const mixed = segmentUtterance(text, names, voice, fallback);
  const segs = useApp.getState().settings.namesOwnVoice
    ? mixed.map((s) => (missingVoices.has(s.lang) ? { ...s, lang: voice } : s))
    : singleVoice(mixed, voice);
  void platform.audio.speakSegments(segs);
}

/** Spoken confirmation of a one-tap report, so the driver never has to look back at the screen. */
export function sayReported(type: FriendReportType): void {
  const vl = voiceLang();
  say(tIn(vl, 'drive.reported', { type: tIn(vl, `hz.${type}`) }), 'alert');
}

/** Faster-route offer, spoken once and only in full voice mode ('guidance' is muted in alerts-only). */
export function sayFaster(savesS: number): void {
  say(tIn(voiceLang(), 'nav.faster', { min: Math.max(1, Math.round(savesS / 60)) }), 'guidance');
}

/** Ranking cost of the hazards currently known on a route (crashes, works, closures; direction-aware). */
function hazardCost(route: NavRoute): number {
  return routeHazardCostS(route, useApp.getState().hazards);
}

/**
 * Turn-by-turn session (F4a, F11): route preview with alternatives, guidance from our own RouteProgress, spoken
 * instructions (incl. "then…" for close turns), automatic reroute with backoff, hazard warnings ahead on the route.
 */
export class Navigator {
  private progress: RouteProgress | null = null;
  private announcer = new HazardAnnouncer();
  private onRoute: HazardOnRoute[] = [];
  private unsub: (() => void) | null = null;
  private pendingConfirm: string | null = null;
  private reeval: ReevalClock = { startedAt: 0, lastCheckAt: null, checks: 0, busy: false };
  private reevalMem: ReevalMemory = emptyMemory();
  private checking = false;
  private learned: LearnedRoute[] = [];
  private samples: DriveSample[] = [];
  private traces: TimedTrace[] = [];
  /** Accident / closure / jam hazards already seen on the corridor ahead (a new one triggers a check). */
  private corridorIds = new Set<string>();
  readonly confirmListeners = new Set<(hazardId: string | null) => void>();

  constructor(private readonly tracking: Tracking) {}

  /** Route preview: every commonly-driven viable route (recursive alternatives + learned + cached vias), recommended first. */
  async preview(dest: { name: string; lat: number; lng: number }): Promise<RouteCandidate[]> {
    await refreshVoices();
    const want = useApp.getState().settings.voiceLang ?? useApp.getState().settings.lang;
    // Offer the system voice download once, while still parked at route preview.
    if (missingVoices.has(want) && !(await db.kvGet<boolean>(`voiceAsked:${want}`, false))) {
      await db.kvSet(`voiceAsked:${want}`, true);
      void platform.audio.installVoice();
    }
    const fix = useApp.getState().fix ?? (await platform.location.current());
    if (!fix) throw new Error('no location');
    const now = Date.now();
    const exclude = excludeList(await loadRouteOptions());
    const lang = voiceLang();
    // Vias and learned routes were found without restrictions; with an exclusion they could cross the avoided roads.
    const cacheKey = `routeVias:${odKey(fix, dest)}${exclude.length ? `:${exclude.join('+')}` : ''}`;
    const [traces, cachedVias, samples] = await Promise.all([db.routeTraces(), db.kvGet<Via[]>(cacheKey, []), db.kvGet<DriveSample[]>(DRIVE_SAMPLES_KEY, [])]);
    const crew = crewBiases();
    const learned = exclude.length ? [] : learnedRoutes(traces, fix, dest, now);
    // Same O/D, options and language a few minutes ago: same routes, re-ranked with the current hazards (0 calls).
    const resultKey = routeCacheKey(fix, dest, exclude, lang);
    const cached = routeResults.get(resultKey, now);
    let candidates: RouteCandidate[];
    if (cached) {
      countSaved('directions', cached.calls);
      candidates = recommend(cached.candidates, { learned, samples, now, traces, crew, hazardCostS: hazardCost });
    } else {
      // A full discovery per O/D and period (peak / other) once a week; then the kept corridors are re-asked (D60).
      const fullKey = `routeFull:${odKey(fix, dest)}:${periodOf(timeBucket(now))}${exclude.length ? `:${exclude.join('+')}` : ''}`;
      const mode = discoveryMode({ from: fix, to: dest, lastFullAt: await db.kvGet<number | null>(fullKey, null), now, budget: budgetLevel('directions') });
      const res = await discoverRoutes(
        { from: fix, to: dest, heading: fix.heading, learned, cachedVias, samples, now, exclude, hazardCostS: hazardCost, traces, crew, mode },
        (q) => directionsQuery(q, lang),
        snapToRoads,
      );
      candidates = res.candidates;
      if (candidates.length === 0) throw new Error('no route');
      countSaved('directions', DISCOVERY.callBudget - res.calls);
      routeResults.set(resultKey, { candidates, calls: res.calls }, now);
      if (mode === 'full') void db.kvSet(fullKey, now);
      if (mode !== 'lean') void db.kvSet(cacheKey, nextViaCache(cachedVias, res.triedVias, res.keptVias, res.plausibleVias));
    }
    const first = candidates[0];
    if (!first) throw new Error('no route');
    void db.kvSet(LAST_PREVIEW_KEY, previewRecord(candidates, fix, dest, now));
    useApp.getState().set({ nav: { route: first.route, candidates, destination: dest, progress: null, active: false, rerouting: false } });
    return candidates;
  }

  choose(route: NavRoute): void {
    const nav = useApp.getState().nav;
    if (nav) useApp.getState().set({ nav: { ...nav, route } });
  }

  start(): void {
    const nav = useApp.getState().nav;
    if (!nav) return;
    this.progress = new RouteProgress(nav.route);
    this.announcer = new HazardAnnouncer();
    roadWeather.reset();
    this.reeval = { startedAt: Date.now(), lastCheckAt: null, checks: 0, busy: isBusy(jamAhead(nav.route, 0)) };
    this.reevalMem = emptyMemory();
    this.corridorIds = new Set();
    const dest = nav.destination;
    void Promise.all([db.routeTraces(), db.kvGet<DriveSample[]>(DRIVE_SAMPLES_KEY, [])]).then(([traces, samples]) => {
      const fix = useApp.getState().fix;
      this.samples = samples;
      this.traces = traces;
      this.learned = fix && excludeList(getRouteOptions()).length === 0 ? learnedRoutes(traces, fix, dest, Date.now()) : [];
    });
    this.refreshHazards();
    useApp.getState().set({ nav: { ...nav, active: true, faster: null } });
    this.tracking.setNavigating(true);
    let lastFixT = 0;
    this.unsub = useApp.subscribe((s, prev) => {
      if (s.fix && s.fix.t !== lastFixT) {
        lastFixT = s.fix.t;
        void this.onFix();
      }
      if (s.hazards !== prev.hazards) {
        this.refreshHazards();
        if (s.nav?.active) this.corridorTrigger();
      }
    });
  }

  end(): void {
    this.unsub?.();
    this.unsub = null;
    this.progress = null;
    useApp.getState().set({ nav: null });
    this.tracking.setNavigating(false);
  }

  /** Take the offered faster route (one tap, or automatically when settings.autoSwitchFaster). */
  acceptFaster(): void {
    const nav = useApp.getState().nav;
    const offer = nav?.faster;
    if (!nav || !offer) return;
    this.switchTo(offer.route);
  }

  dismissFaster(): void {
    const nav = useApp.getState().nav;
    if (!nav?.faster) return;
    this.reevalMem = dismiss(this.reevalMem, nav.faster, Date.now());
    useApp.getState().set({ nav: { ...nav, faster: null } });
  }

  /** New route mid-trip; the announcer keeps what it already said. */
  private switchTo(route: NavRoute): void {
    this.progress = new RouteProgress(route);
    useApp.getState().set({ nav: { ...useApp.getState().nav!, route, faster: null, rerouting: false } });
    this.reevalMem = emptyMemory();
    this.refreshHazards();
  }

  /**
   * Best route for the moment (D43): every 2–5 min (2 when traffic is bad ahead), or early on a new incident / jam on
   * the corridor; ≤ 2 Directions calls per check, ≤ REEVAL.maxPerTrip checks per trip.
   */
  private async maybeReevaluate(trigger: ReevalTrigger): Promise<void> {
    const s = useApp.getState();
    const nav = s.nav;
    const fix = s.fix;
    const p = nav?.progress;
    if (this.checking || !nav?.active || nav.rerouting || !fix || !p || !this.progress) return;
    const now = Date.now();
    const route = nav.route;
    if (!shouldCheck(this.reeval, now, trigger, { s: remainingS(route, p.alongM), m: route.distanceM - p.alongM })) return;
    // Daily budget (D60): past the soft cap only incidents / jams ahead trigger a check, past the hard cap none.
    const level = budgetLevel('directions');
    if (level === 'off' || (level === 'lean' && trigger === 'timer')) {
      countSaved('directions');
      this.reeval = { ...this.reeval, lastCheckAt: now };
      return;
    }
    this.checking = true;
    this.reeval = { ...this.reeval, lastCheckAt: now, checks: this.reeval.checks + 1 };
    try {
      const exclude = excludeList(getRouteOptions());
      const fresh = await directions(fix, nav.destination, fix.heading, voiceLang(), exclude);
      const rest = remainingLine(route, p.alongM);
      let current = matchCurrent(fresh, rest);
      if (!current) {
        const q = currentRouteQuery([{ lat: fix.lat, lng: fix.lng }, ...rest.slice(1)], fix.heading, exclude);
        current = q ? ((await directionsQuery(q, voiceLang()))[0] ?? null) : null;
      }
      if (!current || useApp.getState().nav?.route !== route) return;
      this.reeval = { ...this.reeval, busy: isBusy(jamAhead(current, 0)) };
      const alts = fresh.filter((r) => r !== current);
      const { offer, memory } = decideFaster(current, alts, { learned: this.learned, samples: this.samples, now: Date.now(), hazardCostS: hazardCost, traces: this.traces, crew: crewBiases() }, this.reevalMem);
      this.reevalMem = memory;
      if (!offer) return;
      if (useApp.getState().settings.autoSwitchFaster) this.switchTo(offer.route);
      else useApp.getState().set({ nav: { ...useApp.getState().nav!, faster: offer } });
    } catch {
      // Offline or quota: keep the current route; the next timer tick retries.
    } finally {
      this.checking = false;
    }
  }

  /** A new accident / closure / jam ahead on the corridor triggers an early check. */
  private corridorTrigger(): void {
    const along = useApp.getState().nav?.progress?.alongM ?? 0;
    let fresh = false;
    for (const h of hazardsOnRoute(useApp.getState().nav!.route, useApp.getState().hazards)) {
      if (h.alongM <= along || !['accident', 'closure', 'jam'].includes(h.hazard.type) || h.hazard.level === 'low') continue;
      if (!this.corridorIds.has(h.hazard.id)) {
        this.corridorIds.add(h.hazard.id);
        fresh = true;
      }
    }
    if (fresh) void this.maybeReevaluate('incident');
  }

  /** Answer to "still there?" (voice or one big tap). */
  confirmAnswer(): string | null {
    const id = this.pendingConfirm;
    this.pendingConfirm = null;
    for (const l of this.confirmListeners) l(null);
    return id;
  }

  private refreshHazards(): void {
    const nav = useApp.getState().nav;
    if (!nav) return;
    // Winter road conditions are spoken once per stretch by the road-weather warning instead (D70).
    this.onRoute = useApp.getState().settings.hazardAlerts ? hazardsOnRoute(nav.route, useApp.getState().hazards).filter((h) => !isRoadConditionHazard(h.hazard)) : [];
  }

  private async onFix(): Promise<void> {
    const s = useApp.getState();
    const nav = s.nav;
    const fix = s.fix;
    if (!nav?.active || !fix || !this.progress) return;
    const vl = voiceLang();
    const progress = this.progress;
    const p = withLang(vl, () => progress.update(fix));
    useApp.getState().set({ nav: { ...nav, progress: p }, limitKph: p.limitKph });
    const steps = nav.route.steps;
    const names = [0, 1, 2].flatMap((k) => namesFromStep(steps[p.stepIndex + k]));
    for (const text of p.speak) say(text, 'guidance', names);
    for (const a of this.announcer.update(this.onRoute, p.alongM, p.next?.distanceM ?? null, { selfId: ownReports.selfId, now: Date.now(), lastOwnReportAt: ownReports.lastAt, ownIds: ownReports.anonIds })) {
      if (a.kind === 'announce') {
        say(tIn(vl, 'hz.ahead', { type: tIn(vl, `hz.${a.hazard.type}`), dist: formatDistance(a.distanceM, vl) }), 'alert');
        platform.haptics.play('warning');
      } else {
        this.pendingConfirm = a.hazard.id;
        for (const l of this.confirmListeners) l(a.hazard.id);
        say(tIn(vl, 'nav.stillThere'), 'alert');
      }
    }
    const rw = s.settings.hazardAlerts ? roadWeather.update(nav.route, s.hazards, p.alongM, Date.now()) : null;
    if (rw) {
      const type = tIn(vl, `rw.${rw.zone.category}`);
      say(rw.distanceM > 0 ? tIn(vl, 'hz.ahead', { type, dist: formatDistance(rw.distanceM, vl) }) : tIn(vl, 'rw.here', { type }), 'alert');
      platform.haptics.play('warning');
    }
    const bw = s.settings.hazardAlerts ? roadWeather.border(nav.route, p.alongM, Date.now()) : null;
    if (bw) say(tIn(vl, bw.minutes > 0 ? 'border.wait' : 'border.none', { name: bw.office, min: bw.minutes }), 'alert', [bw.office]);
    if (p.arrived) {
      say(tIn(vl, 'nav.arrived'), 'guidance');
      setTimeout(() => this.end(), 8000);
      return;
    }
    if (p.shouldReroute) {
      this.progress.markRerouted(fix.t);
      useApp.getState().set({ nav: { ...useApp.getState().nav!, rerouting: true } });
      try {
        const routes = await directions(fix, nav.destination, fix.heading, voiceLang(), excludeList(getRouteOptions()));
        // Same ranking as the preview and the re-evaluation (no extra calls): not just Directions' first answer.
        const label = { kind: 'letter', letter: '' } as const;
        const best = recommend(
          routes.map((route) => ({ route, source: 'base' as const, label })),
          { learned: this.learned, samples: this.samples, now: Date.now(), hazardCostS: hazardCost, traces: this.traces, crew: crewBiases() },
        )[0];
        if (best) {
          this.switchTo(best.route);
        }
      } catch {
        useApp.getState().set({ nav: { ...useApp.getState().nav!, rerouting: false } });
      }
      return;
    }
    const offer = useApp.getState().nav?.faster;
    if (offer && Date.now() >= offer.expiresAt) this.dismissFaster();
    void this.maybeReevaluate('timer');
  }
}

/** Settings "Test voice": a sample instruction with two Québec road names, ignoring the mute setting. */
export async function speakTest(): Promise<void> {
  await refreshVoices();
  say(tIn(voiceLang(), 'set.voiceSample'), 'test', ['Rue de la Gare', 'Avenue de la République']);
}
