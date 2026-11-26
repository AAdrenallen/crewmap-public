import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ZoomIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { EDGE_BURST, planEdgeBurst, seedOf, type EdgePop } from '@crewmap/shared/emoteBurst';
import { EMOTE_EMOJI, EMOTE_LIMITS, type Rect } from '@crewmap/shared/emotes';
import { t } from '@crewmap/shared/i18n';
import { saveReceived } from '../../core/quips';
import { muteForRide, setMuteAllForRide } from '../../core/rideMutes';
import { useApp } from '../../core/store';
import { Icon } from '../kitIcons';
import { AvatarStill } from '../map/Sprites';
import { useReduceMotion } from '../useReduceMotion';

const CHIP = { w: 196, h: 34 };

/** Pooled piece: slides in from its edge with a bouncy overshoot, bobs, then slides back out and fades. UI thread. */
function EdgePiece({ p, emoji, progress, life, size, soft, still }: { p: EdgePop; emoji: string; progress: SharedValue<number>; life: number; size: number; soft: boolean; still: boolean }) {
  const style = useAnimatedStyle(() => {
    const tt = (progress.value - p.delayMs) / life;
    if (tt <= 0 || tt >= 1) return { opacity: 0 };
    const fadeIn = Math.min(1, tt / 0.12);
    const fadeOut = tt > 0.78 ? Math.max(0, 1 - (tt - 0.78) / 0.22) : 1;
    const opacity = fadeIn * fadeOut * (soft ? 0.85 : 1);
    if (still) return { opacity };
    // 0..0.22 in (easeOutBack overshoot unless soft), hold with a bob, 0.78..1 back out.
    const k = Math.min(1, tt / 0.22);
    const c = soft ? 0 : 1.9;
    const inK = 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
    const outK = tt > 0.78 ? (tt - 0.78) / 0.22 : 0;
    const off = EDGE_BURST.travelDp * (1 - inK + outK * 0.6);
    const dx = p.edge === 'left' ? -off : p.edge === 'right' ? off : 0;
    const dy = (p.edge === 'top' ? -off : p.edge === 'bottom' ? off : 0) + (soft ? 0 : Math.sin(tt * 12) * 3);
    const pop = soft ? 1 : 0.6 + 0.4 * inK;
    return { opacity, transform: [{ translateX: dx }, { translateY: dy }, { rotate: `${p.tilt * (1 - k * 0.5)}deg` }, { scale: p.scale * pop }] };
  });
  return (
    <Animated.Text style={[styles.piece, { left: p.x, top: p.y, fontSize: size, lineHeight: size + 4 }, style]} allowFontScaling={false}>
      {emoji}
    </Animated.Text>
  );
}

/**
 * F3c: incoming emotes pop in from the screen edges (Life360-style), each cascade with a small sender chip
 * (avatar + name, ×N, mute this friend / mute all for the ride). Pops never land on the occupied layout rects
 * (route banner, next turn, speed, chat bubbles). Driving: two soft side pops + the chip, nothing else. Reduced
 * motion: plain fades. Non-blocking: only the chip buttons take touches.
 */
export function EmoteOverlay({ occupied, routePoints: _routePoints }: { occupied: Rect[]; routePoints: { x: number; y: number }[] }) {
  const emotes = useApp((s) => s.emotes);
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const friends = useApp((s) => s.friends);
  const muteAll = useApp((s) => s.rideMutes.all);
  const screen = useWindowDimensions();
  const current = emotes[0];
  const progress = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  const count = current?.count ?? 1;

  const plan = useMemo(
    () => (current ? planEdgeBurst({ screen: { w: screen.width, h: screen.height }, count, driving, occupied, seed: seedOf(current.id), chipSize: CHIP }) : null),
    [current, count, driving, occupied, screen.width, screen.height],
  );
  const life = driving ? EDGE_BURST.drivingLifeMs : EDGE_BURST.lifeMs;
  const animMs = plan?.durationMs ?? 0;

  useEffect(() => {
    if (!current) return;
    progress.value = 0;
    progress.value = withTiming(animMs, { duration: animMs, easing: Easing.linear });
    const ms = driving ? EMOTE_LIMITS.drivingDismissMs : Math.max(EMOTE_LIMITS.idleDismissMs, animMs + 1500);
    const timer = setTimeout(() => {
      const list = useApp.getState().emotes;
      if (list[0]?.id === current.id) useApp.getState().set({ emotes: list.slice(1) });
    }, ms);
    return () => clearTimeout(timer);
  }, [current, driving, progress, animMs]);

  if (!current || !plan) return muteAll && driving ? <MutedAllBadge occupied={occupied} /> : null;
  const friend = friends[current.from];
  const name = friend?.profile.name ?? '';
  const label = current.msg.preset === 'custom' ? (current.msg.label ?? t('emote.custom')) : t(`emote.${current.msg.preset}`);
  const quip = current.quip;
  const emoji = quip?.meta.emoji ?? EMOTE_EMOJI[current.msg.preset];
  const by = quip && quip.meta.by && quip.meta.by !== name ? ` (${t('quip.by', { name: quip.meta.by })})` : '';
  const size = driving ? EDGE_BURST.drivingSizeDp : EDGE_BURST.sizeDp;
  // Crowded layout: the sender chip still shows, under the top chrome right of the chat-bubble column.
  const upper = occupied.filter((r) => r.y < screen.height / 2).map((r) => r.y + r.h);
  const chip = plan.chip ?? { x: Math.max(8, Math.min(screen.width - CHIP.w - 8, 72)), y: (upper.length ? Math.max(...upper) : screen.height / 3) + 8 };
  const dismiss = () => useApp.getState().set({ emotes: useApp.getState().emotes.filter((e) => e.from !== current.from) });

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {plan.pops.map((p, i) => (
          <EdgePiece key={`${current.id}-${i}`} p={p} emoji={emoji} progress={progress} life={life} size={size} soft={driving} still={reduceMotion} />
        ))}
      </View>
      {(
        <Animated.View
          key={current.id}
          entering={reduceMotion ? FadeIn.duration(160) : ZoomIn.springify().damping(14)}
          exiting={FadeOut.duration(200)}
          style={[styles.chip, { left: chip.x, top: chip.y, maxWidth: CHIP.w }]}
          testID="emote-popup"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${name}: ${label}`}
        >
          <Pressable
            style={styles.who}
            onLongPress={() => {
              muteForRide(current.from);
              dismiss();
            }}
            accessibilityHint={t('emote.muteUser', { name })}
          >
            <View style={styles.av}>{friend?.profile.avatar ? <AvatarStill avatar={friend.profile.avatar} size={24} /> : <Text style={styles.initial}>{name.slice(0, 1).toUpperCase()}</Text>}</View>
            <Text style={styles.chipText} numberOfLines={1}>
              {driving ? name : `${name}${name ? ' · ' : ''}${label}${by}`}
            </Text>
            {count > 1 && (
              <Animated.Text key={count} entering={reduceMotion ? undefined : ZoomIn.springify().damping(9)} style={[styles.count, !driving && count >= 5 && styles.countBig]}>
                ×{count}
              </Animated.Text>
            )}
          </Pressable>
          {quip?.imageUri && !driving && <Image source={{ uri: quip.imageUri }} style={styles.thumb} contentFit="cover" />}
          {quip && !driving && (
            <Pressable testID="quip-save" accessibilityRole="button" onPress={() => void saveReceived(quip.meta)} hitSlop={10}>
              <Text style={styles.save}>{t('quip.save')}</Text>
            </Pressable>
          )}
          <Pressable
            testID="emote-mute-user"
            accessibilityRole="button"
            accessibilityLabel={t('emote.muteUser', { name })}
            hitSlop={10}
            onPress={() => {
              muteForRide(current.from);
              dismiss();
            }}
          >
            <Icon name="close" size={14} color="#C9D3E6" />
          </Pressable>
          <Pressable
            testID="emote-mute-all"
            accessibilityRole="switch"
            accessibilityState={{ checked: muteAll }}
            accessibilityLabel={t('emote.muteAll')}
            hitSlop={10}
            onPress={() => {
              setMuteAllForRide(true);
              useApp.getState().set({ emotes: [] });
            }}
          >
            <Icon name="bellOff" size={15} color="#C9D3E6" />
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

/** While 'Mute all' is on for the ride: a small bell-off that turns it back off. */
function MutedAllBadge({ occupied }: { occupied: Rect[] }) {
  const screen = useWindowDimensions();
  const spot = useMemo(
    () => planEdgeBurst({ screen: { w: screen.width, h: screen.height }, count: 1, driving: true, occupied, seed: 1, chipSize: { w: 36, h: 36 } }).chip,
    [occupied, screen.width, screen.height],
  );
  if (!spot) return null;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Pressable
        testID="emote-unmute-all"
        accessibilityRole="switch"
        accessibilityState={{ checked: true }}
        accessibilityLabel={t('emote.muteAll')}
        hitSlop={8}
        onPress={() => setMuteAllForRide(false)}
        style={[styles.badge, { left: spot.x, top: spot.y }]}
      >
        <Icon name="bellOff" size={18} color="#C9D3E6" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(17,22,36,0.8)', alignItems: 'center', justifyContent: 'center' },
  piece: { position: 'absolute' },
  chip: {
    position: 'absolute',
    backgroundColor: 'rgba(17,22,36,0.88)',
    borderRadius: 999,
    paddingLeft: 4,
    paddingRight: 10,
    height: CHIP.h,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  av: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#2A3350', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initial: { color: '#fff', fontSize: 12, fontWeight: '800' },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  count: { color: '#FFD45C', fontSize: 14, fontWeight: '900' },
  countBig: { fontSize: 18 },
  thumb: { width: 26, height: 26, borderRadius: 6 },
  save: { color: '#9CC9FF', fontSize: 12, fontWeight: '800' },
});
