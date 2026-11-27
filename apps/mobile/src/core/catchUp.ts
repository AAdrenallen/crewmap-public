import { create } from 'zustand';
import { mergeCatchUp, type CatchUpCard } from '@crewmap/shared/emoteSuggest';

/** Catch-up fanfare queue (D58): one card per sender for emotes that arrived while the app was away. */
interface CatchUpState {
  cards: CatchUpCard[];
  style: 'cards' | 'toast';
  sound: boolean;
  enqueue: (add: CatchUpCard[], style: 'cards' | 'toast', sound: boolean) => void;
  /** Drops the card on screen (played or skipped). */
  next: () => void;
  skipAll: () => void;
}

export const useCatchUp = create<CatchUpState>((set) => ({
  cards: [],
  style: 'cards',
  sound: true,
  enqueue: (add, style, sound) =>
    // The card on screen keeps playing; new senders queue behind it, known ones (even the one showing) add up.
    set((s) => ({ cards: mergeCatchUp(s.cards, add), style, sound })),
  next: () => set((s) => ({ cards: s.cards.slice(1) })),
  skipAll: () => set({ cards: [] }),
}));
