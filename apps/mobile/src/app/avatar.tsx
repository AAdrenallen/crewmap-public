import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_AVATAR, DEFAULT_CAR, randomAvatar, type AvatarConfig, type AvatarPartKey, type CarConfig } from '@crewmap/shared/avatar';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../core/engine';
import { useApp } from '../core/store';
import { PART_TABS, PartOptions, PartTabs, RidePicker } from '../ui/avatar/AvatarPickers';
import { AvatarStage } from '../ui/avatar/AvatarStage';
import { Button } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { Icon } from '../ui/screens-common/Icon';

type Mode = 'look' | 'car';
const MODES: readonly Mode[] = ['look', 'car'];

/** F8b: avatar + ride editor (Look / Ride; `?tab=car` opens on the ride) with a live 3D preview (the ride tab shows the avatar posed on the vehicle); saved as JSON config (sprites re-bake per config). */
export default function AvatarEditor() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const { height, width } = useWindowDimensions();
  const me = useApp((s) => s.me);
  const [cfg, setCfg] = useState<AvatarConfig>(me?.avatar ?? DEFAULT_AVATAR);
  const [car, setCar] = useState<CarConfig>(me?.car ?? DEFAULT_CAR);
  const params = useLocalSearchParams<{ tab?: string }>();
  const [mode, setMode] = useState<Mode>(params.tab === 'car' ? 'car' : 'look');
  const [tab, setTab] = useState<AvatarPartKey>('hair');
  const showCar = mode === 'car';
  const wide = width > height;
  // Landscape: preview on the left, editor on the right (the 3D stage would otherwise eat half of a 412 dp screen).
  const previewH = wide ? height : Math.round(height * 0.44);
  const previewW = wide ? Math.round(width * 0.4) : width;

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, flexDirection: wide ? 'row' : 'column' }}>
      <AvatarStage testID="avatar-preview" avatar={cfg} car={car} ride={showCar} focus={tab} width={previewW} height={previewH} insetTop={insets.top}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => router.back()} style={({ pressed }) => [styles.fab, { top: insets.top + 8, left: Math.max(16, insets.left + 8), backgroundColor: th.card, opacity: pressed ? 0.7 : 1 }]}>
          <Icon name="chevronLeft" color={th.text} size={24} />
        </Pressable>
        {!showCar && (
          <Pressable accessibilityRole="button" accessibilityLabel={t('onb.shuffle')} onPress={() => setCfg(randomAvatar())} style={({ pressed }) => [styles.fab, { bottom: 14, right: 16, backgroundColor: th.card, opacity: pressed ? 0.7 : 1 }]}>
            <Icon name="shuffle" color={th.accent} size={22} />
          </Pressable>
        )}
      </AvatarStage>
      <View style={[styles.sheet, { backgroundColor: th.bg }, wide && { marginTop: 0, borderTopRightRadius: 0, paddingTop: insets.top + 8, paddingRight: insets.right }]}>
        <View style={styles.tabs}>
          <PartTabs tabs={MODES} active={mode} onPick={setMode} testPrefix="avatar" />
          {!showCar && <PartTabs tabs={PART_TABS} active={tab} onPick={setTab} testPrefix="avatar" />}
        </View>
        <View style={{ height: StyleSheet.hairlineWidth * 2, marginHorizontal: 16, backgroundColor: th.border }} />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 16 }}>
          {showCar ? (
            <Animated.View key="car" entering={FadeIn.duration(180)}>
              <RidePicker car={car} onChange={setCar} layout="wrap" testPrefix="avatar" />
            </Animated.View>
          ) : (
            <PartOptions value={cfg} tab={tab} onChange={setCfg} testPrefix="avatar" />
          )}
        </ScrollView>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
          <Button
            testID="avatar-save"
            label={t('common.save')}
            onPress={() => {
              if (me) void engine.saveProfile({ ...me, avatar: cfg, car });
              router.back();
            }}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, borderTopLeftRadius: 28, borderTopRightRadius: 28, marginTop: -24, paddingTop: 8 },
  tabs: { padding: 12, paddingHorizontal: 16, gap: 10 },
  fab: { position: 'absolute', width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
});
