import { hazardAge, type AgeUnit } from '@crewmap/hazards';
import { t } from '@crewmap/shared/i18n';

/** Localised "3 min ago" / "now" for an age computed by the hazards package. */
export function ageText(age: { unit: AgeUnit; n: number }): string {
  if (age.unit === 'now') return t('age.now');
  return t('hz.ago', { age: t(`age.${age.unit}`, { n: age.n }) });
}

export const hazardAgeText = (h: { latestReportAt: number }, now: number): string => ageText(hazardAge(h, now));
