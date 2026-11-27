import { CLEAR_LENS, carColorOf, colorOf, finishOf, trimOf, type AvatarConfig, type CarConfig, type FinishId, type FinishItem, type TrimItem } from '@crewmap/shared/avatar';

/**
 * How a kit material is painted for one look (pure: no three.js, unit-tested). `tint` blends from the built-in colour
 * toward `color` (1 = replace); `opacity` < 1 renders it see-through (no depth write, like the car glass);
 * `glow` false drops a built-in emissive glow (a clear neon lens).
 */
export interface Look {
  color?: string;
  tint?: number;
  opacity?: number;
  glow?: boolean;
}
export type LookOf = (material: string) => Look | undefined;

/** Lens materials (build_assets.py `lens_*`). Dark lenses take the chosen colour strongly, light ones a soft tint. */
const DARK_LENS: ReadonlySet<string> = new Set(['lens_dark', 'lens_mirror', 'lens_neon']);
const TINTED_LENS: ReadonlySet<string> = new Set(['lens_tint', 'lens_pink', 'lens_amber', 'lens_red3d', 'lens_blue3d']);
export const LENS_TINT = { dark: 1, tinted: 0.6, clear: 0.3 } as const;
export const CLEAR_OPACITY = 0.25;
const CLEAR_GLASS = '#E8F4FF';

export function lensLook(material: string, lens: string | undefined): Look | undefined {
  const clearMat = material === 'lens_clear';
  if (!clearMat && !DARK_LENS.has(material) && !TINTED_LENS.has(material)) return undefined;
  if (lens === CLEAR_LENS) return { color: CLEAR_GLASS, tint: 1, opacity: CLEAR_OPACITY, glow: false };
  if (!lens) return clearMat ? { opacity: CLEAR_OPACITY } : undefined;
  if (clearMat) return { color: lens, tint: LENS_TINT.clear, opacity: CLEAR_OPACITY + 0.1 };
  return { color: lens, tint: DARK_LENS.has(material) ? LENS_TINT.dark : LENS_TINT.tinted };
}

/** Trim material prefix (build_assets.py `sub`) → trim item. */
const TRIM_PREFIX: Record<string, TrimItem> = { hair2: 'hair', top2: 'top', bottom2: 'bottom', hat2: 'hat', extra2: 'accessory' };

/** Auto accent of hair ties and hat bands when no trim colour is chosen (contrasts with the top). */
export const autoAccent = (cfg: AvatarConfig): string => (cfg.topColor === '#FF6B6B' ? '#5B6CFF' : '#FF6B6B');

export function avatarLook(cfg: AvatarConfig): LookOf {
  const main: Record<string, string> = {
    skin: colorOf(cfg, 'skin'),
    hair: colorOf(cfg, 'hairColor'),
    top: colorOf(cfg, 'topColor'),
    bottom: colorOf(cfg, 'bottomColor'),
    shoe: colorOf(cfg, 'shoeColor'),
    shoe2: colorOf(cfg, 'shoeColor2'),
    hat: colorOf(cfg, 'hatColor'),
    frame: colorOf(cfg, 'glassesColor'),
    extra: colorOf(cfg, 'extraColor'),
  };
  return (name) => {
    if (main[name]) return { color: main[name] };
    if (name.startsWith('lens_')) return lensLook(name, cfg.lens);
    const [prefix, rest] = name.split('_', 2) as [string, string | undefined];
    const item = TRIM_PREFIX[prefix];
    if (!item || !rest) return undefined;
    const trim = trimOf(cfg, item);
    if (trim) return { color: trim };
    return rest === 'accent' ? { color: autoAccent(cfg) } : undefined;
  };
}

/** Material names painted by each finish item. */
export const FINISH_MATERIALS: Record<FinishItem, readonly string[]> = {
  hair: ['hair'],
  top: ['top'],
  bottom: ['bottom'],
  shoes: ['shoe', 'shoe2'],
  hat: ['hat'],
  accessory: ['extra'],
  glasses: ['frame'],
};

export function avatarFinishes(cfg: AvatarConfig): Record<string, FinishId> {
  const out: Record<string, FinishId> = {};
  for (const item of Object.keys(FINISH_MATERIALS) as FinishItem[]) {
    const f = finishOf(cfg, item);
    if (f !== 'none') for (const name of FINISH_MATERIALS[item]) out[name] = f;
  }
  return out;
}

/** Soft tint of natural ride materials (bun, wood, rug) when the rider tints them. */
export const NATURAL_TINT = 0.5;

/** `paint` and the natural `paint_*` (tinted only on request); `accent` and `accent_*` take the optional accent. */
export function carLook(car: CarConfig): LookOf {
  const paint = carColorOf(car);
  return (name) => {
    if (name === 'paint') return { color: paint };
    if (name.startsWith('paint_')) return car.tint ? { color: paint, tint: NATURAL_TINT } : undefined;
    if ((name === 'accent' || name.startsWith('accent_')) && car.accent) return { color: car.accent };
    return undefined;
  };
}

/** Materials the ride finish paints (natural ones only when tinted). */
export function carFinish(car: CarConfig, material: string): FinishId | undefined {
  if (!car.finish) return undefined;
  return material === 'paint' || (car.tint && material.startsWith('paint_')) ? car.finish : undefined;
}
