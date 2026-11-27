import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lang, t } from '@crewmap/shared/i18n';
import { seasonSummary, type SeasonKey } from '@crewmap/shared/memories';
import { formatKm } from '@crewmap/shared/units';
import { digestOf, memoryTz, refreshMemories, useMemories } from '../../core/memories';
import { Bouncy, Card, EmptyState, ScreenHeader, SectionLabel } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/kitIcons';
import { dateLocale } from '../../ui/charts';
import { pageX, useLayoutMode } from '../../ui/layout';
import { AvatarStill } from '../../ui/map/Sprites';
import { useTweenedNumber } from '../../ui/drive/useTweenedNumber';
import { usePeople } from '../../ui/memories/memoryUi';
import { font, palette, radius, type, useTheme } from '../../ui/theme';

const SEASONS: SeasonKey[] = ['winter', 'spring', 'summer', 'fall', 'year'];

/** Season / year in review (D68), computed on this phone from its own memories. */
export default function SeasonReview() {
  const p = useLocalSearchParams<{ season: string; year: string }>();
  const season: SeasonKey = (SEASONS as string[]).includes(p.season ?? '') ? (p.season as SeasonKey) : 'year';
  const year = Number(p.year) || new Date().getFullYear();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const rows = useMemories((s) => s.rows);
  useEffect(() => {
    void refreshMemories();
  }, []);
  const s = useMemo(() => seasonSummary(rows.map(digestOf), season, year, memoryTz()), [rows, season, year]);
  const people = usePeople(s?.crew.map((c) => c.id) ?? []);
  const title = t(`mem.season.${season}`, { year: String(year) });

  if (!s)
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8, ...pageX(lay) }}>
        <ScreenHeader title={title} />
        <EmptyState icon="sparkle" title={t('mem.empty')} />
      </View>
    );

  const month = s.busiestMonth === null ? null : new Date(Date.UTC(year, s.busiestMonth, 15)).toLocaleDateString(dateLocale(lang()), { month: 'long' });
  const top = s.crew[0]?.outings ?? 1;
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ ...pageX(lay) }}>
        <ScreenHeader title={title} />
      </View>
      <ScrollView contentContainerStyle={{ ...pageX(lay), gap: 18, paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        <Animated.View entering={ZoomIn.springify().damping(14)} style={[styles.hero, { backgroundColor: palette.brand }]}>
          <Text style={[type.overline, { color: 'rgba(255,255,255,0.8)' }]}>{title}</Text>
          <Big value={s.outings} label={t('mem.sum.outings')} />
          <Text style={[type.body, { color: '#fff' }]}>{t('mem.sum.group', { count: String(s.groupOutings) })}</Text>
        </Animated.View>
        <View style={styles.grid}>
          <Tile i={0} icon="road" value={formatKm(s.km, lang())} label={t('mem.sum.km')} />
          <Tile i={1} icon="clock" value={`${s.hours} h`} label={t('mem.sum.hours')} />
          <Tile i={2} icon="camera" value={String(s.photos)} label={t('mem.sum.photos')} />
          <Tile i={3} icon="sparkle" value={String(s.emotes)} label={t('mem.sum.emotes')} />
          <Tile i={4} icon="flame" value={String(s.weekStreak)} label={t('mem.sum.streak')} />
          {month && <Tile i={5} icon="star" value={month} label={t('mem.sum.month')} />}
        </View>
        {s.crew.length > 0 && (
          <View>
            <SectionLabel>{t('mem.sum.crew')}</SectionLabel>
            <Card style={{ gap: 12 }}>
              {s.crew.slice(0, 6).map((c, i) => (
                <Animated.View key={c.id} entering={FadeInDown.delay(150 + i * 70).springify().damping(16)} style={styles.crew}>
                  {people[c.id] && <AvatarStill avatar={people[c.id]!.avatar} size={40} />}
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={[type.body, font('semibold'), { color: th.text }]} numberOfLines={1}>
                      {people[c.id]?.name}
                    </Text>
                    <View style={[styles.bar, { backgroundColor: th.cardAlt }]}>
                      <Animated.View entering={FadeInDown.delay(250 + i * 70)} style={[styles.barIn, { width: `${Math.max(8, (c.outings / top) * 100)}%`, backgroundColor: i === 0 ? palette.sun : th.accent }]} />
                    </View>
                  </View>
                  <Text style={[type.headline, { color: th.text }]}>{c.outings}</Text>
                </Animated.View>
              ))}
            </Card>
          </View>
        )}
        {s.places.length > 0 && (
          <View>
            <SectionLabel>{t('mem.places')}</SectionLabel>
            <View style={styles.chips}>
              {s.places.map((pl) => (
                <View key={pl.name} style={[styles.chip, { backgroundColor: th.card, borderColor: th.border }]}>
                  <Icon name="pin" size={15} color={th.accent} />
                  <Text style={[type.small, { color: th.text }]}>{pl.name}</Text>
                  <Text style={[type.caption, { color: th.textSoft }]}>×{pl.n}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
        {s.longest && (
          <Bouncy testID="mem-sum-longest" accessibilityRole="button" onPress={() => router.push({ pathname: '/memories/[id]', params: { id: s.longest!.id } })} style={[styles.longest, { backgroundColor: th.card, borderColor: th.border }]}>
            <Icon name="trophy" size={22} color={palette.sun} />
            <Text style={[type.body, font('semibold'), { color: th.text, flex: 1 }]}>{t('mem.sum.longest')}</Text>
            <Text style={[type.headline, { color: th.text }]}>{formatKm(s.longest.km, lang())}</Text>
            <Icon name="chevronRight" size={20} color={th.textFaint} />
          </Bouncy>
        )}
      </ScrollView>
    </View>
  );
}

function Big({ value, label }: { value: number; label: string }) {
  const [go, setGo] = useState(0);
  useEffect(() => setGo(value), [value]);
  const n = useTweenedNumber(go, 1100);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
      <Text testID="mem-sum-outings" style={[type.hero, { color: '#fff', fontSize: 64, lineHeight: 72 }]}>{n}</Text>
      <Text style={[type.headline, { color: '#fff' }]}>{label}</Text>
    </View>
  );
}

function Tile({ i, icon, value, label }: { i: number; icon: IconName; value: string; label: string }) {
  const th = useTheme();
  return (
    <Animated.View entering={ZoomIn.delay(100 + i * 60).springify().damping(13)} style={styles.tileWrap}>
      <Card style={styles.tile}>
        <Icon name={icon} size={20} color={th.accent} />
        <Text style={[type.num, { color: th.text, textTransform: 'capitalize' }]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        <Text style={[type.caption, { color: th.textSoft }]}>{label}</Text>
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.l, padding: 20, gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tileWrap: { width: '31.5%' },
  tile: { padding: 12, gap: 4, minHeight: 104 },
  crew: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barIn: { height: 8, borderRadius: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 36, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  longest: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, minHeight: 56 },
});
