import { describe, expect, it } from 'vitest';
import { AVATAR_PARTS, CARS, DEFAULT_AVATAR, TRIM_ITEMS, type AvatarPartKey } from '@crewmap/shared/avatar';
import { groupOf, hasLens, hasTrim, isLight, optionLabel, PART_GROUPS, partOptions, pushUndo, RIDE_ICON, withPart } from './avatarParts';

describe('avatar part picker options', () => {
  it('covers every avatar part exactly once', () => {
    const used = PART_GROUPS.flatMap((g) => [g.style, g.color, g.color2].filter((k): k is AvatarPartKey => !!k));
    expect([...used].sort()).toEqual((Object.keys(AVATAR_PARTS) as AvatarPartKey[]).sort());
    expect(new Set(PART_GROUPS.map((g) => g.tab)).size).toBe(PART_GROUPS.length);
  });

  it('keeps the tabs the editor flow taps', () => {
    expect(PART_GROUPS.map((g) => g.tab)).toContain('hair');
    expect(partOptions('hair')).toContain('afro');
  });

  it('pairs colours with what they paint', () => {
    expect(groupOf('hair').color).toBe('hairColor');
    expect(groupOf('body').color).toBe('skin');
    expect(groupOf('face').color).toBeUndefined();
    expect(groupOf('shoes')).toMatchObject({ color: 'shoeColor', color2: 'shoeColor2' });
    expect(groupOf('accessory').color).toBe('extraColor');
    expect(PART_GROUPS.map((g) => g.trim).filter(Boolean).sort()).toEqual([...TRIM_ITEMS].sort());
    expect(groupOf('glasses').lens).toBe(true);
  });

  it('shows trim and lens fields only where the style has them', () => {
    expect(hasTrim({ ...DEFAULT_AVATAR, hat: 'none' }, 'hat')).toBe(false);
    expect(hasTrim({ ...DEFAULT_AVATAR, hat: 'beanie' }, 'hat')).toBe(true);
    expect(hasLens({ ...DEFAULT_AVATAR, glasses: 'none' })).toBe(false);
    expect(hasLens({ ...DEFAULT_AVATAR, glasses: 'round' })).toBe(true);
  });

  it('changes one part and ignores unknown values', () => {
    const next = withPart(DEFAULT_AVATAR, 'hair', 'afro');
    expect(next).toEqual({ ...DEFAULT_AVATAR, hair: 'afro' });
    expect(withPart(DEFAULT_AVATAR, 'hair', 'nope')).toBe(DEFAULT_AVATAR);
    expect(withPart(DEFAULT_AVATAR, 'hair', DEFAULT_AVATAR.hair)).toBe(DEFAULT_AVATAR);
  });

  it('labels and contrasts options', () => {
    expect(optionLabel('hightops')).toBe('Hightops');
    expect(optionLabel('fooBar')).toBe('Foo Bar');
    expect(isLight('#F5F5F5')).toBe(true);
    expect(isLight('#212121')).toBe(false);
  });

  it('has a glyph for every ride', () => {
    expect(Object.keys(RIDE_ICON).sort()).toEqual([...CARS].sort());
  });

  it('caps the undo stack, newest last', () => {
    let s: number[] = [];
    for (let i = 0; i < 15; i++) s = pushUndo(s, i, 10);
    expect(s).toHaveLength(10);
    expect(s[s.length - 1]).toBe(14);
    expect(s[0]).toBe(5);
  });
});
