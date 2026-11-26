import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { Card } from '../../ui/kit';
import { pageX, useLayoutMode } from '../../ui/layout';
import { ScreenHeader } from '../../ui/screens-common/Layout';
import { LICENSE_NOTES, LICENSE_ROWS } from '../../ui/shell/licenses.generated';
import { type, useTheme } from '../../ui/theme';

/** Asset and data-source licences (from ASSETS_LICENSES.md), rendered in-app. */
export default function Licenses() {
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  return (
    <ScrollView style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 12, paddingBottom: insets.bottom + 30 }}>
      <ScreenHeader title={t('set.licenses')} />
      {LICENSE_ROWS.map((r) => (
        <Card key={r.asset} style={{ gap: 4 }}>
          <Text style={[type.headline, { color: th.text }]}>{r.asset}</Text>
          <Text style={[type.small, { color: th.textSoft }]}>{r.source}</Text>
          <Text style={[type.small, { color: th.accent }]}>{r.licence}</Text>
        </Card>
      ))}
      <View style={{ gap: 6 }}>
        {LICENSE_NOTES.map((n) => (
          <Text key={n} style={[type.caption, { color: th.textFaint }]}>
            {n}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
