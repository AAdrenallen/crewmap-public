/**
 * Avatar + car configuration (F8). Part ids match the Blender pipeline (tools/blender/parts.py); the sprite atlas is
 * keyed by these ids. Stored as JSON in the circle doc (profiles) and composed into sprites per heading.
 */
import { normalizeCarStyle, normalizeStyle, type AvatarStyle, type CarStyle } from './avatarStyle';

export * from './avatarStyle';

export const AVATAR_PARTS = {
  body: ['slim', 'regular', 'broad', 'curvy'],
  skin: ['#F9D7C3', '#EFC09A', '#D99E73', '#B97A50', '#8D5A3B', '#5E3A26'],
  // Append only: ids are stored in profiles; older builds map unknown ids to the default (normalizeAvatar).
  hair: ['none', 'buzz', 'short', 'curly', 'bob', 'long', 'bun', 'mohawk', 'afro', 'ponytail', 'fade', 'wavy', 'pigtails', 'braids', 'slicked', 'quiff', 'mullet', 'spiky', 'sidePart', 'pixie', 'dreads', 'bowl', 'spaceBuns', 'undercut', 'topKnot', 'cornrows'],
  hairColor: ['#1F1A17', '#4A3020', '#8B5A2B', '#D8B26E', '#C0392B', '#9AA0A6', '#7E57C2', '#26A69A'],
  face: ['smile', 'grin', 'cool', 'wink', 'calm', 'surprised'],
  top: ['tee', 'hoodie', 'jacket', 'tank', 'sweater', 'jersey'],
  topColor: ['#5B6CFF', '#FF6B6B', '#FFC845', '#2EC4B6', '#1F2937', '#F5F5F5', '#8E44AD', '#27AE60'],
  bottom: ['jeans', 'shorts', 'skirt', 'joggers', 'cargo', 'bootcut', 'skinny', 'baggy', 'leggings', 'overalls', 'pleated', 'kilt', 'capri', 'flares', 'harem', 'chinos', 'bikeshorts', 'boardshorts', 'cutoffs', 'palazzo'],
  bottomColor: ['#2C3E70', '#1F2937', '#6B4F3A', '#9AA0A6', '#3D7A4C', '#B03A48'],
  shoes: ['sneakers', 'boots', 'sandals', 'hightops', 'loafers', 'clogs', 'slippers'],
  shoeColor: ['#F5F5F5', '#1F2937', '#E53935', '#1E88E5', '#8B5A2B', '#FDD835', '#43A047', '#8E44AD'],
  /** Sole, laces and trims. */
  shoeColor2: ['#1F2937', '#F5F5F5', '#FF6B6B', '#FFC845', '#2EC4B6', '#9AA0A6'],
  hat: ['none', 'cap', 'beanie', 'bucket', 'tuque', 'crown', 'backCap', 'cowboy', 'topHat', 'party', 'chef', 'viking', 'pirate', 'hardHat', 'propeller', 'catEars', 'sombrero', 'wizard', 'beret', 'headband'],
  hatColor: ['#FF6B6B', '#1F2937', '#5B6CFF', '#FFC845', '#F5F5F5', '#8B5A2B', '#27AE60', '#8E44AD'],
  glasses: ['none', 'round', 'square', 'shades', 'visor', 'boxed', 'wire', 'aviator', 'slim', 'cyber', 'heart', 'star', 'paper3d', 'monocle', 'nerd', 'goggles', 'pixel', 'steampunk', 'catEye'],
  /** Frames (lenses keep their own tint). */
  glassesColor: ['#1F1A17', '#C9A227', '#9AA0A6', '#B03A48', '#1E88E5', '#F5F5F5'],
  /** The "Extra" slot (wire key stays `accessory`). */
  accessory: ['none', 'backpack', 'scarf', 'headphones', 'chain', 'cape', 'earrings', 'bandana', 'mask', 'facePaint', 'freckles', 'beard', 'goatee', 'moustache', 'handlebar', 'scar', 'bowTie', 'tie', 'pearls', 'wings', 'halo', 'antennae', 'tail', 'eyePatch', 'blush', 'horns'],
  extraColor: ['#FF6B6B', '#4A3020', '#FFC845', '#5B6CFF', '#F5F5F5', '#1F2937', '#2EC4B6', '#8E44AD'],
} as const;

/**
 * Rides (the wire field stays `car` so older peers keep parsing profiles). Ids match the Blender pipeline's
 * `car_<id>` nodes and its manifest `rides` entries (seat, scale, rider pose). Append only.
 */
export const CARS = ['compact', 'hatchback', 'pickup', 'suv', 'sports', 'van', 'convertible', 'motorcycle', 'hotdog', 'skateboard', 'scooter', 'rocket', 'cart', 'bathtub', 'carpet'] as const;
export const CAR_COLORS = ['#E53935', '#1E88E5', '#FDD835', '#43A047', '#F5F5F5', '#212121', '#FB8C00', '#8E24AA'] as const;

export type AvatarPartKey = keyof typeof AVATAR_PARTS;
/** Palette parts plus free colours and finishes (see avatarStyle.ts). */
export type AvatarConfig = { [K in AvatarPartKey]: (typeof AVATAR_PARTS)[K][number] } & AvatarStyle;
export type CarModel = (typeof CARS)[number];
export interface CarConfig extends CarStyle {
  model: CarModel;
  /** Nearest palette entry of the paint (older builds read only this); the exact paint is `hex`. */
  color: (typeof CAR_COLORS)[number];
}

export const DEFAULT_AVATAR: AvatarConfig = {
  body: 'regular',
  skin: '#D99E73',
  hair: 'short',
  hairColor: '#4A3020',
  face: 'smile',
  top: 'hoodie',
  topColor: '#5B6CFF',
  bottom: 'jeans',
  bottomColor: '#2C3E70',
  shoes: 'sneakers',
  shoeColor: '#F5F5F5',
  shoeColor2: '#1F2937',
  hat: 'none',
  hatColor: '#FF6B6B',
  glasses: 'none',
  glassesColor: '#1F1A17',
  accessory: 'none',
  extraColor: '#FF6B6B',
};

export const DEFAULT_CAR: CarConfig = { model: 'hatchback', color: '#1E88E5' };

/**
 * A ride read from the shared doc. Newer peers may send ids this build does not know: keep a valid colour and fall
 * back to the default model rather than failing the sprite bake.
 */
export function normalizeCar(v: unknown): CarConfig {
  if (!v || typeof v !== 'object') return DEFAULT_CAR;
  const o = v as Record<string, unknown>;
  const model = (CARS as readonly unknown[]).includes(o.model) ? (o.model as CarModel) : DEFAULT_CAR.model;
  const color = (CAR_COLORS as readonly unknown[]).includes(o.color) ? (o.color as CarConfig['color']) : DEFAULT_CAR.color;
  return { model, color, ...normalizeCarStyle(o, color) };
}

/**
 * The single read path for a stored avatar: each part falls back to its default on its own (a newer peer's unknown
 * ids, a field an older build never wrote); free colours and finishes are clamped. Fixed key order, so equal looks
 * serialise (and hash to sprite sheets) identically.
 */
export function normalizeAvatar(v: unknown): AvatarConfig {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const cfg = {} as Record<AvatarPartKey, string>;
  for (const k of Object.keys(AVATAR_PARTS) as AvatarPartKey[]) {
    const opts = AVATAR_PARTS[k] as readonly string[];
    cfg[k] = opts.includes(o[k] as string) ? (o[k] as string) : DEFAULT_AVATAR[k];
  }
  const parts = cfg as unknown as AvatarConfig;
  return { ...parts, ...normalizeStyle(o, parts) };
}

/** Sprite cache identity of a look (canonical JSON: includes free colours and finishes). */
export function avatarKey(cfg: AvatarConfig): string {
  return JSON.stringify(normalizeAvatar(cfg));
}

export function rideKey(avatar: AvatarConfig, car: CarConfig): string {
  return JSON.stringify([normalizeAvatar(avatar), normalizeCar(car)]);
}

export function isAvatarConfig(v: unknown): v is AvatarConfig {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (Object.keys(AVATAR_PARTS) as AvatarPartKey[]).every((k) => (AVATAR_PARTS[k] as readonly string[]).includes(o[k] as string));
}

/** 16 headings for sprites. */
export const SPRITE_HEADINGS = 16;

export function headingFrame(headingDeg: number | null, mapBearingDeg = 0): number {
  if (headingDeg === null) return 0;
  const rel = (((headingDeg - mapBearingDeg) % 360) + 360) % 360;
  return Math.round(rel / (360 / SPRITE_HEADINGS)) % SPRITE_HEADINGS;
}

/** Random but tasteful starting avatar (onboarding "shuffle"). */
export function randomAvatar(rnd: () => number = Math.random): AvatarConfig {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  return {
    body: pick(AVATAR_PARTS.body),
    skin: pick(AVATAR_PARTS.skin),
    hair: pick(AVATAR_PARTS.hair),
    hairColor: pick(AVATAR_PARTS.hairColor),
    face: pick(AVATAR_PARTS.face),
    top: pick(AVATAR_PARTS.top),
    topColor: pick(AVATAR_PARTS.topColor),
    bottom: pick(AVATAR_PARTS.bottom),
    bottomColor: pick(AVATAR_PARTS.bottomColor),
    shoes: pick(AVATAR_PARTS.shoes),
    shoeColor: pick(AVATAR_PARTS.shoeColor),
    shoeColor2: pick(AVATAR_PARTS.shoeColor2),
    hat: rnd() < 0.6 ? 'none' : pick(AVATAR_PARTS.hat),
    hatColor: pick(AVATAR_PARTS.hatColor),
    glasses: rnd() < 0.6 ? 'none' : pick(AVATAR_PARTS.glasses),
    glassesColor: pick(AVATAR_PARTS.glassesColor),
    accessory: rnd() < 0.7 ? 'none' : pick(AVATAR_PARTS.accessory),
    extraColor: pick(AVATAR_PARTS.extraColor),
  };
}
