import { isRideMuted, muteRideUser, rideTick, setRideMuteAll, unmuteRideUser } from '@crewmap/shared/rideMutes';
import { useApp } from './store';

/** Ride-scoped emote mutes (store slice `rideMutes`): actions and the ride-end reset. */
export function rideMuted(from: string): boolean {
  return isRideMuted(useApp.getState().rideMutes, from);
}

export function muteForRide(from: string, on = true): void {
  const s = useApp.getState();
  s.set({ rideMutes: on ? muteRideUser(s.rideMutes, from) : unmuteRideUser(s.rideMutes, from) });
}

export function setMuteAllForRide(on: boolean): void {
  const s = useApp.getState();
  s.set({ rideMutes: setRideMuteAll(s.rideMutes, on) });
}

/** Watches driving/navigation and clears the mutes when the ride ends. Returns the unsubscribe. */
export function watchRideEnd(): () => void {
  const tick = (navEnded = false) => {
    const s = useApp.getState();
    const next = rideTick(s.rideMutes, { riding: s.driving || s.nav?.active === true, now: Date.now(), navEnded });
    if (next !== s.rideMutes) s.set({ rideMutes: next });
  };
  const unsub = useApp.subscribe((s, prev) => {
    if (s.driving !== prev.driving || s.nav?.active !== prev.nav?.active || s.rideMutes !== prev.rideMutes)
      tick(prev.nav?.active === true && s.nav?.active !== true);
  });
  const timer = setInterval(() => tick(), 30_000);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
