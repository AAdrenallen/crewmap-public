import { useEffect, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { visibleBlips, type Blip } from '@crewmap/shared/messaging';
import { useBlips } from '../../core/msgNotify';
import { useApp } from '../../core/store';
import { AvatarStill } from '../map/Sprites';
import { palette, useTheme } from '../theme';

const SIZE = 48;
const TINY = 30;

/** Messenger-style chat bubbles on the left edge: tap opens the conversation, swipe left dismisses, auto-fades. */
export function MsgBlips({ top, left }: { top: number; left: number }) {
  const blips = useBlips((s) => s.blips);
  const expire = useBlips((s) => s.expire);
  useEffect(() => {
    if (!blips.length) return;
    const h = setInterval(() => expire(Date.now()), 500);
    return () => clearInterval(h);
  }, [blips.length, expire]);
  if (!blips.length) return null;
  const { shown, more } = visibleBlips(blips);
  return (
    <View testID="msg-bubble" pointerEvents="box-none" style={[styles.col, { top, left }]}>
      {shown.map((b) => (
        <Bubble key={b.id} b={b} />
      ))}
      {more > 0 && (
        <View style={styles.more}>
          <Text style={styles.moreText}>+{more}</Text>
        </View>
      )}
    </View>
  );
}

function Bubble({ b }: { b: Blip }) {
  const th = useTheme();
  const router = useRouter();
  const dismiss = useBlips((s) => s.dismiss);
  const avatar = useApp((s) => s.allFriends[b.from]?.profile.avatar);
  const pop = useRef(new Animated.Value(0)).current;
  const dx = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
  }, [pop]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8,
      onPanResponderMove: (_, g) => dx.setValue(Math.min(0, g.dx)),
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SIZE / 2) dismiss(b.id);
        else Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;
  const size = b.tiny ? TINY : SIZE;
  const open = () => {
    dismiss(b.id);
    router.push(`/chat/${encodeURIComponent(b.id)}`);
  };
  return (
    <Animated.View
      {...pan.panHandlers}
      style={{ transform: [{ translateX: dx }, { scale: pop }], opacity: pop, marginBottom: 8 }}
    >
      <Pressable testID={`msg-bubble-${b.id}`} onPress={open} hitSlop={b.tiny ? 9 : 0} accessibilityRole="button" accessibilityLabel={b.name}>
        <View style={[styles.bubble, { width: size, height: size, borderRadius: size / 2, backgroundColor: th.card }]}>
          {avatar ? (
            <AvatarStill avatar={avatar} size={size - 4} />
          ) : (
            <Text style={[styles.initial, { color: th.text, fontSize: size * 0.42 }]}>{b.name.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={[styles.badge, b.tiny && styles.badgeTiny]}>
          <Text style={styles.badgeText}>{b.count > 9 ? '9+' : b.count}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  col: { position: 'absolute', alignItems: 'flex-start' },
  bubble: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', elevation: 4 },
  initial: { fontWeight: '700' },
  badge: {
    position: 'absolute',
    right: -4,
    top: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: palette.pop,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTiny: { minWidth: 14, height: 14, borderRadius: 7, right: -3, top: -3 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  more: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)' },
  moreText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
