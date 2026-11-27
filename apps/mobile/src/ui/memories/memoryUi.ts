import { useMemo } from 'react';
import { lang, t } from '@crewmap/shared/i18n';
import type { Highlight } from '@crewmap/shared/memories';
import { EMOTE_EMOJI } from '@crewmap/shared/emotes';
import { formatKm, formatMinutes, formatSpeed } from '@crewmap/shared/units';
import { DEFAULT_AVATAR, DEFAULT_CAR, type AvatarConfig, type CarConfig } from '@crewmap/shared/avatar';
import { useApp } from '../../core/store';
import { dateLocale } from '../charts';
import type { IconName } from '../kitIcons';

/** One colour per person on a recap (me first). */
export const MEMBER_COLORS = ['#4F5BFF', '#FF5A6A', '#14B8A6', '#FFC233', '#8E44AD', '#FB8C00', '#2EC4B6', '#E5484D'] as const;
export const colorAt = (i: number): string => MEMBER_COLORS[i % MEMBER_COLORS.length]!;

export interface Person {
  id: string;
  name: string;
  avatar: AvatarConfig;
  car: CarConfig;
  me: boolean;
}

/** Names and looks for ids on a memory (a crewmate who left the crew shows as an unnamed default). */
export function usePeople(ids: readonly string[]): Record<string, Person> {
  const friends = useApp((s) => s.allFriends);
  const me = useApp((s) => s.me);
  return useMemo(() => {
    const out: Record<string, Person> = {};
    for (const id of ids) {
      if (me && id === me.deviceId) out[id] = { id, name: t('mem.you'), avatar: me.avatar, car: me.car, me: true };
      else {
        const p = friends[id]?.profile;
        out[id] = { id, name: p?.name ?? '—', avatar: p?.avatar ?? DEFAULT_AVATAR, car: p?.car ?? DEFAULT_CAR, me: false };
      }
    }
    return out;
  }, [ids.join(','), friends, me]);
}

export const HL_ICON: Record<Highlight['kind'], IconName> = {
  distance: 'road',
  duration: 'clock',
  topSpeed: 'speed',
  farthest: 'compass',
  stops: 'pin',
  hype: 'flame',
  photos: 'camera',
  crew: 'users',
  nightOwl: 'owl',
  earlyBird: 'sunrise',
};

/** Value line of a highlight. */
export function hlValue(h: Highlight): string {
  const l = lang();
  switch (h.kind) {
    case 'distance':
    case 'farthest':
      return formatKm(h.value, l);
    case 'duration':
      return formatMinutes(h.value * 60);
    case 'topSpeed':
      return formatSpeed(h.value, l);
    case 'nightOwl':
    case 'earlyBird':
      return `${String(h.value).padStart(2, '0')}:00`;
    default:
      return String(h.value);
  }
}

export const hlLabel = (h: Highlight, who: string | null): string => (who ? t(`mem.hl.${h.kind}.who`, { name: who }) : t(`mem.hl.${h.kind}`));

export const emojiOf = (preset: string): string => (EMOTE_EMOJI as Record<string, string>)[preset] ?? '✨';

/** "Saturday 4 July" style title for an untitled memory. */
export const memoryDate = (t0: number): string => new Date(t0).toLocaleDateString(dateLocale(lang()), { weekday: 'long', day: 'numeric', month: 'long' });

export const memoryTitle = (m: { title?: string; start: number }): string => m.title ?? memoryDate(m.start);
