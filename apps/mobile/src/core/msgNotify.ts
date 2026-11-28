import { AppState } from 'react-native';
import { create } from 'zustand';
import { BLIP, blipPreview, expireBlips, inAppBlipPolicy, notifIdFor, pushBlip, type Blip, type BlipKind } from '@crewmap/shared/messaging';
import { t } from '@crewmap/shared/i18n';
import { collapseEmote, type EmoteCollapse } from '@crewmap/shared/emoteSuggest';
import { friendContextNow } from './friendContext';
import { notify } from './notify';

/**
 * Message notices: the in-app chat bubble stack and collapsed system notifications for repeated emotes.
 * Mutes (friend, crew and, once `rideMutes` lands in packages/shared, ride mutes) are applied by callers via `muted`.
 */
interface BlipState {
  blips: Blip[];
  /** Currently expanded mini-chat popover; paused from expiry and closed when tapping outside. */
  active: Blip | null;
  push: (b: Omit<Blip, 'count'>) => void;
  open: (b: Blip) => void;
  close: () => void;
  dismiss: (id: string) => void;
  expire: (now: number) => void;
}

export const useBlips = create<BlipState>((set) => ({
  blips: [],
  active: null,
  push: (b) =>
    set((s) => {
      const next = pushBlip(expireBlips(s.blips, b.at, BLIP.uiTtlMs), b);
      const active = s.active?.id === b.id ? (next.find((x) => x.id === b.id) ?? s.active) : s.active;
      return { blips: next, active };
    }),
  open: (b) => set({ active: b }),
  close: () =>
    set((s) => ({
      active: null,
      blips: s.active ? s.blips.filter((x) => x.id !== s.active!.id) : s.blips,
    })),
  dismiss: (id) =>
    set((s) => ({
      blips: s.blips.filter((x) => x.id !== id),
    })),
  expire: (now) =>
    set((s) => {
      const keepId = s.active?.id;
      const should = s.blips.some((x) => x.id !== keepId && now - x.at >= BLIP.uiTtlMs);
      if (!should) return s;
      return { blips: s.blips.filter((x) => x.id === keepId || now - x.at < BLIP.uiTtlMs) };
    }),
}));

/** Shows a bubble for an incoming message when the policy allows it. `muted` = friend/crew/ride mute already applied. */
export function blipFor(o: { thread: string; from: string; name: string; kind: BlipKind; viewing: boolean; muted: boolean; overlayShown?: boolean; preview?: string }): void {
  const { ctx } = friendContextNow();
  const a = inAppBlipPolicy({ ctx, kind: o.kind, viewing: o.viewing, muted: o.muted, ...(o.overlayShown !== undefined ? { overlayShown: o.overlayShown } : {}) });
  if (a === 'silent') return;
  const snippet = o.preview ? blipPreview(o.preview) : undefined;
  useBlips.getState().push({
    id: o.thread,
    from: o.from,
    name: o.name,
    kind: o.kind,
    tiny: a === 'tiny',
    at: Date.now(),
    ...(snippet ? { preview: snippet } : {}),
  });
}

const emoteCounts = new Map<string, EmoteCollapse>();

/**
 * Emotes from one friend collapse into one updating heads-up notification per sender ("Alex sent you 5 emotes 💭🚗"),
 * whatever the preset; the latest preset rides in `data` for "Send back".
 */
export function notifyEmoteCollapsed(o: { from: string; name: string; preset: string; emoji: string; label: string; silent: boolean }): Promise<void> {
  const id = notifIdFor('emote', o.from);
  const c = collapseEmote(emoteCounts.get(id), o.emoji);
  emoteCounts.set(id, c);
  const title = c.count > 1 ? t('notif.emoteMany', { name: o.name, count: String(c.count), emoji: c.emoji }) : t('notif.emote', { name: o.name, emote: o.label });
  return notify(title, '', { channel: 'circle', silent: o.silent, identifier: id, data: { type: 'emote', friendId: o.from, preset: o.preset } });
}

/** Reset collapsed counts (app came to the foreground: the notifications were seen). */
export function resetEmoteCounts(): void {
  emoteCounts.clear();
}

AppState.addEventListener('change', (st) => {
  if (st === 'active') resetEmoteCounts();
});
