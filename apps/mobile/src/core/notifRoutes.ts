/** Pure notification routing: what a notification (or one of its action buttons) opens or does. No platform imports. */

export type NotifType = 'emote' | 'chat' | 'arrival' | 'departure' | 'hazard' | 'trip' | 'moment' | 'crash' | 'driveAlong' | 'friendAlert' | 'parked';

/** Safety check-in (D66): my own "are you OK?" ask, and a crewmate's unanswered one. */
export type CheckInNotifType = 'checkIn' | 'checkInAlert';
const CHECK_IN_TYPES: readonly string[] = ['checkIn', 'checkInAlert'];

export interface NotifData {
  type?: NotifType | CheckInNotifType;
  friendId?: string;
  hazardId?: string;
  tripId?: string;
  placeId?: string;
  chatId?: string;
  /** Emote preset, for "send back". */
  preset?: string;
  placeName?: string;
}

export const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
export const ACTION = { reply: 'reply', markRead: 'markRead', navigate: 'navigate', sendBack: 'sendBack', pingThink: 'pingThink', pingOmw: 'pingOmw', imOk: 'imOk' } as const;
/** Quick pings offered on every emote notification next to "Send back" (Android shows at most 3 buttons). */
export const PING_ACTIONS: Record<string, string> = { [ACTION.pingThink]: 'thinkingOfYou', [ACTION.pingOmw]: 'onMyWay' };
export const CATEGORY = { chat: 'chat', arrival: 'arrival', emote: 'emote', checkIn: 'checkIn' } as const;

const TYPES: readonly string[] = ['emote', 'chat', 'arrival', 'departure', 'hazard', 'trip', 'moment', 'crash', 'driveAlong', 'friendAlert', 'parked'];
const KEYS = ['friendId', 'hazardId', 'tripId', 'placeId', 'chatId', 'preset', 'placeName'] as const;

/** Narrows an untyped notification payload to NotifData (string fields only). */
export function readData(raw: unknown): NotifData {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: NotifData = {};
  if (typeof r.type === 'string' && (TYPES.includes(r.type) || CHECK_IN_TYPES.includes(r.type))) out.type = r.type as NotifData['type'];
  for (const k of KEYS) {
    const v = r[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

const seg = (id: string) => encodeURIComponent(id);

/** Screen opened by tapping the notification body, or null when there is nowhere to go. */
export function routeFor(d: NotifData): string | null {
  switch (d.type) {
    case 'chat':
      return d.chatId ? `/chat/${seg(d.chatId)}` : d.friendId ? `/chat/${seg(d.friendId)}` : null;
    case 'hazard':
      return d.hazardId ? `/hazard/${seg(d.hazardId)}` : null;
    case 'trip':
      return d.tripId ? `/trips/${seg(d.tripId)}` : null;
    case 'arrival':
    case 'departure':
      return d.friendId ? `/friend/${seg(d.friendId)}` : d.placeId ? `/place/${seg(d.placeId)}` : null;
    case 'driveAlong':
      return '/drive-along';
    case 'parked':
      return '/parked';
    case 'emote':
    case 'moment':
    case 'friendAlert':
    case 'checkInAlert':
      return d.friendId ? `/friend/${seg(d.friendId)}` : null;
    default:
      return null;
  }
}

/** Action-button category a notification needs, if any. */
export function categoryFor(d: NotifData): string | undefined {
  if (d.type === 'chat' && d.chatId) return CATEGORY.chat;
  if (d.type === 'checkIn' || d.type === 'crash') return CATEGORY.checkIn;
  if (d.type === 'arrival' && d.friendId) return CATEGORY.arrival;
  if (d.type === 'emote' && d.friendId && d.preset && d.preset !== 'custom') return CATEGORY.emote;
  return undefined;
}

export function navigatePath(name: string, lat: number, lng: number): string {
  return `/route?name=${encodeURIComponent(name)}&lat=${lat}&lng=${lng}`;
}

export type NotifCommand =
  | { kind: 'open'; path: string }
  | { kind: 'reply'; chatId: string; text: string }
  | { kind: 'markRead'; chatId: string }
  | { kind: 'navigate'; friendId: string; placeName: string }
  | { kind: 'sendBack'; friendId: string; preset: string }
  | { kind: 'checkInOk' };

/** Maps a notification response (tap or action button) to what the app should do. */
export function commandFor(actionId: string, d: NotifData, userText?: string): NotifCommand | null {
  if (actionId === ACTION.reply && d.chatId) {
    const text = userText?.trim();
    return text ? { kind: 'reply', chatId: d.chatId, text } : { kind: 'open', path: `/chat/${seg(d.chatId)}` };
  }
  if (actionId === ACTION.markRead && d.chatId) return { kind: 'markRead', chatId: d.chatId };
  if (actionId === ACTION.imOk && (d.type === 'checkIn' || d.type === 'crash')) return { kind: 'checkInOk' };
  if (actionId === ACTION.navigate && d.friendId) return { kind: 'navigate', friendId: d.friendId, placeName: d.placeName ?? '' };
  if (PING_ACTIONS[actionId] && d.friendId) return { kind: 'sendBack', friendId: d.friendId, preset: PING_ACTIONS[actionId] };
  if (actionId === ACTION.sendBack && d.friendId && d.preset && d.preset !== 'custom') return { kind: 'sendBack', friendId: d.friendId, preset: d.preset };
  const path = routeFor(d);
  return path ? { kind: 'open', path } : null;
}
