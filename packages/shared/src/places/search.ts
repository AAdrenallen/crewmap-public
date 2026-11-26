import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { ru } from '../i18n/ru';
import type { PlaceType } from './core';

/** Lowercase, accents stripped (NFD + combining marks removed), apostrophes unified. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘`]/g, "'").toLowerCase().trim();
}

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Type names in every UI language, so "travail" finds Work in an English UI. */
function typeLabels(type: PlaceType): string[] {
  const k = `placeType.${type}` as const;
  return [en[k], fr[k], ru[k]].map(foldText);
}

/** 0 name prefix · 1 word prefix · 2 substring · 3 type name; null = no match. */
export function placeMatchRank(q: string, p: { name: string; type: PlaceType }): number | null {
  const needle = foldText(q);
  if (!needle) return null;
  const name = foldText(p.name);
  if (name.startsWith(needle)) return 0;
  if (words(name).some((w) => w.startsWith(needle))) return 1;
  if (needle.length >= 2 && name.includes(needle)) return 2;
  if (needle.length >= 2 && typeLabels(p.type).some((l) => l.startsWith(needle) || words(l).some((w) => w.startsWith(needle)))) return 3;
  return null;
}

/** Places matching `q` (case/accent-insensitive), best first; ties keep name order. */
export function searchPlaces<P extends { name: string; type: PlaceType }>(q: string, places: readonly P[]): P[] {
  return places
    .map((p) => ({ p, r: placeMatchRank(q, p) }))
    .filter((x): x is { p: P; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}
