import { AppState, type AppStateStatus } from 'react-native';
import { platform, type NavOverlaySnapshot } from '@crewmap/platform';
import { tripScore } from '@crewmap/shared/driving';
import { haversineM } from '@crewmap/shared/geo';
import { t } from '@crewmap/shared/i18n';
import { useApp, type AppState as Store } from './store';

/** Floating overlay over Waze / Google Maps: shown after a handoff once CrewMap is backgrounded. */
export const OVERLAY = {
  /** Snapshot push rate cap. */
  minIntervalMs: 1000,
  /** Auto-hide after this long even if the trip never ends. */
  maxDurationMs: 3 * 3600_000,
} as const;

let launchedAt: number | null = null;
let visible = false;
let lastPush = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let tripM = 0;
let lastFix: { lat: number; lng: number } | null = null;
let started = false;
let extNav: NavOverlaySnapshot['nav'];
const handoffListeners = new Set<() => void>();

/** Whether the floating overlay is on screen (it lists friends' drive times). */
export function overlayShowing(): boolean {
  return visible;
}

/** Waze / Google Maps status read from their notification (core/externalStatus); undefined clears it. */
export function setOverlayNav(nav: NavOverlaySnapshot['nav']): void {
  extNav = nav;
  schedule();
}

/** Runs `cb` on every handoff to Waze / Google Maps. */
export function onExternalNavLaunched(cb: () => void): () => void {
  handoffListeners.add(cb);
  return () => handoffListeners.delete(cb);
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function snapshot(s: Store): NavOverlaySnapshot {
  const friends = Object.values(s.friends)
    .filter((f) => !f.paused && f.presence)
    .map((f) => ({ name: f.profile.name, color: f.profile.car.color, etaMin: f.etaS == null ? null : Math.max(0, Math.round(f.etaS / 60)) }))
    .sort((a, b) => (a.etaMin ?? Infinity) - (b.etaMin ?? Infinity));
  const e = s.emotes[s.emotes.length - 1];
  const from = e ? (s.friends[e.from]?.profile.name ?? '') : '';
  return {
    friends,
    ...(e ? { lastEmote: { from, label: e.msg.preset === 'custom' ? (e.msg.label ?? t('emote.custom')) : t(`emote.${e.msg.preset}`) } } : {}),
    speedKmh: Math.max(0, Math.round((s.fix?.speed ?? 0) * 3.6)),
    score: s.driving ? tripScore(s.liveEvents, tripM, false) : null,
    me: { initials: initials(s.me?.name ?? ''), color: s.me?.car.color ?? '#4F5BFF' },
    ...(extNav ? { nav: extNav } : {}),
  };
}

function push(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  if (!visible) return;
  lastPush = Date.now();
  platform.navOverlay.update(snapshot(useApp.getState()));
}

function schedule(): void {
  if (!visible || pending) return;
  const wait = Math.max(0, lastPush + OVERLAY.minIntervalMs - Date.now());
  pending = setTimeout(push, wait);
}

function hide(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  if (visible) platform.navOverlay.hide();
  visible = false;
}

function end(): void {
  launchedAt = null;
  hide();
}

function onAppState(st: AppStateStatus): void {
  if (st === 'active') return hide();
  if (st !== 'background' || launchedAt === null) return;
  if (Date.now() - launchedAt > OVERLAY.maxDurationMs) return end();
  if (!platform.navOverlay.canDraw()) return;
  visible = platform.navOverlay.show();
  push();
}

/** Called right after handing navigation to Waze / Google Maps. */
export function markExternalNavLaunched(): void {
  launchedAt = Date.now();
  startOverlay();
  for (const cb of handoffListeners) cb();
  // The handoff usually backgrounds us before launch() resolves, so the 'background' event has already fired.
  const now = AppState.currentState;
  if (now === 'background' || now === 'inactive') onAppState(now);
}

/** Wires the overlay to the store and app lifecycle. Idempotent. */
function startOverlay(): void {
  if (started || platform.os !== 'android') return;
  started = true;
  AppState.addEventListener('change', onAppState);
  useApp.subscribe((s, prev) => {
    if (s.fix && s.fix !== prev.fix && s.driving) {
      const p = { lat: s.fix.lat, lng: s.fix.lng };
      if (lastFix) tripM += haversineM(lastFix, p);
      lastFix = p;
    }
    if (s.driving && !prev.driving) {
      tripM = 0;
      lastFix = null;
    }
    if (!s.driving && prev.driving) return end();
    if (launchedAt !== null && Date.now() - launchedAt > OVERLAY.maxDurationMs) return end();
    schedule();
  });
}
