import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../core/store';
import { loadCrewOrder, useCrewOrder } from '../../core/crewOrder';
import { useActiveInterval } from '../useActiveInterval';
import { orderKey, orderRows, type SortMode } from './orderLogic';
import { toRow, type RowInfo } from './sheetLogic';

const REFRESH_MS = 5000;

/**
 * Every visible crewmate in the user's chosen order for the current crew filter. ETA order drifts, so only it and
 * the recency order refresh on a timer; the custom order changes only on a move or a roster change.
 */
export function useOrderedRows(): { rows: RowInfo[]; mode: SortMode; key: string } {
  const idsKey = useApp((s) => Object.keys(s.friends).sort().join('|'));
  const crewFilter = useApp((s) => s.crewFilter);
  const key = orderKey(crewFilter);
  const mode = useCrewOrder((s) => s.modes[key]) ?? 'custom';
  const saved = useCrewOrder((s) => s.custom[key]);
  const [tick, setTick] = useState(0);
  const live = useRef(mode);
  live.current = mode;
  useEffect(() => {
    void loadCrewOrder();
  }, []);
  useActiveInterval(() => {
    if (live.current !== 'custom') setTick((n) => n + 1);
  }, REFRESH_MS);
  const rows = useMemo(() => {
    void idsKey;
    void tick;
    const st = useApp.getState();
    return orderRows(Object.values(st.friends).map((f) => toRow(f, st.fix)), mode, saved ?? []);
  }, [idsKey, tick, mode, saved]);
  return { rows, mode, key };
}
