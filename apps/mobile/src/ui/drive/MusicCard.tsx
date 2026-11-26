import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { platform, type MediaAction, type NowPlaying } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { useTheme } from '../theme';
import { MusicIcon, type MusicGlyph } from './MusicIcons';

/** Above this speed the pill drops art and text (icon-only); it expands again below it minus the hysteresis. */
export const MUSIC_COLLAPSE_KMH = 25;
export const MUSIC_EXPAND_HYSTERESIS_KMH = 5;
const TARGET = 64;

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

/** Compact now-playing pill: art, title, big play/pause and next. Long-press next = next playlist where exposed. */
export function MusicCard({ speedKmh, collapsed, style, testID = 'music-card' }: MusicCardProps) {
  const th = useTheme();
  const np = useNowPlaying();
  const [auto, setAuto] = useState(false);
  useEffect(() => setAuto((c) => musicCollapsed(speedKmh, c)), [speedKmh]);
  if (!np) return null;
  const small = collapsed ?? auto;
  const open = () => void platform.media.openSplit(np.pkg);
  const act = (a: MediaAction) => {
    if (!platform.media.control(a)) open();
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
      <MusicIcon name={glyph} size={34} color={th.text} />
    </Pressable>
  );
  return (
    <View testID={testID} style={[s.pill, { backgroundColor: th.glass }, style]}>
      {!small && (
        <Pressable accessibilityRole="button" accessibilityLabel={t('music.open')} onPress={open} style={s.info}>
          {np.art ? <Image source={{ uri: np.art }} style={s.art} /> : <View style={[s.art, s.artEmpty, { backgroundColor: th.separator }]}><MusicIcon name="note" size={24} color={th.textSoft} /></View>}
          <View style={s.text}>
            <Text numberOfLines={1} style={[s.title, { color: th.text }]}>{np.title ?? np.app ?? ''}</Text>
            {np.artist ? <Text numberOfLines={1} style={[s.artist, { color: th.textSoft }]}>{np.artist}</Text> : null}
          </View>
        </Pressable>
      )}
      {btn(np.playing ? 'pause' : 'play', t(np.playing ? 'music.pause' : 'music.play'), () => act('toggle'), undefined, 'music-toggle')}
      {btn(
        'next',
        t('music.next'),
        () => act(np.canNext ? 'next' : 'toggle'),
        () => (np.canNextPlaylist ? act('nextPlaylist') : open()),
        'music-next',
      )}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', borderRadius: TARGET / 2 + 6, padding: 6, gap: 4, elevation: 4, maxWidth: 420 },
  info: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minHeight: TARGET, paddingRight: 6 },
  art: { width: 52, height: 52, borderRadius: 26 },
  artEmpty: { alignItems: 'center', justifyContent: 'center' },
  text: { marginLeft: 10, flexShrink: 1 },
  title: { fontSize: 16, fontWeight: '700' },
  artist: { fontSize: 13, marginTop: 1 },
  btn: { width: TARGET, height: TARGET, borderRadius: TARGET / 2, alignItems: 'center', justifyContent: 'center' },
});
