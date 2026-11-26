import { describe, expect, it } from 'vitest';
import { CARS, DEFAULT_CAR, type CarConfig } from '@crewmap/shared/avatar';
import { BakeBreaker, rideFallback, sheetFits } from './bakeGuard';

describe('rideFallback', () => {
  it('keeps a ride that has not failed', () => {
    const car: CarConfig = { model: 'rocket', color: '#E53935' };
    expect(rideFallback(car, new Set())).toBe(car);
  });
  it('falls back to the default model (keeping the colour) after a failure', () => {
    expect(rideFallback({ model: 'carpet', color: '#43A047' }, new Set(['carpet']))).toEqual({ model: DEFAULT_CAR.model, color: '#43A047' });
  });
  it('maps unknown ids to the default', () => {
    expect(rideFallback({ model: 'ufo' as CarConfig['model'], color: '#43A047' }, new Set()).model).toBe(DEFAULT_CAR.model);
  });
  it('never replaces the default itself', () => {
    expect(rideFallback(DEFAULT_CAR, new Set([DEFAULT_CAR.model]))).toBe(DEFAULT_CAR);
  });
  it('covers every ride id', () => {
    for (const m of CARS) expect(rideFallback({ model: m, color: '#E53935' }, new Set()).model).toBe(m);
  });
});

describe('sheetFits', () => {
  it('fits the 16x3 avatar sheet on a 4096 GPU', () => expect(sheetFits(16, 3, 192, 2, 4096, 4096)).toBe(true));
  it('rejects it on a 2048 GPU', () => expect(sheetFits(16, 3, 192, 2, 2048, 8192)).toBe(false));
  it('rejects unknown limits', () => expect(sheetFits(1, 1, 192, 2, Number.NaN, 0)).toBe(false));
});

describe('BakeBreaker', () => {
  it('opens after consecutive failures and resets on success', () => {
    const b = new BakeBreaker(2);
    b.fail();
    expect(b.open).toBe(false);
    b.ok();
    b.fail();
    b.fail();
    expect(b.open).toBe(true);
  });
});
