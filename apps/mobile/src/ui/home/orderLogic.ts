import { sortRows, type RowInfo } from './sheetLogic';

/** Pure ordering of crewmates in the deck and the sheet list. */

export type SortMode = 'custom' | 'eta' | 'recent';
export const SORT_MODES: readonly SortMode[] = ['custom', 'eta', 'recent'];
export type MoveKind = 'up' | 'down' | 'top';

/** Storage key per crew filter (`null` = every crew). */
export const orderKey = (crewFilter: string | null): string => crewFilter ?? 'all';

const byRecent = (rows: RowInfo[]): RowInfo[] =>
  [...rows].sort((a, b) => (b.t ?? -1) - (a.t ?? -1) || a.name.localeCompare(b.name));

/** Saved order minus people who left, then newcomers appended by recent activity. */
export function applyCustom(rows: RowInfo[], saved: readonly string[]): RowInfo[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const head: RowInfo[] = [];
  for (const id of saved) {
    const r = byId.get(id);
    if (r && !seen.has(id)) {
      seen.add(id);
      head.push(r);
    }
  }
  return [...head, ...byRecent(rows.filter((r) => !seen.has(r.id)))];
}

export function orderRows(rows: RowInfo[], mode: SortMode, saved: readonly string[]): RowInfo[] {
  if (mode === 'eta') return sortRows(rows, 'eta');
  if (mode === 'recent') return byRecent(rows);
  return applyCustom(rows, saved);
}

/** Moves one id; a no-op at the edges or for an unknown id. */
export function moveId(ids: readonly string[], id: string, kind: MoveKind): string[] {
  const i = ids.indexOf(id);
  const out = [...ids];
  if (i < 0) return out;
  const to = kind === 'top' ? 0 : kind === 'up' ? i - 1 : i + 1;
  if (to < 0 || to >= out.length || to === i) return out;
  out.splice(i, 1);
  out.splice(to, 0, id);
  return out;
}
