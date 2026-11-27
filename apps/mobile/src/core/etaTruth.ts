import type { CrewBias } from '@crewmap/shared/navigation';
import { parseCrewBias } from '@crewmap/shared/navigation';
import { kvGet, kvSet } from './db';

/** Crewmates' road-group ETA multipliers received with their stats aggregates (D60); newest per sender, kept in kv. */
const KEY = 'crewEtaBias';
const crew = new Map<string, CrewBias>();
let loaded = false;

export async function loadCrewBias(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const saved = await kvGet<Record<string, unknown>>(KEY, {});
  for (const [k, v] of Object.entries(saved)) {
    const eb = parseCrewBias(v);
    if (eb && !crew.has(k)) crew.set(k, eb);
  }
}

export function setCrewBias(sender: string, eb: CrewBias | null): void {
  if (!eb) return;
  crew.set(sender, eb);
  void kvSet(KEY, Object.fromEntries(crew));
}

export function crewBiases(): CrewBias[] {
  return [...crew.values()];
}
