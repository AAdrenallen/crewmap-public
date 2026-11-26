import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { TIPS } from '@crewmap/shared/shell';
import { Button, Card, IconTile, ScreenHeader } from '../../ui/kit';
import { pageX, useLayoutMode } from '../../ui/layout';
import { resetTips } from '../../ui/shell/TipBanner';
import { type, useTheme } from '../../ui/theme';

/** Settings → Tips: one short card per main feature. All tip prose lives here and on the first-time banners of secondary screens. */
export default function Tips() {
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  return (
    <ScrollView style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 12, paddingBottom: insets.bottom + 30 }}>
      <ScreenHeader title={t('tips.title')} />
      {TIPS.map((tip) => (
        <Card key={tip.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <IconTile icon={tip.icon} color={th.accent} size={44} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.headline, { color: th.text }]}>{t(`tips.${tip.id}.t`)}</Text>
            <Text style={[type.small, { color: th.textSoft }]}>{t(`tips.${tip.id}.b`)}</Text>
          </View>
        </Card>
      ))}
      <Button testID="tips-reset" kind="secondary" label={t('tips.reset')} onPress={() => void resetTips()} />
    </ScrollView>
  );
}
