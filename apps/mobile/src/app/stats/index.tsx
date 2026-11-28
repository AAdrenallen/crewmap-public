import { useMemo, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import {
  aggCurrent,
  aggregateFor,
  badgeProgress,
  BADGES,
  CATEGORIES,
  rankCategory,
  type BadgeId,
  type Category,
  type CategoryId,
  type Period,
  type StatsAgg,
  type SharedStats,
  type StatMetric,
  type Stats,
} from '@crewmap/shared/stats';
import { formatKm, formatSpeed } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { Bouncy, Button, Card, Segmented } from '../../ui/kit';
import { Bars, ScoreRing, TrendChart } from '../../ui/charts';
import { AvatarStill } from '../../ui/map/Sprites';
import { palette, useTheme } from '../../ui/theme';
import { EmptyState, SectionLabel } from '../../ui/screens-common/Layout';
import { ScreenHeader } from '../../ui/kit';
import { Icon, IconTile, type IconName } from '../../ui/kitIcons';
import { BadgeMedal } from '../../ui/screens-common/BadgeMedal';
import { Skeleton } from '../../ui/screens-common/Skeleton';
import { useMyStats } from '../../ui/screens-common/useStatsData';

const EVENTS: { k: 'hardBrake' | 'rapidAccel' | 'cornering' | 'speeding' | 'phoneHandling' | 'lateNight'; icon: IconName; color: string }[] = [
  { k: 'hardBrake', icon: 'brake', color: '#E5484D' },
  { k: 'rapidAccel', icon: 'accel', color: '#FB8C00' },
  { k: 'cornering', icon: 'corner', color: '#8E44AD' },
  { k: 'speeding', icon: 'speed', color: '#FFB224' },
  { k: 'phoneHandling', icon: 'phone', color: '#2EC4B6' },
  { k: 'lateNight', icon: 'moon', color: '#3C46C9' },
];
const CAT_LOOK: Record<CategoryId, { icon: IconName; color: string }> = {
  driven: { icon: 'car', color: palette.brand },
  walked: { icon: 'walk', color: palette.ok },
  longest: { icon: 'road', color: palette.brandDeep },
  drives: { icon: 'route', color: '#6E56CF' },
  score: { icon: 'shield', color: palette.ok },
  smooth: { icon: 'butter', color: '#F59E0B' },
  noBrake: { icon: 'brake', color: '#E5484D' },
  topSpeed: { icon: 'speed', color: '#FFB224' },
  homeRuns: { icon: 'home', color: '#5B6CFF' },
  nightOwl: { icon: 'owl', color: '#3C46C9' },
  earlyBird: { icon: 'sunrise', color: '#EA580C' },
  places: { icon: 'pin', color: '#FB8C00' },
};
const MEDAL = ['#F5B400', '#A8B3C4', '#C7834A'];
const GAP = 10;
/** Headline cards: distance driven and walked over the selected period (calendar month by default view). */
const HERO: { k: 'drivenKm' | 'walkedKm'; icon: IconName; tint: string; label: 'stats.driven' | 'stats.walked'; m: StatMetric; testID: string }[] = [
  { k: 'drivenKm', icon: 'car', tint: palette.brand, label: 'stats.driven', m: 'distance', testID: 'stat-driven' },
  { k: 'walkedKm', icon: 'walk', tint: palette.ok, label: 'stats.walked', m: 'walks', testID: 'stat-walked' },
];

function catValue(c: Category, v: number): string {
  if (c.unit === 'km') return formatKm(v, lang());
  if (c.unit === 'kph') return formatSpeed(v, lang());
  if (c.unit === 'per100') return `${v} ${t('lb.per100')}`;
  return String(v);
}

/** Equal cells for a measured row width (no percentage rounding overflow on small screens). */
const cellW = (w: number, cols: number) => Math.floor((w - GAP * (cols - 1)) / cols);

/** F5 + F1e: my stats (all fields) or a friend's (only what they share), trends, events, badges, leaderboard. */
export default function StatsScreen() {
  const { who } = useLocalSearchParams<{ who?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();

  const me = useApp((s) => s.me);
  const allFriends = useApp((s) => s.allFriends);
  const crews = useApp((s) => s.crews);
  const crewFilter = useApp((s) => s.crewFilter);
  const [period, setPeriod] = useState<Period>('week');
  const [view, setView] = useState<'you' | 'board'>('you');
  const [w, setW] = useState(0);
  const friendAggs = useApp((st) => st.friendAggs);
  const places = useApp((st) => st.places);
  const [badge, setBadge] = useState<BadgeId | null>(null);
  const mineData = useMyStats();
  const mine = mineData.stats;

  const friend = who ? allFriends[who] : undefined;
  const s: SharedStats | Stats | undefined = friend ? friend.profile.stats?.[period] : mine?.[period];
  const crewName = crewFilter ? crews.find((c) => c.id === crewFilter)?.name : undefined;

  // Leaderboard (D57): my own aggregate plus each friend's latest sealed aggregate for the same period.
  const cards = useMemo(() => {
    if (!me || !mineData.input) return { cards: [], friends: 0 };
    const now = Date.now();
    const homes = new Set(places.filter((p) => p.type === 'home' && p.owner === me.deviceId).map((p) => p.id));
    const entries: { id: string; agg: StatsAgg }[] = [{ id: me.deviceId, agg: aggregateFor(mineData.input, period, now, mineData.tz, homes) }];
    for (const [id, f] of Object.entries(allFriends)) {
      if (crewFilter && !f.crews.includes(crewFilter)) continue;
      const a = friendAggs[id]?.a[period];
      if (a && aggCurrent(a, period, now, mineData.tz)) entries.push({ id, agg: a });
    }
    const list = CATEGORIES.map((c) => ({ c, ...rankCategory(entries, c, me.deviceId) })).filter((x) => x.top.length > 0);
    return { cards: list, friends: entries.length - 1 };
  }, [me, mineData.input, mineData.tz, places, allFriends, crewFilter, friendAggs, period]);

  const name = friend ? friend.profile.name : (me?.name ?? '');
  const avatar = friend?.profile.avatar ?? me?.avatar;
  const open = (m: StatMetric) => (friend ? undefined : () => router.push({ pathname: '/stats/detail', params: { metric: m } }));
  const tile = (icon: IconName, tint: string, label: string, value: string | number | undefined | null, testID?: string, onPress?: () => void) =>
    value === undefined || value === null ? null : (
      <View key={label} style={{ width: w ? cellW(w, cols) : '47%' }}>
        <Bouncy disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${label} ${value}`}>
          <Card style={styles.tile}>
            <IconTile name={icon} color={tint} size={30} />
            <Text style={[styles.num, { color: th.text }]} testID={testID} numberOfLines={1} adjustsFontSizeToFit>
              {value}
            </Text>
            <Text style={[styles.tileLabel, { color: th.textSoft }]} numberOfLines={1}>
              {label}
            </Text>
          </Card>
        </Bouncy>
      </View>
    );

  const cols = w >= 560 ? 4 : 2;
  const bcols = Math.max(3, Math.min(6, Math.floor((w - 24) / 96)));
  const showBoard = !friend && view === 'board';
  const nameOf = (id: string) => (id === me?.deviceId ? me.name : (allFriends[id]?.profile.name ?? ''));
  const loadingMine = !friend && mineData.loading && !mine;
  const failed = !friend && mineData.error && !mine;
  const badgeList: BadgeId[] = friend ? ((s?.badges ?? []) as BadgeId[]) : [...BADGES];
  const earned = new Set<string>(s?.badges ?? []);

  return (
    <ScrollView
      style={{ backgroundColor: th.bg }}
      contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={friend ? undefined : <RefreshControl refreshing={mineData.refreshing} onRefresh={() => void mineData.refresh()} tintColor={th.accent} colors={[th.accent]} />}
    >
      <ScreenHeader title={name || t('stats.title')} right={avatar ? (friend ? <AvatarStill avatar={avatar} size={52} /> : <Bouncy testID="stats-avatar" accessibilityRole="button" accessibilityLabel={t('onb.avatar')} onPress={() => router.push('/avatar')}><AvatarStill avatar={avatar} size={52} /></Bouncy>) : undefined} />
      {!friend && (
        <Segmented
          value={view}
          onChange={setView}
          testIDPrefix="stats-view-"
          options={[
            { key: 'you', label: t('stats.you') },
            { key: 'board', label: t('stats.board') },
          ]}
        />
      )}
      <Segmented
        value={period}
        onChange={setPeriod}
        options={[
          { key: 'week', label: t('stats.week') },
          { key: 'month', label: t('stats.month') },
          { key: 'all', label: t('stats.all') },
        ]}
      />
      <View onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))} style={{ gap: 16 }}>
        {loadingMine ? (
          <View style={{ gap: 16 }} testID="stats-loading">
            <Skeleton height={120} radius={20} />
            <View style={styles.grid}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={{ width: w ? cellW(w, cols) : '47%' }}>
                  <Skeleton height={110} radius={20} />
                </View>
              ))}
            </View>
          </View>
        ) : failed ? (
          <EmptyState icon="warning" title={t('stats.error')} action={<Button label={t('common.retry')} onPress={() => void mineData.refresh()} />} />
        ) : showBoard ? (
          cards.friends === 0 ? (
            <EmptyState icon="trophy" title={t('lb.empty')} />
          ) : (
            <View style={styles.grid} testID="board">
              {crewName ? <View style={{ width: '100%' }}><SectionLabel>{crewName}</SectionLabel></View> : null}
              {cards.cards.map(({ c, top, me: mineRow }) => (
                <View key={c.id} style={{ width: w ? cellW(w, w >= 560 ? 2 : 1) : '100%' }} testID={`board-cat-${c.id}`}>
                  <Card style={{ gap: 6 }}>
                    <View style={styles.inline}>
                      <IconTile name={CAT_LOOK[c.id].icon} color={CAT_LOOK[c.id].color} size={30} />
                      <Text style={[styles.catTitle, { color: th.text }]} numberOfLines={1}>
                        {t(`lb.cat.${c.id}`)}
                      </Text>
                    </View>
                    {[...top, ...(mineRow ? [mineRow] : [])].map((r) => {
                      const isMe = r.id === me?.deviceId;
                      return (
                        <Bouncy
                          key={r.id}
                          disabled={isMe}
                          onPress={isMe ? undefined : () => router.push({ pathname: '/friend/[id]', params: { id: r.id } })}
                          accessibilityRole={isMe ? undefined : 'button'}
                          accessibilityLabel={`${r.rank}. ${nameOf(r.id)} ${catValue(c, r.value)}`}
                          style={[styles.boardRow, isMe && { backgroundColor: th.cardAlt }]}
                          testID={`board-${c.id}-${isMe ? 'me' : r.rank}`}
                        >
                          <View style={styles.medal}>
                            {r.rank <= 3 && (
                              <Svg width={26} height={26} style={StyleSheet.absoluteFill}>
                                <Circle cx={13} cy={13} r={12} fill={MEDAL[r.rank - 1]} />
                              </Svg>
                            )}
                            <Text style={[styles.rank, { color: r.rank <= 3 ? '#FFFFFF' : th.textSoft }]}>{r.rank}</Text>
                          </View>
                          <Text style={[styles.boardName, { color: th.text }]} numberOfLines={1}>
                            {nameOf(r.id)}
                            {isMe ? ` · ${t('stats.you')}` : ''}
                          </Text>
                          <Text style={[styles.boardVal, { color: th.text }]} numberOfLines={1}>
                            {catValue(c, r.value)}
                          </Text>
                        </Bouncy>
                      );
                    })}
                  </Card>
                </View>
              ))}
            </View>
          )
        ) : !s ? (
          <EmptyState icon="chart" title={t('stats.empty')} />
        ) : (
          <>
            {(s.drivenKm !== undefined || s.walkedKm !== undefined) && (
              <Animated.View entering={FadeInDown.duration(300)} style={styles.grid}>
                {HERO.map((h) => {
                  const v = s[h.k];
                  if (v === undefined) return null;
                  const label = t(h.label);
                  return (
                    <View key={h.k} style={{ width: w ? cellW(w, 2) : '47%' }}>
                      <Bouncy disabled={!!friend} onPress={open(h.m)} accessibilityRole={friend ? undefined : 'button'} accessibilityLabel={`${label} ${formatKm(v, lang())}`}>
                        <Card style={styles.hero}>
                          <IconTile name={h.icon} color={h.tint} size={36} />
                          <Text style={[styles.heroNum, { color: th.text }]} testID={h.testID} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                            {formatKm(v, lang())}
                          </Text>
                          <Text style={[styles.tileLabel, { color: th.textSoft }]} numberOfLines={1}>
                            {label}
                          </Text>
                        </Card>
                      </Bouncy>
                    </View>
                  );
                })}
              </Animated.View>
            )}
            {s.avgScore !== undefined && (
              <Card style={{ gap: 12 }}>
                <Bouncy disabled={!!friend} onPress={open('score')} accessibilityRole={friend ? undefined : 'button'} accessibilityLabel={t('stats.trend')}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                    <ScoreRing score={s.avgScore ?? null} size={104} label={t('stats.trend')} />
                    <View style={{ flex: 1, gap: 10, minWidth: 0 }}>
                      {s.cleanTripStreak !== undefined && (
                        <View style={styles.inline}>
                          <Icon name="shield" color={palette.ok} size={20} />
                          <Text style={[styles.inlineNum, { color: th.text }]}>{s.cleanTripStreak}</Text>
                          <Text style={[styles.tileLabel, styles.shrink, { color: th.textSoft }]} numberOfLines={1}>
                            {t('stats.cleanStreak')}
                          </Text>
                        </View>
                      )}
                      {s.activeStreakDays !== undefined && (
                        <View style={styles.inline}>
                          <Icon name="flame" color="#FB8C00" size={18} />
                          <Text style={[styles.minorNum, { color: th.textSoft }]} testID="stat-streak">
                            {s.activeStreakDays}
                          </Text>
                          <Text style={[styles.minor, styles.shrink, { color: th.textSoft }]} numberOfLines={1}>
                            {t('stats.streak')}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </Bouncy>
                {s.scoreTrend && s.scoreTrend.length > 0 && w > 0 && <TrendChart points={s.scoreTrend} width={w - 32} height={150} />}
              </Card>
            )}
            <View style={styles.grid}>
              {tile('clock', '#6E56CF', t('stats.moving'), s.movingMin !== undefined ? `${Math.round(s.movingMin / 6) / 10} h` : undefined, undefined, open('driveTime'))}
              {tile('road', palette.brandDeep, t('stats.trips'), s.trips)}
              {tile('chart', palette.mint, t('stats.longest'), s.longestTrip ? formatKm(s.longestTrip.km, lang()) : undefined)}
              {tile('speed', palette.pop, t('stats.top'), s.topSpeedKph !== undefined ? formatSpeed(s.topSpeedKph, lang()) : undefined, undefined, open('topSpeed'))}
              {tile('pin', '#FB8C00', t('stats.places'), s.places)}
              {tile('city', palette.grey, t('stats.cities'), s.cities)}
              {s.avgScore === undefined && tile('shield', palette.ok, t('stats.cleanStreak'), s.cleanTripStreak)}
            </View>
            {s.events && (
              <View>
                <SectionLabel>{t('stats.events')}</SectionLabel>
                <Bouncy disabled={!!friend} onPress={open('events')} accessibilityRole={friend ? undefined : 'button'} accessibilityLabel={t('stats.events')}>
                  <Card>
                    <Bars rows={EVENTS.map((e) => ({ label: t(`ev.${e.k}`), value: s.events?.[e.k] ?? 0, color: e.color, icon: <IconTile name={e.icon} color={e.color} size={30} /> }))} />
                  </Card>
                </Bouncy>
              </View>
            )}
            {badgeList.length > 0 && (
              <View>
                <SectionLabel>{t('stats.badges')}</SectionLabel>
                <Card style={styles.badges}>
                  {badgeList.map((b) => (
                    <Bouncy
                      key={b}
                      style={[styles.badge, { width: w ? Math.floor((w - 24) / bcols) : 96 }]}
                      onPress={() => setBadge(b)}
                      accessibilityRole="button"
                      accessibilityLabel={t(`badge.${b}`)}
                      testID={`badge-${b}`}
                    >
                      <BadgeMedal id={b} size={56} locked={!earned.has(b)} />
                      <Text style={[styles.badgeText, { color: th.text }]} numberOfLines={2}>
                        {t(`badge.${b}`)}
                      </Text>
                    </Bouncy>
                  ))}
                </Card>
              </View>
            )}
          </>
        )}
      </View>
      <BadgeSheet id={badge} onClose={() => setBadge(null)} mine={!friend} earned={badge ? earned.has(badge) : false} data={mineData} />
    </ScrollView>
  );
}

function BadgeSheet({ id, onClose, mine, earned, data }: { id: BadgeId | null; onClose: () => void; mine: boolean; earned: boolean; data: ReturnType<typeof useMyStats> }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const prog = id && mine && data.input && data.stats ? badgeProgress(id, data.input, data.stats.all, data.tz) : null;
  return (
    <Modal visible={id !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel={t('common.close')}>
        {id && (
          <Pressable style={[styles.sheet, { backgroundColor: th.card, paddingBottom: insets.bottom + 20 }]} onPress={() => undefined}>
            <BadgeMedal id={id} size={96} locked={!earned} />
            <Text style={[styles.sheetTitle, { color: th.text }]}>{t(`badge.${id}`)}</Text>
            <Text style={[styles.sheetBody, { color: th.textSoft }]}>{t(`badge.d.${id}`)}</Text>
            {prog && (
              <View style={{ width: '100%', gap: 8 }}>
                <View style={styles.progRow}>
                  <Text style={[styles.tileLabel, { color: th.textSoft }]}>{prog.done ? t('stats.earned') : t('stats.progress')}</Text>
                  <Text style={[styles.inlineNum, { color: th.text }]}>
                    {prog.current} / {prog.target} {t(`stats.unit.${prog.unit}`)}
                  </Text>
                </View>
                <View style={{ height: 10, borderRadius: 5, backgroundColor: th.cardAlt, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.min(100, (prog.current / prog.target) * 100)}%`, height: '100%', backgroundColor: prog.done ? palette.ok : th.accent, borderRadius: 5 }} />
                </View>
              </View>
            )}
            <Button label={t('common.close')} onPress={onClose} kind="secondary" />
          </Pressable>
        )}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  tile: { padding: 14, gap: 6, minHeight: 110 },
  hero: { padding: 16, gap: 8, minHeight: 132 },
  heroNum: { fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  minor: { fontSize: 12, fontWeight: '600' },
  minorNum: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  shrink: { flexShrink: 1 },
  catTitle: { fontSize: 15, fontWeight: '800', flexShrink: 1 },
  medal: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  num: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: 13, fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineNum: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  badges: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14, paddingHorizontal: 12 },
  badge: { height: 100, alignItems: 'center', justifyContent: 'flex-start', gap: 6, paddingHorizontal: 2 },
  badgeText: { fontSize: 12, lineHeight: 15, minHeight: 30, fontWeight: '700', textAlign: 'center' },
  boardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 8, borderRadius: 12 },
  rank: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  boardName: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700' },
  boardVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  delta: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '800' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { alignItems: 'center', gap: 12, padding: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  sheetTitle: { fontSize: 22, fontWeight: '800' },
  sheetBody: { fontSize: 15, fontWeight: '500', textAlign: 'center' },
  progRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
