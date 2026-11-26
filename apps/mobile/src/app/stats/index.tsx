import { useMemo, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import {
  badgeProgress,
  bestTrend,
  BADGES,
  buildBoard,
  type BadgeId,
  type BoardEntry,
  type LeaderboardMetric,
  type Period,
  type SharedStats,
  type StatMetric,
  type Stats,
} from '@crewmap/shared/stats';
import { formatKm, formatSpeed } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { Bouncy, Button, Card, Chip, Segmented } from '../../ui/kit';
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
const METRICS: { key: LeaderboardMetric; label: () => string }[] = [
  { key: 'avgScore', label: () => t('stats.trend') },
  { key: 'drivenKm', label: () => t('stats.driven') },
  { key: 'walkedKm', label: () => t('stats.walked') },
  { key: 'activeStreakDays', label: () => t('stats.streak') },
  { key: 'cleanTripStreak', label: () => t('stats.cleanStreak') },
  { key: 'cities', label: () => t('stats.cities') },
];
const MEDAL = ['#F5B400', '#A8B3C4', '#C7834A'];

function boardValue(metric: LeaderboardMetric, v: number): string {
  return metric === 'drivenKm' || metric === 'walkedKm' ? formatKm(v, lang()) : String(v);
}

/** F5 + F1e: my stats (all fields) or a friend's (only what they share), trends, events, badges, leaderboard. */
export default function StatsScreen() {
  const { who } = useLocalSearchParams<{ who?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const { width } = useWindowDimensions();
  const me = useApp((s) => s.me);
  const allFriends = useApp((s) => s.allFriends);
  const crews = useApp((s) => s.crews);
  const crewFilter = useApp((s) => s.crewFilter);
  const [period, setPeriod] = useState<Period>('week');
  const [metric, setMetric] = useState<LeaderboardMetric>('avgScore');
  const [badge, setBadge] = useState<BadgeId | null>(null);
  const mineData = useMyStats();
  const mine = mineData.stats;

  const friend = who ? allFriends[who] : undefined;
  const s: SharedStats | Stats | undefined = friend ? friend.profile.stats?.[period] : mine?.[period];
  const crewName = crewFilter ? crews.find((c) => c.id === crewFilter)?.name : undefined;

  const board = useMemo(() => {
    if (!mine || !me) return [];
    const entries: BoardEntry[] = [{ id: me.deviceId, stats: { ...mine[period], updatedAt: 0 }, trend: mine.all.scoreTrend }];
    for (const f of Object.values(allFriends)) {
      if (crewFilter && !f.crews.includes(crewFilter)) continue;
      entries.push({ id: f.profile.deviceId, stats: f.profile.stats?.[period] ?? null, trend: bestTrend(f.profile.stats) });
    }
    return buildBoard(entries, metric, period);
  }, [mine, me, allFriends, crewFilter, period, metric]);

  const name = friend ? friend.profile.name : (me?.name ?? '');
  const avatar = friend?.profile.avatar ?? me?.avatar;
  const open = (m: StatMetric) => (friend ? undefined : () => router.push({ pathname: '/stats/detail', params: { metric: m } }));
  const tile = (icon: IconName, tint: string, label: string, value: string | number | undefined | null, testID?: string, onPress?: () => void) =>
    value === undefined || value === null ? null : (
      <View key={label} style={styles.tileWrap}>
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
      <Segmented
        value={period}
        onChange={setPeriod}
        options={[
          { key: 'week', label: t('stats.week') },
          { key: 'month', label: t('stats.month') },
          { key: 'all', label: t('stats.all') },
        ]}
      />
      {loadingMine ? (
        <View style={{ gap: 16 }} testID="stats-loading">
          <Skeleton height={190} radius={20} />
          <View style={styles.grid}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.tileWrap}>
                <Skeleton height={110} radius={20} />
              </View>
            ))}
          </View>
        </View>
      ) : failed ? (
        <EmptyState icon="warning" title={t('stats.error')} action={<Button label={t('common.retry')} onPress={() => void mineData.refresh()} />} />
      ) : !s ? (
        <EmptyState icon="chart" title={t('stats.empty')} />
      ) : (
        <>
          {s.avgScore !== undefined && (
            <Animated.View entering={FadeInDown.duration(300)}>
              <Card style={{ gap: 12 }}>
                <Bouncy disabled={!!friend} onPress={open('score')} accessibilityRole={friend ? undefined : 'button'} accessibilityLabel={t('stats.trend')}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                    <ScoreRing score={s.avgScore ?? null} size={112} label={t('stats.trend')} />
                    <View style={{ flex: 1, gap: 10 }}>
                      {s.activeStreakDays !== undefined && (
                        <View style={styles.inline}>
                          <Icon name="flame" color="#FB8C00" fill="#FB8C0033" size={22} />
                          <Text style={[styles.inlineNum, { color: th.text }]} testID="stat-streak">
                            {s.activeStreakDays}
                          </Text>
                          <Text style={[styles.tileLabel, { color: th.textSoft }]}>{t('stats.streak')}</Text>
                        </View>
                      )}
                      {s.cleanTripStreak !== undefined && (
                        <View style={styles.inline}>
                          <Icon name="shield" color={palette.ok} size={22} />
                          <Text style={[styles.inlineNum, { color: th.text }]}>{s.cleanTripStreak}</Text>
                          <Text style={[styles.tileLabel, { color: th.textSoft }]} numberOfLines={1}>
                            {t('stats.cleanStreak')}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </Bouncy>
                {s.scoreTrend && s.scoreTrend.length > 0 && <TrendChart points={s.scoreTrend} width={Math.min(width, lay.wide ? 760 : width) - Math.max(16, lay.gutterL) - Math.max(16, lay.gutterR) - 32} height={150} />}
              </Card>
            </Animated.View>
          )}
          <View style={styles.grid}>
            {tile('car', palette.brand, t('stats.driven'), s.drivenKm !== undefined ? formatKm(s.drivenKm, lang()) : undefined, 'stat-driven', open('distance'))}
            {tile('walk', palette.ok, t('stats.walked'), s.walkedKm !== undefined ? formatKm(s.walkedKm, lang()) : undefined, 'stat-walked', open('walks'))}
            {tile('clock', '#6E56CF', t('stats.moving'), s.movingMin !== undefined ? `${Math.round(s.movingMin / 6) / 10} h` : undefined, undefined, open('driveTime'))}
            {tile('road', palette.brandDeep, t('stats.trips'), s.trips)}
            {tile('chart', palette.mint, t('stats.longest'), s.longestTrip ? formatKm(s.longestTrip.km, lang()) : undefined)}
            {tile('speed', palette.pop, t('stats.top'), s.topSpeedKph !== undefined ? formatSpeed(s.topSpeedKph, lang()) : undefined, undefined, open('topSpeed'))}
            {tile('pin', '#FB8C00', t('stats.places'), s.places)}
            {tile('city', palette.grey, t('stats.cities'), s.cities)}
            {s.avgScore === undefined && tile('flame', '#FB8C00', t('stats.streak'), s.activeStreakDays, 'stat-streak')}
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
                  <Bouncy key={b} style={styles.badge} onPress={() => setBadge(b)} accessibilityRole="button" accessibilityLabel={t(`badge.${b}`)} testID={`badge-${b}`}>
                    <BadgeMedal id={b} locked={!earned.has(b)} />
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
      {!friend && board.length > 0 && (
        <View>
          <SectionLabel>{crewName ? `${t('stats.board')} · ${crewName}` : t('stats.board')}</SectionLabel>
          <Card>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 10 }}>
              {METRICS.map((m) => (
                <Chip key={m.key} label={m.label()} active={metric === m.key} onPress={() => setMetric(m.key)} />
              ))}
            </ScrollView>
            {board.map((r, i) => {
              const isMe = r.id === me?.deviceId;
              const f = allFriends[r.id];
              const rowName = isMe ? me.name : (f?.profile.name ?? '');
              const grey = !isMe && r.rank === null;
              const onPress = isMe ? undefined : () => (r.shares ? router.push({ pathname: '/stats', params: { who: r.id } }) : router.push({ pathname: '/friend/[id]', params: { id: r.id } }));
              const better = r.delta !== null && r.delta !== 0 ? r.delta > 0 : null;
              return (
                <Bouncy
                  key={r.id}
                  disabled={!onPress}
                  onPress={onPress}
                  accessibilityRole={onPress ? 'button' : undefined}
                  style={[styles.boardRow, isMe && { backgroundColor: th.cardAlt }, grey && { opacity: 0.5 }, i < board.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border }]}
                  testID={r.rank !== null ? `board-${r.rank}` : `board-none-${r.id}`}
                >
                  {r.rank !== null && r.rank <= 3 ? (
                    <Svg width={30} height={30}>
                      <Circle cx={15} cy={15} r={13} fill={MEDAL[r.rank - 1]} />
                      <Circle cx={15} cy={15} r={9.5} fill="none" stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={1.5} />
                    </Svg>
                  ) : (
                    <View style={{ width: 30 }} />
                  )}
                  <Text style={[styles.rank, { color: r.rank !== null && r.rank <= 3 ? '#FFFFFF' : th.textSoft }]}>{r.rank ?? '–'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.boardName, { color: th.text }]} numberOfLines={1}>
                      {rowName}
                      {isMe ? ` · ${t('stats.you')}` : ''}
                    </Text>
                    {grey && (
                      <Text style={[styles.tileLabel, { color: th.textSoft }]} numberOfLines={1}>
                        {t('stats.noShare')}
                      </Text>
                    )}
                  </View>
                  {r.rankChange !== null && r.rankChange !== 0 && (
                    <Text style={[styles.change, { color: r.rankChange > 0 ? palette.ok : palette.danger }]}>
                      {r.rankChange > 0 ? '▲' : '▼'}
                      {Math.abs(r.rankChange)}
                    </Text>
                  )}
                  {r.value !== null && (
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[styles.boardVal, { color: th.text }]}>{boardValue(metric, r.value)}</Text>
                      {r.delta !== null && r.delta !== 0 && (
                        <Text style={[styles.delta, { color: better ? palette.ok : palette.danger }]}>
                          {r.delta > 0 ? '+' : '−'}
                          {boardValue(metric, Math.abs(r.delta))}
                        </Text>
                      )}
                    </View>
                  )}
                </Bouncy>
              );
            })}
          </Card>
        </View>
      )}
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tileWrap: { width: '48.5%' },
  tile: { padding: 14, gap: 6 },
  num: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: 13, fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineNum: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  badges: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 },
  badge: { width: '33.3%', alignItems: 'center', gap: 6 },
  badgeText: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  boardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 8, borderRadius: 12 },
  rank: { position: 'absolute', left: 8, width: 30, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  boardName: { fontSize: 15, fontWeight: '700' },
  boardVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  delta: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '800' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { alignItems: 'center', gap: 12, padding: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  sheetTitle: { fontSize: 22, fontWeight: '800' },
  sheetBody: { fontSize: 15, fontWeight: '500', textAlign: 'center' },
  progRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
