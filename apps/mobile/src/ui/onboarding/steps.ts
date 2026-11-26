/** Pure onboarding step list and progression (the screen is apps/mobile/src/app/onboarding.tsx). */
import { extractInviteLink } from '@crewmap/shared/links';

export type Step = 'name' | 'perms' | 'look' | 'ride' | 'crew';
export const STEPS: readonly Step[] = ['name', 'perms', 'look', 'ride', 'crew'];

/** Steps that show the shared 3D stage (kept mounted across them, so the GL context is not recreated). */
export const STAGE_STEPS: readonly Step[] = ['look', 'ride'];

export interface StepInput {
  name: string;
  /** Foreground location: the one permission onboarding requires. */
  locationGranted: boolean;
  link: string;
  /** The link came from the clipboard, not a tapped link: the crew step asks first instead of joining on Next. */
  linkFromClipboard?: boolean;
}

/** Either invite form (`crewmap://join#…` or the https join page). */
export function isInviteLink(link: string): boolean {
  return extractInviteLink(link) !== null;
}

export function canAdvance(step: Step, s: StepInput): boolean {
  switch (step) {
    case 'name':
      return s.name.trim().length > 0;
    case 'perms':
      return s.locationGranted;
    case 'look':
    case 'ride':
      return true;
    case 'crew':
      // The crew step finishes through its own create / join actions.
      return false;
  }
}

/** Next: another step, or straight to joining when an invite link was opened before onboarding. */
export type Advance = { kind: 'step'; step: Step } | { kind: 'join' };

export function advance(step: Step, s: StepInput): Advance | null {
  if (!canAdvance(step, s)) return null;
  if (step === 'ride' && isInviteLink(s.link) && !s.linkFromClipboard) return { kind: 'join' };
  const next = STEPS[STEPS.indexOf(step) + 1];
  return next ? { kind: 'step', step: next } : null;
}

/** Previous step; null on the first one (hardware back leaves the app there). */
export function back(step: Step): Step | null {
  const i = STEPS.indexOf(step);
  return i > 0 ? STEPS[i - 1]! : null;
}

/** 1-based position for the progress bar. */
export function progress(step: Step): { n: number; total: number } {
  return { n: STEPS.indexOf(step) + 1, total: STEPS.length };
}

/** How long the "You're in" moment holds before the map (0 with reduce motion). */
export function celebrateMs(reduceMotion: boolean): number {
  return reduceMotion ? 0 : 1100;
}
