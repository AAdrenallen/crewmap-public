import { create } from 'zustand';
import type { EmotePreset } from '@crewmap/shared/emotes';
import { kvGet, kvSet } from './db';

/** Per-friend pinned emotes (long-press in the picker), shown first. On this device only. */
const KEY = 'emotePins';
const MAX = 6;

export const useEmotePins = create<{ loaded: boolean; pins: Record<string, string[]> }>(() => ({ loaded: false, pins: {} }));

export async function loadPins(): Promise<void> {
  if (useEmotePins.getState().loaded) return;
  const pins = await kvGet<Record<string, string[]>>(KEY, {});
  useEmotePins.setState({ loaded: true, pins });
}

export async function togglePin(friendId: string, p: EmotePreset): Promise<void> {
  await loadPins();
  const cur = useEmotePins.getState().pins[friendId] ?? [];
  const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].slice(-MAX);
  const pins = { ...useEmotePins.getState().pins, [friendId]: next };
  useEmotePins.setState({ pins });
  await kvSet(KEY, pins);
}
