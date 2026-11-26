/**
 * Pure driving-UX decisions (docs/DRIVING.md "Driver interaction"): what the HUD shows at which speed, and which
 * interruptions may appear while moving. Tunables live here, with tests in driveUx.test.ts.
 */

export const DRIVE_UX = {
  /** Above this the car counts as moving (secondary controls hide). */
  movingKph: 10,
  /** Below this for `stopHoldMs` the car counts as stopped (more controls appear). */
  stoppedKph: 3,
  stopHoldMs: 4000,
  /** Open report grid closes itself after this long without a choice. */
  reportAutoCloseMs: 6000,
  /** Trip-details panel (swipe-up on the ETA pill) closes itself after this long. */
  detailsAutoCloseMs: 10000,
  /** Big-target sizes while driving (≥ 64 dp, NHTSA / Android Auto guidance). */
  targetDp: 64,
  primaryMovingDp: 76,
  /** No popups when the next manoeuvre is closer than this. */
  maneuverQuietM: 250,
  /** Queued items older than this are dropped instead of shown at the next stop. */
  queueMaxAgeMs: 30 * 60_000,
  /** Faster-route offer closes itself after this long. */
  fasterAutoCloseMs: 20_000,
  /** Trip-end card: shown for this long, only for driver trips this long with no harsh event. */
  celebrateMs: 6000,
  celebrateMinS: 5 * 60,
} as const;

export type Motion = 'moving' | 'stopped';

/** Hysteresis: moving at ≥ movingKph; stopped only after < stoppedKph for stopHoldMs. `belowSince` = when speed first fell below. */
export function nextMotion(prev: Motion, kph: number | null, belowSince: number | null, now: number): Motion {
  const v = kph ?? 0;
  if (v >= DRIVE_UX.movingKph) return 'moving';
  if (
    prev === 'moving' &&
    v < DRIVE_UX.stoppedKph &&
    belowSince !== null &&
    now - belowSince >= DRIVE_UX.stopHoldMs
  )
    return 'stopped';
  return prev;
}

export interface HudPlan {
  /** Search, recenter, drive-along picker: only when stopped. */
  secondary: boolean;
  /** Size of the report button and the end-navigation button. */
  primaryDp: number;
  /** Popups (emotes, moment toasts, chat) may show. */
  popups: boolean;
}

export function hudPlan(motion: Motion): HudPlan {
  const moving = motion === 'moving';
  return {
    secondary: !moving,
    primaryDp: moving ? DRIVE_UX.primaryMovingDp : DRIVE_UX.targetDp,
    popups: !moving,
  };
}

export type InterruptKind = 'chat' | 'emote' | 'friend' | 'hazardConfirm' | 'faster' | 'safety';

export interface Interrupt {
  id: string;
  kind: InterruptKind;
  at: number;
}

/** Safety items and the one-tap "still there?" pass (the navigator already keeps it away from manoeuvres); the rest wait. */
export function routeInterrupt(
  kind: InterruptKind,
  motion: Motion,
  nextManeuverM: number | null,
): 'show' | 'queue' {
  if (kind === 'safety') return 'show';
  const nearTurn = nextManeuverM !== null && nextManeuverM < DRIVE_UX.maneuverQuietM;
  if (kind === 'hazardConfirm' || kind === 'faster') return nearTurn ? 'queue' : 'show';
  return motion === 'stopped' && !nearTurn ? 'show' : 'queue';
}

/** Adds to the queue, one entry per id (latest wins), oldest first. */
export function enqueue(q: readonly Interrupt[], item: Interrupt): Interrupt[] {
  return [...q.filter((x) => x.id !== item.id), item].sort((a, b) => a.at - b.at);
}

/** At a stop the queue is released (stale entries dropped); while moving it is kept. */
export function release(
  q: readonly Interrupt[],
  motion: Motion,
  now: number,
): { show: Interrupt[]; keep: Interrupt[] } {
  if (motion === 'moving') return { show: [], keep: [...q] };
  return { show: q.filter((x) => now - x.at <= DRIVE_UX.queueMaxAgeMs), keep: [] };
}

/** The single small chip shown while moving: total count and the kind of the newest item, or null when empty. */
export function queueChip(q: readonly Interrupt[]): { count: number; kind: InterruptKind } | null {
  const last = q[q.length - 1];
  return last ? { count: q.length, kind: last.kind } : null;
}

/** Calm trip-end celebration: a driver trip of some length with no risky event. Returns the smooth minutes, or null. */
export function smoothStreakMin(t: { durationS: number; events: number; passenger: boolean }): number | null {
  if (t.passenger || t.events > 0 || t.durationS < DRIVE_UX.celebrateMinS) return null;
  return Math.round(t.durationS / 60);
}

/** Context for friend-feature decisions: browsing the map, or driving / navigating (moving or briefly stopped). */
export type FriendContext = 'browse' | 'driveStopped' | 'driveMoving';

export function friendContext(driving: boolean, motion: Motion): FriendContext {
  if (!driving) return 'browse';
  return motion === 'moving' ? 'driveMoving' : 'driveStopped';
}

export const NOTICE_UX = {
  /** In-app notices always close themselves; never sticky. */
  browseMs: 6000,
  /** Brief non-blocking pill while driving. */
  pillMs: 3500,
  /** The same notice (e.g. the same pair of friends) is not shown again within this window. */
  repeatMs: 2 * 3600_000,
} as const;

/** friendsNearOthers = two other friends near each other; friendsNearMe = a friend near me. */
export type NoticeKind = 'friendsNearMe' | 'friendsNearOthers' | 'passPlace' | 'arrival' | 'chat' | 'emote' | 'groupDrive' | 'ask';

export type NoticeAction = 'toast' | 'pill' | 'defer' | 'drop';

/**
 * What an in-app friend notice does per context. Browsing: an auto-closing toast. Driving: things about me get a brief
 * pill (never near a turn); social chatter waits for a stop.
 */
export function noticePolicy(
  kind: NoticeKind,
  ctx: FriendContext,
  nextManeuverM: number | null = null,
): NoticeAction {
  // Two other friends near each other lives in their cards (sheet), never as a popup.
  if (kind === 'friendsNearOthers') return 'drop';
  if (ctx === 'browse') return 'toast';
  const nearTurn = nextManeuverM !== null && nextManeuverM < DRIVE_UX.maneuverQuietM;
  if (ctx === 'driveStopped') return nearTurn ? 'defer' : 'pill';
  switch (kind) {
    case 'friendsNearMe':
    case 'arrival':
    case 'emote':
    case 'groupDrive':
    case 'ask':
      return nearTurn ? 'defer' : 'pill';
    default:
      return 'defer';
  }
}

export function noticeMs(action: NoticeAction): number {
  return action === 'pill' ? NOTICE_UX.pillMs : NOTICE_UX.browseMs;
}

/** Stable key for a proximity moment (order-independent), for rate limiting. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Rate limit: true when `key` was not shown within `repeatMs`. Mutates `seen` with the new time when allowed. */
export function allowRepeat(
  seen: Map<string, number>,
  key: string,
  now: number,
  repeatMs: number = NOTICE_UX.repeatMs,
): boolean {
  const last = seen.get(key);
  if (last !== undefined && now - last < repeatMs) return false;
  seen.set(key, now);
  return true;
}

/** Classifies a proximity moment for `noticePolicy`, with its rate-limit key. */
export function momentNotice(
  m: { kind: 'passPlace'; placeId: string; owner: string } | { kind: 'friendsNear'; a: string; b: string },
  meId: string | null,
): { kind: NoticeKind; key: string } {
  if (m.kind === 'passPlace') return { kind: 'passPlace', key: `place:${m.owner}:${m.placeId}` };
  const mine = meId !== null && (m.a === meId || m.b === meId);
  return { kind: mine ? 'friendsNearMe' : 'friendsNearOthers', key: `near:${pairKey(m.a, m.b)}` };
}

/** System-notification variant of `noticePolicy`: browsing = normal; driving = silent (no sound), or skipped when dropped. */
export function notifyMode(
  kind: NoticeKind,
  ctx: FriendContext,
  nextManeuverM: number | null = null,
): 'normal' | 'silent' | 'skip' {
  const a = noticePolicy(kind, ctx, nextManeuverM);
  if (a === 'drop') return 'skip';
  return ctx === 'browse' ? 'normal' : 'silent';
}

/** In-app emote popup while driving: only when the policy shows it now (never deferred into a turn). */
export function emotePopup(
  ctx: FriendContext,
  nextManeuverM: number | null,
  drivingPopupsOn: boolean,
): boolean {
  if (ctx === 'browse') return true;
  return drivingPopupsOn && noticePolicy('emote', ctx, nextManeuverM) === 'pill';
}
