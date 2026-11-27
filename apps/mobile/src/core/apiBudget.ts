import { create } from 'zustand';
import { ApiBudget, type ApiDay, type ApiKind, type BudgetLevel } from '@crewmap/shared/apiBudget';
import * as db from './db';

/**
 * The app's one daily counter of billable map requests (D60): `mapbox.ts` counts every request, features ask
 * `budgetLevel` before optional calls, and Settings → Help → Diagnostics shows the last days.
 */
const KEY = 'apiBudget.v1';
let budget = new ApiBudget();
let loaded: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Snapshot for the Diagnostics screen (newest day first). */
export const useApiBudget = create<{ days: ApiDay[] }>(() => ({ days: [] }));

export function loadApiBudget(): Promise<void> {
  loaded ??= db
    .kvGet<unknown>(KEY, [])
    .then((v) => {
      const current = budget.toJSON();
      budget = new ApiBudget(v);
      // Requests counted before the stored counters loaded.
      for (const d of current) for (const [k, n] of Object.entries(d.used)) if (n) budget.use(k as ApiKind, new Date(`${d.day}T12:00:00`).getTime(), n);
      publish();
    })
    .catch(() => undefined);
  return loaded;
}

function publish(): void {
  useApiBudget.setState({ days: budget.history() });
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void db.kvSet(KEY, budget.toJSON()).catch(() => undefined);
  }, 10_000);
}

export function countRequest(kind: ApiKind, units = 1): void {
  budget.use(kind, Date.now(), units);
  publish();
}

/** Requests avoided (cache hits, skipped probes). */
export function countSaved(kind: ApiKind, units = 1): void {
  if (units <= 0) return;
  budget.save(kind, Date.now(), units);
  publish();
}

export function budgetLevel(kind: ApiKind): BudgetLevel {
  return budget.level(kind, Date.now());
}
