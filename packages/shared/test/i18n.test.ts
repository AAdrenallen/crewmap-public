import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { fr } from '../src/i18n/fr';
import { ru } from '../src/i18n/ru';

const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();

describe('i18n fr', () => {
  it('has the same keys as en', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });
  it('keeps placeholders identical', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(ph(fr[k]), k).toEqual(ph(en[k]));
    }
  });
  it('has no empty strings', () => {
    for (const [k, v] of Object.entries(fr)) expect(v.trim(), k).not.toBe('');
  });
});

describe('i18n ru', () => {
  it('has the same keys as en', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });
  it('keeps placeholders identical', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(ph(ru[k]), k).toEqual(ph(en[k]));
  });
});
