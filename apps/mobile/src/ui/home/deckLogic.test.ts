import { describe, expect, it } from 'vitest';
import { DECK, DECK_STEP, DECK_VIEW_H, END_KEY, deckCardWidth, deckItems, enterDelay, fadeEdges, focusChanged, topIndex } from './deckLogic';

describe('deck', () => {
  it('ends with the end card', () => {
    expect(deckItems(['a', 'b'])).toEqual(['a', 'b', END_KEY]);
  });
  it('follows the map only for user scrolls that change the top friend', () => {
    expect(focusChanged(null, 1, ['a', 'b'], true)).toBeNull();
    expect(focusChanged(1, 1, ['a', 'b'], true)).toBeNull();
    expect(focusChanged(0, 1, ['a', 'b'], true)).toBe('b');
    expect(focusChanged(0, 1, ['a', 'b'], false)).toBeNull();
    expect(focusChanged(1, 2, ['a', 'b'], true)).toBeNull();
  });
  it('sizes the card between the old width and the full width, clamped', () => {
    expect(deckCardWidth(412)).toBe(318);
    expect(deckCardWidth(320)).toBe(272);
    expect(deckCardWidth(280)).toBe(244);
    expect(deckCardWidth(900)).toBe(340);
    expect(deckCardWidth(0)).toBe(0);
  });
});

describe('list geometry', () => {
  it('the viewport fits two full cards and a peek of the third', () => {
    expect(DECK_VIEW_H - DECK.padTop - 2 * DECK_STEP).toBe(DECK.peek);
  });
  it('maps an offset to the top row, clamped', () => {
    expect(topIndex(0, 4)).toBe(0);
    expect(topIndex(DECK_STEP * 1.6, 4)).toBe(2);
    expect(topIndex(-30, 4)).toBe(0);
    expect(topIndex(9999, 4)).toBe(3);
  });
  it('fades the top once scrolled and the bottom while more lies below', () => {
    expect(fadeEdges(0, 180, 400)).toEqual({ top: false, bottom: true });
    expect(fadeEdges(100, 180, 400)).toEqual({ top: true, bottom: true });
    expect(fadeEdges(220, 180, 400)).toEqual({ top: true, bottom: false });
    expect(fadeEdges(0, 180, 170)).toEqual({ top: false, bottom: false });
  });
  it('staggers entrance but caps the wait', () => {
    expect(enterDelay(0)).toBe(0);
    expect(enterDelay(2)).toBe(2 * DECK.enterDelay);
    expect(enterDelay(50)).toBe(DECK.enterMax * DECK.enterDelay);
  });
});
