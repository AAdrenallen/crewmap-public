import { create } from 'zustand';
import { CONVOY } from '@crewmap/shared/companions';
import { kvGet, kvSet } from './db';

const KEY = 'convoyPrefs';

/** Convoy preferences (D65), on this device only: regroup alert limits and crews whose convoy alerts are muted. */
export interface ConvoyPrefs {
  regroupM: number;
  regroupMin: number;
  /** Crew ids: no convoy callouts or regroup alerts for convoys of these crews. */
  mutedCrews: string[];
}

const DEFAULTS: ConvoyPrefs = { regroupM: CONVOY.regroupM, regroupMin: CONVOY.regroupMin, mutedCrews: [] };

export const useConvoyPrefs = create<ConvoyPrefs>(() => DEFAULTS);

function normalize(raw: Partial<ConvoyPrefs> | null): ConvoyPrefs {
  const m = raw?.regroupM;
  const min = raw?.regroupMin;
  return {
    regroupM: typeof m === 'number' && (CONVOY.regroupMChoices as readonly number[]).includes(m) ? m : DEFAULTS.regroupM,
    regroupMin: typeof min === 'number' && (CONVOY.regroupMinChoices as readonly number[]).includes(min) ? min : DEFAULTS.regroupMin,
    mutedCrews: Array.isArray(raw?.mutedCrews) ? raw.mutedCrews.filter((x): x is string => typeof x === 'string') : [],
  };
}

export async function loadConvoyPrefs(): Promise<void> {
  useConvoyPrefs.setState(normalize(await kvGet<Partial<ConvoyPrefs> | null>(KEY, null)));
}

export async function patchConvoyPrefs(p: Partial<ConvoyPrefs>): Promise<void> {
  const next = normalize({ ...useConvoyPrefs.getState(), ...p });
  useConvoyPrefs.setState(next);
  await kvSet(KEY, next);
}

export function isConvoyMuted(crew: string | null): boolean {
  return !!crew && useConvoyPrefs.getState().mutedCrews.includes(crew);
}
