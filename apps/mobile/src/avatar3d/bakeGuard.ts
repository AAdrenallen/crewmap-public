import { CARS, DEFAULT_CAR, type CarConfig } from '@crewmap/shared/avatar';

/**
 * Pure guards around on-device sprite baking: a bake failure (GL context, driver, model) must never take the app
 * down, and must not be retried on every mount.
 */

/** A ride whose bake failed this session rides the default model instead (unknown ids too). */
export function rideFallback(car: CarConfig, failed: ReadonlySet<string>): CarConfig {
  const known = (CARS as readonly string[]).includes(car.model);
  if (car.model === DEFAULT_CAR.model) return car;
  return !known || failed.has(car.model) ? { ...car, model: DEFAULT_CAR.model } : car;
}

/** Whether a sheet (and its supersampled cell target) fits the GPU's texture/renderbuffer limits. */
export function sheetFits(cols: number, rows: number, cell: number, supersample: number, maxTex: number, maxRb: number): boolean {
  if (!(maxTex > 0) || !(maxRb > 0)) return false;
  const w = cols * cell;
  const h = rows * cell;
  const big = cell * supersample;
  const lim = Math.min(maxTex, maxRb);
  return w <= lim && h <= lim && big <= lim;
}

/** Consecutive bake failures after which baking stays off for the session (flat fallback badges instead). */
export const BAKE_FAILS_MAX = 3;

/** Session circuit breaker: counts consecutive failures; any success resets it. */
export class BakeBreaker {
  private fails = 0;
  constructor(private readonly max = BAKE_FAILS_MAX) {}
  get open(): boolean {
    return this.fails >= this.max;
  }
  fail(): void {
    this.fails++;
  }
  ok(): void {
    this.fails = 0;
  }
}
