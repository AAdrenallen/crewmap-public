import { DRIVING_SAFE, EMOTE_PRESETS, type EmotePreset } from './emotes';
import type { ComboGroup } from './emoteCombo';

/** Context-aware quick picks, per-friend favourites and the catch-up fanfare queue (D58). */
export const EMOTE_SUGGEST = {
  /** A friend's arrival/departure counts as "just now" for this long. */
  momentMs: 20 * 60_000,
  /** Battery at or under this (and not charging) suggests "charge up". */
  lowBattery: 20,
  /** Quick row length. */
  quickMax: 6,
  /** Sent at least this often to a friend = an automatic favourite. */
  favMinSends: 2,
  /** Favourite ranking only looks at the last 30 days. */
  favWindowMs: 30 * 24 * 3_600_000,
  /** Combo burst sizes offered by the sender (1 = a single emote). */
  bursts: [1, 3, 5] as const,
} as const;

/** What we may know about a friend right now. Fields stripped by their sharing policy are simply absent. */
export interface FriendNow {
  driving?: boolean;
  /** Battery %, when shared. */
  battery?: number | null;
  charging?: boolean;
  /** Their latest shared place moment. */
  moment?: { kind: 'arrive' | 'leave' | 'drivingHome'; t: number; home?: boolean } | null;
  /** Kind of the last emote they sent me, and when. */
  lastReceived?: { preset: EmotePreset | 'custom'; t: number } | null;
}

/** Suggestions for this friend, most fitting first. While they drive: the driving-safe set only. */
export function suggestEmotes(f: FriendNow, now: number): EmotePreset[] {
  const out: EmotePreset[] = [];
  const add = (p: EmotePreset) => {
    if (!out.includes(p)) out.push(p);
  };
  const recent = (t: number) => now - t >= 0 && now - t <= EMOTE_SUGGEST.momentMs;
  if (f.lastReceived && f.lastReceived.preset !== 'custom' && recent(f.lastReceived.t)) add(REPLY_TO[f.lastReceived.preset]);
  if (f.moment && recent(f.moment.t)) {
    if (f.moment.kind === 'arrive') add(f.moment.home ? 'welcomeHome' : 'thanks');
    else if (f.moment.kind === 'drivingHome') add('driveSafe');
    else add('thinkingOfYou');
  }
  if (typeof f.battery === 'number' && f.battery <= EMOTE_SUGGEST.lowBattery && !f.charging) add('chargeUp');
  if (f.driving) {
    add('driveSafe');
    add('onMyWay');
  }
  for (const p of ['thinkingOfYou', 'onMyWay', 'imHere', 'needRide'] as const) add(p);
  const list = f.driving ? out.filter((p) => DRIVING_SAFE.includes(p)) : out;
  return list.slice(0, EMOTE_SUGGEST.quickMax);
}

/** The natural "send back" for each preset. */
export const REPLY_TO: Record<EmotePreset, EmotePreset> = {
  getMeFood: 'onMyWay',
  areWeThereYet: 'onMyWay',
  whereAreYou: 'imHere',
  hurryUp: 'onMyWay',
  callMe: 'thinkingOfYou',
  honkHonk: 'honkHonk',
  onMyWay: 'thanks',
  missYou: 'missYou',
  thinkingOfYou: 'missYou',
  imHere: 'thanks',
  needRide: 'onMyWay',
  welcomeHome: 'thanks',
  chargeUp: 'thanks',
  driveSafe: 'thanks',
  thanks: 'missYou',
};

export interface SentLog {
  preset: EmotePreset | 'custom';
  mine: boolean;
  t: number;
  ok?: boolean;
}

/**
 * Per-friend favourites: pinned first (in pin order), then the presets I send them most (recent sends break ties).
 * Unknown presets (an old log or a newer build) are skipped.
 */
export function rankFavourites(log: readonly SentLog[], pinned: readonly string[], now: number): EmotePreset[] {
  const known = (p: string): p is EmotePreset => (EMOTE_PRESETS as readonly string[]).includes(p);
  const out: EmotePreset[] = pinned.filter(known).filter((p, i, a) => a.indexOf(p) === i);
  const score = new Map<EmotePreset, { n: number; last: number }>();
  for (const e of log) {
    if (!e.mine || e.ok === false || e.preset === 'custom' || !known(e.preset) || now - e.t > EMOTE_SUGGEST.favWindowMs) continue;
    const s = score.get(e.preset) ?? { n: 0, last: 0 };
    s.n++;
    s.last = Math.max(s.last, e.t);
    score.set(e.preset, s);
  }
  const auto = [...score.entries()]
    .filter(([p, s]) => s.n >= EMOTE_SUGGEST.favMinSends && !out.includes(p))
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .map(([p]) => p);
  return [...out, ...auto];
}

/** Grid order: favourites first, then the rest in their usual order. */
export function orderGrid(favs: readonly EmotePreset[]): EmotePreset[] {
  return [...favs, ...EMOTE_PRESETS.filter((p) => !favs.includes(p))];
}

/** Recent row: newest first, consecutive repeats (same side, same preset) folded with a count. */
export interface RecentChip {
  key: string;
  preset: EmotePreset | 'custom';
  mine: boolean;
  t: number;
  ok: boolean;
  count: number;
}

export function recentChips(log: readonly SentLog[], max = 12): RecentChip[] {
  const out: RecentChip[] = [];
  const sorted = [...log].sort((a, b) => b.t - a.t);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const prev = out[out.length - 1];
    if (prev && prev.preset === e.preset && prev.mine === e.mine && prev.ok === (e.ok !== false)) {
      prev.count++;
      continue;
    }
    if (out.length >= max) break;
    out.push({ key: `${e.t}-${e.mine ? 'm' : 'f'}-${i}`, preset: e.preset, mine: e.mine, t: e.t, ok: e.ok !== false, count: 1 });
  }
  return out;
}

/** Days in a row (ending today or yesterday) on which both of us sent at least one emote: a friendly streak. */
export function emoteStreakDays(log: readonly SentLog[], now: number, dayOf: (t: number) => number): number {
  const mine = new Set<number>();
  const theirs = new Set<number>();
  for (const e of log) (e.mine ? mine : theirs).add(dayOf(e.t));
  let d = dayOf(now);
  if (!(mine.has(d) && theirs.has(d))) d -= 1;
  let n = 0;
  while (mine.has(d) && theirs.has(d)) {
    n++;
    d -= 1;
  }
  return n;
}

/** Running per-sender notification collapse: count + up to 3 distinct emoji, newest last. */
export interface EmoteCollapse {
  count: number;
  emoji: string;
  seen: string[];
}

export function collapseEmote(prev: EmoteCollapse | undefined, emoji: string): EmoteCollapse {
  const seen = prev ? prev.seen.filter((e) => e !== emoji) : [];
  seen.push(emoji);
  const last = seen.slice(-3);
  return { count: (prev?.count ?? 0) + 1, emoji: last.join(''), seen: last };
}

// --- Catch-up fanfare -----------------------------------------------------------------------------------------------

export const CATCH_UP = {
  /** One card per sender, shown in sequence. */
  cardMs: 2600,
  /** Gap between cards. */
  gapMs: 250,
  /** At most this many cards; the rest fold into the last one. */
  maxCards: 5,
  /** Emoji shown on a card. */
  maxEmoji: 4,
} as const;

export interface CatchUpCard {
  from: string;
  total: number;
  /** Distinct presets, most sent first. */
  presets: (EmotePreset | 'custom')[];
  latestAt: number;
  /** Extra senders folded into this (last) card. */
  others: number;
  /** Start offset in the sequence, ms. */
  atMs: number;
}

/** Folds combo groups into one card per sender, biggest first, timed as a skippable sequence. */
export function catchUpCards(groups: readonly ComboGroup[]): CatchUpCard[] {
  const per = new Map<string, { total: number; latestAt: number; counts: Map<EmotePreset | 'custom', number> }>();
  for (const g of groups) {
    const s = per.get(g.from) ?? { total: 0, latestAt: 0, counts: new Map() };
    s.total += g.count;
    s.latestAt = Math.max(s.latestAt, g.latestAt);
    s.counts.set(g.preset, (s.counts.get(g.preset) ?? 0) + g.count);
    per.set(g.from, s);
  }
  const all = [...per.entries()]
    .sort((a, b) => b[1].total - a[1].total || b[1].latestAt - a[1].latestAt)
    .map(([from, s]) => ({
      from,
      total: s.total,
      latestAt: s.latestAt,
      presets: [...s.counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, CATCH_UP.maxEmoji),
      others: 0,
      atMs: 0,
    }));
  const cards = all.slice(0, CATCH_UP.maxCards);
  const rest = all.length - cards.length;
  if (rest > 0) cards[cards.length - 1]!.others = rest;
  cards.forEach((c, i) => (c.atMs = i * (CATCH_UP.cardMs + CATCH_UP.gapMs)));
  return cards;
}

/** How the fanfare plays: full cards + sound when stopped; a tiny silent toast while driving or navigating. */
export function catchUpMode(o: { driving: boolean; navigating: boolean; soundWhileDriving: boolean }): { style: 'cards' | 'toast'; sound: boolean } {
  if (o.driving || o.navigating) return { style: 'toast', sound: o.soundWhileDriving };
  return { style: 'cards', sound: true };
}

/** Merges new cards into a queue still playing: same sender adds up instead of stacking twice. */
export function mergeCatchUp(queue: readonly CatchUpCard[], add: readonly CatchUpCard[]): CatchUpCard[] {
  const out = queue.map((c) => ({ ...c, presets: [...c.presets] }));
  for (const c of add) {
    const cur = out.find((q) => q.from === c.from);
    if (!cur) {
      out.push({ ...c, presets: [...c.presets] });
      continue;
    }
    cur.total += c.total;
    cur.latestAt = Math.max(cur.latestAt, c.latestAt);
    for (const p of c.presets) if (!cur.presets.includes(p) && cur.presets.length < CATCH_UP.maxEmoji) cur.presets.push(p);
  }
  out.forEach((c, i) => (c.atMs = i * (CATCH_UP.cardMs + CATCH_UP.gapMs)));
  return out;
}
