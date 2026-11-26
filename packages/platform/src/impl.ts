import type { Platform } from './contracts';

/**
 * Resolved when no native implementation exists for the current platform (Node/Vitest, and iOS until the port in
 * docs/IOS-PORT.md is done). Metro picks `impl.android.ts` on Android.
 */
export class PlatformUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} has no implementation on this platform (see docs/IOS-PORT.md)`);
  }
}

export const platform: Platform = new Proxy({} as Platform, {
  get(_t, prop) {
    if (prop === 'os') return 'ios';
    throw new PlatformUnavailableError(String(prop));
  },
});
