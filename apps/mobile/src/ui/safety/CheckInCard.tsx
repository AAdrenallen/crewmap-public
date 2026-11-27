import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { formatClock } from '@crewmap/shared/units';
import { answerCheckIn, useCheckIn } from '../../core/checkIn';
import { Icon } from '../kit';
import { font, radius, space, type, useTheme } from '../theme';

/**
 * Safety check-in ask (D66): one big "I'm OK" over whatever screen is open. Root-mounted, box-none around the card
 * so the map stays usable; the same answer is on the notification.
 */
export function CheckInCard() {
  const ask = useCheckIn((s) => s.ask);
  const insets = useSafeAreaInsets();
  const th = useTheme();
  if (!ask) return null;
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.wrap, { paddingTop: insets.top + space(3), paddingLeft: Math.max(space(3), insets.left), paddingRight: Math.max(space(3), insets.right) }]}>
      <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutUp.duration(180)} style={[styles.card, { backgroundColor: th.card, borderColor: th.danger }]}>
        <View style={styles.head}>
          <Icon name="shield" size={22} color={th.danger} />
          <Text accessibilityRole="header" style={[type.title, { color: th.text, flex: 1 }]}>
            {t('checkIn.ask')}
          </Text>
        </View>
        <Text style={[type.body, { color: th.textSoft }]}>{t('checkIn.stoppedAt', { time: formatClock(ask.since) })}</Text>
        <Pressable
          testID="checkin-ok"
          accessibilityRole="button"
          accessibilityLabel={t('checkIn.ok')}
          onPress={answerCheckIn}
          style={({ pressed }) => [styles.ok, { backgroundColor: th.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[type.title, font('bold'), { color: '#FFFFFF' }]}>{t('checkIn.ok')}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  card: { width: '100%', maxWidth: 480, gap: space(3), padding: space(4), borderRadius: radius.l, borderWidth: 2, elevation: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  ok: { minHeight: 72, borderRadius: radius.m, alignItems: 'center', justifyContent: 'center' },
});
