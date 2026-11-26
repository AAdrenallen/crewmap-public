import { useMemo, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { calendarRange, customRange, metricReport, STAT_METRICS, type RangeKind, type StatMetric } from '@crewmap/shared/stats';
import { t } from '@crewmap/shared/i18n';
import { Bouncy, Button, Card, Chip, Segmented } from '../../ui/kit';
import { palette, useTheme } from '../../ui/theme';
import { EmptyState } from '../../ui/screens-common/Layout';
import { ScreenHeader } from '../../ui/kit';
import { Icon } from '../../ui/kitIcons';
import { MetricChart } from '../../ui/screens-common/MetricChart';
import { Skeleton } from '../../ui/screens-common/Skeleton';
import { useMyStats } from '../../ui/screens-common/useStatsData';
import { dayLabel, formatMetric, metricLabel, monthLabel, rangeLabel, weekdayLabel } from '../../ui/screens-common/statsFormat';

const DAY = 86_400_000;
const COLOR: Record<StatMetric, string> = { distance: palette.brand, driveTime: '#6E56CF', score: palette.ok, topSpeed: palette.pop, events: '#E5484D', walks: '#2EC4B6' };

/** Drill-down for one metric: bars per day/week, period selector with navigation, comparison with the previous period. */
export default function StatDetail() {
  const params = useLocalSearchParams<{ metric?: string }>();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const { width } = useWindowDimensions();
  const data = useMyStats();
  const initial = STAT_METRICS.includes(params.metric as StatMetric) ? (params.metric as StatMetric) : 'distance';
  const [metric, setMetric] = useState<StatMetric>(initial);
  const [kind, setKind] = useState<RangeKind>('week');
  const [offset, setOffset] = useState(0);
  const [now] = useState(() => Date.now());
  const today = customRange(now, now, data.tz).from;
  const [cFrom, setCFrom] = useState(() => today - 13 * DAY);
  const [cTo, setCTo] = useState(today);
  const [sel, setSel] = useState<number | null>(null);

  const range = kind === 'custom' ? customRange(cFrom, cTo, data.tz) : calendarRange(kind, now, data.tz, offset);
  const report = useMemo(() => (data.input ? metricReport(data.input, metric, kind, range, now, data.tz) : null), [data.input, metric, kind, range, now, data.tz]);
  const color = COLOR[metric];
  const cmp = report?.comparison;
  const bucketLabel = (b: { start: number; end: number }) => {
    if (kind === 'year') return monthLabel(b.start);
    if (b.end - b.start > DAY * 1.5 || (report && report.buckets.length > 14)) return dayLabel(b.start);
    return weekdayLabel(b.start);
  };
  const shown = sel !== null && report ? report.buckets[sel] : null;
  const empty = report ? report.buckets.every((b) => !b.value) : false;
  const step = (which: 'from' | 'to', days: number) => {
    if (which === 'from') setCFrom(Math.min(Math.min(cTo, today), cFrom + days * DAY));
    else setCTo(Math.max(cFrom, Math.min(today, cTo + days * DAY)));
    setSel(null);
  };
  const good = cmp?.good;
  const tone = good === null || good === undefined ? th.textSoft : good ? palette.ok : palette.danger;

  return (
    <ScrollView
      style={{ backgroundColor: th.bg }}
      contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={() => void data.refresh()} tintColor={th.accent} colors={[th.accent]} />}
    >
      <ScreenHeader title={metricLabel(metric)} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {STAT_METRICS.map((m) => (
          <Chip key={m} label={metricLabel(m)} active={metric === m} onPress={() => { setMetric(m); setSel(null); }} testID={`metric-${m}`} />
        ))}
      </ScrollView>
      <Segmented
        value={kind}
        onChange={(k) => {
          setKind(k);
          setOffset(0);
          setSel(null);
        }}
        options={[
          { key: 'week', label: t('stats.week') },
          { key: 'month', label: t('stats.month') },
          { key: 'year', label: t('stats.year') },
          { key: 'custom', label: t('stats.custom') },
        ]}
      />
      {kind !== 'custom' ? (
        <View style={styles.nav}>
          <Bouncy hitSlop={8} style={styles.arrow} accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => { setOffset(offset - 1); setSel(null); }} testID="range-prev">
            <Icon name="chevronLeft" color={th.text} size={22} />
          </Bouncy>
          <Text style={[styles.range, { color: th.text }]}>{rangeLabel(range)}</Text>
          <Bouncy hitSlop={8} disabled={offset >= 0} style={[styles.arrow, offset >= 0 && { opacity: 0.3 }]} accessibilityRole="button" accessibilityLabel={t('onb.next')} onPress={() => { setOffset(offset + 1); setSel(null); }} testID="range-next">
            <Icon name="chevronRight" color={th.text} size={22} />
          </Bouncy>
        </View>
      ) : (
        <Card style={{ gap: 10 }}>
          {(['from', 'to'] as const).map((w) => (
            <View key={w} style={{ gap: 6 }}>
              <View style={styles.nav}>
                <Text style={[styles.label, { color: th.textSoft }]}>{t(w === 'from' ? 'stats.from' : 'stats.to')}</Text>
                <Text style={[styles.range, { color: th.text }]}>{dayLabel(w === 'from' ? cFrom : cTo)}</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {[-7, -1, 1, 7].map((d) => (
                  <Chip key={d} label={d > 0 ? `+${d}` : `−${-d}`} onPress={() => step(w, d)} testID={`custom-${w}-${d}`} />
                ))}
              </View>
            </View>
          ))}
        </Card>
      )}

      {data.error && !data.input ? (
        <EmptyState icon="warning" title={t('stats.error')} action={<Button label={t('common.retry')} onPress={() => void data.refresh()} />} />
      ) : !report ? (
        <View style={{ gap: 16 }} testID="stats-loading">
          <Skeleton height={96} radius={20} />
          <Skeleton height={200} radius={20} />
        </View>
      ) : (
        <>
          <Card style={{ gap: 8 }}>
            <Text style={[styles.label, { color: th.textSoft }]}>{shown ? (shown.end - shown.start > DAY * 1.5 ? rangeLabel({ from: shown.start, to: shown.end }) : dayLabel(shown.start)) : rangeLabel(range)}</Text>
            <Text style={[styles.big, { color: th.text }]} testID="detail-value">
              {formatMetric(metric, shown ? shown.value : (cmp?.current ?? null))}
            </Text>
            {!shown && cmp && (
              <View style={styles.cmp} testID="detail-compare">
                <Text style={{ color: tone, fontSize: 16, fontWeight: '800' }}>{cmp.direction === 'up' ? '▲' : cmp.direction === 'down' ? '▼' : '–'}</Text>
                <Text style={{ color: tone, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                  {cmp.delta === null ? '—' : `${cmp.delta > 0 ? '+' : cmp.delta < 0 ? '−' : ''}${formatMetric(metric, Math.abs(cmp.delta))}`}
                  {cmp.pct !== null ? `  (${cmp.pct > 0 ? '+' : cmp.pct < 0 ? '−' : ''}${Math.abs(cmp.pct)}%)` : ''}
                </Text>
                <Text style={[styles.label, { color: th.textSoft }]} numberOfLines={1}>
                  {t('stats.vsPrev')} · {rangeLabel(report.previousRange)}
                </Text>
              </View>
            )}
          </Card>
          {empty && (!cmp || !cmp.previous) ? (
            <EmptyState icon="chart" title={t('stats.empty')} />
          ) : (
            <Card>
              <MetricChart buckets={report.buckets} previous={report.previousBuckets} color={color} width={Math.min(width, lay.wide ? 760 : width) - Math.max(16, lay.gutterL) - Math.max(16, lay.gutterR) - 32} selected={sel} onSelect={setSel} label={bucketLabel} />
            </Card>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  range: { fontSize: 16, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
  label: { fontSize: 13, fontWeight: '600' },
  big: { fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'] },
  cmp: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
