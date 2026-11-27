import { describe, expect, it } from 'vitest';
import { LOCATE_UX, locateActions, locateTarget, pillBottom } from './locateLogic';

const now = 1_000_000_000;

describe('locateTarget', () => {
  it('fresh, stale and hidden', () => {
    expect(locateTarget({ paused: false, presence: { lat: 1, lng: 2, t: now - 1000 } }, now).kind).toBe('live');
    expect(locateTarget({ paused: false, presence: { lat: 1, lng: 2, t: now - LOCATE_UX.staleMs } }, now).kind).toBe('stale');
    expect(locateTarget({ paused: true, presence: { lat: 1, lng: 2, t: now } }, now).kind).toBe('hidden');
    expect(locateTarget({ paused: false, presence: null }, now).kind).toBe('hidden');
    expect(locateTarget({ paused: false, presence: { lat: NaN, lng: 2, t: now } }, now).kind).toBe('hidden');
  });
});

describe('locateActions', () => {
  it('a position offers directions first; hidden offers ask to share once', () => {
    const live = locateTarget({ paused: false, presence: { lat: 1, lng: 2, t: now } }, now);
    expect(locateActions(live, { chat: true, driving: false })).toEqual(['directions', 'along', 'chat', 'emote']);
    expect(locateActions({ kind: 'hidden' }, { chat: true, driving: false })).toEqual(['askOnce', 'ask', 'chat', 'emote']);
  });
  it('driving drops chat', () => {
    expect(locateActions({ kind: 'hidden' }, { chat: true, driving: true })).not.toContain('chat');
  });
});

describe('pillBottom', () => {
  const col = { x: 0, width: 400 };
  it('clears lower HUD boxes in its column and ignores the top banners', () => {
    const boxes = [
      { x: 0, y: 0, width: 400, height: 200 }, // nav banners
      { x: 130, y: 700, width: 170, height: 80 }, // ETA footer
    ];
    expect(pillBottom(boxes, 800, 20, col)).toBe(800 - 700 + LOCATE_UX.gapDp);
  });
  it('keeps the minimum when nothing is below or boxes sit outside the column', () => {
    expect(pillBottom([{ x: 500, y: 700, width: 50, height: 50 }], 800, 20, col)).toBe(20);
    expect(pillBottom([], 800, 20, col)).toBe(20);
  });
});
