import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { platform, type MediaOpenResult } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { useTheme } from '../theme';
import { MusicIcon } from './MusicIcons';

export interface MusicButtonProps {
  /** Player to open; default: preferred → active session → first installed. */
  pkg?: string;
  /** Diameter in dp (≥ 64 while driving). */
  size?: number;
  onResult?: (r: MediaOpenResult) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Opens the music app beside CrewMap (split screen), or full screen with the bubble when split isn't available. */
export function MusicButton({ pkg, size = 64, onResult, style, testID = 'music-split' }: MusicButtonProps) {
  const th = useTheme();
  if (platform.os !== 'android') return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('music.open')}
      hitSlop={8}
      onPress={() => void platform.media.openSplit(pkg).then((r) => onResult?.(r))}
      style={({ pressed }) => [s.btn, { width: size, height: size, borderRadius: size / 2, backgroundColor: th.glass, opacity: pressed ? 0.7 : 1 }, style]}
    >
      <MusicIcon name="note" size={size * 0.44} color={th.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', elevation: 4 },
});
