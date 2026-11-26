import { Platform, useColorScheme, type TextStyle, type ViewStyle } from 'react-native';
import { useApp } from '../core/store';

/** Core palette. Brand indigo, warm accents for social moments; calm, high-contrast palette while driving (F2). */
export const palette = {
  brand: '#4F5BFF',
  brandDeep: '#3540D6',
  brandSoft: '#E8EAFF',
  pop: '#FF5A6A',
  sun: '#FFC233',
  mint: '#14B8A6',
  ink: '#0B0F1A',
  inkSoft: '#151B2B',
  paper: '#FFFFFF',
  paperSoft: '#F4F6FA',
  grey: '#8A93A8',
  danger: '#E5484D',
  warn: '#F5A524',
  ok: '#22A06B',
  speed: '#E5484D',
  // Traffic congestion ramp (route cards, legends).
  trafficFree: '#22A06B',
  trafficModerate: '#F5A524',
  trafficHeavy: '#E5484D',
  trafficSevere: '#9B1C31',
} as const;

export interface Theme {
  bg: string;
  card: string;
  cardAlt: string;
  text: string;
  textSoft: string;
  textFaint: string;
  border: string;
  separator: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  glass: string;
  scrim: string;
  danger: string;
  ok: string;
  warn: string;
  driving: boolean;
  dark: boolean;
}

const light: Omit<Theme, 'driving' | 'dark'> = {
  bg: palette.paperSoft,
  card: palette.paper,
  cardAlt: '#EDF0F6',
  text: '#0B0F1A',
  textSoft: '#4B5468',
  textFaint: '#8A93A8',
  border: '#DFE3EC',
  separator: 'rgba(11,15,26,0.08)',
  accent: palette.brand,
  accentSoft: palette.brandSoft,
  onAccent: '#FFFFFF',
  glass: 'rgba(255,255,255,0.94)',
  scrim: 'rgba(11,15,26,0.45)',
  danger: palette.danger,
  ok: palette.ok,
  warn: palette.warn,
};

const dark: Omit<Theme, 'driving' | 'dark'> = {
  bg: palette.ink,
  card: palette.inkSoft,
  cardAlt: '#1F2638',
  text: '#F4F6FC',
  textSoft: '#A8B0C4',
  textFaint: '#6B7489',
  border: '#2A3247',
  separator: 'rgba(255,255,255,0.08)',
  accent: '#7480FF',
  accentSoft: 'rgba(116,128,255,0.18)',
  onAccent: '#FFFFFF',
  glass: 'rgba(21,27,43,0.94)',
  scrim: 'rgba(0,0,0,0.6)',
  danger: '#FF6369',
  ok: '#3DD68C',
  warn: '#FFB224',
};

const drive: Omit<Theme, 'driving' | 'dark'> = {
  ...dark,
  bg: '#05070D',
  card: '#0E1220',
  cardAlt: '#161C2E',
  text: '#FFFFFF',
  textSoft: '#B8C0D6',
  border: '#2A3350',
  accent: '#7DD3FC',
  accentSoft: 'rgba(125,211,252,0.16)',
  onAccent: '#05070D',
  glass: 'rgba(14,18,32,0.96)',
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const isDark = driving || scheme === 'dark';
  return { ...(driving ? drive : isDark ? dark : light), driving, dark: isDark };
}

export const radius = { xs: 6, s: 10, m: 16, l: 24, xl: 32, pill: 999 } as const;
export const space = (n: number) => n * 4;
/** Minimum touch target (Material 48 dp). */
export const hit = 48;

/** Inter font families, loaded in the root layout. Android needs one family per weight. */
export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  heavy: 'Inter_800ExtraBold',
} as const;

export function font(w: keyof typeof fonts): TextStyle {
  return { fontFamily: fonts[w] };
}

export const type = {
  hero: { ...font('heavy'), fontSize: 36, lineHeight: 42, letterSpacing: -0.8 },
  title: { ...font('bold'), fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  headline: { ...font('semibold'), fontSize: 17, lineHeight: 22, letterSpacing: -0.1 },
  body: { ...font('medium'), fontSize: 16, lineHeight: 22 },
  small: { ...font('semibold'), fontSize: 13, lineHeight: 18 },
  caption: { ...font('medium'), fontSize: 12, lineHeight: 16, letterSpacing: 0.1 },
  overline: { ...font('bold'), fontSize: 12, lineHeight: 16, letterSpacing: 0.8, textTransform: 'uppercase' as const },
  num: { ...font('bold'), fontSize: 28, lineHeight: 34, letterSpacing: -0.5, fontVariant: ['tabular-nums' as const] },
};

/** Elevation tokens: Android elevation + iOS shadow in one style. */
function shadow(level: number, opacity: number, blur: number, y: number): ViewStyle {
  return Platform.select<ViewStyle>({
    android: { elevation: level, shadowColor: '#0B0F1A' },
    default: { shadowColor: '#0B0F1A', shadowOpacity: opacity, shadowRadius: blur, shadowOffset: { width: 0, height: y } },
  });
}

export const elevation = {
  none: {} as ViewStyle,
  low: shadow(2, 0.08, 4, 1),
  mid: shadow(6, 0.12, 12, 4),
  high: shadow(12, 0.18, 24, 8),
  sheet: shadow(24, 0.22, 32, -4),
} as const;

export const motion = {
  press: { damping: 18, stiffness: 420, mass: 0.6 },
  release: { damping: 14, stiffness: 260, mass: 0.6 },
} as const;
