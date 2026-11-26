import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Icon, type IconName } from './Icon';

const BADGE: Record<string, { icon: IconName; from: string; to: string }> = {
  smoothOperator: { icon: 'butter', from: '#FFD66B', to: '#F59E0B' },
  nightOwl: { icon: 'owl', from: '#818CF8', to: '#3730A3' },
  roadWarrior: { icon: 'road', from: '#F87171', to: '#B91C1C' },
  explorer: { icon: 'compass', from: '#5EEAD4', to: '#0F766E' },
  earlyBird: { icon: 'sunrise', from: '#FDBA74', to: '#EA580C' },
  weekStreak: { icon: 'flame', from: '#FB923C', to: '#DC2626' },
  featherFoot: { icon: 'feather', from: '#A5F3FC', to: '#0891B2' },
  walker: { icon: 'walk', from: '#86EFAC', to: '#15803D' },
};

/** Hexagonal gradient medallion for a badge; `locked` greys it out. */
export function BadgeMedal({ id, size = 64, locked }: { id: string; size?: number; locked?: boolean }) {
  const b = BADGE[id] ?? { icon: 'star' as IconName, from: '#A5B4FC', to: '#4F46E5' };
  const gid = `bdg-${id}${locked ? '-l' : ''}`;
  const from = locked ? '#C8CDD8' : b.from;
  const to = locked ? '#8D95A8' : b.to;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', opacity: locked ? 0.7 : 1 }}>
      <Svg width={size} height={size} viewBox="0 0 64 64" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Path d="M32 2l26 15v30L32 62 6 47V17z" fill={`url(#${gid})`} />
        <Path d="M32 8l21 12v24L32 56 11 44V20z" fill="none" stroke="#FFFFFF" strokeOpacity={0.45} strokeWidth={1.5} />
      </Svg>
      <Icon name={b.icon} color="#FFFFFF" size={size * 0.42} strokeWidth={2.2} />
    </View>
  );
}

export const BADGE_IDS = Object.keys(BADGE);
