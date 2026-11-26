/**
 * Parses the ongoing navigation notification that Google Maps / Waze post while guiding (read through Android
 * Notification Access). Pure and locale-tolerant (English + French). Raw strings never leave this function.
 *
 * Observed shapes (title / text / subText vary by app version):
 *  Google Maps  title "350 m" or "Turn left onto Main St", text "Turn left onto Main St" or "toward X",
 *               subText "12 min · 8.3 km · 11:43 ETA" / "12 min · 8,3 km · Arrivée prévue à 11:43".
 *  Waze         title "Turn right onto X" / "Tournez à droite", text "In 350 m" / "Dans 350 m",
 *               subText or bigText "ETA 11:43 · 12 min · 8.3 km" / "Arrivée 11 h 43 · 12 min".
 */

export type ExternalNavSource = 'waze' | 'gmaps';

export interface ExternalNavRaw {
  app: ExternalNavSource;
  title: string | null;
  text: string | null;
  subText: string | null;
  bigText: string | null;
  t: number;
}

export interface ExternalNavUpdate {
  app: ExternalNavSource;
  /** Traffic-aware remaining time, minutes. */
  remainingMin: number | null;
  remainingKm: number | null;
  /** Arrival clock time, 24 h. */
  arrival: string | null;
  /** Next maneuver, prefixed with its distance when shown ("350 m · Turn left onto X"). */
  nextInstruction: string | null;
  t: number;
}

const SEP = /\s*(?:[·•|\n]|,\s(?=\D)|\s-\s|\s–\s|[()])\s*/;
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const DIST = new RegExp(String.raw`^(?:(?:in|dans|à)\s+)?${NUM}\s*(km|m|mi|ft|yd)\b\.?(?:\s+(?:left|restants?|remaining))?$`, 'i');
const ARRIVAL_KW = /\b(eta|arrival|arrive|arriving|arrivée|arrivee|arrivée prévue|arrival time|heure d'arrivée)\b/i;
const CLOCK = /\b(\d{1,2})\s*(?::|h)\s*(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?!\s*min)/i;
const CLOCK_AMPM = /\b(\d{1,2})\s*(am|pm)\b/i;
const DUR_H = /(\d+)\s*(?:h|hr|hrs|hour|hours|heure|heures)\b\.?\s*(?:(\d+)\s*(?:min|mins|minutes?|mn)\b)?/i;
const DUR_M = /(\d+)\s*(?:min|mins|minutes?|mn)\b/i;
const INSTRUCTION =
  /\b(turn|keep|head|continue|take|exit|merge|make a|u-turn|roundabout|slight|bear|go straight|arrive|destination|enter|at the|onto|toward|tournez|tourner|prenez|prendre|continuez|serrez|restez|gardez|rond-point|faites|demi-tour|sortez|sortie|rejoignez|dirigez|vous êtes arrivé|destination|vers|engagez|empruntez|suivez|au bout)\b/i;

function toKm(v: string, unit: string): number {
  const n = Number(v.replace(',', '.'));
  switch (unit.toLowerCase()) {
    case 'm':
      return n / 1000;
    case 'mi':
      return n * 1.609344;
    case 'ft':
      return n * 0.0003048;
    case 'yd':
      return n * 0.0009144;
    default:
      return n;
  }
}

const round1 = (km: number) => Math.round(km * 10) / 10;
const pad = (n: number) => String(n).padStart(2, '0');

function clock(seg: string): string | null {
  const m = CLOCK.exec(seg);
  let h: number;
  let min: number;
  let ap: string | undefined;
  if (m) {
    h = Number(m[1]);
    min = Number(m[2]);
    ap = m[3];
  } else {
    const a = CLOCK_AMPM.exec(seg);
    if (!a) return null;
    h = Number(a[1]);
    min = 0;
    ap = a[2];
  }
  if (ap) {
    const pm = ap.toLowerCase().startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function duration(seg: string): number | null {
  const h = DUR_H.exec(seg);
  if (h) return Number(h[1]) * 60 + (h[2] ? Number(h[2]) : 0);
  const m = DUR_M.exec(seg);
  return m ? Number(m[1]) : null;
}

interface FieldParse {
  remainingMin: number | null;
  arrival: string | null;
  dists: number[];
  instruction: string | null;
}

function parseField(s: string): FieldParse {
  const out: FieldParse = { remainingMin: null, arrival: null, dists: [], instruction: null };
  const words: string[] = [];
  for (const raw of s.split(SEP)) {
    const seg = raw.trim().replace(/[,.;]+$/, '');
    if (!seg) continue;
    const d = DIST.exec(seg);
    if (d) {
      out.dists.push(toKm(d[1]!, d[2]!));
      continue;
    }
    if (ARRIVAL_KW.test(seg)) {
      const c = clock(seg);
      if (c) {
        out.arrival ??= c;
        continue;
      }
    }
    // "1 h 05 min" is a duration; "11 h 43" / "11:43" alone is a clock time.
    if (DUR_M.test(seg) || /^\d+\s*(?:h|hr|hrs|hours?|heures?)\.?$/i.test(seg) || /\b(left|restant|reste)\b/i.test(seg)) {
      const v = duration(seg);
      if (v !== null) {
        out.remainingMin ??= v;
        continue;
      }
    }
    if (/^\d{1,2}\s*(?::|h)\s*\d{2}(\s*(am|pm))?$/i.test(seg)) {
      out.arrival ??= clock(seg);
      continue;
    }
    if (/\p{L}{2,}/u.test(seg)) words.push(seg);
  }
  const joined = words.join(', ');
  if (joined && INSTRUCTION.test(joined)) out.instruction = joined;
  return out;
}

/** Returns null when the notification carries nothing navigation-like (e.g. Waze's idle "running" notification). */
export function parseExternalNav(raw: ExternalNavRaw): ExternalNavUpdate | null {
  const fields = [raw.title, raw.text, raw.subText, raw.bigText].map((f) => (f ?? '').trim());
  const parsed = fields.map(parseField);
  let remainingMin: number | null = null;
  let remainingKm: number | null = null;
  let arrival: string | null = null;
  let instruction: string | null = null;
  let maneuverKm: number | null = null;
  // The trip summary is the field holding a duration or an arrival time; a distance there is the remaining distance.
  for (const p of parsed) {
    const summary = p.remainingMin !== null || p.arrival !== null;
    if (summary) {
      remainingMin ??= p.remainingMin;
      arrival ??= p.arrival;
      if (remainingKm === null && p.dists.length) remainingKm = round1(p.dists[p.dists.length - 1]!);
    } else if (maneuverKm === null && p.dists.length) {
      maneuverKm = p.dists[0]!;
    }
    if (instruction === null && !summary) instruction = p.instruction;
  }
  if (instruction === null) instruction = parsed.find((p) => p.instruction)?.instruction ?? null;
  if (remainingMin === null && arrival === null && instruction === null) return null;
  const nextInstruction =
    instruction === null ? null : maneuverKm === null ? instruction : `${formatManeuver(maneuverKm)} · ${instruction}`;
  return { app: raw.app, remainingMin, remainingKm, arrival, nextInstruction, t: raw.t };
}

function formatManeuver(km: number): string {
  if (km < 1) return `${Math.round((km * 1000) / 10) * 10} m`;
  return `${round1(km)} km`;
}

/** Arrival epoch ms from a parsed update: remaining time when given, else the next occurrence of the clock time. */
export function externalArrivalMs(u: ExternalNavUpdate, now: number = u.t): number | null {
  if (u.remainingMin !== null) return now + u.remainingMin * 60_000;
  if (!u.arrival) return null;
  const [h, m] = u.arrival.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() < now - 5 * 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}
