import { useRef, useState, type ComponentRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Bouncy, Icon } from '../kit';
import { elevation, font, radius, type, useTheme } from '../theme';
import { crewColor, crewInitial } from './sheetLogic';

interface Anchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crew filter: compact button (current filter + member count + chevron) that opens an anchored dropdown. Hidden with one crew. */
export function CrewFilterMenu() {
  const th = useTheme();
  const router = useRouter();
  const win = useWindowDimensions();
  const crews = useApp((s) => s.crews);
  const crewFilter = useApp((s) => s.crewFilter);
  const btn = useRef<ComponentRef<typeof View>>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>({ x: 0, y: 0, w: 0, h: 0 });
  const p = useSharedValue(0);

  const show = () => {
    btn.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, w, h });
      setOpen(true);
      p.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) });
    });
  };
  const hide = (after?: () => void) => {
    p.value = withTiming(0, { duration: 110 });
    setTimeout(() => {
      setOpen(false);
      after?.();
    }, 110);
  };
  const style = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * -8 }, { scale: 0.96 + 0.04 * p.value }] }));

  if (crews.length < 2) return null;
  const current = crews.find((c) => c.id === crewFilter) ?? null;
  const total = current ? current.memberIds.length : new Set(crews.flatMap((c) => c.memberIds)).size;
  const label = current?.name ?? t('crew.all');
  const choose = (id: string | null) => hide(() => engine.crews.setFilter(id));
  const width = Math.min(300, win.width - 28);
  const left = Math.max(14, Math.min(anchor.x, win.width - width - 14));
  const maxH = Math.max(160, win.height - (anchor.y + anchor.h) - 24);

  return (
    <>
      <View ref={btn} collapsable={false} style={styles.wrap}>
        <Bouncy
          testID="crew-filter"
          haptic="select"
          onPress={show}
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          style={[styles.btn, { backgroundColor: current ? th.accent : th.glass, borderColor: current ? th.accent : th.separator }, elevation.low]}
        >
          <Icon name="crew" size={16} color={current ? th.onAccent : th.text} />
          <Text style={[type.small, font('bold'), { color: current ? th.onAccent : th.text, flexShrink: 1 }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={[type.small, { color: current ? th.onAccent : th.textSoft }]}>{total}</Text>
          <Icon name="chevronDown" size={16} color={current ? th.onAccent : th.textSoft} />
        </Bouncy>
      </View>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => hide()} statusBarTranslucent>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => hide()} accessibilityLabel={t('common.close')} testID="crew-filter-scrim" />
        <Animated.View style={[styles.menu, { top: anchor.y + anchor.h + 6, left, width, maxHeight: maxH, backgroundColor: th.card, borderColor: th.separator }, elevation.high, style]}>
          <ScrollView bounces={false}>
            <Option testID="crew-filter-option-0" label={t('crew.all')} count={new Set(crews.flatMap((c) => c.memberIds)).size} selected={!current} onPress={() => choose(null)} />
            {crews.map((c, i) => (
              <Option key={c.id} testID={`crew-filter-option-${i + 1}`} label={c.name} count={c.memberIds.length} color={crewColor(c.id)} initial={crewInitial(c.name)} selected={crewFilter === c.id} onPress={() => choose(c.id)} />
            ))}
            <View style={[styles.sep, { backgroundColor: th.separator }]} />
            <Option testID="crew-filter-manage" label={t('crew.manage')} icon="settings" onPress={() => hide(() => router.push('/crew'))} />
          </ScrollView>
        </Animated.View>
      </Modal>
    </>
  );
}

function Option({ label, count, color, initial, icon, selected, onPress, testID }: { label: string; count?: number; color?: string; initial?: string; icon?: 'settings'; selected?: boolean; onPress: () => void; testID: string }) {
  const th = useTheme();
  return (
    <Bouncy testID={testID} haptic="select" onPress={onPress} accessibilityLabel={label} accessibilityState={{ selected: !!selected }} scaleTo={0.98} style={styles.opt}>
      <View style={[styles.badge, { backgroundColor: color ?? th.cardAlt }]}>
        {icon ? <Icon name={icon} size={16} color={th.textSoft} /> : initial ? <Text style={[type.small, font('bold'), { color: '#FFFFFF' }]}>{initial}</Text> : <Icon name="crew" size={16} color={th.textSoft} />}
      </View>
      <Text style={[type.body, { color: th.text, flex: 1 }]} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined && <Text style={[type.small, { color: th.textSoft }]}>{count}</Text>}
      <View style={{ width: 20 }}>{selected && <Icon name="check" size={18} color={th.accent} />}</View>
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', marginHorizontal: 14, marginTop: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, maxWidth: 240, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  menu: { position: 'absolute', borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingVertical: 4 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
