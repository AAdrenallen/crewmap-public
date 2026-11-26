import { en, type I18nKey } from './en';
import { fr } from './fr';
import { ru } from './ru';

export type { I18nKey };
export type Lang = 'en' | 'fr' | 'ru';

const DICTS: Record<Lang, Record<I18nKey, string>> = { en, fr, ru };
let current: Lang = 'en';

export function setLang(l: Lang): void {
  current = l;
}

export function lang(): Lang {
  return current;
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{([a-z]+)\}/g, (_m, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** Translate in a specific language (the navigation voice may differ from the UI language). */
export function tIn(l: Lang, key: I18nKey, vars?: Record<string, string | number>): string {
  return withLang(l, () => t(key, vars));
}

/** Run `fn` with `l` as the current language (for shared code that formats spoken text via `t`). */
export function withLang<T>(l: Lang, fn: () => T): T {
  const prev = current;
  current = l;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
