/**
 * Ride-scoped emote mutes: "Mute {name}" and "Mute all" last until the ride ends (navigation ends, or the car has
 * been stopped / not driving for `endStoppedMs`). Muted emotes are still logged, just not shown or played.
 */
export const RIDE_MUTES = {
  /** Not driving for this long = the ride is over and the mutes reset. */
  endStoppedMs: 5 * 60_000,
} as const;

export interface RideMutes {
  users: readonly string[];
  all: boolean;
  /** When the ride last stopped (not driving and no navigation), or null while riding. */
  stoppedSince: number | null;
}

export const NO_RIDE_MUTES: RideMutes = { users: [], all: false, stoppedSince: null };

export function muteRideUser(m: RideMutes, id: string): RideMutes {
  return m.users.includes(id) ? m : { ...m, users: [...m.users, id] };
}

export function unmuteRideUser(m: RideMutes, id: string): RideMutes {
  return m.users.includes(id) ? { ...m, users: m.users.filter((u) => u !== id) } : m;
}

export function setRideMuteAll(m: RideMutes, all: boolean): RideMutes {
  return m.all === all ? m : { ...m, all };
}

export function isRideMuted(m: RideMutes, from: string): boolean {
  return m.all || m.users.includes(from);
}

export function hasRideMutes(m: RideMutes): boolean {
  return m.all || m.users.length > 0;
}

/**
 * Advance on a driving-state sample. `navEnded` = navigation just ended (resets at once). Returns the same object
 * when nothing changed so callers can skip store writes.
 */
export function rideTick(m: RideMutes, s: { riding: boolean; now: number; navEnded?: boolean }): RideMutes {
  if (s.navEnded) return hasRideMutes(m) ? NO_RIDE_MUTES : m.stoppedSince === null ? m : NO_RIDE_MUTES;
  if (s.riding) return m.stoppedSince === null ? m : { ...m, stoppedSince: null };
  if (m.stoppedSince === null) return hasRideMutes(m) ? { ...m, stoppedSince: s.now } : m;
  return s.now - m.stoppedSince >= RIDE_MUTES.endStoppedMs ? NO_RIDE_MUTES : m;
}
