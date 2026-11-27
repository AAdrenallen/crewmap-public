import { type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type PressableProps, type ScrollViewProps, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeOutUp, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { platform } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { Icon, type IconName } from './kitIcons';
import { elevation, font, hit, motion, palette, radius, space, type as typo, useTheme } from './theme';

/** Presence freshness for avatar dots: live < 5 min, stale after, off when paused or unknown. */
export function presenceState(f: { paused: boolean; presence: { t: number } | null | undefined }): 'live' | 'stale' | 'off' {
  if (f.paused || !f.presence) return 'off';
  return Date.now() - f.presence.t < 5 * 60_000 ? 'live' : 'stale';
}

export { Icon, BatteryIcon, PresenceDot, type IconName } from './kitIcons';

/** Pressable with spring scale + dim feedback and haptics. */
export function Bouncy({
  children,
  style,
  onPress,
  haptic = 'tap',
  scaleTo = 0.96,
  ...rest
}: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: 'tap' | 'select' | 'bounce' | null; scaleTo?: number; children: ReactNode }) {
  const s = useSharedValue(1);
  const o = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }], opacity: o.value }));
  // Flex sizing must sit on the Pressable (the outer flex child), not only on the animated inner view.
  const flat = StyleSheet.flatten(style) ?? {};
  const outer: ViewStyle = { flex: flat.flex, flexGrow: flat.flexGrow, flexShrink: flat.flexShrink, flexBasis: flat.flexBasis, alignSelf: flat.alignSelf };
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={outer}
      onPressIn={(e) => {
        s.value = withSpring(scaleTo, motion.press);
        o.value = withTiming(0.88, { duration: 80 });
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.value = withSpring(1, motion.release);
        o.value = withTiming(1, { duration: 160 });
        rest.onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) platform.haptics.play(haptic);
        onPress?.(e);
      }}
    >
      <Animated.View style={[style, a]}>{children}</Animated.View>
    </Pressable>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  testID,
  icon,
  loading,
  compact,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  testID?: string;
  icon?: IconName;
  loading?: boolean;
  compact?: boolean;
}) {
  const th = useTheme();
  const bg = kind === 'primary' ? th.accent : kind === 'danger' ? th.danger : kind === 'secondary' ? th.accentSoft : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? th.onAccent : kind === 'secondary' ? th.accent : th.text;
  return (
    <Bouncy
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: bg, opacity: disabled ? 0.4 : 1, borderColor: kind === 'ghost' ? th.border : 'transparent' },
        kind === 'primary' && !disabled ? elevation.low : null,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={20} color={fg} /> : null}
      <Text maxFontSizeMultiplier={1.3} style={[typo.headline, { color: fg }]}>{label}</Text>
    </Bouncy>
  );
}

/** Round icon control (map controls, header actions). Always ≥ 48 dp. */
export function IconButton({
  icon,
  label,
  onPress,
  testID,
  size = hit,
  tone = 'surface',
  active,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  size?: number;
  tone?: 'surface' | 'accent' | 'plain' | 'danger';
  active?: boolean;
  disabled?: boolean;
}) {
  const th = useTheme();
  const bg = tone === 'accent' || active ? th.accent : tone === 'danger' ? th.danger : tone === 'plain' ? 'transparent' : th.glass;
  const fg = tone === 'accent' || tone === 'danger' || active ? th.onAccent : th.text;
  const s = Math.max(size, hit);
  return (
    <Bouncy
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      scaleTo={0.9}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      style={[{ width: s, height: s, borderRadius: s / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: bg, opacity: disabled ? 0.4 : 1 }, tone === 'surface' ? elevation.mid : null]}
    >
      <Icon name={icon} size={22} color={fg} />
    </Bouncy>
  );
}

/** Grouped vertical stack of map controls in one elevated pill, separated by hairlines. */
export function ControlGroup({ items }: { items: { icon: IconName; label: string; onPress: () => void; testID?: string; active?: boolean; badge?: number }[] }) {
  const th = useTheme();
  return (
    <View style={[styles.group, { backgroundColor: th.glass, borderColor: th.separator }, elevation.mid]}>
      {items.map((it, i) => (
        <View key={it.label}>
          {i > 0 && <View style={[styles.groupSep, { backgroundColor: th.separator }]} />}
          <Bouncy testID={it.testID} accessibilityRole="button" accessibilityLabel={it.label} onPress={it.onPress} scaleTo={0.88} style={styles.groupItem}>
            <Icon name={it.icon} size={22} color={it.active ? th.accent : th.text} />
            {!!it.badge && <CountBadge n={it.badge} style={styles.groupBadge} />}
          </Bouncy>
        </View>
      ))}
    </View>
  );
}

export function Card({ children, style, flat }: { children: ReactNode; style?: StyleProp<ViewStyle>; flat?: boolean }) {
  const th = useTheme();
  return <View style={[{ backgroundColor: th.card, borderRadius: radius.l, padding: space(4) }, flat ? { borderWidth: StyleSheet.hairlineWidth, borderColor: th.border } : elevation.low, style]}>{children}</View>;
}

export function H({ children, style }: { children: ReactNode; style?: object }) {
  const th = useTheme();
  return (
    <Text accessibilityRole="header" style={[typo.title, { color: th.text }, style]}>
      {children}
    </Text>
  );
}

export function T({ children, soft, style, numberOfLines, testID }: { children: ReactNode; soft?: boolean; style?: object; numberOfLines?: number; testID?: string }) {
  const th = useTheme();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[typo.body, { color: soft ? th.textSoft : th.text }, style]}>
      {children}
    </Text>
  );
}

/** Section label above a group of rows. */
export function SectionLabel({ children }: { children: ReactNode }) {
  const th = useTheme();
  return <Text style={[typo.overline, { color: th.textFaint, marginTop: space(2), marginLeft: space(1) }]}>{children}</Text>;
}

/**
 * Scrolling screen with text fields. The app is edge-to-edge, so Android does not resize the window for the IME:
 * the KeyboardAvoidingView pads the keyboard height away and the ScrollView keeps the focused field in view.
 */
export function KeyboardScroll({ style, children, ...rest }: ScrollViewProps & { children: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="none" {...rest} style={[{ flex: 1 }, style]}>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Field(props: TextInputProps & { label: string; icon?: IconName; onClear?: () => void; hideLabel?: boolean }) {
  const th = useTheme();
  const { label, icon, onClear, hideLabel, style, ...input } = props;
  return (
    <View style={{ gap: space(1.5) }}>
      {!hideLabel && <Text style={[typo.small, { color: th.textSoft, marginLeft: space(1) }]}>{label}</Text>}
      <View style={[styles.field, { backgroundColor: th.cardAlt, borderColor: th.border }]}>
        {icon && <Icon name={icon} size={20} color={th.textSoft} />}
        <TextInput placeholderTextColor={th.textFaint} accessibilityLabel={label} selectionColor={th.accent} {...input} style={[typo.body, { color: th.text, flex: 1, paddingVertical: space(3.5) }, style]} />
        {onClear && !!input.value && (
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.clear')} hitSlop={12} onPress={onClear} style={styles.clear}>
            <Icon name="close" size={18} color={th.textSoft} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function Row({ label, value, onPress, right, testID }: { label: string; value?: string; onPress?: () => void; right?: ReactNode; testID?: string }) {
  const th = useTheme();
  const body = (
    <View style={[styles.row, { borderBottomColor: th.separator }]}>
      <Text style={[typo.body, { color: th.text, flex: 1 }]}>{label}</Text>
      {value !== undefined && <Text style={[typo.body, { color: th.textSoft }]}>{value}</Text>}
      {right}
      {onPress && !right && <Icon name="chevron" size={18} color={th.textFaint} />}
    </View>
  );
  return onPress ? (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} android_ripple={{ color: th.separator }}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** Rich list row: leading visual, title/subtitle, trailing slot. */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  onLongPress,
  testID,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const th = useTheme();
  const body = (
    <View style={styles.item}>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[typo.headline, { color: th.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
          <Text style={[typo.small, font('medium'), { color: th.textSoft }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
    </View>
  );
  return onPress ? (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress} onLongPress={onLongPress} android_ripple={{ color: th.separator }} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  ) : (
    <View testID={testID}>{body}</View>
  );
}

/** Rounded square holding an icon; used as list leading visual. */
export function IconTile({ icon, color, size = 40 }: { icon: IconName; color?: string; size?: number }) {
  const th = useTheme();
  const c = color ?? th.accent;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3, backgroundColor: `${c}1F`, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={size * 0.52} color={c} />
    </View>
  );
}

export function Toggle({ label, value, onChange, testID }: { label: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  const th = useTheme();
  return <Row label={label} right={<Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: th.accent, false: th.border }} thumbColor="#FFFFFF" />} />;
}

export function Chip({ label, active, onPress, testID, icon }: { label: string; active?: boolean; onPress?: () => void; testID?: string; icon?: IconName }) {
  const th = useTheme();
  const fg = active ? th.onAccent : th.text;
  return (
    <Bouncy
      testID={testID}
      haptic="select"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
      hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }}
      style={[styles.chip, { backgroundColor: active ? th.accent : th.cardAlt, borderColor: active ? th.accent : th.border }]}
    >
      {icon && <Icon name={icon} size={16} color={fg} />}
      <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[typo.small, { color: fg }]}>{label}</Text>
    </Bouncy>
  );
}

/** Unread counter dot (chat). */
export function CountBadge({ n, style, testID }: { n: number; style?: StyleProp<ViewStyle>; testID?: string }) {
  const th = useTheme();
  if (n <= 0) return null;
  return (
    <View testID={testID} style={[{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: th.danger }, style]}>
      <Text style={[typo.caption, font('bold'), { color: '#FFFFFF', fontSize: 11 }]}>{n > 99 ? '99+' : n}</Text>
    </View>
  );
}

/** Small status pill. */
export function Badge({ label, tone = 'accent' }: { label: string; tone?: 'accent' | 'sun' | 'ok' | 'danger' | 'neutral' }) {
  const th = useTheme();
  const c = tone === 'sun' ? palette.sun : tone === 'ok' ? th.ok : tone === 'danger' ? th.danger : tone === 'neutral' ? th.textSoft : th.accent;
  return (
    <View style={{ backgroundColor: `${c}24`, borderRadius: radius.pill, paddingHorizontal: space(2.5), paddingVertical: 3 }}>
      <Text style={[typo.caption, font('bold'), { color: tone === 'sun' ? (th.dark ? palette.sun : '#8A5A00') : c }]}>{label}</Text>
    </View>
  );
}

/** Segmented control. Few options → equal-width track; many → wrapping chips. testIDs `seg-<key>`. */
export function Segmented<T extends string>({ options, value, onChange, testIDPrefix = 'seg-' }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void; testIDPrefix?: string }) {
  const th = useTheme();
  if (options.length > 4) {
    return (
      <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
        {options.map((o) => (
          <Chip key={o.key} label={o.label} active={o.key === value} onPress={() => onChange(o.key)} testID={`${testIDPrefix}${o.key}`} />
        ))}
      </View>
    );
  }
  return (
    <View style={[styles.segTrack, { backgroundColor: th.cardAlt }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            testID={`${testIDPrefix}${o.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            onPress={() => {
              platform.haptics.play('select');
              onChange(o.key);
            }}
            style={[styles.seg, on && [{ backgroundColor: th.card }, elevation.low]]}
          >
            <Text style={[typo.small, { color: on ? th.text : th.textSoft }]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Screen header: back button, title, optional trailing action. */
export function ScreenHeader({ title, right, onBack, testID }: { title?: string; right?: ReactNode; onBack?: () => void; testID?: string }) {
  const router = useRouter();
  const th = useTheme();
  return (
    <View style={styles.header}>
      <IconButton
        testID={testID ?? 'header-back'}
        icon="back"
        tone="plain"
        label={t('common.back')}
        onPress={() => {
          if (onBack) onBack();
          else if (router.canGoBack()) router.back();
          else router.replace('/');
        }}
      />
      <Text accessibilityRole="header" style={[typo.title, { color: th.text, flex: 1 }]} numberOfLines={1}>
        {title ?? ''}
      </Text>
      {right}
    </View>
  );
}

/** Bottom sheet surface with drag handle. */
export function Sheet({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const th = useTheme();
  return (
    <View style={[styles.sheet, { backgroundColor: th.card }, elevation.sheet, style]}>
      <View style={[styles.handle, { backgroundColor: th.border }]} />
      {children}
    </View>
  );
}

/** Centered empty / error state with an icon and optional action. */
export function EmptyState({ icon, title, action, testID }: { icon: IconName; title: string; action?: { label: string; onPress: () => void }; testID?: string }) {
  const th = useTheme();
  return (
    <View testID={testID} style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: th.cardAlt }]}>
        <Icon name={icon} size={30} color={th.textSoft} />
      </View>
      <Text style={[typo.headline, { color: th.textSoft, textAlign: 'center' }]}>{title}</Text>
      {action && <Button kind="secondary" compact label={action.label} onPress={action.onPress} />}
    </View>
  );
}

/** Floating toast; position it with `style`. */
export function Toast({ message, icon, tone = 'neutral', onPress, style, testID }: { message: string; icon?: IconName; tone?: 'neutral' | 'sun' | 'danger'; onPress?: () => void; style?: StyleProp<ViewStyle>; testID?: string }) {
  const th = useTheme();
  const bg = tone === 'sun' ? palette.sun : tone === 'danger' ? th.danger : th.dark ? '#F4F6FC' : '#151B2B';
  const fg = tone === 'sun' ? '#1B1200' : tone === 'danger' ? '#FFFFFF' : th.dark ? '#0B0F1A' : '#F4F6FC';
  return (
    <Animated.View entering={FadeInDown.springify().damping(16)} exiting={FadeOutUp.duration(180)} style={[styles.toast, { backgroundColor: bg }, elevation.high, style]}>
      <Pressable testID={testID} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={message} onPress={onPress} style={styles.toastInner}>
        {icon && <Icon name={icon} size={20} color={fg} />}
        <Text style={[typo.small, { color: fg, flexShrink: 1 }]} numberOfLines={2}>
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 54, borderRadius: radius.m, paddingHorizontal: space(6), alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, flexDirection: 'row', gap: space(2) },
  buttonCompact: { minHeight: hit, paddingHorizontal: space(5), borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: space(3), borderBottomWidth: StyleSheet.hairlineWidth, gap: space(3) },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: space(2.5), gap: space(3) },
  chip: { minHeight: hit, borderRadius: radius.pill, paddingHorizontal: space(4), flexDirection: 'row', alignItems: 'center', gap: space(1.5), borderWidth: StyleSheet.hairlineWidth },
  field: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), borderRadius: radius.m, paddingHorizontal: space(4), borderWidth: StyleSheet.hairlineWidth },
  clear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  group: { borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  groupItem: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  groupBadge: { position: 'absolute', top: 5, right: 5 },
  groupSep: { height: StyleSheet.hairlineWidth, marginHorizontal: 10 },
  segTrack: { flexDirection: 'row', borderRadius: radius.m, padding: 3 },
  seg: { flex: 1, minHeight: 40, borderRadius: radius.m - 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space(2) },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(1), marginLeft: -space(2) },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space(5), paddingTop: space(2.5), gap: space(3) },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: space(1) },
  empty: { alignItems: 'center', justifyContent: 'center', gap: space(3), paddingVertical: space(10), paddingHorizontal: space(6) },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  toast: { borderRadius: radius.m, maxWidth: '92%' },
  toastInner: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), paddingVertical: space(3), minHeight: hit },
});
