import { platform, type ExternalNavApp, type ExternalNavUpdate } from '@crewmap/platform';
import { externalArrivalMs } from '@crewmap/shared/navigation/externalNavParse';
import { onExternalNavLaunched, setOverlayNav } from './overlay';

/** Waze / Google Maps status read from their navigation notification after a handoff. */
export const EXTERNAL_STATUS = {
  /** An update older than this no longer counts (notification frozen or listener disconnected). */
  staleMs: 3 * 60_000,
} as const;

let latest: { u: ExternalNavUpdate; at: number } | null = null;
let unsubs: (() => void)[] = [];

function onUpdate(u: ExternalNavUpdate): void {
  const at = externalArrivalMs(u);
  if (at !== null) latest = { u, at };
  setOverlayNav({ remainingMin: u.remainingMin, arrival: u.arrival, nextInstruction: u.nextInstruction });
}

function stop(): void {
  for (const f of unsubs) f();
  unsubs = [];
  latest = null;
  setOverlayNav(undefined);
}

function start(): void {
  if (platform.os !== 'android' || unsubs.length || !platform.externalNavStatus.hasAccess()) return;
  unsubs = [platform.externalNavStatus.onUpdate(onUpdate), platform.externalNavStatus.onEnded(stop)];
}

/** Traffic-aware arrival (epoch ms) to publish in presence, while Waze / Google Maps is guiding. */
export function externalEta(now = Date.now()): { at: number; app: ExternalNavApp } | null {
  if (!latest) return null;
  if (now - latest.u.t > EXTERNAL_STATUS.staleMs) {
    latest = null;
    return null;
  }
  return { at: latest.at, app: latest.u.app };
}

onExternalNavLaunched(start);
