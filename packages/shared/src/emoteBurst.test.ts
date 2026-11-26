import { describe, expect, it } from 'vitest';
import { audioLayers, EDGE_AUDIO, EDGE_BURST, planEdgeBurst, seedOf } from './emoteBurst';
import { EMOTE_COMBO } from './emoteCombo';
import { intersects } from './emotes';

const screen = { w: 400, h: 800 };
const occupied = [
  { x: 0, y: 0, w: 400, h: 120 }, // next-turn banner
  { x: 0, y: 660, w: 400, h: 140 }, // ETA footer
  { x: 8, y: 180, w: 220, h: 60 }, // chat bubbles slot
];

describe('planEdgeBurst', () => {
  it('never places a pop or the chip over occupied rects', () => {
    for (const driving of [false, true])
      for (const count of [1, 5, 40]) {
        const p = planEdgeBurst({ screen, count, driving, occupied, seed: seedOf(`e${count}`), chipSize: { w: 120, h: 28 } });
        expect(p.pops.length).toBeGreaterThan(0);
        for (const pop of p.pops) {
          const s = driving ? EDGE_BURST.drivingSizeDp : EDGE_BURST.sizeDp;
          expect(occupied.some((o) => intersects({ x: pop.x, y: pop.y, w: s, h: s }, o))).toBe(false);
        }
        expect(p.chip).not.toBeNull();
        expect(occupied.some((o) => intersects({ ...p.chip!, w: 120, h: 28 }, o))).toBe(false);
      }
  });

  it('driving: a couple of soft pops; idle: grows with count, capped', () => {
    const d = planEdgeBurst({ screen, count: 30, driving: true, occupied, seed: 1 });
    expect(d.pops).toHaveLength(EDGE_BURST.drivingPops);
    expect(d.pops.every((p) => p.scale <= 1 && p.tilt === 0)).toBe(true);
    const one = planEdgeBurst({ screen, count: 1, driving: false, occupied, seed: 1 });
    const many = planEdgeBurst({ screen, count: 10, driving: false, occupied, seed: 1 });
    const huge = planEdgeBurst({ screen, count: 500, driving: false, occupied, seed: 1 });
    expect(many.pops.length).toBeGreaterThan(one.pops.length);
    expect(huge.pops.length).toBeLessThanOrEqual(EMOTE_COMBO.maxParticles);
    expect(new Set(many.pops.map((p) => p.edge)).size).toBeGreaterThanOrEqual(2);
    const open = planEdgeBurst({ screen, count: 10, driving: false, occupied: [], seed: 1 });
    expect(new Set(open.pops.map((p) => p.edge)).size).toBeGreaterThan(2);
  });

  it('staggers pops and is deterministic per seed', () => {
    const a = planEdgeBurst({ screen, count: 6, driving: false, occupied, seed: 42 });
    const b = planEdgeBurst({ screen, count: 6, driving: false, occupied, seed: 42 });
    expect(a).toEqual(b);
    for (let i = 1; i < a.pops.length; i++) expect(a.pops[i]!.delayMs).toBeGreaterThan(a.pops[i - 1]!.delayMs);
  });

  it('returns no pops when the whole screen is occupied', () => {
    const p = planEdgeBurst({ screen, count: 3, driving: false, occupied: [{ x: 0, y: 0, w: 400, h: 800 }], seed: 1, chipSize: { w: 100, h: 28 } });
    expect(p.pops).toHaveLength(0);
    expect(p.chip).toBeNull();
  });
});

describe('audioLayers', () => {
  it('none for a single emote; escalates and caps for many', () => {
    const plan = planEdgeBurst({ screen, count: 1, driving: false, occupied, seed: 1 });
    expect(audioLayers(plan, 1)).toEqual([]);
    const big = planEdgeBurst({ screen, count: 50, driving: false, occupied, seed: 1 });
    const l = audioLayers(big, 50);
    expect(l).toHaveLength(EDGE_AUDIO.maxLayers);
    for (let i = 1; i < l.length; i++) {
      expect(l[i]!.volume).toBeGreaterThanOrEqual(l[i - 1]!.volume);
      expect(l[i]!.rate).toBeGreaterThan(l[i - 1]!.rate);
    }
    expect(Math.max(...l.map((x) => x.volume))).toBeLessThanOrEqual(EDGE_AUDIO.maxVolume);
    expect(Math.max(...l.map((x) => x.rate))).toBeLessThanOrEqual(EDGE_AUDIO.maxRate);
  });
});
