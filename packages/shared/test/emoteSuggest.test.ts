import { describe, expect, it } from 'vitest';
import { DRIVING_SAFE, EMOTE_PRESETS, LEGACY_PRESETS, PRESET_FALLBACK, fromWire, toWire, validateEmote } from '../src/emotes';
import {
  CATCH_UP,
  catchUpCards,
  catchUpMode,
  collapseEmote,
  emoteStreakDays,
  mergeCatchUp,
  orderGrid,
  rankFavourites,
  recentChips,
  suggestEmotes,
} from '../src/emoteSuggest';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe('wire compatibility', () => {
  it('sends newer presets as their legacy fallback that an old build validates', () => {
    const w = toWire({ preset: 'welcomeHome', k: 'a' });
    expect(w).toEqual({ preset: 'missYou', p2: 'welcomeHome', k: 'a' });
    // An old reader only knows the legacy list and ignores p2.
    expect((LEGACY_PRESETS as readonly string[]).includes(w.preset)).toBe(true);
    expect(validateEmote(w)).toBeNull();
  });
  it('legacy presets go out unchanged', () => {
    expect(toWire({ preset: 'honkHonk' })).toEqual({ preset: 'honkHonk' });
  });
  it('reads p2 when known, degrades an unknown one to the fallback', () => {
    expect(fromWire({ preset: 'missYou', p2: 'welcomeHome' })?.preset).toBe('welcomeHome');
    expect(fromWire({ preset: 'onMyWay', p2: 'someFuturePing' })?.preset).toBe('onMyWay');
    expect(fromWire({ preset: 'onMyWay', p2: 'x' })).not.toHaveProperty('p2');
    expect(fromWire(null)).toBeNull();
    expect(fromWire({ nope: 1 })).toBeNull();
  });
  it('every preset has a legacy fallback', () => {
    for (const p of EMOTE_PRESETS) expect(LEGACY_PRESETS).toContain(PRESET_FALLBACK[p]);
  });
});

describe('suggestEmotes', () => {
  it('welcomes a friend who just got home', () => {
    expect(suggestEmotes({ moment: { kind: 'arrive', t: NOW - 5 * MIN, home: true } }, NOW)[0]).toBe('welcomeHome');
  });
  it('ignores an old moment', () => {
    expect(suggestEmotes({ moment: { kind: 'arrive', t: NOW - 3 * 60 * MIN, home: true } }, NOW)).not.toContain('welcomeHome');
  });
  it('low battery, not charging → charge up', () => {
    expect(suggestEmotes({ battery: 12, charging: false }, NOW)[0]).toBe('chargeUp');
    expect(suggestEmotes({ battery: 12, charging: true }, NOW)).not.toContain('chargeUp');
    expect(suggestEmotes({ battery: null }, NOW)).not.toContain('chargeUp');
  });
  it('driving friend: driving-safe set only', () => {
    const s = suggestEmotes({ driving: true, battery: 5, lastReceived: { preset: 'whereAreYou', t: NOW - MIN } }, NOW);
    expect(s.length).toBeGreaterThan(0);
    for (const p of s) expect(DRIVING_SAFE).toContain(p);
    expect(s[0]).toBe('driveSafe');
  });
  it('replies to what they just sent', () => {
    expect(suggestEmotes({ lastReceived: { preset: 'whereAreYou', t: NOW - MIN } }, NOW)[0]).toBe('imHere');
  });
  it('caps length and never repeats', () => {
    const s = suggestEmotes({ battery: 1, moment: { kind: 'leave', t: NOW }, lastReceived: { preset: 'missYou', t: NOW } }, NOW);
    expect(new Set(s).size).toBe(s.length);
    expect(s.length).toBeLessThanOrEqual(6);
  });
});

describe('favourites and grid', () => {
  const log = [
    { preset: 'honkHonk' as const, mine: true, t: NOW - 3 * MIN },
    { preset: 'honkHonk' as const, mine: true, t: NOW - 2 * MIN },
    { preset: 'missYou' as const, mine: true, t: NOW - MIN },
    { preset: 'missYou' as const, mine: true, t: NOW - MIN / 2 },
    { preset: 'missYou' as const, mine: true, t: NOW - MIN / 4 },
    { preset: 'callMe' as const, mine: false, t: NOW },
    { preset: 'getMeFood' as const, mine: true, t: NOW, ok: false },
    { preset: 'getMeFood' as const, mine: true, t: NOW, ok: false },
  ];
  it('pins first, then most sent (failed and received excluded)', () => {
    expect(rankFavourites(log, ['thanks', 'bogus', 'thanks'], NOW)).toEqual(['thanks', 'missYou', 'honkHonk']);
  });
  it('old sends fall out of the window', () => {
    expect(rankFavourites(log, [], NOW + 40 * 24 * 60 * MIN)).toEqual([]);
  });
  it('grid keeps every preset once, favourites first', () => {
    const g = orderGrid(['thanks', 'missYou']);
    expect(g.slice(0, 2)).toEqual(['thanks', 'missYou']);
    expect([...g].sort()).toEqual([...EMOTE_PRESETS].sort());
  });
});

describe('recentChips', () => {
  it('newest first, folds consecutive repeats, unique keys', () => {
    const c = recentChips([
      { preset: 'honkHonk', mine: true, t: 1 },
      { preset: 'honkHonk', mine: true, t: 2 },
      { preset: 'honkHonk', mine: true, t: 2 },
      { preset: 'missYou', mine: false, t: 3 },
    ]);
    expect(c.map((x) => [x.preset, x.count])).toEqual([
      ['missYou', 1],
      ['honkHonk', 3],
    ]);
    expect(new Set(c.map((x) => x.key)).size).toBe(c.length);
  });
  it('respects max', () => {
    const log = Array.from({ length: 30 }, (_, i) => ({ preset: i % 2 ? ('missYou' as const) : ('thanks' as const), mine: true, t: i }));
    expect(recentChips(log, 5)).toHaveLength(5);
  });
});

describe('emoteStreakDays', () => {
  const day = (t: number) => Math.floor(t / 86_400_000);
  const D = 86_400_000;
  it('counts days where both sides sent, ending today or yesterday', () => {
    const log = [0, 1, 2].flatMap((d) => [
      { preset: 'thanks' as const, mine: true, t: NOW - d * D },
      { preset: 'thanks' as const, mine: false, t: NOW - d * D },
    ]);
    expect(emoteStreakDays(log, NOW, day)).toBe(3);
    expect(emoteStreakDays(log, NOW + D, day)).toBe(3);
    expect(emoteStreakDays(log, NOW + 2 * D, day)).toBe(0);
    expect(emoteStreakDays([{ preset: 'thanks', mine: true, t: NOW }], NOW, day)).toBe(0);
  });
});

describe('collapseEmote', () => {
  it('counts per sender and keeps the last 3 distinct emoji', () => {
    let c = collapseEmote(undefined, 'a');
    c = collapseEmote(c, 'b');
    c = collapseEmote(c, 'a');
    c = collapseEmote(c, 'c');
    c = collapseEmote(c, 'd');
    expect(c.count).toBe(5);
    expect(c.emoji).toBe('acd');
  });
});

describe('catch-up fanfare', () => {
  const g = (from: string, preset: 'honkHonk' | 'missYou' | 'thanks', count: number, latestAt = NOW) => ({ from, preset, count, latestAt });
  it('one card per sender, biggest first, sequenced', () => {
    const cards = catchUpCards([g('a', 'honkHonk', 2), g('b', 'missYou', 4), g('a', 'thanks', 3)]);
    expect(cards.map((c) => [c.from, c.total])).toEqual([
      ['a', 5],
      ['b', 4],
    ]);
    expect(cards[0]!.presets).toEqual(['thanks', 'honkHonk']);
    expect(cards[1]!.atMs).toBe(CATCH_UP.cardMs + CATCH_UP.gapMs);
  });
  it('folds senders past the cap into the last card', () => {
    const cards = catchUpCards(Array.from({ length: 8 }, (_, i) => g(`f${i}`, 'thanks', 8 - i)));
    expect(cards).toHaveLength(CATCH_UP.maxCards);
    expect(cards[cards.length - 1]!.others).toBe(3);
  });
  it('merging adds up a sender already queued', () => {
    const q = catchUpCards([g('a', 'thanks', 1)]);
    const m = mergeCatchUp(q, catchUpCards([g('a', 'honkHonk', 2), g('b', 'missYou', 1)]));
    expect(m.map((c) => [c.from, c.total])).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
    expect(m[0]!.presets).toEqual(['thanks', 'honkHonk']);
    expect(q[0]!.total).toBe(1);
  });
  it('driving or navigating: toast, sound only when allowed', () => {
    expect(catchUpMode({ driving: false, navigating: false, soundWhileDriving: false })).toEqual({ style: 'cards', sound: true });
    expect(catchUpMode({ driving: true, navigating: false, soundWhileDriving: false })).toEqual({ style: 'toast', sound: false });
    expect(catchUpMode({ driving: false, navigating: true, soundWhileDriving: true })).toEqual({ style: 'toast', sound: true });
  });
});
