/** Pure messaging notice logic: in-app chat bubble policy, the bubble stack, and system-notification grouping. */

/** Same values as the app's FriendContext (ui/drive/driveUx). */
export type FriendContext = 'browse' | 'driveStopped' | 'driveMoving';

export type BlipKind = 'chat1' | 'chatCrew' | 'quip' | 'emote';
export type BlipAction = 'bubble' | 'tiny' | 'silent';

export interface BlipInput {
  ctx: FriendContext;
  kind: BlipKind;
  /** The conversation is on screen (chat screen open, app foreground). */
  viewing: boolean;
  /** The sender is muted (friend, crew or ride mute). */
  muted: boolean;
  /** Emotes only: the emote overlay already showed it. */
  overlayShown?: boolean;
}

/**
 * What an incoming message does in-app. Browsing: a bubble. Driving: a tiny bubble for 1:1 messages only (never
 * blocking, no sound); crew chatter and quips stay silent until stopped. Emotes get a bubble only when the overlay did
 * not render them.
 */
export function inAppBlipPolicy(i: BlipInput): BlipAction {
  if (i.viewing || i.muted) return 'silent';
  if (i.kind === 'emote' && i.overlayShown) return 'silent';
  if (i.ctx === 'browse') return 'bubble';
  if (i.ctx === 'driveStopped') return 'tiny';
  return i.kind === 'chat1' ? 'tiny' : 'silent';
}

export const BLIP = { max: 3, ttlMs: 5000 } as const;

export interface Blip {
  /** Conversation key (thread); one bubble per conversation. */
  id: string;
  from: string;
  name: string;
  kind: BlipKind;
  tiny: boolean;
  count: number;
  at: number;
}

/** Adds a message to the bubble stack: same conversation moves to the front with its count bumped. Newest first. */
export function pushBlip(list: readonly Blip[], b: Omit<Blip, 'count'>): Blip[] {
  const prev = list.find((x) => x.id === b.id);
  const rest = list.filter((x) => x.id !== b.id);
  return [{ ...b, tiny: prev ? prev.tiny && b.tiny : b.tiny, count: (prev?.count ?? 0) + 1 }, ...rest];
}

/** Drops bubbles older than the TTL. */
export function expireBlips(list: readonly Blip[], now: number, ttlMs: number = BLIP.ttlMs): Blip[] {
  return list.filter((b) => now - b.at < ttlMs);
}

/** Visible bubbles and the hidden remainder ('+N'). */
export function visibleBlips(list: readonly Blip[], max: number = BLIP.max): { shown: Blip[]; more: number } {
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/** Stable notification identifier per conversation, so new messages replace (update) one notification. */
export function notifIdFor(kind: 'chat' | 'emote', key: string, preset?: string): string {
  return kind === 'chat' ? `chat:${key}` : `emote:${key}:${preset ?? ''}`;
}

export interface ChatNotif {
  title: string;
  body: string;
}

/**
 * Collapsed chat notification: one per conversation. With several unread, the title carries the count; the body is
 * the newest text, or a neutral line when previews are hidden.
 */
export function chatNotif(
  o: { title: string; text: string; unread: number; hidePreview: boolean },
  tr: { count: (n: number) => string; hidden: string },
): ChatNotif {
  const title = o.unread > 1 ? `${o.title} (${o.unread})` : o.title;
  const body = o.hidePreview ? (o.unread > 1 ? tr.count(o.unread) : tr.hidden) : o.text;
  return { title, body };
}
