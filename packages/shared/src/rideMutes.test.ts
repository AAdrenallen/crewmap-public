import { describe, expect, it } from 'vitest';
import { isRideMuted, muteRideUser, NO_RIDE_MUTES, RIDE_MUTES, rideTick, setRideMuteAll, unmuteRideUser } from './rideMutes';

describe('rideMutes', () => {
  it('scopes per user and for everyone', () => {
    let m = muteRideUser(NO_RIDE_MUTES, 'a');
    expect(isRideMuted(m, 'a')).toBe(true);
    expect(isRideMuted(m, 'b')).toBe(false);
    m = setRideMuteAll(m, true);
    expect(isRideMuted(m, 'b')).toBe(true);
    m = unmuteRideUser(setRideMuteAll(m, false), 'a');
    expect(isRideMuted(m, 'a')).toBe(false);
    expect(muteRideUser(muteRideUser(NO_RIDE_MUTES, 'a'), 'a').users).toEqual(['a']);
  });

  it('survives short stops, resets after a long stop', () => {
    let m = setRideMuteAll(muteRideUser(NO_RIDE_MUTES, 'a'), true);
    m = rideTick(m, { riding: true, now: 0 });
    m = rideTick(m, { riding: false, now: 1000 }); // red light / fuel stop
    m = rideTick(m, { riding: false, now: 1000 + RIDE_MUTES.endStoppedMs - 1 });
    expect(isRideMuted(m, 'a')).toBe(true);
    m = rideTick(m, { riding: true, now: 1000 + RIDE_MUTES.endStoppedMs });
    expect(m.stoppedSince).toBeNull();
    m = rideTick(m, { riding: false, now: 10_000_000 });
    m = rideTick(m, { riding: false, now: 10_000_000 + RIDE_MUTES.endStoppedMs });
    expect(m).toEqual(NO_RIDE_MUTES);
  });

  it('resets as soon as navigation ends', () => {
    const m = rideTick(muteRideUser(NO_RIDE_MUTES, 'a'), { riding: false, now: 5, navEnded: true });
    expect(m).toEqual(NO_RIDE_MUTES);
  });

  it('returns the same object when nothing changes', () => {
    expect(rideTick(NO_RIDE_MUTES, { riding: false, now: 1 })).toBe(NO_RIDE_MUTES);
    const m = muteRideUser(NO_RIDE_MUTES, 'a');
    expect(rideTick(m, { riding: true, now: 1 })).toBe(m);
  });
});
