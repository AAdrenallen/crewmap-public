import { describe, expect, it } from 'vitest';
import { advance, back, canAdvance, celebrateMs, isInviteLink, progress, STAGE_STEPS, STEPS, type StepInput } from './steps';

const base: StepInput = { name: 'Ada', locationGranted: true, link: '' };

describe('onboarding steps', () => {
  it('runs name → perms → look → ride → crew', () => {
    expect(STEPS).toEqual(['name', 'perms', 'look', 'ride', 'crew']);
    expect(STAGE_STEPS.every((s) => STEPS.includes(s))).toBe(true);
  });

  it('walks forward one step at a time', () => {
    expect(advance('name', base)).toEqual({ kind: 'step', step: 'perms' });
    expect(advance('perms', base)).toEqual({ kind: 'step', step: 'look' });
    expect(advance('look', base)).toEqual({ kind: 'step', step: 'ride' });
    expect(advance('ride', base)).toEqual({ kind: 'step', step: 'crew' });
    expect(advance('crew', base)).toBeNull();
  });

  it('needs a name and foreground location', () => {
    expect(canAdvance('name', { ...base, name: '   ' })).toBe(false);
    expect(advance('name', { ...base, name: '' })).toBeNull();
    expect(canAdvance('perms', { ...base, locationGranted: false })).toBe(false);
    expect(canAdvance('look', { ...base, locationGranted: false })).toBe(true);
  });

  it('joins straight after the ride step when an invite was opened first', () => {
    const link = 'crewmap://join#abc';
    expect(isInviteLink(` ${link}`)).toBe(true);
    expect(isInviteLink('https://example.org')).toBe(false);
    expect(advance('ride', { ...base, link })).toEqual({ kind: 'join' });
    expect(advance('look', { ...base, link })).toEqual({ kind: 'step', step: 'ride' });
    expect(isInviteLink('https://aadrenallen.github.io/crewmap-public/join/#abc')).toBe(true);
  });

  it('never joins on Next with a clipboard link: the crew step asks', () => {
    const link = 'crewmap://join#abc';
    expect(advance('ride', { ...base, link, linkFromClipboard: true })).toEqual({ kind: 'step', step: 'crew' });
  });

  it('goes back one step, not past the first', () => {
    expect(back('name')).toBeNull();
    expect(back('perms')).toBe('name');
    expect(back('ride')).toBe('look');
    expect(back('crew')).toBe('ride');
  });

  it('reports 1-based progress', () => {
    expect(progress('name')).toEqual({ n: 1, total: 5 });
    expect(progress('crew')).toEqual({ n: 5, total: 5 });
  });

  it('skips the celebration hold with reduce motion', () => {
    expect(celebrateMs(true)).toBe(0);
    expect(celebrateMs(false)).toBeGreaterThan(0);
    expect(celebrateMs(false)).toBeLessThanOrEqual(1500);
  });
});
