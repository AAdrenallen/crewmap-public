import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EMOTE_EMOJI, EMOTE_LIMITS } from '@crewmap/shared/emotes';
import { CATCH_UP } from '@crewmap/shared/emoteSuggest';
import { seedOf } from '@crewmap/shared/emoteBurst';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useCatchUp } from '../../core/catchUp';
import { useApp } from '../../core/store';
import { font, type, useTheme } from '../theme';

const PIECES = 14;

/**
 * Catch-up fanfare (D58): one card per sender for what arrived while away, played in sequence. Tap a card to skip it,
 * "Skip" drops the rest. The layer is box-none, so the map and navigation stay usable underneath. While driving: a
 * small toast only.
 */
export function CatchUpFanfare() {
  const cards = useCatchUp((s) => s.cards);
  const style = useCatchUp((s) => s.style);
  const sound = useCatchUp((s) => s.sound);
  const card = cards[0];
  const friends = useApp((s) => s.allFriends);
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const toast = style === 'toast';

  useEffect(() => {
    if (!card) return;
    engine.emotes.playCard(card, sound);
    const timer = setTimeout(() => useCatchUp.getState().next(), toast ? EMOTE_LIMITS.drivingDismissMs : CATCH_UP.cardMs);
    return () => clearTimeout(timer);
    // One play per sender card: the count may grow while it shows without replaying it.
  }, [card?.from, toast]);

  if (!card) return null;
  const name = friends[card.from]?.profile.name ?? '';
  const title = card.total > 1 ? t('catchUp.title', { name, count: String(card.total) }) : t('catchUp.one', { name });
  const emoji = card.presets.map((p) => EMOTE_EMOJI[p]).join(' ');
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { paddingTop: insets.top + 8 }]}>
      <Animated.View key={card.from} entering={FadeInDown.duration(220)} exiting={FadeOutUp.duration(180)} style={styles.wrap} pointerEvents="box-none">
        {!toast && <Confetti seed={seedOf(`${card.from}-${card.latestAt}`)} emoji={card.presets.map((p) => EMOTE_EMOJI[p])} />}
        <Pressable
          testID="catchup-card"
          accessibilityRole="button"
          accessibilityLabel={title}
          onPress={() => useCatchUp.getState().next()}
          style={[toast ? styles.toast : styles.card, { backgroundColor: th.card, borderColor: th.border }]}
        >
          <Text style={toast ? styles.toastEmoji : styles.emoji} numberOfLines={1}>
            {emoji}
          </Text>
          <View style={{ flexShrink: 1 }}>
            <Text style={[toast ? type.caption : type.body, font('bold'), { color: th.text }]} numberOfLines={2}>
              {title}
            </Text>
            {card.others > 0 && <Text style={[type.caption, { color: th.textSoft }]}>{t('catchUp.others', { count: String(card.others) })}</Text>}
          </View>
          {!toast && cards.length > 1 && (
            <Pressable testID="catchup-skip" accessibilityRole="button" hitSlop={10} onPress={() => useCatchUp.getState().skipAll()} style={[styles.skip, { backgroundColor: th.cardAlt }]}>
              <Text style={[type.caption, font('bold'), { color: th.textSoft }]}>{t('catchUp.skip')}</Text>
            </Pressable>
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** A short emoji confetti pop around the card (reduced motion: none). */
function Confetti({ seed, emoji }: { seed: number; emoji: string[] }) {
  const reduce = useReducedMotion();
  const { width } = useWindowDimensions();
  const pieces = useMemo(() => {
    let x = seed || 1;
    const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: PIECES }, (_, i) => ({ dx: (rnd() - 0.5) * width * 0.9, dy: 40 + rnd() * 160, rot: (rnd() - 0.5) * 120, e: emoji[i % emoji.length] ?? '🎉', d: rnd() * 250 }));
  }, [seed, emoji, width]);
  if (reduce) return null;
  return (
    <View pointerEvents="none" style={styles.confetti}>
      {pieces.map((p, i) => (
        <Piece key={i} {...p} />
      ))}
    </View>
  );
}

function Piece({ dx, dy, rot, e, d }: { dx: number; dy: number; rot: number; e: string; d: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    const id = setTimeout(() => (v.value = withTiming(1, { duration: 1300, easing: Easing.out(Easing.cubic) })), d);
    return () => clearTimeout(id);
  }, [v, d]);
  const st = useAnimatedStyle(() => ({
    opacity: v.value < 0.75 ? Math.min(1, v.value * 5) : (1 - v.value) * 4,
    transform: [{ translateX: dx * v.value }, { translateY: dy * v.value - 30 * Math.sin(v.value * Math.PI) }, { rotate: `${rot * v.value}deg` }, { scale: 0.6 + 0.6 * v.value }],
  }));
  return <Animated.Text style={[styles.piece, st]}>{e}</Animated.Text>;
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, maxWidth: 480, width: '100%', elevation: 6 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, maxWidth: 300, elevation: 3 },
  emoji: { fontSize: 28 },
  toastEmoji: { fontSize: 16 },
  skip: { marginLeft: 'auto', paddingHorizontal: 10, minHeight: 28, borderRadius: 14, justifyContent: 'center' },
  confetti: { position: 'absolute', top: 24, left: 0, right: 0, alignItems: 'center' },
  piece: { position: 'absolute', fontSize: 22 },
});
