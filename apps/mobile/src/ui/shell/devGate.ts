import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { developerVisible, registerUnlockTap, type TapState } from '@crewmap/shared/shell';
import { kvGet, kvSet } from '../../core/db';

const KEY = 'devUnlocked';
let unlocked = false;
let loaded = false;
const subs = new Set<() => void>();

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  unlocked = await kvGet<boolean>(KEY, false);
  subs.forEach((f) => f());
}

/** Is the Developer section reachable: dev builds always, release builds only after the hidden unlock. */
export function useDeveloperVisible(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    void load();
    return () => {
      subs.delete(f);
    };
  }, []);
  return developerVisible(__DEV__, unlocked);
}

/** Registers a tap on the version label; persists the unlock on the 7th tap in a row. Returns true when it just unlocked. */
export function useVersionTap(): () => boolean {
  const [tap, setTap] = useState<TapState>({ count: 0, last: 0 });
  return () => {
    const r = registerUnlockTap(tap, Date.now());
    setTap(r.state);
    if (r.unlocked && !unlocked) {
      unlocked = true;
      void kvSet(KEY, true);
      subs.forEach((f) => f());
      return true;
    }
    return false;
  };
}

/** Dev-only routes refuse to render in production: send the user home. Returns whether the route may render. */
export function useDevRouteGuard(): boolean {
  const router = useRouter();
  useEffect(() => {
    if (!__DEV__) router.replace('/');
  }, [router]);
  return __DEV__;
}
