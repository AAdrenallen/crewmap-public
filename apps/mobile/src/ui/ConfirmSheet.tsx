import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@crewmap/shared/i18n';
import { Button } from './kit';
import { radius, type, useTheme } from './theme';

/** In-app confirm dialog (bottom sheet). Destructive by default; Android back and scrim tap cancel. */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const th = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} style={styles.scrim} onPress={onCancel} />
      <View style={styles.wrap} pointerEvents="box-none">
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: th.card }]}>
          <Text accessibilityRole="header" style={[type.headline, { color: th.text }]}>
            {title}
          </Text>
          {!!message && <Text style={[type.body, { color: th.textSoft }]}>{message}</Text>}
          <Button testID="confirm-yes" kind={destructive ? 'danger' : 'primary'} label={confirmLabel} onPress={onConfirm} />
          <Button testID="confirm-no" kind="ghost" label={t('common.cancel')} onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.5)' },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.l, borderTopRightRadius: radius.l, padding: 20, gap: 12 },
});
