/** Pure decisions for the crewmate list (bottom area, collapsed sheet): a compact vertical scroller, two cards visible. */

export const DECK = {
  /** Card height (FriendCard: 12 padding + 52 avatar, plus borders). */
  itemH: 76,
  gap: 10,
  /** Space above the first card. */
  padTop: 8,
  /** Cards that are always fully visible. */
  visible: 2,
  /** Sliver of the next card that peeks below the visible ones, so scrolling is obvious. */
  peek: 12,
  /** Height of the soft fade at the top / bottom edge. */
  fade: 22,
  /** Entrance: per-row stagger and duration (ms), and the most rows staggered. */
  enterDelay: 45,
  enterMs: 240,
  enterMax: 6,
} as const;

/** Widths: the old carousel card, the cap on large screens, and the gutter left of / right of the card. */
export const DECK_W = { small: 260, max: 340, padLeft: 14, rail: 22 } as const;

/** Card width: midway between the old small card and the full container, kept inside [small, max] (or the full width when that is narrower). */
export function deckCardWidth(containerW: number): number {
  const full = Math.max(0, containerW - DECK_W.padLeft - DECK_W.rail);
  const mid = Math.round((DECK_W.small + full) / 2);
  return Math.min(full, Math.max(DECK_W.small, Math.min(DECK_W.max, mid)));
}

export const DECK_STEP = DECK.itemH + DECK.gap;
/** Viewport that shows `visible` full cards plus a peek of the next. */
export const DECK_VIEW_H = DECK.padTop + DECK.visible * DECK_STEP + DECK.peek;
export const END_KEY = '__end__';

/** Friends followed by the end-of-list card. */
export const deckItems = (ids: readonly string[]): string[] => [...ids, END_KEY];

/** Index of the row at the top of the viewport for a scroll offset. */
export const topIndex = (y: number, count: number): number => Math.max(0, Math.min(count - 1, Math.round(Math.max(0, y) / DECK_STEP)));

/** Whether the map should follow after a scroll settles: only user scrolls, only real friend changes (never the end card). */
export function focusChanged(prev: number | null, next: number, ids: readonly string[], user: boolean): string | null {
  if (!user || prev === null || prev === next) return null;
  return ids[next] ?? null;
}

/** Edge fades: top once scrolled, bottom while more content lies below. */
export function fadeEdges(y: number, viewH: number, contentH: number): { top: boolean; bottom: boolean } {
  return { top: y > 2, bottom: y + viewH < contentH - 2 };
}

/** Entrance delay of a row (ms), capped so long lists do not wait. */
export const enterDelay = (i: number): number => Math.min(i, DECK.enterMax) * DECK.enterDelay;
