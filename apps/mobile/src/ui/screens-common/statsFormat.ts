import { lang, t } from '@crewmap/shared/i18n';
import { formatKm } from '@crewmap/shared/units';
import type { StatMetric, TimeRange } from '@crewmap/shared/stats';

const DAY = 86_400_000;

export function metricLabel(m: StatMetric): string {
  switch (m) {
    case 'distance':
      return t('stats.driven');
    case 'driveTime':
      return t('stats.driveTime');
    case 'score':
      return t('stats.trend');
    case 'topSpeed':
      return t('stats.top');
    case 'events':
      return t('stats.events');
    case 'walks':
      return t('stats.walked');
  }
}

export function formatMetric(m: StatMetric, v: number | null): string {
  if (v === null) return '—';
  switch (m) {
    case 'distance':
    case 'walks':
      return formatKm(v, lang());
    case 'driveTime': {
      const h = Math.floor(v / 60);
      const r = Math.round(v % 60);
      return h === 0 ? `${r} min` : `${h} h ${String(r).padStart(2, '0')}`;
    }
    case 'topSpeed':
      return `${v} km/h`;
    default:
      return String(v);
  }
}

function fmt(t0: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Date(t0).toLocaleDateString(lang(), opts);
  } catch {
    return new Date(t0).toISOString().slice(0, 10);
  }
}

export const dayLabel = (t0: number) => fmt(t0, { day: 'numeric', month: 'short' });
export const weekdayLabel = (t0: number) => fmt(t0, { weekday: 'short' });
export const monthLabel = (t0: number) => fmt(t0, { month: 'short' });

/** Human range, e.g. "13 Jan – 19 Jan" (end shown inclusive). */
export function rangeLabel(r: TimeRange): string {
  const a = dayLabel(r.from);
  const b = dayLabel(r.to - DAY / 2);
  return a === b ? a : `${a} – ${b}`;
}
