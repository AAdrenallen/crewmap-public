import { useEffect } from 'react';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { PRESET_FALLBACK, type EmotePreset } from '@crewmap/shared/emotes';

type Motion = 'bounce' | 'wiggle' | 'pulse' | 'shake' | 'drive' | 'spin';

const MOTION: Record<EmotePreset | 'custom', Motion> = {
  getMeFood: 'bounce',
  areWeThereYet: 'wiggle',
  whereAreYou: 'bounce',
  hurryUp: 'shake',
  callMe: 'shake',
  honkHonk: 'pulse',
  onMyWay: 'drive',
  missYou: 'pulse',
  thinkingOfYou: 'pulse',
  imHere: 'bounce',
  needRide: 'drive',
  welcomeHome: 'bounce',
  chargeUp: 'pulse',
  driveSafe: 'drive',
  thanks: 'wiggle',
  custom: 'spin',
};

/** Original vector emote art, one small illustration per preset. */
function Art({ preset }: { preset: EmotePreset | 'custom' }) {
  switch (preset) {
    case 'getMeFood':
      return (
        <G>
          <Ellipse cx={32} cy={22} rx={22} ry={12} fill="#F2A541" />
          <Rect x={10} y={28} width={44} height={7} rx={3} fill="#4CAF50" />
          <Rect x={9} y={34} width={46} height={9} rx={4} fill="#7B3F1E" />
          <Rect x={11} y={42} width={42} height={5} rx={2} fill="#FFC845" />
          <Path d="M10 46h44c0 6-4 9-10 9H20c-6 0-10-3-10-9z" fill="#E59A3A" />
          <Circle cx={24} cy={16} r={1.6} fill="#FFF3D6" />
          <Circle cx={34} cy={13} r={1.6} fill="#FFF3D6" />
          <Circle cx={41} cy={18} r={1.6} fill="#FFF3D6" />
        </G>
      );
    case 'areWeThereYet':
      return (
        <G>
          <Rect x={6} y={30} width={44} height={16} rx={7} fill="#5B6CFF" />
          <Path d="M14 30l6-10h16l8 10z" fill="#8FA0FF" />
          <Circle cx={16} cy={47} r={6} fill="#1B2236" />
          <Circle cx={40} cy={47} r={6} fill="#1B2236" />
          <Circle cx={52} cy={14} r={10} fill="#FFC845" />
          <Path d="M48 11c0-3 2-4 4-4s4 1 4 3-3 3-3 5M53 20v1" stroke="#1B2236" strokeWidth={2.4} strokeLinecap="round" fill="none" />
        </G>
      );
    case 'whereAreYou':
      return (
        <G>
          <Path d="M32 4c-11 0-19 8-19 19 0 14 19 35 19 35s19-21 19-35C51 12 43 4 32 4z" fill="#FF6B6B" />
          <Circle cx={32} cy={23} r={11} fill="#fff" />
          <Path d="M28 20c0-3 2-5 4-5s4 2 4 4-4 3-4 6M32 30v1" stroke="#FF6B6B" strokeWidth={3} strokeLinecap="round" fill="none" />
        </G>
      );
    case 'hurryUp':
      return (
        <G>
          <Path d="M14 40c0-8 8-14 16-14h10l10 10v8H14z" fill="#2EC4B6" />
          <Rect x={12} y={44} width={40} height={6} rx={3} fill="#fff" />
          <Path d="M2 26h14M4 34h10M6 18h12" stroke="#FFC845" strokeWidth={4} strokeLinecap="round" />
          <Path d="M30 30l4 5M36 30l4 5" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" />
        </G>
      );
    case 'callMe':
      return (
        <G>
          <Rect x={20} y={6} width={24} height={46} rx={6} fill="#1B2236" />
          <Rect x={23} y={11} width={18} height={32} rx={2} fill="#7DD3FC" />
          <Circle cx={32} cy={47} r={2.5} fill="#8A93A8" />
          <Path d="M50 16c4 4 4 12 0 16M55 11c7 7 7 19 0 26M14 16c-4 4-4 12 0 16M9 11c-7 7-7 19 0 26" stroke="#FFC845" strokeWidth={3} strokeLinecap="round" fill="none" />
        </G>
      );
    case 'honkHonk':
      return (
        <G>
          <Path d="M8 26h12l20-14v40L20 38H8z" fill="#FFC845" />
          <Rect x={4} y={26} width={8} height={12} rx={2} fill="#E59A3A" />
          <Path d="M46 22c4 3 4 17 0 20M52 16c7 6 7 26 0 32" stroke="#FF6B6B" strokeWidth={4} strokeLinecap="round" fill="none" />
        </G>
      );
    case 'onMyWay':
      return (
        <G>
          <Rect x={4} y={30} width={40} height={14} rx={6} fill="#30A46C" />
          <Path d="M12 30l5-9h14l7 9z" fill="#7FD3A6" />
          <Circle cx={14} cy={45} r={5} fill="#1B2236" />
          <Circle cx={34} cy={45} r={5} fill="#1B2236" />
          <Path d="M46 37h14m-6-6l6 6-6 6" stroke="#30A46C" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </G>
      );
    case 'missYou':
      return (
        <G>
          <Path d="M32 56S6 40 6 22C6 12 13 6 21 6c5 0 9 3 11 7 2-4 6-7 11-7 8 0 15 6 15 16 0 18-26 34-26 34z" fill="#FF6B6B" />
          <Ellipse cx={20} cy={18} rx={5} ry={3} fill="#FFB3B3" />
        </G>
      );
    default:
      return (
        <G>
          <Circle cx={32} cy={32} r={24} fill="#5B6CFF" />
          <Rect x={27} y={14} width={10} height={22} rx={5} fill="#fff" />
          <Path d="M21 30c0 7 5 12 11 12s11-5 11-12M32 42v8" stroke="#fff" strokeWidth={3} strokeLinecap="round" fill="none" />
        </G>
      );
  }
}

export function EmoteArt({ preset, size = 56 }: { preset: EmotePreset | 'custom'; size?: number }) {
  const v = useSharedValue(0);
  const motion = MOTION[preset];
  useEffect(() => {
    v.value = withRepeat(withSequence(withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 320, easing: Easing.in(Easing.quad) })), -1);
  }, [v]);
  const style = useAnimatedStyle(() => {
    switch (motion) {
      case 'bounce':
        return { transform: [{ translateY: -8 * v.value }] };
      case 'wiggle':
        return { transform: [{ rotate: `${(v.value - 0.5) * 16}deg` }] };
      case 'pulse':
        return { transform: [{ scale: 1 + 0.12 * v.value }] };
      case 'shake':
        return { transform: [{ translateX: (v.value - 0.5) * 8 }] };
      case 'drive':
        return { transform: [{ translateX: (v.value - 0.5) * 12 }] };
      case 'spin':
        return { transform: [{ rotate: `${v.value * 20}deg` }] };
    }
  });
  return (
    <Animated.View style={style}>
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <Art preset={preset === 'custom' ? preset : PRESET_FALLBACK[preset]} />
      </Svg>
    </Animated.View>
  );
}
