import { FlatList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { Bouncy, Button, ScreenHeader } from '../../ui/kit';
import { PLACE_TYPE_ICON } from '../../ui/places';
import { useTheme } from '../../ui/theme';
import { EmptyState } from '../../ui/screens-common/Layout';
import { Icon, IconTile } from '../../ui/kitIcons';
import { Skeleton } from '../../ui/screens-common/Skeleton';

export default function Places() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const places = useApp((s) => s.places);
  const ready = useApp((s) => s.ready);
  const me = useApp((s) => s.me);
  const friends = useApp((s) => s.friends);
  const crews = useApp((s) => s.crews);
  const sharing = useApp((s) => s.sharing);
  /** Crews this place actually reaches: listed on the place and the crew shares places. */
  const reach = (ids: string[]) => crews.filter((c) => ids.includes(c.id) && sharing[c.id]?.places !== false).map((c) => c.name);
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: 16 }}>
        <ScreenHeader testID="places-back" title={t('places.title')} />
      </View>
      <FlatList
        data={places}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
        ListEmptyComponent={
          ready ? (
            <EmptyState icon="pin" title={t('places.empty')} />
          ) : (
            <View style={{ gap: 10 }}>
              <Skeleton height={72} radius={20} />
              <Skeleton height={72} radius={20} />
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const mine = item.owner === me?.deviceId;
          const names = mine ? reach(item.sharedWith) : [];
          return (
            <Animated.View entering={FadeInDown.delay(Math.min(index, 8) * 35).duration(260)}>
              <Bouncy
                testID={`place-row-${item.name}`}
                accessibilityLabel={item.name}
                onPress={() => router.push(mine ? { pathname: '/places/edit', params: { id: item.id } } : { pathname: '/place/[id]', params: { id: item.id } })}
                style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}
              >
                <IconTile name={PLACE_TYPE_ICON[item.type]} color={item.color} size={46} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[styles.name, { color: th.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.meta}>
                    {mine && <Icon name={names.length ? 'users' : 'lock'} color={th.textSoft} size={14} strokeWidth={2.2} />}
                    <Text maxFontSizeMultiplier={1.3} style={{ color: th.textSoft, fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>
                      {mine ? (names.length ? `${t('places.sharedWith')}: ${names.join(', ')}` : t('places.private')) : `${t(`placeType.${item.type}`)} · ${friends[item.owner]?.profile.name ?? ''}`}
                    </Text>
                  </View>
                </View>
                {<Icon name="chevronRight" color={th.textSoft} size={18} />}
              </Bouncy>
            </Animated.View>
          );
        }}
      />
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
        <Button testID="place-add" label={t('places.add')} onPress={() => router.push('/places/edit')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, padding: 12, minHeight: 72, borderWidth: StyleSheet.hairlineWidth },
  name: { fontSize: 16.5, fontWeight: '700' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
});
