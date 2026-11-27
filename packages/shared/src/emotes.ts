/** F3 emotes: presets, rate limiting, and driver-safe overlay placement. */

export const EMOTE_PRESETS = [
  'getMeFood',
  'areWeThereYet',
  'whereAreYou',
  'hurryUp',
  'callMe',
  'honkHonk',
  'onMyWay',
  'missYou',
  // Friendly pings (D58). On the wire they travel as their legacy fallback + `p2`, so older builds still show something.
  'thinkingOfYou',
  'imHere',
  'needRide',
  'welcomeHome',
  'chargeUp',
  'driveSafe',
  'thanks',
] as const;
export type EmotePreset = (typeof EMOTE_PRESETS)[number];

/** The presets every build since F3 understands. */
export const LEGACY_PRESETS = ['getMeFood', 'areWeThereYet', 'whereAreYou', 'hurryUp', 'callMe', 'honkHonk', 'onMyWay', 'missYou'] as const;
export type LegacyPreset = (typeof LEGACY_PRESETS)[number];
export const PING_PRESETS: readonly EmotePreset[] = EMOTE_PRESETS.filter((p) => !(LEGACY_PRESETS as readonly string[]).includes(p));

/** What an older build shows for a newer preset (it drops unknown presets). */
export const PRESET_FALLBACK: Record<EmotePreset, LegacyPreset> = {
  getMeFood: 'getMeFood',
  areWeThereYet: 'areWeThereYet',
  whereAreYou: 'whereAreYou',
  hurryUp: 'hurryUp',
  callMe: 'callMe',
  honkHonk: 'honkHonk',
  onMyWay: 'onMyWay',
  missYou: 'missYou',
  thinkingOfYou: 'missYou',
  imHere: 'onMyWay',
  needRide: 'callMe',
  welcomeHome: 'missYou',
  chargeUp: 'callMe',
  driveSafe: 'missYou',
  thanks: 'missYou',
};

/** Calm presets that ask nothing of a driver: the only quick set offered while the friend drives. */
export const DRIVING_SAFE: readonly EmotePreset[] = ['driveSafe', 'thinkingOfYou', 'missYou', 'onMyWay', 'thanks'];

export type WireEmote = EmoteMessage & { p2?: string };

/** Wire form: newer presets go out as their legacy fallback with the real one in `p2` (older readers ignore it). */
export function toWire(m: EmoteMessage): WireEmote {
  if (m.preset === 'custom' || PRESET_FALLBACK[m.preset] === m.preset) return m;
  return { ...m, preset: PRESET_FALLBACK[m.preset], p2: m.preset };
}

/** Reads a wire emote: a known `p2` wins; an unknown one (a newer build's preset) degrades to the fallback. */
export function fromWire(raw: unknown): EmoteMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { p2, ...rest } = raw as Record<string, unknown>;
  if (typeof rest.preset !== 'string') return null;
  const msg = rest as unknown as EmoteMessage;
  if (typeof p2 === 'string' && (EMOTE_PRESETS as readonly string[]).includes(p2)) msg.preset = p2 as EmotePreset;
  return msg;
}

export const EMOTE_LIMITS = {
  /** Custom clips: ≤ 5 s and ≤ 60 KB (AAC mono ~64 kbps ≈ 40 KB for 5 s). */
  maxClipMs: 5000,
  maxClipBytes: 60_000,
  /** While the recipient drives: 1 emote per sender per recipient per 2 min. */
  drivingIntervalMs: 2 * 60_000,
  /** Driving popup auto-dismiss (≤ 3 s, no tap). */
  drivingDismissMs: 2800,
  idleDismissMs: 6000,
} as const;

export interface EmoteMessage {
  preset: EmotePreset | 'custom';
  /** Custom audio clip, base64 AAC, when preset === 'custom'. */
  clip?: string;
  clipMs?: number;
  /** Sender's label for custom clips. */
  label?: string;
  /** Sender's client key: stable across re-sends so the recipient counts each emote once. */
  k?: string;
}

export function validateEmote(m: EmoteMessage): string | null {
  if (m.preset !== 'custom' && !EMOTE_PRESETS.includes(m.preset)) return 'unknown preset';
  if (m.preset === 'custom') {
    if (!m.clip) return 'missing clip';
    if ((m.clipMs ?? 0) > EMOTE_LIMITS.maxClipMs + 250) return 'clip too long';
    // base64 → bytes
    if (Math.floor((m.clip.length * 3) / 4) > EMOTE_LIMITS.maxClipBytes) return 'clip too large';
    if (m.label && m.label.length > 24) return 'label too long';
  }
  return null;
}

/**
 * Receiver-side rate limit while driving (the sender also enforces it from the recipient's presence, but the
 * recipient is the authority): drop extra emotes from the same sender within the interval.
 */
export class DrivingEmoteLimiter {
  private readonly last = new Map<string, number>();

  allow(sender: string, t: number, recipientDriving: boolean): boolean {
    if (!recipientDriving) return true;
    const prev = this.last.get(sender);
    if (prev !== undefined && t - prev < EMOTE_LIMITS.drivingIntervalMs) return false;
    this.last.set(sender, t);
    return true;
  }
}

// --- Driver-safe overlay placement ---------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Pick a spot for the emote popup that overlaps none of the occupied regions (turn banners, speed/limit, route
 * line, alerts…), preferring areas far from the route line's screen projection. Returns null if nothing fits: the
 * emote then shows as a small chip in the reserved emote slot instead.
 */
export function placeOverlay(
  screen: { w: number; h: number },
  size: { w: number; h: number },
  occupied: Rect[],
  routePoints: { x: number; y: number }[] = [],
  margin = 12,
): Rect | null {
  const step = 16;
  let best: { r: Rect; score: number } | null = null;
  for (let y = margin; y + size.h <= screen.h - margin; y += step) {
    for (let x = margin; x + size.w <= screen.w - margin; x += step) {
      const r = { x, y, w: size.w, h: size.h };
      const padded = { x: x - margin, y: y - margin, w: size.w + 2 * margin, h: size.h + 2 * margin };
      if (occupied.some((o) => intersects(padded, o))) continue;
      // Distance from the route line (larger is better); slight bias to the upper-middle band (glanceable).
      let minRoute = Infinity;
      const cx = x + size.w / 2;
      const cy = y + size.h / 2;
      for (const p of routePoints) minRoute = Math.min(minRoute, Math.hypot(p.x - cx, p.y - cy));
      if (routePoints.some((p) => p.x >= x - margin && p.x <= x + size.w + margin && p.y >= y - margin && p.y <= y + size.h + margin)) continue;
      const routeScore = routePoints.length ? Math.min(minRoute, 400) : 200;
      const bandScore = -Math.abs(cy - screen.h * 0.4) * 0.3;
      const score = routeScore + bandScore;
      if (!best || score > best.score) best = { r, score };
    }
  }
  return best?.r ?? null;
}

/** One emoji per emote, used for the edge pop-ins (custom voice clips use the microphone). */
export const EMOTE_EMOJI: Record<EmotePreset | 'custom', string> = {
  getMeFood: '🍔',
  areWeThereYet: '⏳',
  whereAreYou: '📍',
  hurryUp: '⏩',
  callMe: '📞',
  honkHonk: '📯',
  onMyWay: '🚗',
  missYou: '💜',
  thinkingOfYou: '💭',
  imHere: '🏁',
  needRide: '🚕',
  welcomeHome: '🏠',
  chargeUp: '🔋',
  driveSafe: '🛡️',
  thanks: '🙏',
  custom: '🎙️',
};

