/**
 * Friend drive-time (Mapbox Matrix) refresh policy, D45. Pure: the app feeds positions + visibility, this decides
 * which friends need a routed query now and what number to show in between (dead-reckoned).
 */
import { haversineM, type LatLng } from './geo';

export const ETA_REFRESH = {
  /** Below this speed (m/s) a party counts as still. */
  stillMps: 1.5,
  /** Staleness while someone moves: `perKmMs` per straight-line km, clamped. Near friends refresh more often. */
  perKmMs: 30_000,
  minStaleMs: 60_000,
  maxStaleMs: 15 * 60_000,
  /** Overlay over Waze / Maps: half the rate, never under this. */
  overlayFactor: 2,
  overlayMinStaleMs: 2 * 60_000,
  /** Re-query on movement beyond max(moveM, moveFrac × distance), even if not stale. */
  moveM: 300,
  moveFrac: 0.1,
  /** An opened friend card refreshes that friend if older than this. */
  focusStaleMs: 20_000,
  /** At most one batched call per this gap (focus excepted). */
  minGapMs: 30_000,
  /** A friend's shared nav destination within this of me counts as "heading to me". */
  headingToMeM: 300,
} as const;

/** Where friend drive times are visible right now. 'off' = backgrounded without overlay, or screen off. */
export type EtaView = 'map' | 'overlay' | 'off';

export interface EtaBase {
  /** Query time (ms), routed duration (s) and the straight-line distance (m) at query time. */
  at: number;
  etaS: number | null;
  straightM: number;
  me: LatLng;
  friend: LatLng;
}

export interface EtaFriendInput {
  id: string;
  pos: LatLng;
  spd: number | null;
  /** Friend's own navigation ETA (epoch ms) when their destination is me (see `headingToMe`). */
  navEtaToMe?: number;
  /** Shown on the current surface (overlay lists only these). */
  shown: boolean;
}

export interface EtaPlanInput {
  now: number;
  view: EtaView;
  me: LatLng;
  mySpd: number | null;
  friends: EtaFriendInput[];
  base: ReadonlyMap<string, EtaBase>;
  lastCallAt: number;
  /** Friend card open. */
  focusId?: string | null;
}

const moving = (spd: number | null) => (spd ?? 0) >= ETA_REFRESH.stillMps;

/** Staleness for one friend; Infinity when both are still (keep the last answer). */
export function etaStaleMs(straightM: number, meMoving: boolean, friendMoving: boolean, view: EtaView): number {
  if (!meMoving && !friendMoving) return Infinity;
  const c = ETA_REFRESH;
  let ms = Math.min(c.maxStaleMs, Math.max(c.minStaleMs, (straightM / 1000) * c.perKmMs));
  if (view === 'overlay') ms = Math.max(c.overlayMinStaleMs, ms * c.overlayFactor);
  return ms;
}

/** Friend ids that need a Matrix query now (one batched call). */
export function planEtaRefresh(i: EtaPlanInput): string[] {
  if (i.view === 'off') return [];
  const c = ETA_REFRESH;
  const due: string[] = [];
  let focusDue = false;
  for (const f of i.friends) {
    if (f.navEtaToMe !== undefined) continue;
    if (i.view === 'overlay' && !f.shown) continue;
    const b = i.base.get(f.id);
    if (!b) {
      due.push(f.id);
      continue;
    }
    const anyMoving = moving(i.mySpd) || moving(f.spd);
    if (f.id === i.focusId && anyMoving && i.now - b.at > c.focusStaleMs) {
      due.push(f.id);
      focusDue = true;
      continue;
    }
    const straight = haversineM(i.me, f.pos);
    const moveLimit = Math.max(c.moveM, c.moveFrac * straight);
    const moved = haversineM(b.me, i.me) > moveLimit || haversineM(b.friend, f.pos) > moveLimit;
    if (moved || i.now - b.at > etaStaleMs(straight, moving(i.mySpd), moving(f.spd), i.view)) due.push(f.id);
  }
  if (due.length && !focusDue && i.now - i.lastCallAt < c.minGapMs) return [];
  return due;
}

/**
 * Number to show between queries: the friend's own nav ETA when heading to me, else the routed value corrected by
 * straight-line change × the last routed s/m factor (both ends' P2P positions).
 */
export function displayEtaS(b: EtaBase | undefined, me: LatLng, friend: LatLng, now: number, navEtaToMe?: number): number | null {
  if (navEtaToMe !== undefined) return Math.max(0, Math.round((navEtaToMe - now) / 1000));
  if (!b || b.etaS == null) return null;
  if (b.straightM < 1) return b.etaS;
  const factor = b.etaS / b.straightM;
  return Math.max(0, Math.round(b.etaS + (haversineM(me, friend) - b.straightM) * factor));
}

/** Whether a friend's shared navigation destination is me. */
export function headingToMe(dest: LatLng | null | undefined, me: LatLng): boolean {
  return !!dest && haversineM(dest, me) <= ETA_REFRESH.headingToMeM;
}
