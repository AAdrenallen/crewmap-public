import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { platform, type MediaOpenResult } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { useTheme } from '../theme';
import { MusicIcon } from './MusicIcons';
import { useMusicUi } from './musicState';

export interface MusicButtonProps {
  /** Player to target; default: preferred → active session → first installed. */
  pkg?: string;
  /** Diameter in dp (≥ 64 while driving). */
  size?: number;
  onResult?: (r: MediaOpenResult) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Toggles the comfortable in-app slide-in music player & playlist drawer (never splits the screen 50/50!). */
export function MusicButton({ size = 64, style, testID = 'music-split' }: MusicButtonProps) {
  const th = useTheme();
  const drawerOpen = useMusicUi((st) => st.drawerOpen);
  const toggleDrawer = useMusicUi((st) => st.toggleDrawer);
  const restoreCard = useMusicUi((st) => st.restoreCard);
  if (platform.os !== 'android') return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('music.open')}
      accessibilityState={{ expanded: drawerOpen }}
      hitSlop={8}
      onPress={() => {
        restoreCard();
        toggleDrawer();
      }}
      style={({ pressed }) => [
        s.btn,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: drawerOpen ? th.accent : th.glass,
          borderColor: th.separator,
          opacity: pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      <MusicIcon name="note" size={size * 0.44} color={drawerOpen ? th.onAccent : th.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', elevation: 4, borderWidth: StyleSheet.hairlineWidth },
});
