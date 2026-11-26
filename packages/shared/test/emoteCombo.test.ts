import { describe, expect, it } from 'vitest';
import { EMOTE_COMBO, aggregateEmotes, comboPlan, type PendingEmote } from '../src/emoteCombo';

const now = 1_000_000_000_000;
const e = (id: string, from: string, preset: PendingEmote['preset'], ageMs: number): PendingEmote => ({ id, from, preset, sentAt: now - ageMs });

describe('emote combo', () => {
  it('groups per sender and type, dedupes by id (not by type), sorts by count', () => {
    const items = [
      ...Array.from({ length: 14 }, (_, i) => e(`a${i}`, 'alex', 'honkHonk', 1000 * i)),
      e('a0', 'alex', 'honkHonk', 5), // duplicate id
      e('b1', 'alex', 'missYou', 10),
      e('c1', 'sam', 'honkHonk', 10),
    ];
    const s = aggregateEmotes(items, now);
    expect(s.groups[0]).toMatchObject({ from: 'alex', preset: 'honkHonk', count: 14 });
    expect(s.groups).toHaveLength(3);
  });

  it('summarises emotes older than 24 h silently', () => {
    const old = EMOTE_COMBO.staleMs + 1000;
    const s = aggregateEmotes([e('1', 'alex', 'honkHonk', old), e('2', 'alex', 'honkHonk', old), e('3', 'alex', 'honkHonk', 5)], now);
    expect(s.stale).toEqual([{ from: 'alex', count: 2, latestAt: now - old }]);
    expect(s.groups[0]?.count).toBe(1);
  });

  it('plans a capped, accelerating build-up', () => {
    const p = comboPlan(27);
    expect(p.bursts).toBe(12);
    expect(p.offsetsMs[11]).toBeLessThanOrEqual(EMOTE_COMBO.maxWindowMs);
    const gaps = p.offsetsMs.slice(1).map((o, i) => o - p.offsetsMs[i]!);
    expect(gaps[0]!).toBeGreaterThan(gaps[gaps.length - 1]!);
    expect(p.showCount).toBe(true);
    expect(p.sound[11]).toBe(true);
    expect(comboPlan(1)).toMatchObject({ bursts: 1, showCount: false, offsetsMs: [0] });
    expect(comboPlan(500).intensity).toBe(1);
    expect(comboPlan(3).intensity).toBeLessThan(comboPlan(30).intensity);
  });

});

import { LIVE_STREAK_MS, nextStreak, streakPop } from '../src/emoteCombo';

describe('live streak', () => {
  it('extends within the gap, restarts after quiet or for another sender/type', () => {
    const a = nextStreak(null, 'alex', 'honkHonk', 1000, 'x');
    expect(a).toMatchObject({ count: 1, continued: false });
    const b = nextStreak(a, 'alex', 'honkHonk', 1000 + LIVE_STREAK_MS, 'y');
    expect(b).toMatchObject({ count: 2, continued: true, id: 'x' });
    expect(nextStreak(b, 'alex', 'honkHonk', b.lastAt + LIVE_STREAK_MS + 1, 'z')).toMatchObject({ count: 1, id: 'z' });
    expect(nextStreak(b, 'sam', 'honkHonk', b.lastAt + 10, 'w').continued).toBe(false);
    expect(nextStreak(b, 'alex', 'missYou', b.lastAt + 10, 'w').continued).toBe(false);
  });
  it('pops grow and stay capped', () => {
    expect(streakPop(5).volume).toBeGreaterThan(streakPop(1).volume);
    expect(streakPop(500).volume).toBe(1);
    expect(streakPop(500).intensity).toBe(1);
    expect(streakPop(13).sound).toBe(false);
  });
});
