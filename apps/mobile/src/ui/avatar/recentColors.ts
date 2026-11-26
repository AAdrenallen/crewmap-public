import { create } from 'zustand';
import { pushRecentColor } from '@crewmap/shared/avatar';
import { kvGet, kvSet } from '../../core/db';

const KEY = 'recentColors';

/** Colours picked with the custom picker, newest first (this device only). */
export const useRecentColors = create<{ list: string[] }>(() => ({ list: [] }));

let loading: Promise<void> | null = null;
export function loadRecentColors(): Promise<void> {
  loading ??= kvGet<string[]>(KEY, [])
    .then((l) => useRecentColors.setState({ list: Array.isArray(l) ? l.slice(0, 8) : [] }))
    .catch(() => undefined);
  return loading;
}

export function addRecentColor(hex: string): void {
  const list = pushRecentColor(useRecentColors.getState().list, hex);
  useRecentColors.setState({ list });
  void kvSet(KEY, list).catch(() => undefined);
}
