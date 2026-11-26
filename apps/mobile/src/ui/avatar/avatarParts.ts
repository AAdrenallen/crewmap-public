import { AVATAR_PARTS, type AvatarConfig, type AvatarPartKey, type CarModel } from '@crewmap/shared/avatar';
import type { IconName } from '../kitIcons';

/**
 * Pure option lists for the avatar part picker (editor + onboarding). Each tab pairs a style with its colour, so
 * colours sit next to what they paint and every category fits on screen without a sideways tab scroller.
 */
export interface PartGroup {
  /** Tab id; also the i18n key suffix (`avatar.<tab>`) and testID suffix (`<prefix>-tab-<tab>`). */
  tab: AvatarPartKey;
  style: AvatarPartKey;
  color?: AvatarPartKey;
  /** Second colour of the same item (shoe soles, laces and trims). */
  color2?: AvatarPartKey;
}

export const PART_GROUPS: readonly PartGroup[] = [
  { tab: 'hair', style: 'hair', color: 'hairColor' },
  { tab: 'face', style: 'face' },
  { tab: 'body', style: 'body', color: 'skin' },
  { tab: 'top', style: 'top', color: 'topColor' },
  { tab: 'bottom', style: 'bottom', color: 'bottomColor' },
  { tab: 'shoes', style: 'shoes', color: 'shoeColor', color2: 'shoeColor2' },
  { tab: 'hat', style: 'hat', color: 'hatColor' },
  { tab: 'glasses', style: 'glasses', color: 'glassesColor' },
  { tab: 'accessory', style: 'accessory', color: 'extraColor' },
];

export function groupOf(tab: AvatarPartKey): PartGroup {
  return PART_GROUPS.find((g) => g.tab === tab) ?? PART_GROUPS[0]!;
}

export function partOptions(key: AvatarPartKey): readonly string[] {
  return AVATAR_PARTS[key] as readonly string[];
}

/** Config with one part changed; unknown values leave it as is. */
export function withPart(cfg: AvatarConfig, key: AvatarPartKey, value: string): AvatarConfig {
  if (!partOptions(key).includes(value) || cfg[key] === value) return cfg;
  return { ...cfg, [key]: value } as AvatarConfig;
}

/** Part ids are camelCase words: `hightops` -> `Hightops`, `bucketHat` -> `Bucket Hat`. */
export function optionLabel(v: string): string {
  return v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Whether a `#RRGGBB` swatch needs a dark check mark. */
export function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1, 7), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 160;
}

/** Ride picker glyph per vehicle (no per-ride bake: the live stage shows the real model). */
export const RIDE_ICON: Record<CarModel, IconName> = {
  compact: 'car',
  hatchback: 'car',
  pickup: 'rideTruck',
  suv: 'rideSuv',
  sports: 'rideSports',
  van: 'rideVan',
  convertible: 'rideConvertible',
  motorcycle: 'rideMoto',
  hotdog: 'rideHotdog',
  skateboard: 'rideSkate',
  scooter: 'rideScooter',
  rocket: 'rideRocket',
  cart: 'rideCart',
  bathtub: 'rideBath',
  carpet: 'rideCarpet',
};

/** Undo stack for shuffles: newest last, capped. */
export const UNDO_MAX = 10;
export function pushUndo<T>(stack: readonly T[], item: T, max = UNDO_MAX): T[] {
  const next = [...stack, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
