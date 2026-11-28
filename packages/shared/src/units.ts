import { t as tr } from './i18n';

/** Metric units, 24 h time (Config §0). */

export function formatDistance(m: number, locale: 'en' | 'fr' | 'ru' = 'en'): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} ${locale === 'ru' ? 'м' : 'm'}`;
  const km = m / 1000;
  const s = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return `${locale !== 'en' ? s.replace('.', ',') : s} ${locale === 'ru' ? 'км' : 'km'}`;
}

export function formatKm(km: number, locale: 'en' | 'fr' | 'ru' = 'en'): string {
  const s = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return `${locale !== 'en' ? s.replace('.', ',') : s} ${locale === 'ru' ? 'км' : 'km'}`;
}

export function formatMinutes(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h} h` : `${h} h ${String(r).padStart(2, '0')}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatClock(t: number, tz?: string): string {
  const key = tz ?? '';
  let fmt = clockFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) });
    if (clockFormatters.size > 16) clockFormatters.clear();
    clockFormatters.set(key, fmt);
  }
  return fmt.format(t);
}

export function kph(mps: number | null): number | null {
  return mps === null ? null : Math.round(mps * 3.6);
}

/** Localised "now", "3 min", "2 h", "3 d" since `t` (callers add any "ago"/"seen" wording). */
export function formatAge(t: number, now: number): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return tr('age.now');
  if (s < 3600) return tr('age.min', { n: Math.round(s / 60) });
  if (s < 86_400) return tr('age.h', { n: Math.round(s / 3600) });
  return tr('age.d', { n: Math.round(s / 86_400) });
}

/** Turn-by-turn distance, rounded like Google Maps: 10 m steps below 100 m, 50 m steps below 1 km, then 0.1 km (1 km from 10 km). */
export function formatNavDistance(m: number, locale: 'en' | 'fr' | 'ru' = 'en'): string {
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} ${locale === 'ru' ? 'м' : 'm'}`;
  const r = Math.round(m / 50) * 50;
  if (r < 1000) return `${r} ${locale === 'ru' ? 'м' : 'm'}`;
  return formatKm(Math.round(m / 100) / 10, locale);
}

/** Speed in km/h, e.g. "87 km/h" (Russian: "км/ч"). */
export function formatSpeed(kph: number, locale: 'en' | 'fr' | 'ru' = 'en'): string {
  return `${Math.round(kph)} ${locale === 'ru' ? 'км/ч' : 'km/h'}`;
}

/** The speed unit alone ("km/h", "км/ч"). */
export function speedUnit(locale: 'en' | 'fr' | 'ru' = 'en'): string {
  return locale === 'ru' ? 'км/ч' : 'km/h';
}
