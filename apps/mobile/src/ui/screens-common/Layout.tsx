import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { platform } from '@crewmap/platform';
import { palette, useTheme } from '../theme';
import { Icon, IconTile, type IconName } from './Icon';

export { ScreenHeader } from '../kit';

export function SectionLabel({ children }: { children: string }) {
  const th = useTheme();
  return <Text style={[styles.section, { color: th.textSoft }]}>{children.toUpperCase()}</Text>;
}

/** Grouped settings card: rows separated by hairlines. */
export function Group({ title, children, index = 0 }: { title?: string; children: ReactNode; index?: number }) {
  const th = useTheme();
  return (
    <Animated.View entering={FadeInDown.delay(index * 40).duration(260)}>
      {title && <SectionLabel>{title}</SectionLabel>}
      <View style={[styles.group, { backgroundColor: th.card, borderColor: th.border }]}>{children}</View>
    </Animated.View>
  );
}

export function ListRow({
  icon,
  tint = palette.brand,
  label,
  value,
  onPress,
  right,
  danger,
  testID,
  last,
}: {
  icon?: IconName;
  tint?: string;
  label: string;
  value?: string;
  onPress?: () => void;
  right?: ReactNode;
  danger?: boolean;
  testID?: string;
  last?: boolean;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      onPress={() => {
        platform.haptics.play('select');
        onPress?.();
      }}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? th.cardAlt : 'transparent' }]}
    >
      {icon && <IconTile name={icon} color={danger ? palette.danger : tint} size={32} />}
      <View style={[styles.rowBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border }]}>
        <Text style={[styles.rowLabel, { color: danger ? palette.danger : th.text }]} numberOfLines={1}>
          {label}
        </Text>
        {value !== undefined && (
          <Text style={[styles.rowValue, { color: th.textSoft }]} numberOfLines={1}>
            {value}
          </Text>
        )}
        {right}
        {onPress && !right && <Icon name="chevronRight" color={th.textSoft} size={18} />}
      </View>
    </Pressable>
  );
}

export function SwitchRow({ icon, tint, label, value, onChange, testID, last }: { icon?: IconName; tint?: string; label: string; value: boolean; onChange: (v: boolean) => void; testID?: string; last?: boolean }) {
  const th = useTheme();
  return (
    <ListRow
      icon={icon}
      tint={tint}
      label={label}
      last={last}
      onPress={() => onChange(!value)}
      testID={testID}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          accessibilityLabel={label}
          trackColor={{ false: th.border, true: th.accent }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

/** Centered empty / error state with an icon medallion. */
export function EmptyState({ icon, title, action }: { icon: IconName; title: string; action?: ReactNode }) {
  const th = useTheme();
  return (
    <Animated.View entering={FadeInDown.duration(300)} style={styles.empty}>
      <View style={[styles.medal, { backgroundColor: th.cardAlt }]}>
        <Icon name={icon} color={th.accent} size={40} />
      </View>
      <Text style={[styles.emptyTitle, { color: th.textSoft }]}>{title}</Text>
      {action}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.8, marginLeft: 16, marginBottom: 6, marginTop: 6 },
  group: { borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, gap: 12, minHeight: 56 },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingRight: 14 },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: '600' },
  rowValue: { fontSize: 15, fontWeight: '500', maxWidth: '45%' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 14 },
  medal: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
});
