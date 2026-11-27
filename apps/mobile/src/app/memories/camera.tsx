import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { Bouncy, Button, H, Icon, IconButton, ScreenHeader, Toast } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

/** Take a photo for a memory (D68): captured, re-encoded small, shared with the crewmates who were there. */
export default function MemoryCamera() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const [perm, request] = useCameraPermissions();
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cam = useRef<CameraView>(null);
  const close = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/memories/[id]', params: { id } }));

  if (!perm) return <ActivityIndicator color={th.accent} size="large" style={{ flex: 1, backgroundColor: th.bg }} />;
  if (!perm.granted)
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, padding: 20, paddingTop: insets.top + 8 }}>
        <ScreenHeader />
        <View style={styles.center}>
          <View style={[styles.badge, { backgroundColor: th.accentSoft }]}>
            <Icon name="camera" size={40} color={th.accent} />
          </View>
          <H style={{ textAlign: 'center' }}>{t('mem.addCamera')}</H>
          <View style={{ alignSelf: 'stretch' }}>
            <Button icon="camera" label={perm.canAskAgain ? t('onb.allow') : t('onb.openSettings')} onPress={() => (perm.canAskAgain ? void request() : void Linking.openSettings())} />
          </View>
        </View>
      </View>
    );

  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pic = await cam.current?.takePictureAsync({ quality: 0.9, skipProcessing: false });
      if (!pic) throw new Error('no picture');
      const r = await engine.memories.addPhoto(id, { camera: pic.uri });
      if (r === 'ok') return close();
      setErr(t(`mem.photo.${r === 'canceled' ? 'failed' : r}`));
    } catch {
      setErr(t('mem.photo.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView ref={cam} style={StyleSheet.absoluteFill} facing={facing} />
      <View style={[styles.top, { top: insets.top + 8 }]}>
        <IconButton testID="mem-cam-close" icon="close" label={t('common.close')} onPress={close} />
        <IconButton testID="mem-cam-flip" icon="shuffle" label={t('mem.flip')} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} />
      </View>
      <View style={[styles.bottom, { bottom: insets.bottom + 36 }]}>
        <Bouncy testID="mem-cam-shoot" accessibilityRole="button" accessibilityLabel={t('mem.addCamera')} haptic="bounce" scaleTo={0.86} onPress={() => void shoot()} style={styles.shutter}>
          {busy ? <ActivityIndicator color="#000" /> : <View style={styles.shutterIn} />}
        </Bouncy>
      </View>
      {err && <Toast testID="mem-cam-error" tone="danger" message={err} onPress={() => setErr(null)} style={{ position: 'absolute', alignSelf: 'center', top: insets.top + 72 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingBottom: 48 },
  badge: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  top: { position: 'absolute', left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between' },
  bottom: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, backgroundColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  shutterIn: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFFFFF' },
});
