import { create } from 'zustand';
import { kvGet, kvSet } from './db';
import { moveId, type MoveKind, type SortMode } from '../ui/home/orderLogic';

const KEY = 'crewOrder';

interface Saved {
  modes: Record<string, SortMode>;
  custom: Record<string, string[]>;
}

/** Deck / list order per crew filter, kept on this device only. */
export const useCrewOrder = create<Saved & { loaded: boolean }>(() => ({ loaded: false, modes: {}, custom: {} }));

let loading: Promise<void> | null = null;

export function loadCrewOrder(): Promise<void> {
  loading ??= kvGet<Saved>(KEY, { modes: {}, custom: {} })
    .then((s) => useCrewOrder.setState({ modes: s.modes ?? {}, custom: s.custom ?? {}, loaded: true }))
    .catch(() => useCrewOrder.setState({ loaded: true }));
  return loading;
}

const persist = async (): Promise<void> => {
  const { modes, custom } = useCrewOrder.getState();
  await kvSet(KEY, { modes, custom });
};

export async function setSortMode(key: string, mode: SortMode): Promise<void> {
  useCrewOrder.setState((s) => ({ modes: { ...s.modes, [key]: mode } }));
  await persist();
}

/** Applies a move to the order currently shown and switches that filter to the custom order. */
export async function moveFriend(key: string, shown: readonly string[], id: string, kind: MoveKind): Promise<void> {
  const next = moveId(shown, id, kind);
  useCrewOrder.setState((s) => ({ modes: { ...s.modes, [key]: 'custom' }, custom: { ...s.custom, [key]: next } }));
  await persist();
}
