import type { NavStep } from './route';

/** Languages the navigation voice can speak (D-voice). */
export type SpeechLang = 'en' | 'fr' | 'ru';

export interface SpeechSegment {
  text: string;
  lang: SpeechLang;
}

const CYRILLIC = /[Ѐ-ӿ]/;
const FR_ACCENT = /[éèêëàâçôûùüïîœÉÈÊÀÂÇÔÛÎÏ]/;
/** Generic French road types that come first ("Rue X", "Rue de la Gare"). */
const FR_PREFIX = new Set([
  'rue', 'avenue', 'av', 'boulevard', 'boul', 'bd', 'chemin', 'ch', 'montée', 'montee', 'rang', 'côte', 'cote', 'route', 'rte',
  'autoroute', 'aut', 'place', 'impasse', 'croissant', 'promenade', 'allée', 'allee', 'carré', 'terrasse', 'quai', 'sentier',
  'ruelle', 'voie', 'cours', 'pont', 'rond-point', 'square', 'traverse', 'concession', 'pointe', 'lac', 'île', 'ile', 'mont',
]);
const FR_PARTICLE = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'aux', 'au', 'sur', 'en']);
/** English road types that come last ("Cameron Street", "Lakeshore Road"). */
const EN_SUFFIX = new Set([
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'av', 'drive', 'dr', 'lane', 'ln', 'highway', 'hwy', 'crescent', 'cres', 'court',
  'ct', 'way', 'circle', 'parkway', 'pkwy', 'trail', 'line', 'sideroad', 'boulevard', 'blvd', 'place', 'pl', 'terrace', 'gate',
  'close', 'grove', 'heights', 'expressway', 'freeway', 'bridge', 'square', 'park', 'hill', 'row',
]);
const EN_WORD = new Set(['the', 'of', 'and', 'north', 'south', 'east', 'west', 'old', 'new', 'upper', 'lower', 'county', 'township', 'mount', 'lake', 'river', 'falls', 'bay']);
const EN_ENDING = /(bury|borough|burgh|ton|wood|field|ford|ham|shore|side|view|dale|land|wick|worth|mouth|port|vale|ridge|brook|bridge|stone|town|hurst|by|ing|ey|ay)$/;
const FR_ENDING = /(ville|ière|ieres|ières|eau|eaux|ois|oise|elle|ette|ais|aise|ac|aux|ien|ienne|ard|ault|eault|ier|é|ée|gne|eur|euse|ine|ure|que)$/;
/** Route numbers / refs: "A-15", "148", "QC 117", "ON-17", "Hwy 417" → read in the voice language. */
const ROUTE_NUMBER = /^(?:[A-Z]{1,3}[- ]?)?\d{1,4}[A-Z]?(?:\s*[/;]\s*(?:[A-Z]{1,3}[- ]?)?\d{1,4}[A-Z]?)*$/;

const words = (s: string): string[] => s.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Language a road or place name is written in, or `null` for a bare route number (spoken in the voice language).
 * `fallback` decides ambiguous names; in Québec it should be 'fr'.
 */
export function classifyName(name: string, fallback: SpeechLang): SpeechLang | null {
  const n = name.trim();
  if (!n) return null;
  if (CYRILLIC.test(n)) return 'ru';
  if (ROUTE_NUMBER.test(n)) return null;
  const w = words(n);
  const first = w[0] ?? '';
  const last = w[w.length - 1] ?? '';
  let fr = 0;
  let en = 0;
  if (FR_ACCENT.test(n)) fr += 3;
  if (FR_PREFIX.has(first) && w.length > 1) fr += 3;
  if (EN_SUFFIX.has(last) && w.length > 1 && !/^\d+$/.test(w[w.length - 2] ?? '')) en += 3;
  if (/\b(saint|sainte|st|ste)-/i.test(n) || /^(saint|sainte|ste)$/.test(first)) fr += 3;
  else if (first === 'st' && !FR_ACCENT.test(n)) en += 1; // "St Clair Avenue", "St. Lawrence Street"
  if (/[a-zà-ÿ]-[a-zà-ÿ]/i.test(n)) fr += 2; // hyphenated compounds: Camille-Roy, Pointe-Claire, Lac-Clair
  if (/\b[dl]['’]/i.test(n)) fr += 2;
  for (const x of w.slice(1)) if (FR_PARTICLE.has(x)) fr += 2;
  for (const x of w) if (EN_WORD.has(x)) en += 2;
  if (/'s\b/i.test(n)) en += 2;
  if (w.length === 1 || en + fr === 0) {
    const core = w.length > 1 && EN_SUFFIX.has(last) ? w[w.length - 2]! : first;
    if (/[wk]|th|sh|oo|ee/.test(core) && !FR_ACCENT.test(core)) en += 1;
    if (EN_ENDING.test(core)) en += 1;
    if (FR_ENDING.test(core)) fr += 1;
  }
  if (fr > en) return 'fr';
  if (en > fr) return 'en';
  return fallback;
}

/** Names the instruction text can contain: road name, refs, and banner text components (exits, destinations). */
export function namesFromStep(step: Pick<NavStep, 'name' | 'ref' | 'banners'> | null | undefined): string[] {
  if (!step) return [];
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    const v = s?.trim();
    if (v && v.length > 1) out.add(v);
  };
  add(step.name);
  for (const r of step.ref?.split(/\s*;\s*/) ?? []) add(r);
  for (const b of step.banners) {
    for (const c of [...b.primary.components, ...(b.secondary?.components ?? [])]) if (c.type === 'text') add(c.text);
  }
  return [...out];
}

/**
 * Split a spoken instruction into same-language segments: template words in `voice`, proper names in the
 * language they are written in. Names are located by exact (case-insensitive) spans, longest first.
 */
export function segmentUtterance(text: string, names: readonly string[], voice: SpeechLang, fallback: SpeechLang): SpeechSegment[] {
  const spans: { start: number; end: number; lang: SpeechLang }[] = [];
  const lower = text.toLowerCase();
  const sorted = [...new Set(names)].filter((n) => n.trim().length > 1).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const l = classifyName(name, fallback);
    const needle = name.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      from = end;
      if (spans.some((s) => i < s.end && end > s.start)) continue;
      // Whole-word match only.
      if (/[\p{L}\p{N}]/u.test(text[i - 1] ?? '') || /[\p{L}\p{N}]/u.test(text[end] ?? '')) continue;
      spans.push({ start: i, end, lang: l ?? voice });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const segs: SpeechSegment[] = [];
  const push = (text0: string, l: SpeechLang) => {
    let t = text0;
    const prev = segs[segs.length - 1];
    // Leading punctuation ("Cameron Street, puis…") stays with the previous segment so pauses fall naturally.
    const lead = prev ? (/^[\s,.;:!?)]+/.exec(t)?.[0] ?? '') : '';
    if (prev && lead) {
      prev.text += lead;
      t = t.slice(lead.length);
    }
    if (!t) return;
    if (prev && (prev.lang === l || !/[\p{L}\p{N}]/u.test(t))) prev.text += t;
    else segs.push({ text: t, lang: l });
  };
  let at = 0;
  for (const s of spans) {
    push(text.slice(at, s.start), voice);
    push(text.slice(s.start, s.end), s.lang);
    at = s.end;
  }
  push(text.slice(at), voice);
  return segs
    .map((s) => ({ text: s.text.replace(/\s+/g, ' ').trim(), lang: s.lang }))
    .filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}

/** Rough Québec outline (lng, lat), south border along the Ottawa River and the 45th parallel. */
const QUEBEC: [number, number][] = [
  [-79.52, 62.6], [-79.52, 47.5], [-79.1, 46.7], [-78.7, 46.3], [-77.1, 45.85], [-76.3, 45.5], [-75.7, 45.47], [-75.0, 45.6],
  [-74.6, 45.64], [-74.38, 45.57], [-74.33, 45.23], [-74.15, 45.0], [-71.5, 45.0], [-70.3, 45.9], [-69.2, 47.45], [-68.3, 47.4],
  [-67.8, 47.9], [-66.3, 48.0], [-64.0, 48.1], [-57.1, 51.4], [-57.1, 62.6],
];

/** Point-in-polygon: inside Québec → ambiguous names default to French. */
export function inQuebec(lat: number, lng: number): boolean {
  let inside = false;
  for (let i = 0, j = QUEBEC.length - 1; i < QUEBEC.length; j = i++) {
    const [xi, yi] = QUEBEC[i]!;
    const [xj, yj] = QUEBEC[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Abbreviations a non-French voice would misread inside French names ("St-Jérôme" → "Street Jérôme"). */
const FR_ABBR: [RegExp, string][] = [
  [/\bBoul\.?\s/gi, 'Boulevard '],
  [/\bCh\.\s/g, 'Chemin '],
  [/\bAv\.\s/g, 'Avenue '],
  [/\bMtée\s/gi, 'Montée '],
];

/** Spell a name out so any voice pronounces it as written (accents kept, French abbreviations expanded). */
export function pronounceName(name: string, nameLang: SpeechLang): string {
  if (nameLang !== 'fr') return name;
  let out = name;
  out = out.replace(/\bSte[-.]\s?(?=\p{Lu})/gu, 'Sainte-').replace(/\bSt[-.]\s?(?=\p{Lu})/gu, 'Saint-');
  for (const [re, rep] of FR_ABBR) out = out.replace(re, rep);
  return out;
}

/**
 * Single-speaker utterance: every segment is read by the voice-language speaker; French names are expanded so that
 * speaker does not apply its own abbreviations. Returns one segment.
 */
export function singleVoice(segs: readonly SpeechSegment[], voice: SpeechLang): SpeechSegment[] {
  const text = segs.map((s) => (s.lang === voice ? s.text : pronounceName(s.text, s.lang))).join(' ').trim();
  return text ? [{ text, lang: voice }] : [];
}
