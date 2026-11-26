import { useState } from 'react';
import { useActiveInterval } from '../useActiveInterval';

/** Re-renders every `everyMs` while in the foreground and returns the current time (for "2 min ago" labels). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useActiveInterval(() => setNow(Date.now()), everyMs);
  return now;
}
