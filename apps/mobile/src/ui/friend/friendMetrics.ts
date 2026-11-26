import { driveTime, nearestWithin } from '@crewmap/shared/friend';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance, formatMinutes } from '@crewmap/shared/units';
import { useApp, type FriendView } from '../../core/store';

/** Primary friend metric: drive time from me ("12 min", or "~14 min" when estimated from the straight line). */
export function driveLabel(f: FriendView, me: { lat: number; lng: number } | null): string | null {
  const p = f.presence;
  if (!p || f.paused) return null;
  const dt = driveTime(f.etaS, me ? haversineM(me, p) : null);
  if (!dt) return null;
  const min = formatMinutes(dt.s);
  return dt.approx ? t('friend.driveApprox', { min }) : min;
}

/** Secondary: straight-line distance from me. */
export function awayLabel(f: FriendView, me: { lat: number; lng: number } | null): string | null {
  const p = f.presence;
  if (!p || f.paused || !me) return null;
  return t('friend.away', { dist: formatDistance(haversineM(me, p), lang()) });
}

/** "With Sam · 120 m": the closest other crewmate within the moments distance (replaces the proximity popup). */
export function useWithFriend(f: FriendView | undefined): string | null {
  return useApp((s) => {
    const p = f?.presence;
    if (!f || !p || f.paused || p.prec !== 'p') return null;
    const others = Object.values(s.friends)
      .filter((o) => o.presence && o.presence.prec === 'p' && !o.paused)
      .map((o) => ({
        id: o.profile.deviceId,
        lat: o.presence!.lat,
        lng: o.presence!.lng,
        name: o.profile.name,
      }));
    const n = nearestWithin(
      { id: f.profile.deviceId, lat: p.lat, lng: p.lng },
      others,
      s.settings.friendsNearM,
    );
    return n
      ? t('friend.withFriend', { name: n.other.name, dist: formatDistance(n.distanceM, lang()) })
      : null;
  });
}
