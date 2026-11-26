import { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { t } from '@crewmap/shared/i18n';
import { syncState, type SyncState } from '@crewmap/shared/shell';
import type { Crews } from '../../core/crews';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Icon } from '../kit';
import { useActiveInterval } from '../useActiveInterval';
import { radius, type, useTheme } from '../theme';

const POLL_MS = 3_000;

/** Home can render before engine.init has built the crews facade. */
const readConnectivity = () => (engine.crews as Crews | undefined)?.connectivity() ?? { started: false, queued: 0, relaysUp: 0, relaysTotal: 0 };

function useSyncState(): SyncState {
  const online = useApp((s) => s.online);
  const [k, setK] = useState(readConnectivity);
  // Foreground only; keep the old object when nothing changed so the map does not re-render every poll.
  useActiveInterval(() => {
    const n = readConnectivity();
    setK((o) => (o.started === n.started && o.queued === n.queued && o.relaysUp === n.relaysUp && o.relaysTotal === n.relaysTotal ? o : n));
  }, POLL_MS);
  return syncState({ online, ...k });
}

/** Small status pill on the map, only while something is off (offline, relays down, updates waiting). */
export function SyncChip({ style }: { style?: StyleProp<ViewStyle> }) {
  const th = useTheme();
  const st = useSyncState();
  if (!st) return null;
  const label = st.kind === 'offline' ? t('sync.offline') : st.kind === 'reconnecting' ? t('sync.reconnecting') : t('sync.queued', { n: st.n });
  return (
    <View testID="sync-chip" accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={label} style={[styles.chip, { backgroundColor: th.glass, borderColor: th.separator }, style]}>
      <Icon name={st.kind === 'offline' ? 'alert' : 'link'} size={14} color={st.kind === 'offline' ? th.danger : th.textSoft} />
      <Text style={[type.caption, { color: th.textSoft }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 26, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
