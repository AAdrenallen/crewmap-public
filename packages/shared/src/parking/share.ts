import { t } from '../i18n';
import type { ParkedSpot } from './core';

/** Map link for a shared spot (openstreetmap.org opens in any browser or maps app; no API call). */
export function spotLink(s: Pick<ParkedSpot, 'lat' | 'lng'>): string {
  const lat = s.lat.toFixed(5);
  const lng = s.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=19/${lat}/${lng}`;
}

/** Crew chat text for "Share with crew": only built on an explicit tap, never sent on its own. */
export function parkingShareText(s: ParkedSpot): string {
  const where = [s.street, s.note].filter((x): x is string => !!x).join(' · ');
  return t('park.shareText', { where: where || t('park.title'), link: spotLink(s) });
}

/** Title of the walk-away notification. */
export function parkedNoticeTitle(s: ParkedSpot): string {
  return s.street ? t('park.notif', { street: s.street }) : t('park.notifHere');
}
