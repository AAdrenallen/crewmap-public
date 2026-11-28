import { useEffect, useRef, useState } from 'react';
import { Animated, Image, PanResponder, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { platform, type MediaAction, type NowPlaying } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { useTheme } from '../theme';
import { MusicIcon, type MusicGlyph } from './MusicIcons';
import { useMusicUi } from './musicState';

/** Above this speed the pill drops art and text (icon-only); it expands again below it minus the hysteresis. */
export const MUSIC_COLLAPSE_KMH = 25;
export const MUSIC_EXPAND_HYSTERESIS_KMH = 5;
const TARGET = 60;

export interface MusicCardProps {
  /** Current speed; drives the auto-collapse. */
  speedKmh: number;
  /** Force icon-only (e.g. tight landscape HUD). */
  collapsed?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Subscribes to the active media session; null when nothing plays or Notification Access is missing. */
export function useNowPlaying(): NowPlaying | null {
  const [np, setNp] = useState<NowPlaying | null>(null);
  useEffect(() => {
    if (platform.os !== 'android' || !platform.media.hasAccess()) return;
    const off = platform.media.onChange(setNp);
    setNp(platform.media.current());
    return off;
  }, []);
  return np;
}

/** Pure: collapse state with hysteresis. */
export function musicCollapsed(speedKmh: number, wasCollapsed: boolean): boolean {
  return wasCollapsed ? speedKmh > MUSIC_COLLAPSE_KMH - MUSIC_EXPAND_HYSTERESIS_KMH : speedKmh > MUSIC_COLLAPSE_KMH;
}

/**
 * Compact now-playing pill in navigation:
 * - Tapping track info opens the comfortable in-app slide-in MusicDrawer (never 50/50 split-screen!).
 * - Swiping left, right, or down smoothly dismisses the popup card so it never covers the map!
 * - Hidden while MusicDrawer is open so controls are never duplicated.
 */
export function MusicCard({ speedKmh, collapsed, style, testID = 'music-card' }: MusicCardProps) {
  const th = useTheme();
  const np = useNowPlaying();
  const drawerOpen = useMusicUi((st) => st.drawerOpen);
  const cardDismissed = useMusicUi((st) => st.cardDismissed);
  const openDrawer = useMusicUi((st) => st.openDrawer);
  const dismissCard = useMusicUi((st) => st.dismissCard);
  const [auto, setAuto] = useState(false);

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;

  useEffect(() => setAuto((c) => musicCollapsed(speedKmh, c)), [speedKmh]);
  useEffect(() => {
    if (!cardDismissed) {
      tx.setValue(0);
      ty.setValue(0);
    }
  }, [cardDismissed, tx, ty]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 || g.dy > 14,
      onPanResponderMove: (_, g) => {
        tx.setValue(g.dx);
        ty.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 56 || g.vx < -0.65 || g.vx > 0.65 || g.dy > 44) {
          Animated.timing(tx, {
            toValue: g.dx >= 0 ? 320 : -320,
            duration: 180,
            useNativeDriver: true,
          }).start(() => dismissCard());
        } else {
          Animated.parallel([
            Animated.spring(tx, { toValue: 0, useNativeDriver: true, friction: 7 }),
            Animated.spring(ty, { toValue: 0, useNativeDriver: true, friction: 7 }),
          ]).start();
        }
      },
    }),
  ).current;

  if (!np || drawerOpen || cardDismissed) return null;
  const small = collapsed ?? auto;
  const act = (a: MediaAction) => {
    if (!platform.media.control(a)) openDrawer();
  };
  const btn = (glyph: MusicGlyph, label: string, onPress: () => void, onLongPress?: () => void, id?: string) => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [s.btn, pressed && { backgroundColor: th.separator }]}
    >
      <MusicIcon name={glyph} size={30} color={th.text} />
    </Pressable>
  );

  return (
    <Animated.View
      {...pan.panHandlers}
      testID={testID}
      style={[
        s.pill,
        { backgroundColor: th.glass, borderColor: th.separator, transform: [{ translateX: tx }, { translateY: ty }] },
        style,
      ]}
    >
      {!small && (
        <Pressable accessibilityRole="button" accessibilityLabel={t('music.open')} onPress={openDrawer} style={s.info}>
          {np.art ? (
            <Image source={{ uri: np.art }} style={s.art} />
          ) : (
            <View style={[s.art, s.artEmpty, { backgroundColor: th.separator }]}>
              <MusicIcon name="note" size={22} color={th.textSoft} />
            </View>
          )}
          <View style={s.text}>
            <Text numberOfLines={1} style={[s.title, { color: th.text }]}>
              {np.title ?? np.app ?? ''}
            </Text>
            {np.artist ? (
              <Text numberOfLines={1} style={[s.artist, { color: th.textSoft }]}>
                {np.artist}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )}
      {btn(np.playing ? 'pause' : 'play', t(np.playing ? 'music.pause' : 'music.play'), () => act('toggle'), undefined, 'music-toggle')}
      {btn(
        'next',
        t('music.next'),
        () => act(np.canNext ? 'next' : 'toggle'),
        () => (np.canNextPlaylist ? act('nextPlaylist') : openDrawer()),
        'music-next',
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: TARGET / 2 + 6,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 5,
    gap: 2,
    elevation: 5,
    maxWidth: 340,
  },
  info: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minHeight: TARGET, paddingRight: 4 },
  art: { width: 46, height: 46, borderRadius: 23 },
  artEmpty: { alignItems: 'center', justifyContent: 'center' },
  text: { marginLeft: 9, flexShrink: 1, maxWidth: 155 },
  title: { fontSize: 15, fontWeight: '700' },
  artist: { fontSize: 12.5, marginTop: 1 },
  btn: { width: TARGET, height: TARGET, borderRadius: TARGET / 2, alignItems: 'center', justifyContent: 'center' },
});
