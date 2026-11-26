import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { t } from '@crewmap/shared/i18n';
import { extractInviteLink } from '@crewmap/shared/links';
import { Button, H, Icon, IconButton, ScreenHeader } from '../ui/kit';
import { palette, type, useTheme } from '../ui/theme';

const FRAME = 260;

function Corners() {
  const arm = 36;
  const w = 5;
  const c = palette.sun;
  const base = { position: 'absolute' as const, width: arm, height: arm, borderColor: c };
  return (
    <>
      <View style={[base, { top: 0, left: 0, borderTopWidth: w, borderLeftWidth: w, borderTopLeftRadius: 24 }]} />
      <View style={[base, { top: 0, right: 0, borderTopWidth: w, borderRightWidth: w, borderTopRightRadius: 24 }]} />
      <View style={[base, { bottom: 0, left: 0, borderBottomWidth: w, borderLeftWidth: w, borderBottomLeftRadius: 24 }]} />
      <View style={[base, { bottom: 0, right: 0, borderBottomWidth: w, borderRightWidth: w, borderBottomRightRadius: 24 }]} />
    </>
  );
}

/** In-person QR invite scan → /join with the link. */
export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const { width, height } = useWindowDimensions();
  const wide = width > height;
  const [perm, request] = useCameraPermissions();
  const [done, setDone] = useState(false);
  const sweep = useSharedValue(0);
  useEffect(() => {
    sweep.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [sweep]);
  const line = useAnimatedStyle(() => ({ transform: [{ translateY: sweep.value * (FRAME - 24) }] }));
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) return false;
      router.replace('/');
      return true;
    });
    return () => sub.remove();
  }, [router]);

  if (!perm) {
    return (
      <View style={[styles.center, { backgroundColor: th.bg }]}>
        <ActivityIndicator color={th.accent} size="large" />
      </View>
    );
  }
  if (!perm.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, padding: 20, paddingTop: insets.top + 8 }}>
        <ScreenHeader />
        <View style={styles.center}>
          <View style={[styles.badge, { backgroundColor: th.accentSoft }]}>
            <Icon name="camera" size={40} color={th.accent} />
          </View>
          <H style={{ textAlign: 'center' }}>{t('circle.scan')}</H>
          <View style={{ alignSelf: 'stretch' }}>
            <Button
              icon="camera"
              label={perm.canAskAgain ? t('onb.allow') : t('onb.openSettings')}
              onPress={() => (perm.canAskAgain ? void request() : void Linking.openSettings())}
            />
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          done
            ? undefined
            : ({ data }) => {
                const link = extractInviteLink(data);
                if (!link) return;
                setDone(true);
                router.replace({ pathname: '/join', params: { link } });
              }
        }
      />
      <View style={[styles.frame, wide && { top: Math.max(8, Math.round((height - FRAME) / 2) - 10) }]} pointerEvents="none">
        <Corners />
        <Animated.View style={[styles.line, line]} />
      </View>
      <View style={[styles.close, { top: insets.top + 8, left: Math.max(14, insets.left + 8) }]}>
        <IconButton testID="scan-close" icon="close" label={t('common.close')} onPress={close} />
      </View>
      <View style={[styles.bottom, { bottom: insets.bottom + (wide ? 8 : 48) }]}>
        <View style={styles.pill}>
          <Icon name="qr" size={18} color="#FFFFFF" />
          <Text style={[type.headline, { color: '#FFFFFF' }]}>{t('circle.scan')}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingBottom: 48 },
  badge: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'absolute', alignSelf: 'center', top: '28%', width: FRAME, height: FRAME },
  line: { position: 'absolute', left: 16, right: 16, top: 12, height: 2, borderRadius: 1, backgroundColor: palette.sun, opacity: 0.85 },
  close: { position: 'absolute', left: 14 },
  bottom: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 12 },
});
