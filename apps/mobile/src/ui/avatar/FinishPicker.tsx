import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Pattern, Rect, Stop } from 'react-native-svg';
import { ANIMATED_FINISHES, FINISHES, type FinishId } from '@crewmap/shared/avatar';
import { t, type I18nKey } from '@crewmap/shared/i18n';
import { Bouncy } from '../kit';
import { Icon } from '../kitIcons';
import { radius, space, type, useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';

const S = 52;

/** Flat SVG stand-ins for the shader finishes (one GL context per tile would be far too heavy). */
const LOOK: Record<Exclude<FinishId, 'none'>, { stops: string[]; pattern?: 'checker' | 'stripes' | 'zebra' | 'dots' | 'pixel' | 'weave' }> = {
  rainbow: { stops: ['#FF3B30', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE'] },
  psychedelic: { stops: ['#FF2D95', '#7B2BFF', '#00E5FF', '#B6FF00', '#FF2D95'] },
  holo: { stops: ['#C9F6FF', '#F7C6FF', '#FFF3B8', '#B8FFD9', '#C9D6FF'] },
  gold: { stops: ['#7A5200', '#FFD45E', '#B07A10', '#FFF1B0'] },
  chrome: { stops: ['#3A3F46', '#F2F4F7', '#6C737D', '#FFFFFF'] },
  galaxy: { stops: ['#0B0424', '#3A1366', '#123A7A', '#0B0424'], pattern: 'dots' },
  lava: { stops: ['#2A0B05', '#FF5A0A', '#3A1006', '#FFB020'] },
  ice: { stops: ['#E8FBFF', '#99D8FF', '#FFFFFF', '#BDEBFF'] },
  glitch: { stops: ['#00FFFF', '#111111', '#FF00FF', '#111111'], pattern: 'stripes' },
  neon: { stops: ['#0D0D1A', '#39FF14', '#0D0D1A'] },
  camo: { stops: ['#4B5A2A', '#7A6A3C', '#2F3A1A', '#5C6B33'], pattern: 'dots' },
  zebra: { stops: ['#F5F5F5', '#F5F5F5'], pattern: 'zebra' },
  leopard: { stops: ['#D99A4A', '#E8B467'], pattern: 'dots' },
  checker: { stops: ['#F7F7F7', '#F7F7F7'], pattern: 'checker' },
  stripes: { stops: ['#D7263D', '#D7263D'], pattern: 'stripes' },
  tiedye: { stops: ['#FF6FB5', '#FFD23F', '#3BCEAC', '#5E60CE'] },
  carbon: { stops: ['#15171A', '#2A2D31'], pattern: 'weave' },
  pixel: { stops: ['#5B6CFF', '#2EC4B6'], pattern: 'pixel' },
};

function Preview({ id, spin }: { id: FinishId; spin: SharedValue<number> }) {
  const th = useTheme();
  const moving = ANIMATED_FINISHES.includes(id);
  const style = useAnimatedStyle(() => (moving ? { transform: [{ rotate: `${spin.value}deg` }, { scale: 1.6 }] } : {}));
  if (id === 'none') return <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: th.cardAlt }]}><Icon name="close" size={20} color={th.textSoft} /></View>;
  const look = LOOK[id];
  const ink = id === 'stripes' ? '#FFFFFF' : id === 'glitch' ? '#FF00FF' : id === 'leopard' ? '#3B2410' : id === 'galaxy' ? '#FFFFFF' : id === 'camo' ? '#2A3315' : '#111111';
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={S} height={S}>
        <Defs>
          <LinearGradient id={`f${id}`} x1="0" y1="0" x2="1" y2="1">
            {look.stops.map((c, i) => (
              <Stop key={i} offset={i / Math.max(1, look.stops.length - 1)} stopColor={c} />
            ))}
          </LinearGradient>
          {look.pattern && (
            <Pattern id={`p${id}`} width={look.pattern === 'pixel' ? 8 : 12} height={look.pattern === 'pixel' ? 8 : 12} patternUnits="userSpaceOnUse">
              {look.pattern === 'checker' && <><Rect width={6} height={6} fill={ink} /><Rect x={6} y={6} width={6} height={6} fill={ink} /></>}
              {look.pattern === 'stripes' && <Rect x={4} width={3} height={12} fill={ink} />}
              {look.pattern === 'zebra' && <Rect y={2} width={12} height={4} fill={ink} transform="rotate(-25 6 6)" />}
              {look.pattern === 'dots' && <><Rect x={2} y={2} width={3} height={3} rx={1.5} fill={ink} /><Rect x={8} y={7} width={2} height={2} rx={1} fill={ink} /></>}
              {look.pattern === 'pixel' && <Rect width={4} height={4} fill="#FFC845" opacity={0.7} />}
              {look.pattern === 'weave' && <><Rect width={6} height={6} fill="#3A3E44" /><Rect x={6} y={6} width={6} height={6} fill="#3A3E44" /></>}
            </Pattern>
          )}
        </Defs>
        <Rect width={S} height={S} fill={`url(#f${id})`} />
        {look.pattern && <Rect width={S} height={S} fill={`url(#p${id})`} />}
      </Svg>
    </Animated.View>
  );
}

/** Special finishes for one item: a sideways row of tiles; all unlocked, the sparkle is just the "rare" look. */
export function FinishPicker({ value, onChange, testPrefix }: { value: FinishId; onChange: (f: FinishId) => void; testPrefix: string }) {
  const th = useTheme();
  const still = useReduceMotion();
  const spin = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    spin.value = withRepeat(withTiming(360, { duration: 6000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(spin);
  }, [spin, still]);
  return (
    <View style={{ gap: space(2) }}>
      <Text style={[type.caption, { color: th.textSoft }]}>{t('avatar.finish')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2.5), paddingHorizontal: space(0.5) }}>
        {FINISHES.map((id) => {
          const on = value === id;
          const label = t(`finish.${id}` as I18nKey);
          return (
            <Bouncy key={id} testID={`${testPrefix}-finish-${id}`} haptic="select" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={() => onChange(id)} style={styles.item}>
              <View style={[styles.tile, { borderColor: on ? th.accent : th.border }]}>
                <View style={styles.clip}>
                  <Preview id={id} spin={spin} />
                </View>
                {id !== 'none' && (
                  <View style={[styles.badge, { backgroundColor: th.card }]}>
                    <Icon name="sparkle" size={11} color="#F5B700" strokeWidth={2.4} />
                  </View>
                )}
              </View>
              <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={[type.caption, { color: on ? th.text : th.textSoft, textAlign: 'center' }]}>
                {label}
              </Text>
            </Bouncy>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  item: { width: S + 14, alignItems: 'center', gap: space(1) },
  tile: { width: S + 6, height: S + 6, borderRadius: radius.m + 3, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  clip: { width: S, height: S, borderRadius: radius.m, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
});
