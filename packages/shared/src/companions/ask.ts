/**
 * Location asks (D47), pure. Two kinds over one wire kind ('where-ask', sealed to one recipient):
 * - 'where': "where do you want me?" The recipient answers with a place and a short note; the asker gets a
 *   ready-to-navigate destination card.
 * - 'once': "share your location once". The recipient may share a precise fix that expires; it bypasses the standing
 *   crew policy for this one request only and never outlives its expiry on either side.
 */

export const ASK = {
  /** Same pair + same kind: at most this often (sender refuses, receiver drops). */
  cooldownMs: 10 * 60_000,
  /** An unanswered ask lapses after this (also the relay TTL of the message). */
  pendingMs: 30 * 60_000,
  /** A where-answer stays as a card this long unless dismissed. */
  cardMs: 6 * 3_600_000,
  /** One-time share durations offered to the recipient (minutes). */
  onceMinutes: [15, 60, 240] as readonly number[],
  /** Hard cap on how long a received share is honoured. */
  maxShareMs: 4 * 3_600_000,
  noteMax: 80,
  placeMax: 60,
  /** Tolerated clock skew when a share arrives. */
  skewMs: 2 * 60_000,
} as const;

export type AskKind = 'where' | 'once';

export interface AskPlace {
  name: string;
  lat: number;
  lng: number;
}

export type AskOp =
  | { v: 1; op: 'ask'; id: string; ask: AskKind; t: number }
  | { v: 1; op: 'answer'; id: string; place: AskPlace; note?: string; t: number }
  | { v: 1; op: 'share'; id: string; lat: number; lng: number; acc: number; t: number; until: number }
  | { v: 1; op: 'decline'; id: string; t: number };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const validLat = (n: unknown): n is number => finite(n) && n >= -90 && n <= 90;
const validLng = (n: unknown): n is number => finite(n) && n >= -180 && n <= 180;

export function parseAskOp(raw: unknown): AskOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64 || !finite(o.t)) return null;
  const id = o.id;
  const t = o.t;
  switch (o.op) {
    case 'ask':
      return o.ask === 'where' || o.ask === 'once' ? { v: 1, op: 'ask', id, ask: o.ask, t } : null;
    case 'answer': {
      const p = o.place as Record<string, unknown> | undefined;
      if (!p || typeof p.name !== 'string' || !validLat(p.lat) || !validLng(p.lng)) return null;
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, ASK.noteMax) : '';
      return { v: 1, op: 'answer', id, place: { name: p.name.slice(0, ASK.placeMax), lat: p.lat, lng: p.lng }, ...(note ? { note } : {}), t };
    }
    case 'share':
      if (!validLat(o.lat) || !validLng(o.lng) || !finite(o.acc) || !finite(o.until)) return null;
      return { v: 1, op: 'share', id, lat: o.lat, lng: o.lng, acc: Math.max(0, o.acc), t, until: o.until };
    case 'decline':
      return { v: 1, op: 'decline', id, t };
    default:
      return null;
  }
}

export type AskState = 'pending' | 'answered' | 'shared' | 'declined' | 'expired' | 'dismissed';

export interface AskEntry {
  id: string;
  /** 'out' = I asked; 'in' = someone asked me. */
  dir: 'out' | 'in';
  peer: string;
  ask: AskKind;
  state: AskState;
  /** When the ask was created (local clock). */
  t: number;
  /** Share expiry (ms epoch, my clock) once shared. */
  until?: number;
  place?: AskPlace;
  note?: string;
  /** Received one-time position (out + shared); removed at expiry. */
  loc?: { lat: number; lng: number; acc: number; t: number };
}

export type AskGate = 'ok' | 'pending' | 'cooldown';

/** May a new ask of this kind pass between me and `peer` in this direction? One pending per pair, then a cooldown. */
export function askGate(entries: readonly AskEntry[], dir: AskEntry['dir'], peer: string, ask: AskKind, now: number): AskGate {
  let gate: AskGate = 'ok';
  for (const e of entries) {
    if (e.dir !== dir || e.peer !== peer || e.ask !== ask) continue;
    if (e.state === 'pending' && now - e.t < ASK.pendingMs) return 'pending';
    // Once a 'where' ask was already answered, allow a follow-up if plans change without a 10-min lockout.
    if (ask === 'where' && (e.state === 'answered' || e.state === 'dismissed')) continue;
    if (now - e.t < ASK.cooldownMs) gate = 'cooldown';
  }
  return gate;
}

export function newAsk(entries: readonly AskEntry[], peer: string, ask: AskKind, id: string, now: number): { entries: AskEntry[]; gate: AskGate } {
  const gate = askGate(entries, 'out', peer, ask, now);
  if (gate !== 'ok') return { entries: [...entries], gate };
  return { entries: [...entries, { id, dir: 'out', peer, ask, state: 'pending', t: now }], gate };
}

export type AskEffect = 'prompt' | 'destination' | 'shared' | 'declined' | 'ignored';

/** Apply a received op. `muted` = I muted asks from this sender. Unknown / mismatched ops are ignored. */
export function receiveAsk(entries: readonly AskEntry[], from: string, op: AskOp, now: number, muted = false): { entries: AskEntry[]; effect: AskEffect } {
  const keep = (effect: AskEffect): { entries: AskEntry[]; effect: AskEffect } => ({ entries: [...entries], effect });
  if (op.op === 'ask') {
    if (muted || entries.some((e) => e.id === op.id)) return keep('ignored');
    if (askGate(entries, 'in', from, op.ask, now) !== 'ok') return keep('ignored');
    return { entries: [...entries, { id: op.id, dir: 'in', peer: from, ask: op.ask, state: 'pending', t: now }], effect: 'prompt' };
  }
  const i = entries.findIndex((e) => e.id === op.id && e.dir === 'out' && e.peer === from && e.state === 'pending');
  if (i < 0) return keep('ignored');
  const cur = entries[i]!;
  const set = (patch: Partial<AskEntry>, effect: AskEffect) => ({ entries: entries.map((e, k) => (k === i ? { ...e, ...patch } : e)), effect });
  if (op.op === 'decline') return set({ state: 'declined' }, 'declined');
  if (op.op === 'answer' && cur.ask === 'where') return set({ state: 'answered', place: op.place, ...(op.note ? { note: op.note } : {}) }, 'destination');
  if (op.op === 'share' && cur.ask === 'once') {
    // Honour at most maxShareMs from now, whatever the sender claims; an already-expired share is dropped.
    const until = Math.min(op.until, now + ASK.maxShareMs);
    if (until <= now) return keep('ignored');
    return set({ state: 'shared', until, loc: { lat: op.lat, lng: op.lng, acc: op.acc, t: Math.min(op.t, now + ASK.skewMs) } }, 'shared');
  }
  return keep('ignored');
}

/** My reply to an incoming ask: answered (with a place) / shared (until) / declined. Not pending any more -> no-op. */
export function resolveIncoming(entries: readonly AskEntry[], id: string, state: 'answered' | 'shared' | 'declined', patch: { place?: AskPlace; note?: string; until?: number } = {}): AskEntry[] {
  return entries.map((e) => (e.id === id && e.dir === 'in' && e.state === 'pending' ? { ...e, state, ...patch } : e));
}

export function dismissAsk(entries: readonly AskEntry[], id: string): AskEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, state: 'dismissed' as const } : e));
}

/** Expire stale entries: lapsed pendings, ended shares (position wiped), old cards; forget finished ones after the cooldown. */
export function expireAsks(entries: readonly AskEntry[], now: number): AskEntry[] {
  const out: AskEntry[] = [];
  for (const e of entries) {
    let x = e;
    if (x.state === 'pending' && now - x.t >= ASK.pendingMs) x = { ...x, state: 'expired' };
    else if (x.state === 'shared' && (x.until ?? 0) <= now) {
      const { loc: _loc, ...rest } = x;
      x = { ...rest, state: 'expired' };
    } else if (x.state === 'answered' && x.dir === 'out' && now - x.t >= ASK.cardMs) x = { ...x, state: 'expired' };
    const live = x.state === 'pending' || x.state === 'shared' || (x.state === 'answered' && x.dir === 'out');
    if (live || now - Math.max(x.t, x.until ?? 0) < ASK.cooldownMs) out.push(x);
  }
  return out;
}

export const incomingPrompts = (entries: readonly AskEntry[]): AskEntry[] => entries.filter((e) => e.dir === 'in' && e.state === 'pending');

export const destinationCards = (entries: readonly AskEntry[]): AskEntry[] => entries.filter((e) => e.dir === 'out' && e.state === 'answered' && !!e.place);

export interface OnceShare {
  peer: string;
  lat: number;
  lng: number;
  acc: number;
  t: number;
  until: number;
}

/** Positions currently shared with me once (not yet expired), newest per peer. */
export function activeOnceShares(entries: readonly AskEntry[], now: number): OnceShare[] {
  const m = new Map<string, OnceShare>();
  for (const e of entries) {
    if (e.dir !== 'out' || e.state !== 'shared' || !e.loc || (e.until ?? 0) <= now) continue;
    const cur = m.get(e.peer);
    if (!cur || e.loc.t >= cur.t) m.set(e.peer, { peer: e.peer, ...e.loc, until: e.until! });
  }
  return [...m.values()];
}

/** Whole minutes left (rounded up, at least 1) while active, else 0. */
export function minutesLeft(until: number, now: number): number {
  return until > now ? Math.max(1, Math.ceil((until - now) / 60_000)) : 0;
}

/** The share op to send for a chosen duration (minutes, clamped to the longest offered option). */
export function shareOp(id: string, fix: { lat: number; lng: number; acc: number }, minutes: number, now: number): Extract<AskOp, { op: 'share' }> {
  const max = Math.max(...ASK.onceMinutes);
  const m = Math.min(Math.max(1, minutes), max);
  return { v: 1, op: 'share', id, lat: fix.lat, lng: fix.lng, acc: fix.acc, t: now, until: now + m * 60_000 };
}
