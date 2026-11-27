import { useEffect } from 'react';
import type { MoveKind } from './orderLogic';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import type { FriendView } from '../../core/store';
import { Bouncy, Icon, type IconName } from '../kit';
import { elevation, radius, type, useTheme } from '../theme';

/** Long-press quick actions for a crewmate: only what the existing screens already offer. */
export function FriendActions({ friend, onClose, onLocate, order }: { friend: FriendView | null; onClose: () => void; onLocate: (id: string) => void; /** Where the friend sits in the shown order, and how to move them. */ order?: { index: number; count: number; onMove: (id: string, kind: MoveKind) => void } }) {
  const th = useTheme();
  const router = useRouter();
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(friend ? 1 : 0, { duration: 140 });
  }, [friend, p]);
  const style = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: 0.94 + 0.06 * p.value }] }));
  if (!friend) return null;
  const id = friend.profile.deviceId;
  const pr = friend.presence;
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const items: { key: string; icon: IconName; label: string; onPress: () => void }[] = [
    { key: 'chat', icon: 'send', label: t('friend.message'), onPress: go(() => router.push({ pathname: '/chat/[id]', params: { id } })) },
    { key: 'emote', icon: 'chat', label: t('friend.emote'), onPress: go(() => router.push({ pathname: '/emote/[id]', params: { id } })) },
  ];
  // Ask location = "where do you want me?"; asking to share once is offered when their policy shows me no exact position (D47).
  const askWhere = engine.asks.availability(id, 'where');
  const askOnce = engine.asks.availability(id, 'once');
  const visible = !!pr && !friend.paused;
  if (!visible) items.push({ key: 'ask', icon: 'locate', label: askWhere === 'old' ? t('ask.needsUpdate') : t('fa.askLocation'), onPress: go(() => void engine.asks.ask(id, 'where')) });
  if (!pr || pr.prec !== 'p' || friend.paused)
    items.push({ key: 'askOnce', icon: 'clock', label: askOnce === 'old' ? t('ask.needsUpdate') : t('ask.askOnce'), onPress: go(() => void engine.asks.ask(id, 'once')) });
  // Directions live in the locate pill (one path for finding someone).
  if (visible) items.unshift({ key: 'locate', icon: 'locate', label: t('friend.locate'), onPress: go(() => onLocate(id)) });
  if (pr) {
    items.push({
      key: 'along',
      icon: 'car',
      label: t('gd.title'),
      onPress: go(() => router.push({ pathname: '/search', params: { with: id } })),
    });
  }
  if (order && order.count > 1) {
    const mv = (kind: MoveKind) => go(() => order.onMove(id, kind));
    if (order.index > 0) items.push({ key: 'top', icon: 'star', label: t('home.pinTop'), onPress: mv('top') });
    if (order.index > 0) items.push({ key: 'up', icon: 'chevronDown', label: t('home.moveUp'), onPress: mv('up') });
    if (order.index < order.count - 1) items.push({ key: 'down', icon: 'chevronDown', label: t('home.moveDown'), onPress: mv('down') });
  }
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: th.scrim }]} onPress={onClose} accessibilityLabel={t('common.close')} />
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View style={[styles.card, { backgroundColor: th.card, borderColor: th.separator }, elevation.high, style]}>
          <Text style={[type.headline, { color: th.text, paddingHorizontal: 16, paddingVertical: 10 }]} numberOfLines={1}>
            {friend.profile.name}
          </Text>
          {items.map((i) => (
            <Bouncy key={i.key} testID={`friend-action-${i.key}`} onPress={i.onPress} accessibilityLabel={i.label} scaleTo={0.98} style={styles.item}>
              <View style={i.key === 'up' ? styles.flip : undefined}>
                <Icon name={i.icon} size={20} color={th.accent} />
              </View>
              <Text style={[type.body, { color: th.text }]}>{i.label}</Text>
            </Bouncy>
          ))}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  card: { width: 260, borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingBottom: 4 },
  flip: { transform: [{ rotate: '180deg' }] },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 48, paddingHorizontal: 16 },
});
