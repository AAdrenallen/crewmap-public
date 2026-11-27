import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR, DEFAULT_CAR, withCarAccent, withCarTint, withFinish, withLens, withTrim } from '@crewmap/shared/avatar';
import { autoAccent, avatarFinishes, avatarLook, carFinish, carLook, CLEAR_OPACITY, FINISH_MATERIALS, LENS_TINT } from './looks';

function glbMaterials(file: string): string[] {
  const b = readFileSync(new URL(`../../assets/models/${file}`, import.meta.url));
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')) as { materials: { name: string }[] };
  return j.materials.map((m) => m.name);
}

describe('avatar looks', () => {
  const mats = glbMaterials('avatar.glb');

  it('every finish and primary material exists in avatar.glb', () => {
    for (const names of Object.values(FINISH_MATERIALS)) for (const n of names) expect(mats, n).toContain(n);
    const look = avatarLook(DEFAULT_AVATAR);
    for (const n of ['skin', 'hair', 'top', 'bottom', 'shoe', 'shoe2', 'hat', 'frame', 'extra']) {
      expect(mats).toContain(n);
      expect(look(n)?.color).toBeTruthy();
    }
  });

  it('trims keep built-in colours until chosen; ties and bands default to the auto accent', () => {
    const look = avatarLook(DEFAULT_AVATAR);
    expect(look('hat2_white')).toBeUndefined();
    expect(look('hat2_accent')?.color).toBe(autoAccent(DEFAULT_AVATAR));
    expect(look('white')).toBeUndefined();
    const t = avatarLook(withTrim(DEFAULT_AVATAR, 'hat', '#123456'));
    expect(t('hat2_white')?.color).toBe('#123456');
    expect(t('hat2_accent')?.color).toBe('#123456');
    expect(t('top2_white')).toBeUndefined();
  });

  it('lenses: dark ones strongly recoloured, clear ones softly tinted and see-through', () => {
    const none = avatarLook(DEFAULT_AVATAR);
    expect(none('lens_dark')).toBeUndefined();
    expect(none('lens_clear')?.opacity).toBe(CLEAR_OPACITY);
    const red = avatarLook(withLens(DEFAULT_AVATAR, '#FF0000'));
    expect(red('lens_dark')).toEqual({ color: '#FF0000', tint: LENS_TINT.dark });
    expect(red('lens_pink')?.tint).toBe(LENS_TINT.tinted);
    expect(red('lens_clear')?.tint).toBe(LENS_TINT.clear);
    expect(red('lens_clear')!.opacity!).toBeLessThan(1);
    const clear = avatarLook(withLens(DEFAULT_AVATAR, 'clear'));
    for (const n of mats.filter((m) => m.startsWith('lens_'))) expect(clear(n)?.opacity, n).toBe(CLEAR_OPACITY);
    expect(clear('lens_neon')?.glow).toBe(false);
  });

  it('glasses finish paints the frame', () => {
    expect(avatarFinishes(withFinish(DEFAULT_AVATAR, 'glasses', 'gold'))).toEqual({ frame: 'gold' });
  });
});

describe('ride looks', () => {
  const mats = glbMaterials('cars.glb');

  it('natural materials keep their look until tinted; accents only when chosen', () => {
    expect(mats).toContain('paint_bun');
    const plain = carLook(DEFAULT_CAR);
    expect(plain('paint')?.color).toBe(DEFAULT_CAR.color);
    expect(plain('paint_bun')).toBeUndefined();
    expect(plain('accent_rim')).toBeUndefined();
    const tinted = carLook(withCarAccent(withCarTint(DEFAULT_CAR, true), '#00FF00'));
    expect(tinted('paint_bun')?.tint).toBeLessThan(1);
    expect(tinted('accent_rim')?.color).toBe('#00FF00');
    expect(tinted('accent')?.color).toBe('#00FF00');
  });

  it('finish covers natural materials only when tinted', () => {
    const car = { ...DEFAULT_CAR, finish: 'gold' as const };
    expect(carFinish(car, 'paint')).toBe('gold');
    expect(carFinish(car, 'paint_wood')).toBeUndefined();
    expect(carFinish(withCarTint(car, true), 'paint_wood')).toBe('gold');
  });
});
