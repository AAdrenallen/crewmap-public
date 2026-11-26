import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** True while the app is in the foreground. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setActive(st === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * setInterval that only runs while the app is in the foreground (and `enabled`). Fires once on resume so
 * state that drifted while backgrounded catches up immediately.
 */
export function useActiveInterval(fn: () => void, ms: number, enabled = true): void {
  const active = useAppActive();
  const ref = useRef(fn);
  ref.current = fn;
  const resumed = useRef(false);
  useEffect(() => {
    if (!active || !enabled) {
      resumed.current = true;
      return;
    }
    if (resumed.current) ref.current();
    resumed.current = false;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [active, enabled, ms]);
}
