/**
 * Privacy scrubbing for the on-device error log: no coordinates, names, free text, ids or URLs' query strings.
 * Pure (no React Native imports) so it is unit-tested.
 */

export type ErrorKind = 'render' | 'fatal' | 'js' | 'promise' | 'console.error' | 'console.warn' | 'mapbox';

export interface ErrorEntry {
  t: number;
  kind: ErrorKind;
  msg: string;
  stack?: string;
  route?: string;
}

export const MAX_ENTRIES = 200;
const MAX_MSG = 300;
const STACK_LINES = 6;

/** Identifier-like quoted values (prop, layer, source names) are kept; anything else quoted is free text. */
const IDENT = /^[A-Za-z_$][\w$.\-/:]{0,40}$/;

export function scrub(text: string, names: readonly string[] = []): string {
  let s = String(text);
  for (const n of names) {
    const v = n.trim();
    if (v.length < 2) continue;
    s = s.split(v).join('<name>');
  }
  s = s
    .replace(/https?:\/\/[^\s"')]+/g, (u) => u.replace(/[?#].*$/, '?…'))
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    // Decimal numbers with 3+ fraction digits look like lat/lng (also inside arrays like [-73.5673, 45.5017]).
    .replace(/-?\d{1,3}\.\d{3,}/g, '<num>')
    // Long hex / base64-ish tokens: keys, ids.
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<id>')
    .replace(/"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”/g, (m, a?: string, b?: string, c?: string) => {
      const v = a ?? b ?? c ?? '';
      return IDENT.test(v) ? m : '"<text>"';
    });
  return s.length > MAX_MSG ? `${s.slice(0, MAX_MSG)}…` : s;
}

/** First few frames, file paths reduced to basenames, then scrubbed. */
export function shortStack(stack: string | undefined, names: readonly string[] = []): string | undefined {
  if (!stack) return undefined;
  const lines = stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\w*Error:/.test(l))
    .slice(0, STACK_LINES)
    .map((l) => l.replace(/(?:[A-Za-z]:)?[^\s()]*[\\/]([^\\/\s()]+)/g, '$1'));
  return lines.length ? lines.map((l) => scrub(l, names)).join('\n') : undefined;
}

export function describe(e: unknown): { msg: string; stack?: string } {
  if (e instanceof Error) return { msg: `${e.name}: ${e.message}`, stack: e.stack };
  if (typeof e === 'string') return { msg: e };
  try {
    return { msg: JSON.stringify(e) ?? String(e) };
  } catch {
    return { msg: String(e) };
  }
}

export function makeEntry(kind: ErrorKind, e: unknown, route: string | undefined, names: readonly string[], t = Date.now()): ErrorEntry {
  const d = describe(e);
  const stack = shortStack(d.stack, names);
  return { t, kind, msg: scrub(d.msg, names), ...(stack ? { stack } : {}), ...(route ? { route } : {}) };
}

/** Appends and keeps the newest `max`. */
export function pushEntry(list: ErrorEntry[], e: ErrorEntry, max = MAX_ENTRIES): ErrorEntry[] {
  const next = [...list, e];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Route template only (`friend/[id]`), never the concrete ids. */
export function routeOf(segments: readonly string[]): string {
  return segments.length ? segments.join('/') : 'index';
}

/** True for a number usable by native props (rnmapbox crashes or logs on NaN/undefined). */
export const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
