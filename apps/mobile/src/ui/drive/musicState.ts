import { create } from 'zustand';

interface MusicUiState {
  /** Slide-in in-app music player drawer open state. */
  drawerOpen: boolean;
  /** True when the user swiped the compact navigation MusicCard pill off-screen so it stays out of the way. */
  cardDismissed: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  dismissCard: () => void;
  restoreCard: () => void;
}

export const useMusicUi = create<MusicUiState>((set) => ({
  drawerOpen: false,
  cardDismissed: false,
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  dismissCard: () => set({ cardDismissed: true }),
  restoreCard: () => set({ cardDismissed: false }),
}));
