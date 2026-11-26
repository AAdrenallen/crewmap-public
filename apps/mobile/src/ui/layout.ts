import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** portrait phone, landscape phone (~915 × 412 dp), or a tablet (shortest side ≥ 600 dp) in either rotation. */
export type LayoutMode = 'portrait' | 'landscape' | 'tablet';

export const TABLET_MIN_DP = 600;

/** Width of the left column that holds the turn banner / route list when the screen is wide. */
export const SIDE_PANEL_W = 360;

/** Pure: which layout fits a window of this size. */
export function layoutModeFor(width: number, height: number): LayoutMode {
  if (Math.min(width, height) >= TABLET_MIN_DP) return 'tablet';
  return width > height ? 'landscape' : 'portrait';
}

export interface LayoutInfo {
  mode: LayoutMode;
  width: number;
  height: number;
  /** Wider than tall: panels sit at the side and the map stays visible beside them. */
  wide: boolean;
  /** Phone held sideways (short vertical space: compact HUD). */
  landscape: boolean;
  /** Width of a side panel for this screen. */
  panelW: number;
  /** Horizontal safe-area gutter: notch / cutout / gesture bar sides, never below the 14 dp page margin. */
  gutterL: number;
  gutterR: number;
}

export const PAGE_MARGIN = 14;

/** Pure part of `useLayoutMode`, so it can be tested without React. */
export function layoutInfo(width: number, height: number, insets: { left: number; right: number }): LayoutInfo {
  const mode = layoutModeFor(width, height);
  const wide = width > height;
  return {
    mode,
    width,
    height,
    wide,
    landscape: mode === 'landscape',
    panelW: Math.min(SIDE_PANEL_W, Math.round(width * 0.42)),
    gutterL: Math.max(PAGE_MARGIN, insets.left + 8),
    gutterR: Math.max(PAGE_MARGIN, insets.right + 8),
  };
}

export function useLayoutMode(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return layoutInfo(width, height, insets);
}

interface Padding {
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
}

/**
 * Camera padding while following the user (so the puck sits in the free part of the screen). Portrait keeps the
 * turn banner above the puck; wide screens put the banner in the left column, so the puck centres in what is right of it.
 */
export function followPaddingFor(info: Pick<LayoutInfo, 'wide' | 'panelW' | 'height'>, headingUp: boolean, navigating: boolean): Padding {
  if (!info.wide) return { paddingTop: headingUp ? (navigating ? 360 : 240) : 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 };
  return {
    paddingTop: headingUp ? Math.round(info.height * 0.18) : 0,
    paddingBottom: 0,
    paddingLeft: navigating ? info.panelW : 0,
    paddingRight: 0,
  };
}

/** Camera padding that frames the route candidates in the part of the map the route sheet / panel leaves free. */
export function previewPaddingFor(info: Pick<LayoutInfo, 'wide' | 'panelW' | 'height'>): Padding {
  if (!info.wide) return { paddingTop: 90, paddingRight: 48, paddingBottom: Math.round(info.height * 0.58), paddingLeft: 48 };
  return { paddingTop: 56, paddingRight: 56, paddingBottom: 56, paddingLeft: info.panelW + 56 };
}

/**
 * Horizontal padding for scrolling content: keeps clear of notches in landscape and stops lines from stretching across
 * a 900 dp screen (content stays one readable column, centred).
 */
export function pageX(info: Pick<LayoutInfo, 'wide' | 'gutterL' | 'gutterR'>, base = 16): { paddingLeft: number; paddingRight: number; maxWidth: number | undefined; width: '100%'; alignSelf: 'center' } {
  return {
    paddingLeft: Math.max(base, info.gutterL),
    paddingRight: Math.max(base, info.gutterR),
    maxWidth: info.wide ? 760 : undefined,
    width: '100%',
    alignSelf: 'center',
  };
}
