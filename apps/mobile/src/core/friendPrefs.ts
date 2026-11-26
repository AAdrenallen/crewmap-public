import { create } from 'zustand';
import { fromUtf8 } from '@crewmap/p2p';
import type { EmoteMessage } from '@crewmap/shared/emotes';
import { appendLog, cityCacheKey, type FriendEvent } from '@crewmap/shared/friend';
import { kvGet, kvSet } from './db';
import { reverseCity } from './mapbox';

const MUTE_KEY = 'friendMute';
const ASK_MUTE_KEY = 'askMute';
const EVENT_MAX = 40;
const EMOTE_MAX = 20;

/** An emote exchanged with a friend (kept per friend, on this device only). */
export interface EmoteLogEntry {
  preset: EmoteMessage['preset'];
  mine: boolean;
  t: number;
  ok: boolean;
}

interface PrefsState {
  loaded: boolean;
  muted: Record<string, true>;
  /** Friends whose location asks (D47) are dropped silently. */
  askMuted: Record<string, true>;
  events: Record<string, FriendEvent[]>;
  emotes: Record<string, EmoteLogEntry[]>;
}

export const useFriendPrefs = create<PrefsState>(() => ({ loaded: false, muted: {}, askMuted: {}, events: {}, emotes: {} }));

const eventKey = (id: string) => `friendEvents:${id}`;
const emoteKey = (id: string) => `emoteLog:${id}`;

export function isMuted(id: string): boolean {
  return !!useFriendPrefs.getState().muted[id];
}

export function isAskMuted(id: string): boolean {
  return !!useFriendPrefs.getState().askMuted[id];
}

export async function loadMuted(): Promise<void> {
  const [muted, askMuted] = await Promise.all([kvGet<Record<string, true>>(MUTE_KEY, {}), kvGet<Record<string, true>>(ASK_MUTE_KEY, {})]);
  useFriendPrefs.setState({ muted, askMuted, loaded: true });
}

export async function setAskMuted(id: string, on: boolean): Promise<void> {
  const { [id]: _drop, ...rest } = useFriendPrefs.getState().askMuted;
  const askMuted: Record<string, true> = on ? { ...rest, [id]: true } : rest;
  useFriendPrefs.setState({ askMuted });
  await kvSet(ASK_MUTE_KEY, askMuted);
}

export async function setMuted(id: string, on: boolean): Promise<void> {
  const { [id]: _drop, ...rest } = useFriendPrefs.getState().muted;
  const muted: Record<string, true> = on ? { ...rest, [id]: true } : rest;
  useFriendPrefs.setState({ muted, loaded: true });
  await kvSet(MUTE_KEY, muted);
}

export async function loadFriendLogs(id: string): Promise<void> {
  const [events, emotes] = await Promise.all([kvGet<FriendEvent[]>(eventKey(id), []), kvGet<EmoteLogEntry[]>(emoteKey(id), [])]);
  useFriendPrefs.setState((s) => ({ events: { ...s.events, [id]: events }, emotes: { ...s.emotes, [id]: emotes } }));
}

export async function logFriendEvent(id: string, e: FriendEvent): Promise<void> {
  const cur = useFriendPrefs.getState().events[id] ?? (await kvGet<FriendEvent[]>(eventKey(id), []));
  const next = appendLog(cur, e, EVENT_MAX, (a, b) => a.t === b.t && a.placeId === b.placeId && a.kind === b.kind);
  useFriendPrefs.setState((s) => ({ events: { ...s.events, [id]: next } }));
  await kvSet(eventKey(id), next);
}

export async function logEmote(id: string, e: EmoteLogEntry): Promise<void> {
  const cur = useFriendPrefs.getState().emotes[id] ?? (await kvGet<EmoteLogEntry[]>(emoteKey(id), []));
  const next = appendLog(cur, e, EMOTE_MAX);
  useFriendPrefs.setState((s) => ({ emotes: { ...s.emotes, [id]: next } }));
  await kvSet(emoteKey(id), next);
}

let attachedTo: object | null = null;
let offs: (() => void)[] = [];

/** Starts recording shared arrivals/departures and received emotes, and loads the mute list. Idempotent per router. */
export function attachFriendLog(r: { on: (kind: 'arrival' | 'emote', h: (m: { sender: string; payload: Uint8Array }) => void) => () => void }): void {
  if (attachedTo === r) return;
  for (const o of offs) o();
  attachedTo = r;
  void loadMuted().catch(() => undefined);
  offs = [
    r.on('arrival', (m) => {
      try {
        const a = JSON.parse(fromUtf8(m.payload)) as { placeId: string; placeName: string; kind: FriendEvent['kind']; t?: number };
        void logFriendEvent(m.sender, { placeId: a.placeId, placeName: a.placeName, kind: a.kind, t: a.t ?? Date.now() }).catch(() => undefined);
      } catch {
        /* malformed payload: ignore */
      }
    }),
    r.on('emote', (m) => {
      try {
        const e = JSON.parse(fromUtf8(m.payload)) as EmoteMessage;
        void logEmote(m.sender, { preset: e.preset, mine: false, t: Date.now(), ok: true }).catch(() => undefined);
      } catch {
        /* malformed payload: ignore */
      }
    }),
  ];
}

const cities = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Reverse-geocoded city for a position, cached per ~1 km cell for the session (null when unknown/offline). */
export function cityFor(p: { lat: number; lng: number }): Promise<string | null> {
  const k = cityCacheKey(p);
  if (cities.has(k)) return Promise.resolve(cities.get(k) ?? null);
  const pending = inflight.get(k);
  if (pending) return pending;
  const run = reverseCity(p)
    .then((c) => {
      cities.set(k, c);
      return c;
    })
    .catch(() => null)
    .finally(() => inflight.delete(k));
  inflight.set(k, run);
  return run;
}
