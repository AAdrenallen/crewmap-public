import { create } from 'zustand';

/** The crewmate the home map is locating (fly to + action pill), or null. `at` makes repeat requests re-fly. */
export const useLocate = create<{ id: string | null; at: number }>(() => ({ id: null, at: 0 }));

export function locateFriend(id: string): void {
  useLocate.setState({ id, at: Date.now() });
}

export function clearLocate(): void {
  useLocate.setState({ id: null });
}
