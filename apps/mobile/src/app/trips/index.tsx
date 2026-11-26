import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import { Modal, Pressable, RefreshControl, ScrollView, SectionList, Share, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { filterTrips, groupByDay, NO_FILTER, tripToGpx, type ScoreBand, type TripFilter } from '@crewmap/shared/driving';
import { formatClock, formatKm, formatMinutes, formatSpeed } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import * as db from '../../core/db';
import { useApp } from '../../core/store';
import { Bouncy, Card, Chip, Toast } from '../../ui/kit';
import { dateLocale, Glyph, RouteThumb, scoreColor } from '../../ui/charts';
import { useTheme } from '../../ui/theme';
import { EmptyState } from '../../ui/screens-common/Layout';
import { ScreenHeader } from '../../ui/kit';
import { Icon } from '../../ui/kitIcons';

const UNDO_MS = 5000;
const BANDS: Exclude<ScoreBand, 'none'>[] = ['great', 'good', 'fair', 'poor'];

/** Draws the stored ~40-point polyline; no per-row database access. */
const Thumb = memo(function Thumb({ item, color }: { item: db.TripListItem; color: string }) {
  return <RouteThumb points={item.thumb} color={color} size={60} />;
});

function Skeleton() {
  const th = useTheme();
  const o = useSharedValue(0.4);
  useEffect(() => {
    o.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <View style={{ gap: 10, padding: 16 }} testID="trips-skeleton">
      {[0, 1, 2, 3, 4].map((i) => (
        <Animated.View key={i} style={[styles.row, { backgroundColor: th.card, borderColor: th.border }, style]}>
          <View style={{ width: 60, height: 60, borderRadius: 14, backgroundColor: th.cardAlt }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ height: 14, width: '60%', borderRadius: 7, backgroundColor: th.cardAlt }} />
            <View style={{ height: 12, width: '85%', borderRadius: 6, backgroundColor: th.cardAlt }} />
          </View>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: th.cardAlt }} />
        </Animated.View>
      ))}
    </View>
  );
}

export default function Trips() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const l = lang();
  const [trips, setTrips] = useState<db.TripListItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<TripFilter>(NO_FILTER);
  const [menu, setMenu] = useState<db.TripListItem | null>(null);
  const [undo, setUndo] = useState<db.DeletedTrip | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tripStartedAt = useApp((s) => s.tripStartedAt);

  const load = useCallback(async () => {
    try {
      const x = await db.tripList();
      setTrips(x.sort((a, b) => b.startedAt - a.startedAt));
    } catch {
      setTrips((p) => p ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, tripStartedAt]);
  useEffect(() => {
    let live = true;
    void db.backfillTripPolys().then((n) => { if (live && n > 0) void load(); }, () => undefined);
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), []);

  const shown = useMemo(() => filterTrips(trips ?? [], filter, Date.now()), [trips, filter]);
  const sections = useMemo(
    () => groupByDay(shown).map((g) => ({ key: g.key, t: g.t, distanceM: g.distanceM, data: g.trips })),
    [shown],
  );
  const totalM = useMemo(() => shown.reduce((a, x) => a + x.distanceM, 0), [shown]);

  const remove = async (item: db.TripListItem) => {
    setMenu(null);
    const d = await db.deleteTrip(item.id).catch(() => null);
    if (!d) return;
    setTrips((p) => (p ? p.filter((x) => x.id !== item.id) : p));
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(d);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };
  const restore = async () => {
    const d = undo;
    if (!d) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
    await db.restoreTrip(d).catch(() => undefined);
    await load();
  };
  const exportGpx = async (item: db.TripListItem) => {
    setMenu(null);
    const tr = await db.loadTrip(item.id).catch(() => null);
    if (!tr) return;
    const name = `${new Date(tr.startedAt).toLocaleDateString(dateLocale(l))} ${formatClock(tr.startedAt)}`;
    await Share.share({ title: `${name}.gpx`, message: tripToGpx(tr, name) }).catch(() => undefined);
  };

  const chip = (label: string, active: boolean, onPress: () => void, id: string) => <Chip key={id} testID={`trips-f-${id}`} label={label} active={active} onPress={onPress} />;

  const header = (
    <View style={{ gap: 12, paddingBottom: 6 }}>
      <Card style={styles.summary}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.meta, { color: th.textSoft }]}>{t('trips.total')}</Text>
          <Text testID="trips-total" style={[styles.big, { color: th.text }]}>{formatKm(totalM / 1000, l)}</Text>
        </View>
        <Text style={[styles.big, { color: th.accent }]}>{shown.length}</Text>
      </Card>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {(['week', 'month', 'all'] as const).map((p) => chip(t(`trips.${p}`), filter.period === p, () => setFilter({ ...filter, period: p }), p))}
        <View style={{ width: 8 }} />
        {(['all', 'driver', 'passenger'] as const).map((r) =>
          chip(r === 'all' ? t('trips.roleAll') : t(`trips.${r}`), filter.role === r, () => setFilter({ ...filter, role: r }), `r-${r}`),
        )}
        <View style={{ width: 8 }} />
        {BANDS.map((b) => chip(t(`band.${b}`), filter.band === b, () => setFilter({ ...filter, band: filter.band === b ? null : b }), `b-${b}`))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ ...pageX(lay) }}>
        <ScreenHeader title={t('trips.title')} />
      </View>
      {trips === null ? (
        <Skeleton />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(x) => x.id}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={th.accent} colors={[th.accent]} onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }} />}
          contentContainerStyle={{ ...pageX(lay), gap: 10, paddingTop: 16, paddingBottom: insets.bottom + 96, flexGrow: 1 }}
          ListHeaderComponent={trips.length > 0 ? header : undefined}
          ListEmptyComponent={<EmptyState icon="car" title={trips.length === 0 ? t('trips.empty') : t('trips.noMatch')} />}
          renderSectionHeader={({ section }) => (
            <View style={styles.day}>
              <Text style={[styles.dayText, { color: th.textSoft }]}>{new Date(section.t).toLocaleDateString(dateLocale(l), { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
              <Text style={[styles.dayText, { color: th.textSoft }]}>{formatKm(section.distanceM / 1000, l)}</Text>
            </View>
          )}
          renderItem={({ item, index }) => {
            const col = item.score === null ? th.textSoft : scoreColor(item.score);
            const evs = Object.values(item.events).reduce<number>((a, b) => a + (b ?? 0), 0);
            return (
              <Animated.View entering={FadeInDown.delay(Math.min(index, 8) * 35).duration(260)}>
                <Bouncy
                  testID={`trip-row-${index}`}
                  accessibilityLabel={`${formatKm(item.distanceM / 1000, l)}`}
                  onPress={() => router.push({ pathname: '/trips/[id]', params: { id: item.id } })}
                  onLongPress={() => setMenu(item)}
                  style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}
                >
                  <Thumb item={item} color={item.passenger ? th.textSoft : th.accent} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={[styles.title, { color: th.text }]} numberOfLines={1}>
                      {formatClock(item.startedAt)}
                    </Text>
                    <Text style={[styles.meta, { color: th.textSoft }]} numberOfLines={1}>
                      {formatKm(item.distanceM / 1000, l)} · {formatMinutes(item.durationS)} · {formatSpeed(item.topSpeedKph, l)}
                    </Text>
                    {evs > 0 && (
                      <View style={styles.evs}>
                        <Icon name="warning" size={13} color="#FFB224" strokeWidth={2.2} />
                        <Text style={[styles.meta, { color: th.textSoft, fontSize: 12 }]}>{evs}</Text>
                      </View>
                    )}
                  </View>
                  <View style={[styles.score, { borderColor: col }]}>
                    <Text style={[styles.scoreText, { color: col }]}>{item.score ?? '—'}</Text>
                  </View>
                  <Pressable testID={`trip-more-${index}`} accessibilityRole="button" accessibilityLabel={t('trip.menu')} hitSlop={8} onPress={() => setMenu(item)} style={styles.more}>
                    <Glyph kind="more" color={th.textSoft} size={20} />
                  </Pressable>
                </Bouncy>
              </Animated.View>
            );
          }}
        />
      )}
      <Modal transparent visible={menu !== null} animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={styles.scrim} onPress={() => setMenu(null)} accessibilityLabel={t('common.close')}>
          <View style={[styles.menu, { backgroundColor: th.card, borderColor: th.border, marginBottom: insets.bottom + 16 }]}>
            <Bouncy testID="trip-menu-export" accessibilityRole="button" style={styles.menuRow} onPress={() => menu && void exportGpx(menu)}>
              <Icon name="download" color={th.text} size={22} />
              <Text style={[styles.title, { color: th.text }]}>{t('trips.exportGpx')}</Text>
            </Bouncy>
            <Bouncy testID="trip-menu-delete" accessibilityRole="button" style={styles.menuRow} onPress={() => menu && void remove(menu)}>
              <Icon name="trash" color={th.danger} size={22} />
              <Text style={[styles.title, { color: th.danger }]}>{t('trips.delete')}</Text>
            </Bouncy>
          </View>
        </Pressable>
      </Modal>
      {undo && <Toast testID="trip-undo" message={`${t('trips.deleted')} · ${t('trips.undo')}`} onPress={() => void restore()} style={{ position: 'absolute', alignSelf: 'center', bottom: insets.bottom + 24 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, padding: 10, paddingRight: 8, borderWidth: StyleSheet.hairlineWidth, minHeight: 80 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  big: { fontSize: 26, fontWeight: '800', fontVariant: ['tabular-nums'] },
  day: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10, paddingHorizontal: 4 },
  dayText: { fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  more: { width: 36, height: 48, alignItems: 'center', justifyContent: 'center' },
  score: { width: 48, height: 48, borderRadius: 24, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  scoreText: { fontWeight: '800', fontSize: 17, fontVariant: ['tabular-nums'] },
  title: { fontSize: 16, fontWeight: '700' },
  meta: { fontWeight: '600', fontSize: 13.5 },
  evs: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', paddingHorizontal: 16 },
  menu: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20 },
});
