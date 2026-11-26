import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { t } from '@crewmap/shared/i18n';
import type { AvatarConfig } from '@crewmap/shared/avatar';
import { useApp, type FriendView } from '../../core/store';
import { AvatarStill } from '../map/Sprites';
import { Chip, Field, Segmented } from '../kit';
import { moveFriend, setSortMode } from '../../core/crewOrder';
import { SORT_MODES, type MoveKind, type SortMode } from './orderLogic';
import { useOrderedRows } from './useOrderedRows';
import { radius, type, elevation, useTheme } from '../theme';
import { LiveCard, LiveRow } from './FriendCard';
import { CrewDeck } from './CrewDeck';
import { FriendActions } from './FriendActions';
import { locateFriend, useLocate } from '../../core/locate';
import { ROW_FILTERS, filterRows, isDriving, snapAfterDrag, snapAfterTap, snapHeights, sortRows, type RowFilter, type RowInfo, type SnapName } from './sheetLogic';

const SPRING = { damping: 24, stiffness: 240, mass: 0.8 } as const;

interface SheetData {
  rows: RowInfo[];
  total: number;
  driving: number;
  avatars: AvatarConfig[];
}

/**
 * Rows follow the user's order for the current crew filter (see useOrderedRows); filter and search apply on top. A 1 Hz
 * position update never re-renders the sheet itself; each visible row subscribes to its own friend.
 */
function useSheetData(filter: RowFilter, query: string): SheetData & { all: RowInfo[]; mode: SortMode; key: string } {
  const { rows: all, mode, key } = useOrderedRows();
  return useMemo(() => {
    const st = useApp.getState();
    return {
      all,
      mode,
      key,
      rows: filterRows(all, filter, query, Date.now()),
      total: all.length,
      driving: all.filter(isDriving).length,
      avatars: sortRows(all, 'distance').slice(0, 5).flatMap((r) => (st.friends[r.id] ? [st.friends[r.id]!.profile.avatar] : [])),
    };
  }, [all, mode, key, filter, query]);
}

/**
 * Bottom sheet (portrait) / left side panel (landscape) with every crewmate. Collapsed: summary + nearest cards.
 * Half: scrolling list. Full: search, filter chips and sort. `height` is the live sheet height (for the controls above it).
 */
export function CrewmateSheet({ height, bottomInset, leftInset, topReserved, wide, panelW, onOpen, onFocus, onInvite }: { height: SharedValue<number>; bottomInset: number; leftInset: number; topReserved: number; wide: boolean; panelW: number; onOpen: (f: FriendView) => void; onFocus: (id: string) => void; onInvite: () => void }) {
  const th = useTheme();
  const win = useWindowDimensions();
  const heights = useMemo(() => snapHeights(win.height - topReserved - bottomInset), [win.height, topReserved, bottomInset]);
  const [snap, setSnap] = useState<SnapName>('collapsed');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [query, setQuery] = useState('');
  const [actions, setActions] = useState<FriendView | null>(null);
  const data = useSheetData(snap === 'full' ? filter : 'all', snap === 'full' ? query : '');
  const move = useCallback((id: string, kind: MoveKind) => void moveFriend(data.key, data.all.map((r) => r.id), id, kind).catch(() => undefined), [data.key, data.all]);
  const orderOf = actions ? { index: data.all.findIndex((r) => r.id === actions.profile.deviceId), count: data.all.length, onMove: move } : undefined;

  const settle = useCallback(
    (s: SnapName) => {
      setSnap(s);
      height.value = withSpring(heights[s] + bottomInset, SPRING);
    },
    [heights, bottomInset, height],
  );
  // Locate (from here or the friend screen): collapse so the map shows the fly-to and the pill sits above the sheet.
  const locateAt = useLocate((s) => (s.id ? s.at : 0));
  const seenLocate = useRef(0);
  useEffect(() => {
    if (!locateAt || seenLocate.current === locateAt) return;
    seenLocate.current = locateAt;
    settle('collapsed');
  }, [locateAt, settle]);
  const start = useSharedValue(0);
  const live = useRef({ snap, heights, settle });
  live.current.snap = snap;
  live.current.heights = heights;
  live.current.settle = settle;

  // Follow window changes (rotation) and keep the shared height in sync with the snap.
  useEffect(() => {
    height.value = heights[snap] + bottomInset;
  }, [heights, bottomInset]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-6, 6])
        .failOffsetX([-14, 14])
        .onBegin(() => {
          start.value = height.value;
        })
        .onUpdate((e) => {
          const lo = heights.collapsed + bottomInset;
          const hi = heights.full + bottomInset;
          const raw = start.value - e.translationY;
          // Rubber-band: past a detent the sheet follows at a third of the finger.
          height.value = raw < lo ? lo - (lo - raw) / 3 : raw > hi ? hi + (raw - hi) / 3 : raw;
        })
        .onEnd((e) => {
          const s = snapAfterDrag(height.value - bottomInset, e.velocityY, heights);
          height.value = withSpring(heights[s] + bottomInset, { ...SPRING, velocity: -e.velocityY });
          scheduleOnRN(setSnap, s);
        }),
    [height, start, heights, bottomInset],
  );

  useEffect(() => {
    if (snap === 'collapsed') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      live.current.settle('collapsed');
      return true;
    });
    return () => sub.remove();
  }, [snap]);

  const style = useAnimatedStyle(() => ({ height: height.value }));
  const open = useCallback((f: FriendView) => onOpen(f), [onOpen]);
  const showActions = useCallback((f: FriendView) => setActions(f), []);
  const closeActions = useCallback(() => setActions(null), []);
  const renderRow = useCallback(({ item }: { item: RowInfo }) => <LiveRow id={item.id} onOpen={open} onActions={showActions} />, [open, showActions]);
  const collapsedIds = useMemo(() => data.all.slice(0, 6).map((r) => r.id), [data.all]);
  const renderDeck = useCallback((id: string) => <LiveCard id={id} fill onOpen={open} onActions={showActions} />, [open, showActions]);
  const key = useCallback((r: RowInfo) => r.id, []);
  const summary = `${t('home.crewmates', { n: data.total })}${data.driving > 0 ? ` · ${t('home.drivingN', { n: data.driving })}` : ''}`;

  return (
    <Animated.View
      testID="crew-sheet"
      style={[styles.sheet, wide ? { left: leftInset, width: panelW } : { left: 0, right: 0 }, { backgroundColor: th.card, borderColor: th.separator, paddingBottom: bottomInset }, elevation.sheet, style]}
    >
      <GestureDetector gesture={pan}>
      <View collapsable={false}>
        <Pressable testID="crew-sheet-handle" accessibilityRole="button" accessibilityLabel={t('home.sheet')} accessibilityState={{ expanded: snap !== 'collapsed' }} onPress={() => settle(snapAfterTap(snap))} style={styles.header} hitSlop={{ top: 8 }}>
          <View style={[styles.grab, { backgroundColor: th.border }]} />
          <View style={styles.summary}>
            <View style={styles.stack}>
              {data.avatars.map((a, i) => (
                <View key={i} style={[styles.stackItem, { marginLeft: i === 0 ? 0 : -12, backgroundColor: th.cardAlt, borderColor: th.card, zIndex: 10 - i }]}>
                  <AvatarStill avatar={a} size={28} />
                </View>
              ))}
            </View>
            <Text style={[type.headline, { color: th.text, flex: 1 }]} numberOfLines={1} testID="crew-sheet-summary">
              {summary}
            </Text>
          </View>
        </Pressable>
      </View>
      </GestureDetector>

      {snap === 'collapsed' ? (
        <CrewDeck testID="crew-deck" ids={collapsedIds} renderCard={renderDeck} onFocus={onFocus} onInvite={onInvite} />
      ) : (
        <View style={{ flex: 1 }}>
          {snap === 'full' && (
            <View style={styles.controls}>
              <Field label={t('home.search')} hideLabel icon="search" value={query} onChangeText={setQuery} onClear={() => setQuery('')} testID="crew-sheet-search" />
              <View style={styles.chips}>
                {ROW_FILTERS.map((f) => (
                  <Chip key={f} testID={`crew-sheet-filter-${f}`} label={t(`home.filter.${f}`)} active={filter === f} onPress={() => setFilter(f)} />
                ))}
              </View>
              <Segmented<SortMode> options={SORT_MODES.map((m) => ({ key: m, label: t(`home.sort.${m}`) }))} value={data.mode} onChange={(m) => void setSortMode(data.key, m).catch(() => undefined)} />
            </View>
          )}
          <FlatList
            data={data.rows}
            keyExtractor={key}
            renderItem={renderRow}
            initialNumToRender={10}
            windowSize={7}
            maxToRenderPerBatch={8}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={[type.body, { color: th.textSoft, textAlign: 'center', padding: 24 }]}>{t('home.none')}</Text>}
          />
        </View>
      )}
      <FriendActions
        friend={actions}
        onClose={closeActions}
        onLocate={locateFriend}
        order={orderOf && orderOf.index >= 0 ? orderOf : undefined} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', bottom: 0, borderTopLeftRadius: radius.l, borderTopRightRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0, overflow: 'hidden' },
  header: { paddingTop: 8, paddingBottom: 6, paddingHorizontal: 16 },
  grab: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: 8 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  stack: { flexDirection: 'row', alignItems: 'center' },
  stackItem: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  controls: { paddingHorizontal: 16, gap: 8, paddingBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
