import { describe, expect, it } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ru } from './ru';

const keys = (o: object) => Object.keys(o).sort();

describe('i18n key parity', () => {
  for (const [name, d] of [['fr', fr], ['ru', ru]] as const) {
    it(`${name} has exactly the keys of en`, () => {
      const e = new Set(keys(en));
      const l = new Set(keys(d));
      expect({ missing: [...e].filter((k) => !l.has(k)), extra: [...l].filter((k) => !e.has(k)) }).toEqual({ missing: [], extra: [] });
    });
    it(`${name} keeps the same {placeholders} as en`, () => {
      const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join();
      const bad = keys(en).filter((k) => k in d && ph((en as Record<string, string>)[k]!) !== ph((d as Record<string, string>)[k]!));
      expect(bad).toEqual([]);
    });
  }
});
