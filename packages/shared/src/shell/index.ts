/** Pure shell logic: hidden developer unlock, map sync chip state, tips. */

export const DEV_UNLOCK_TAPS = 7;
/** Taps further apart than this restart the count. */
export const DEV_TAP_GAP_MS = 2_000;

export interface TapState {
  count: number;
  last: number;
}

/** Register one tap on the version label; `unlocked` becomes true on the 7th tap in a row. */
export function registerUnlockTap(s: TapState, now: number): { state: TapState; unlocked: boolean } {
  const count = s.last > 0 && now - s.last <= DEV_TAP_GAP_MS ? s.count + 1 : 1;
  if (count >= DEV_UNLOCK_TAPS) return { state: { count: 0, last: 0 }, unlocked: true };
  return { state: { count, last: now }, unlocked: false };
}

/** Developer tools are reachable in dev builds, or in release builds once the hidden unlock was done. */
export function developerVisible(isDev: boolean, unlocked: boolean): boolean {
  return isDev || unlocked;
}

export type SyncState = { kind: 'offline' } | { kind: 'reconnecting' } | { kind: 'queued'; n: number } | null;

export interface Connectivity {
  /** Device has a network (store flag from the tracking loop). */
  online: boolean;
  /** At least one crew router is running. */
  started: boolean;
  /** Relay sockets: connected / known (0 known = no socket opened yet). */
  relaysUp: number;
  relaysTotal: number;
  /** Messages sent but not acknowledged yet (router retry queue). */
  queued: number;
}

/** What the map chip shows; null when everything is fine (the chip stays hidden). */
export function syncState(c: Connectivity): SyncState {
  if (!c.online) return { kind: 'offline' };
  if (!c.started) return null;
  if (c.relaysTotal > 0 && c.relaysUp === 0) return { kind: 'reconnecting' };
  if (c.queued > 0) return { kind: 'queued', n: c.queued };
  return null;
}


/** Tips live on the Tips screen (Settings). Short illustrated cards; never shown on the main screens. */
export const TIPS = [
  { id: 'crew', icon: 'family' },
  { id: 'sharing', icon: 'shield' },
  { id: 'drive', icon: 'car' },
  { id: 'quips', icon: 'heart' },
  { id: 'hazards', icon: 'warning' },
  { id: 'nav', icon: 'route' },
  { id: 'battery', icon: 'bolt' },
] as const;
export type TipId = (typeof TIPS)[number]['id'];

/** Secondary screens that may show a one-time tip banner, and the tip each one shows. */
export const FIRST_TIME_PROMPTS = {
  'drive-along': 'drive',
  quips: 'quips',
} as const satisfies Record<string, TipId>;
export type PromptScreen = keyof typeof FIRST_TIME_PROMPTS;

/** Main screens: never show tip or helper prose. */
export const MAIN_SCREENS = ['home', 'driving-hud', 'nav-banners', 'friend-carousel', 'crew-deck'] as const;

/** Show the first-time banner for `screen` only if it is allowed there, not seen yet, and the user is not driving/navigating. */
export function tipForScreen(screen: string, seen: readonly string[], busy: boolean): TipId | null {
  if (busy || !Object.prototype.hasOwnProperty.call(FIRST_TIME_PROMPTS, screen)) return null;
  const id = FIRST_TIME_PROMPTS[screen as PromptScreen];
  return seen.includes(id) ? null : id;
}

/** Add `id` to the seen list (idempotent). */
export function markTipSeen(seen: readonly string[], id: TipId): string[] {
  return seen.includes(id) ? [...seen] : [...seen, id];
}
