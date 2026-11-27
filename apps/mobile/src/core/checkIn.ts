import * as Notifications from 'expo-notifications';
import { create } from 'zustand';
import type { Fix } from '@crewmap/platform';
import { OSM_HEADERS, OSM_OVERPASS_ENDPOINTS, overpassUrl } from '@crewmap/hazards';
import { openJson, type DeviceIdentity, type Incoming } from '@crewmap/p2p';
import type { Activity } from '@crewmap/shared/driving';
import { haversineM } from '@crewmap/shared/geo';
import { t } from '@crewmap/shared/i18n';
import { detectStops, expectedStopS, learnStopDelays, type StopDelayModel } from '@crewmap/shared/insight';
import type { Place } from '@crewmap/shared/places';
import {
  assessStop,
  CHECK_IN,
  CheckInMonitor,
  okCellKey,
  parseSurroundings,
  surroundingsQuery,
  type CheckInAction,
  type Stop,
  type StopContext,
  type Surroundings,
} from '@crewmap/shared/safety';
import { formatClock } from '@crewmap/shared/units';
import { countRequest } from './apiBudget';
import type { Crews } from './crews';
import * as db from './db';
import { recordError } from './errorLog';
import { notify } from './notify';
import { useApp } from './store';

/**
 * Safety check-in on the phone (D66): feeds the pure CheckInMonitor from Tracking, looks up the surroundings of a
 * candidate stop (one tiny Overpass count query, cached per 250 m cell), asks the driver once and, unanswered,
 * tells the opted-in crewmates (sealed per recipient). Receives crewmates' alerts. Never calls anyone.
 */

export interface CheckInAlert {
  lat: number;
  lng: number;
  acc: number;
  since: number;
  crash: boolean;
  t: number;
}

interface CheckInView {
  /** My own pending "are you OK?" (in-app card). */
  ask: { since: number; crash: boolean } | null;
  /** Crewmates whose check-in went unanswered, by deviceId. */
  alerts: Record<string, CheckInAlert>;
}

export const useCheckIn = create<CheckInView>(() => ({ ask: null, alerts: {} }));

const NOTIF_ID = 'checkin';
const SURR_KEY = 'checkInSurroundings.v1';
const OK_KEY = 'checkInOkCells.v1';
const SURR_MAX_AGE_MS = 90 * 86_400_000;
const MODEL_MAX_AGE_MS = 6 * 3600_000;
const MODEL_TRIPS = 20;
const FETCH_TIMEOUT_MS = 20_000;
const HAZARD_JAM = new Set(['jam', 'closure', 'accident']);

const monitor = new CheckInMonitor(CHECK_IN.defaultWaitMin);
let crews: Crews | null = null;
let places: () => Place[] = () => [];
let beforeSend: () => Promise<void> = async () => undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Fix time minus wall time at the last fix: replayed drives run ahead of the wall clock. */
let clockOffset = 0;
let surr: Record<string, { at: number; s: Surroundings }> = {};
let okCells = new Set<string>();
let model: { at: number; m: StopDelayModel } | null = null;
let looking: string | null = null;
const tried = new Map<string, number>();
const RETRY_MS = 30 * 60_000;
let alertedTo: string[] = [];
let started = false;
let receiving = false;

const now = () => Date.now() + clockOffset;

/** Tracking calls this once it starts. */
export async function startCheckIn(c: Crews, myPlaces: () => Place[], radio: () => Promise<void>): Promise<void> {
  crews = c;
  places = myPlaces;
  beforeSend = radio;
  if (started) return;
  started = true;
  surr = await db.kvGet<typeof surr>(SURR_KEY, {}).catch(() => ({}));
  okCells = new Set(await db.kvGet<string[]>(OK_KEY, []).catch(() => []));
}

/** Somebody to tell? Without an opted-in crewmate the phone never asks. */
const active = () => !!crews && crews.checkInConfigured();

export function checkInFix(f: Fix): void {
  if (!started) return;
  clockOffset = f.t - Date.now();
  if (!active()) {
    if (monitor.snapshot().phase !== 'none') apply(monitor.walking(f.t));
    return;
  }
  monitor.setWait(useApp.getState().settings.checkInWaitMin);
  apply(monitor.fix({ t: f.t, lat: f.lat, lng: f.lng, speed: f.speed, heading: f.heading, accuracy: f.accuracy }));
  pump();
}

export function checkInCrash(t: number): void {
  if (!started || !active()) return;
  monitor.crash(t);
  pump();
}

export function checkInActivity(a: { t: number; activity: Activity }): void {
  if (!started) return;
  if (a.activity === 'walking' || a.activity === 'running') apply(monitor.walking(a.t));
  pump();
}

/** "I'm OK" from the card or the notification button. */
export function answerCheckIn(): void {
  apply(monitor.answer(now()));
  pump();
}

function pump(): void {
  const n = now();
  apply(monitor.tick(n, (s) => assessStop(s, contextFor(s))));
  const cand = monitor.candidate(n);
  if (cand) void lookUp(cand);
  schedule(n);
}

function schedule(n: number): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const snap = monitor.snapshot();
  const due = monitor.dueAt();
  const ctxAt = snap.phase === 'stopped' && snap.stop ? snap.stop.since + CHECK_IN.contextAtS * 1000 : null;
  const next = [due, ctxAt !== null && ctxAt > n ? ctxAt : null].filter((x): x is number => x !== null);
  if (!next.length) return;
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, Math.max(1000, Math.min(...next) - n));
}

function contextFor(s: Stop): StopContext {
  const st = useApp.getState();
  const byId = new Map<string, Place>();
  for (const p of places()) byId.set(p.id, p);
  const known = [...byId.values()].map((p) => ({ lat: p.lat, lng: p.lng, radiusM: p.radiusM, home: p.type === 'home' }));
  const nav = st.nav?.active ? st.nav.destination : null;
  const cell = surr[okCellKey(s)];
  return {
    places: known,
    navDest: nav ? { lat: nav.lat, lng: nav.lng } : null,
    knownStopS: model ? expectedStopS(model.m, s, s.since) : null,
    okBefore: okCells.has(okCellKey(s)),
    trafficNearby: st.hazards.some((h) => HAZARD_JAM.has(h.type) && haversineM(h, s) <= CHECK_IN.jam.hazardM),
    poisNearby: st.pois.filter((p) => (p.kind === 'fuel' || p.kind === 'charging') && haversineM(p, s) <= CHECK_IN.surroundingsM).length,
    surroundings: cell && now() - cell.at <= SURR_MAX_AGE_MS ? cell.s : null,
  };
}

/** Learned stop delays (D63) from my recent drives: lights, junctions and queues I wait at anyway. */
async function refreshModel(): Promise<void> {
  if (model && now() - model.at < MODEL_MAX_AGE_MS) return;
  const recent = (await db.tripSummaries(now() - 60 * 86_400_000)).slice(-MODEL_TRIPS);
  const stops = [];
  for (const s of recent) {
    const trip = await db.loadTrip(s.id);
    if (trip) stops.push(...detectStops(trip.points.map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, speed: p.speed, heading: p.heading, accuracy: 10 }))));
  }
  model = { at: now(), m: learnStopDelays(stops) };
}

async function lookUp(s: Stop): Promise<void> {
  const key = okCellKey(s);
  if (looking === key) return;
  const cell = surr[key];
  if (cell && now() - cell.at <= SURR_MAX_AGE_MS) return;
  // One network attempt per cell per half hour: a refused or flaky Overpass is not hammered on every fix (D61 back-off).
  if (now() - (tried.get(key) ?? -Infinity) < RETRY_MS) return;
  tried.set(key, now());
  looking = key;
  try {
    await refreshModel().catch((e: unknown) => recordError('js', e));
    const q = surroundingsQuery(s);
    for (const ep of OSM_OVERPASS_ENDPOINTS) {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      try {
        countRequest('overpass');
        const res = await fetch(overpassUrl(ep, q), { headers: OSM_HEADERS, signal: ctl.signal });
        if (res.status !== 200) continue;
        const parsed = parseSurroundings(await res.json());
        if (!parsed) continue;
        surr = { ...surr, [key]: { at: now(), s: parsed } };
        await db.kvSet(SURR_KEY, surr);
        return;
      } catch {
        // offline at a remote spot is normal: the driver is asked anyway
      } finally {
        clearTimeout(to);
      }
    }
  } finally {
    looking = null;
  }
}

function rememberOk(s: Stop | null): void {
  if (!s) return;
  okCells.add(okCellKey(s));
  void db.kvSet(OK_KEY, [...okCells].slice(-200)).catch(() => undefined);
}

function apply(actions: CheckInAction[]): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'ask':
        useCheckIn.setState({ ask: { since: a.stop.since, crash: a.stop.crash } });
        void notify(t('checkIn.ask'), t('checkIn.stoppedAt', { time: formatClock(a.stop.since) }), { channel: 'alerts', data: { type: 'checkIn' }, identifier: NOTIF_ID });
        break;
      case 'alert':
        void sendAlert(a.stop);
        break;
      case 'dismiss':
        if (a.how === 'ok') rememberOk(monitor.snapshot().stop);
        clearAsk();
        break;
      case 'resolve':
        if (a.how === 'ok') rememberOk(a.stop);
        clearAsk();
        void sendResolve();
        break;
    }
  }
}

function clearAsk(): void {
  useCheckIn.setState({ ask: null });
  void Notifications.dismissNotificationAsync(NOTIF_ID).catch(() => undefined);
}

async function sendAlert(s: Stop): Promise<void> {
  if (!crews) return;
  await beforeSend().catch(() => undefined);
  const value = { v: 1, s: 'alert', lat: s.lat, lng: s.lng, acc: Math.round(s.acc), since: s.since, crash: s.crash, t: now() };
  const sent: string[] = [];
  for (const to of crews.checkInRecipients()) {
    if (await crews.companionSend(to, 'check-in', () => value).catch(() => false)) sent.push(to);
  }
  alertedTo = sent;
}

async function sendResolve(): Promise<void> {
  if (!crews || !alertedTo.length) return;
  await beforeSend().catch(() => undefined);
  const value = { v: 1, s: 'ok', t: now() };
  for (const to of alertedTo) await crews.companionSend(to, 'check-in', () => value).catch(() => false);
  alertedTo = [];
}

// --- receiving ------------------------------------------------------------------------------------------------------

function readAlert(v: unknown): ({ s: 'alert' } & CheckInAlert) | { s: 'ok'; t: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null);
  if (o.s === 'ok' && num('t') !== null) return { s: 'ok', t: num('t')! };
  const lat = num('lat');
  const lng = num('lng');
  const since = num('since');
  if (o.s !== 'alert' || lat === null || lng === null || since === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { s: 'alert', lat, lng, acc: num('acc') ?? 50, since, crash: o.crash === true, t: num('t') ?? since };
}

function onIncoming(me: DeviceIdentity, m: Incoming): void {
  const a = readAlert(openJson(me, m.payload));
  if (!a) return;
  const name = useApp.getState().allFriends[m.sender]?.profile.name ?? '';
  const id = `${NOTIF_ID}-${m.sender}`;
  const cur = useCheckIn.getState().alerts;
  if (a.s === 'alert') {
    const { s: _s, ...alert } = a;
    useCheckIn.setState({ alerts: { ...cur, [m.sender]: alert } });
    void notify(t(a.crash ? 'checkIn.alertCrash' : 'checkIn.alert', { name }), t('checkIn.stoppedAt', { time: formatClock(a.since) }), {
      channel: 'alerts',
      data: { type: 'checkInAlert', friendId: m.sender },
      identifier: id,
    });
    return;
  }
  const had = cur[m.sender];
  if (!had || had.t > a.t) return;
  const { [m.sender]: _gone, ...rest } = cur;
  useCheckIn.setState({ alerts: rest });
  void notify(t('checkIn.resolved', { name }), '', { channel: 'circle', data: { type: 'checkInAlert', friendId: m.sender }, identifier: id });
}

/** Engine calls this once the crews are online (also on headless wake-ups); handlers survive crew restarts. */
export function startCheckInReceiver(c: Crews, me: DeviceIdentity): void {
  const r = c.router;
  if (receiving || !r) return;
  receiving = true;
  r.on('check-in', (m) => onIncoming(me, m));
}
