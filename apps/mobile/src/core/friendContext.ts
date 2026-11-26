import { kph } from '@crewmap/shared/units';
import { DRIVE_UX, friendContext, type FriendContext } from '../ui/drive/driveUx';
import { useApp } from './store';

/** Non-React read of the friend context (browse / driving stopped / moving) for core notice routing. */
export function friendContextNow(): { ctx: FriendContext; next: number | null } {
  const s = useApp.getState();
  const driving = s.driving || s.nav?.active === true;
  const v = kph(s.fix?.speed ?? null) ?? 0;
  return {
    ctx: friendContext(driving, v >= DRIVE_UX.movingKph ? 'moving' : 'stopped'),
    next: s.nav?.progress?.next?.distanceM ?? null,
  };
}
