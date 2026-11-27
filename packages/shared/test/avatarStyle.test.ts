import { describe, expect, it } from 'vitest';
import {
  avatarKey,
  colorOf,
  DEFAULT_AVATAR,
  DEFAULT_CAR,
  isAvatarConfig,
  nearestColor,
  normalizeAvatar,
  normalizeCar,
  normalizeHex,
  pushRecentColor,
  rideKey,
  withCarColor,
  withCarFinish,
  withColor,
  withFinish,
  AVATAR_PARTS,
  CLEAR_LENS,
  RIDES_NATURAL,
  TRIM_ITEMS,
  TRIM_STYLES,
  trimOf,
  withCarTint,
  withLens,
  withTrim,
} from '../src/avatar';

describe('avatar colours and finishes', () => {
  it('normalises hex input', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(normalizeHex('12ab9f')).toBe('#12AB9F');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });

  it('keeps palette slots valid for older builds and stores the exact colour beside them', () => {
    const cfg = withColor(DEFAULT_AVATAR, 'hairColor', '#00ff00');
    expect(AVATAR_PARTS.hairColor as readonly string[]).toContain(cfg.hairColor);
    expect(cfg.hex?.hairColor).toBe('#00FF00');
    expect(colorOf(cfg, 'hairColor')).toBe('#00FF00');
    expect(isAvatarConfig(cfg)).toBe(true);
    const back = withColor(cfg, 'hairColor', '#4A3020');
    expect(back.hex).toBeUndefined();
    expect(withColor(cfg, 'hairColor', 'nope')).toBe(cfg);
  });

  it('nearest palette colour', () => {
    expect(nearestColor('#FE0000', ['#000000', '#FF0000', '#00FF00'])).toBe('#FF0000');
  });

  it('normalizeAvatar clamps per field', () => {
    const n = normalizeAvatar({ ...DEFAULT_AVATAR, hair: 'hologramHair', skin: '#zzz', hex: { topColor: '#123', skin: 'nope', nonsense: '#FFFFFF' }, topFinish: 'gold', hairFinish: 'warp', bottomFinish: 'none' });
    expect(n.hair).toBe(DEFAULT_AVATAR.hair);
    expect(n.skin).toBe(DEFAULT_AVATAR.skin);
    expect(n.hex).toEqual({ topColor: '#112233' });
    expect(n.topFinish).toBe('gold');
    expect(n.hairFinish).toBeUndefined();
    expect('bottomFinish' in n).toBe(false);
    expect(normalizeAvatar(null)).toEqual(DEFAULT_AVATAR);
  });

  it('normalizeCar keeps paint, accent and finish', () => {
    const c = normalizeCar({ model: 'van', color: '#E53935', hex: '#e53936', accent: 'fff', finish: 'chrome' });
    expect(c).toEqual({ model: 'van', color: '#E53935', hex: '#E53936', accent: '#FFFFFF', finish: 'chrome' });
    expect(normalizeCar({ model: 'van', color: '#E53935', finish: 'warp', hex: '#E53935' })).toEqual({ model: 'van', color: '#E53935' });
    const p = withCarColor(DEFAULT_CAR, '#123456');
    expect(p.hex).toBe('#123456');
    expect(withCarFinish(p, 'none').finish).toBeUndefined();
  });

  it('sprite cache keys include colours and finishes and ignore equivalent spellings', () => {
    const base = avatarKey(DEFAULT_AVATAR);
    expect(avatarKey(withFinish(DEFAULT_AVATAR, 'top', 'rainbow'))).not.toBe(base);
    expect(avatarKey(withFinish(withFinish(DEFAULT_AVATAR, 'top', 'rainbow'), 'top', 'none'))).toBe(base);
    expect(avatarKey(withColor(DEFAULT_AVATAR, 'topColor', '#010203'))).not.toBe(base);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_AVATAR).reverse()) as typeof DEFAULT_AVATAR;
    expect(avatarKey(reordered)).toBe(base);
    expect(avatarKey({ ...DEFAULT_AVATAR, hex: { topColor: '#aabbcc' } })).toBe(avatarKey({ ...DEFAULT_AVATAR, hex: { topColor: '#AABBCC' } }));
    expect(rideKey(DEFAULT_AVATAR, withCarFinish(DEFAULT_CAR, 'galaxy'))).not.toBe(rideKey(DEFAULT_AVATAR, DEFAULT_CAR));
  });

  it('recent colours: newest first, unique, capped', () => {
    let r: string[] = [];
    for (const c of ['#111111', '#222222', '#111111']) r = pushRecentColor(r, c, 2);
    expect(r).toEqual(['#111111', '#222222']);
    expect(pushRecentColor(r, 'nope')).toEqual(r);
  });
});

describe('ride accent material', () => {
  it('RIDES_WITH_ACCENT matches the rides with an accent material in cars.glb', async () => {
    const { readFileSync } = await import('node:fs');
    const { RIDES_WITH_ACCENT, CARS } = await import('../src/avatar');
    const b = readFileSync(new URL('../../../apps/mobile/assets/models/cars.glb', import.meta.url));
    const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')) as {
      materials: { name: string }[];
      nodes: { name?: string; mesh?: number; children?: number[] }[];
      meshes: { primitives: { material?: number }[] }[];
    };
    const mats = (i: number): string[] => {
      const n = j.nodes[i]!;
      const own = n.mesh === undefined ? [] : j.meshes[n.mesh]!.primitives.map((p) => j.materials[p.material ?? -1]?.name ?? '');
      return [...own, ...(n.children ?? []).flatMap(mats)];
    };
    const withAccent = CARS.filter((m) => {
      const i = j.nodes.findIndex((n) => n.name === `car_${m}`);
      return i >= 0 && mats(i).some((m) => m === 'accent' || m.startsWith('accent_'));
    });
    expect([...RIDES_WITH_ACCENT].sort()).toEqual([...withAccent].sort());
    const natural = CARS.filter((m) => {
      const i = j.nodes.findIndex((n) => n.name === `car_${m}`);
      return i >= 0 && mats(i).some((x) => x.startsWith('paint_'));
    });
    expect([...RIDES_NATURAL].sort()).toEqual([...natural].sort());
  });
});

describe('avatar trims and lenses', () => {
  it('TRIM_STYLES matches the styles with `<slot>2_*` trim materials in avatar.glb', async () => {
    const { readFileSync } = await import('node:fs');
    const b = readFileSync(new URL('../../../apps/mobile/assets/models/avatar.glb', import.meta.url));
    const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')) as {
      materials: { name: string }[];
      nodes: { name?: string; mesh?: number }[];
      meshes: { primitives: { material?: number }[] }[];
    };
    const prefix: Record<string, [string, string]> = { hair: ['hair', 'hair2_'], top: ['top', 'top2_'], bottom: ['bottom', 'bottom2_'], hat: ['hat', 'hat2_'], accessory: ['acc', 'extra2_'] };
    for (const item of TRIM_ITEMS) {
      const [node, mat] = prefix[item]!;
      const found = new Set<string>();
      for (const n of j.nodes) {
        if (n.mesh === undefined || !n.name?.startsWith(`${node}_`)) continue;
        if (j.meshes[n.mesh]!.primitives.some((p) => j.materials[p.material ?? -1]?.name.startsWith(mat))) found.add(n.name.split('_')[1]!);
      }
      expect([...TRIM_STYLES[item]].sort(), item).toEqual([...found].sort());
    }
    const lensless = AVATAR_PARTS.glasses.filter((g) => g !== 'none' && !j.nodes.some((n) => n.mesh !== undefined && n.name?.startsWith(`glasses_${g}_`) && j.meshes[n.mesh]!.primitives.some((p) => j.materials[p.material ?? -1]?.name.startsWith('lens_'))));
    expect(lensless).toEqual(['pixel']);
  });

  it('trim, lens and glasses finish normalise and old payloads parse unchanged', () => {
    const old = normalizeAvatar({ ...DEFAULT_AVATAR });
    expect(old).toEqual(DEFAULT_AVATAR);
    const cfg = normalizeAvatar({ ...DEFAULT_AVATAR, trim: { hat: 'fff', top: 'nope', shoes: '#000000' }, lens: 'clear', glassesFinish: 'gold' });
    expect(cfg.trim).toEqual({ hat: '#FFFFFF' });
    expect(cfg.lens).toBe(CLEAR_LENS);
    expect(cfg.glassesFinish).toBe('gold');
    expect(normalizeAvatar({ ...DEFAULT_AVATAR, lens: 'tinted' }).lens).toBeUndefined();
    expect(isAvatarConfig(cfg)).toBe(true);
  });

  it('withTrim / withLens set and clear', () => {
    const a = withTrim(DEFAULT_AVATAR, 'hat', '#123456');
    expect(trimOf(a, 'hat')).toBe('#123456');
    expect(withTrim(a, 'hat', null).trim).toBeUndefined();
    expect(withLens(DEFAULT_AVATAR, '#abc').lens).toBe('#AABBCC');
    expect(withLens(withLens(DEFAULT_AVATAR, 'clear'), null).lens).toBeUndefined();
  });

  it('ride tint is optional and round-trips', () => {
    expect(normalizeCar({ model: 'hotdog', color: '#E53935' }).tint).toBeUndefined();
    expect(normalizeCar({ model: 'hotdog', color: '#E53935', tint: true }).tint).toBe(true);
    expect(withCarTint(withCarTint(DEFAULT_CAR, true), false)).toEqual(DEFAULT_CAR);
  });
});
