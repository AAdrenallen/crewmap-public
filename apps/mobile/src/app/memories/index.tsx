import { useEffect, useMemo } from 'react';
import { FlatList, Image, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lang, t } from '@crewmap/shared/i18n';
import { seasonChoices } from '@crewmap/shared/memories';
import { formatKm } from '@crewmap/shared/units';
import { digestOf, memoryTz, refreshMemories, useMemories, type MemoryRow } from '../../core/memories';
import { Bouncy, EmptyState, ScreenHeader } from '../../ui/kit';
import { Icon } from '../../ui/kitIcons';
import { RouteThumb } from '../../ui/charts';
import { pageX, useLayoutMode } from '../../ui/layout';
import { AvatarStill } from '../../ui/map/Sprites';
import { memoryDate, memoryTitle, usePeople } from '../../ui/memories/memoryUi';
import { font, palette, radius, type, useTheme } from '../../ui/theme';

/** Trip memories (D68): group outings and notable drives, newest first, with the season review on top. */
export default function MemoriesList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const rows = useMemories((s) => s.rows);
  const loaded = useMemories((s) => s.loaded);
  useEffect(() => {
    void refreshMemories();
  }, []);
  const seasons = useMemo(() => seasonChoices(rows.map(digestOf), Date.now(), memoryTz()), [rows]);

  const header =
    seasons.length > 0 ? (
      <View style={styles.seasons}>
        {seasons.map((s, i) => (
          <Animated.View key={`${s.season}${s.year}`} entering={FadeInDown.delay(i * 50).springify().damping(16)}>
            <Bouncy
              testID={`mem-season-${s.season}-${s.year}`}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/memories/season', params: { season: s.season, year: String(s.year) } })}
              style={[styles.season, { backgroundColor: s.season === 'year' ? palette.brand : th.accentSoft }]}
            >
              <Icon name="sparkle" size={18} color={s.season === 'year' ? '#fff' : th.accent} />
              <Text style={[type.small, { color: s.season === 'year' ? '#fff' : th.accent }]}>{t(`mem.season.${s.season}`, { year: String(s.year) })}</Text>
            </Bouncy>
          </Animated.View>
        ))}
      </View>
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ ...pageX(lay) }}>
        <ScreenHeader title={t('mem.title')} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ ...pageX(lay), gap: 12, paddingTop: 12, paddingBottom: insets.bottom + 48, flexGrow: 1 }}
        ListHeaderComponent={header ?? undefined}
        ListEmptyComponent={loaded ? <EmptyState testID="mem-empty" icon="sparkle" title={t('mem.empty')} /> : undefined}
        renderItem={({ item, index }) => <Row row={item} index={index} onPress={() => router.push({ pathname: '/memories/[id]', params: { id: item.id } })} />}
      />
    </View>
  );
}

function Row({ row, index, onPress }: { row: MemoryRow; index: number; onPress: () => void }) {
  const th = useTheme();
  const people = usePeople(row.members);
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 8) * 40).springify().damping(16)}>
      <Bouncy testID={`mem-row-${index}`} accessibilityRole="button" accessibilityLabel={memoryTitle(row)} onPress={onPress} style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}>
        <View style={[styles.cover, { backgroundColor: th.cardAlt }]}>
          {row.cover ? <Image source={{ uri: row.cover }} style={StyleSheet.absoluteFill} /> : <RouteThumb points={row.thumb} color={th.accent} size={72} />}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[type.headline, { color: th.text }]} numberOfLines={1}>
            {memoryTitle(row)}
          </Text>
          <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={1}>
            {[row.title ? memoryDate(row.start) : null, row.distanceM > 0 ? formatKm(row.distanceM / 1000, lang()) : null, row.places[0] ?? null].filter(Boolean).join(' · ')}
          </Text>
          <View style={styles.meta}>
            {row.members.slice(0, 4).map((m, i) => (
              <View key={m} style={[styles.face, { marginLeft: i ? -8 : 0, borderColor: th.card, backgroundColor: th.cardAlt }]}>
                {people[m] && <AvatarStill avatar={people[m]!.avatar} size={22} />}
              </View>
            ))}
            {row.kind === 'notable' && <Icon name="star" size={15} color={palette.sun} />}
            {row.photos > 0 && <Count icon="camera" n={row.photos} />}
            {row.emotes > 0 && <Count icon="sparkle" n={row.emotes} />}
            {row.kept && <Icon name="heart" size={15} color={palette.pop} />}
          </View>
        </View>
        <Icon name="chevronRight" size={20} color={th.textFaint} />
      </Bouncy>
    </Animated.View>
  );
}

function Count({ icon, n }: { icon: 'camera' | 'sparkle'; n: number }) {
  const th = useTheme();
  return (
    <View style={styles.count}>
      <Icon name={icon} size={14} color={th.textSoft} />
      <Text style={[type.caption, font('bold'), { color: th.textSoft }]}>{n}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  seasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
  season: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, minHeight: 40, borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, minHeight: 92 },
  cover: { width: 72, height: 72, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  face: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
