import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { t } from '@crewmap/shared/i18n';
import { formatClock } from '@crewmap/shared/units';
import { useCheckIn } from '../../core/checkIn';
import { Icon } from '../kit';
import { font, radius, space, type, useTheme } from '../theme';

/** A crewmate's unanswered check-in (D66): where they stopped and since when, one tap to route there. */
export function CheckInAlertBanner({ friendId, name }: { friendId: string; name: string }) {
  const a = useCheckIn((s) => s.alerts[friendId]);
  const router = useRouter();
  const th = useTheme();
  if (!a) return null;
  return (
    <Pressable
      testID="checkin-alert"
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/route', params: { name, lat: String(a.lat), lng: String(a.lng) } })}
      style={[styles.box, { backgroundColor: `${th.danger}1A`, borderColor: th.danger }]}
    >
      <Icon name="shield" size={22} color={th.danger} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.headline, font('bold'), { color: th.danger }]}>{t(a.crash ? 'checkIn.alertCrash' : 'checkIn.alert', { name })}</Text>
        <Text style={[type.body, { color: th.text }]}>{t('checkIn.stoppedAt', { time: formatClock(a.since) })}</Text>
      </View>
      <Icon name="route" size={22} color={th.danger} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), borderRadius: radius.m, borderWidth: 1 },
});
