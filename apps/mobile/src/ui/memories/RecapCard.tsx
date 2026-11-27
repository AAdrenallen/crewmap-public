import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOutUp, ZoomIn } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { platform } from '@crewmap/platform';
import { lang, t } from '@crewmap/shared/i18n';
import { formatKm } from '@crewmap/shared/units';
import { useCatchUp } from '../../core/catchUp';
import { engine } from '../../core/engine';
import { useMemories, type MemoryRow } from '../../core/memories';
import { useApp } from '../../core/store';
import { Icon } from '../kitIcons';
import { RouteThumb } from '../charts';
import { AvatarStill } from '../map/Sprites';
import { font, type, useTheme } from '../theme';
import { usePeople } from './memoryUi';

/**
 * The one recap card after a group outing (D68): shown once, never while driving or guiding, never over the catch-up
 * fanfare. Tap opens the recap, the cross dismisses it for good.
 */
export function RecapCard() {
  const id = useMemories((s) => s.card);
  const rows = useMemories((s) => s.rows);
  const busy = useApp((s) => s.driving || s.nav?.active === true);
  const catching = useCatchUp((s) => s.cards.length > 0);
  const row = id ? rows.find((r) => r.id === id) : undefined;
  if (!row || busy || catching) return null;
  return <Card row={row} />;
}

function Card({ row }: { row: MemoryRow }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const people = usePeople(row.members);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    platform.haptics.play('success');
  }, [row.id]);
  if (gone) return null;
  const dismiss = () => {
    setGone(true);
    void engine.memories.markSeen(row.id);
  };
  const names = row.members.map((m) => people[m]?.name ?? '').filter(Boolean);
  const title = names.length === 1 ? t('mem.card.one', { name: names[0]! }) : t('mem.card.many', { count: String(names.length) });
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { paddingTop: insets.top + 8, alignItems: 'center', paddingHorizontal: 16 }]}>
      <Animated.View entering={ZoomIn.springify().damping(14)} exiting={FadeOutUp.duration(180)} style={{ width: '100%', maxWidth: 480 }}>
        <Pressable
          testID="mem-recap-card"
          accessibilityRole="button"
          accessibilityLabel={title}
          onPress={() => {
            dismiss();
            router.push({ pathname: '/memories/[id]', params: { id: row.id } });
          }}
          style={[styles.card, { backgroundColor: th.card, borderColor: th.border }]}
        >
          <RouteThumb points={row.thumb} color={th.accent} size={52} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={[type.body, font('bold'), { color: th.text }]} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.faces}>
              {row.members.slice(0, 5).map((m, i) => (
                <View key={m} style={[styles.face, { marginLeft: i ? -10 : 0, borderColor: th.card, backgroundColor: th.cardAlt }]}>
                  {people[m] && <AvatarStill avatar={people[m]!.avatar} size={26} />}
                </View>
              ))}
              <Text style={[type.caption, { color: th.textSoft, marginLeft: 6 }]}>{formatKm(row.distanceM / 1000, lang())}</Text>
            </View>
          </View>
          <Pressable testID="mem-recap-dismiss" accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={10} onPress={dismiss} style={styles.x}>
            <Icon name="close" size={18} color={th.textSoft} />
          </Pressable>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, elevation: 6 },
  faces: { flexDirection: 'row', alignItems: 'center' },
  face: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  x: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
